// Slides that were never published (Ben, 2026-11-27): a talk started from a PDF on one device
// gets a code made on the spot, and a device that joins with it is sent the PDF through the
// relay, in pieces, encrypted with the key the code gives. Nothing is stored anywhere: the relay
// forwards each piece and forgets it.
import { deriveKeys } from "../core/crypto";
import type { TalkKeys } from "../core/crypto";
import { DECK_CHUNK_BYTES, randomSid } from "../core/protocol";
import type { Envelope, Message } from "../core/protocol";
import { NetworkError, NoTalkError } from "./fetch-deck";
import { RELAY_URL, RelayClient } from "./relay-client";

/** Pieces a second: well under the relay's limit of 120 messages a second per device. */
const CHUNKS_PER_SECOND = 40;
/** How long a joining device waits for anyone to answer before deciding there is no such talk. */
const ANSWER_WAIT_MS = 4000;
const STALL_MS = 12_000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Sends the PDF to the device that asked. Resolves when done, or early if the connection goes. */
export async function sendDeck(send: (message: Message) => number, pdf: ArrayBuffer, title: string, to: string): Promise<void> {
  const bytes = new Uint8Array(pdf);
  const chunks = Math.ceil(bytes.length / DECK_CHUNK_BYTES);
  const id = randomSid();
  if (send({ type: "deck-info", body: { for: to, id, bytes: bytes.length, chunks, title } }) === 0) return;
  for (let index = 0; index < chunks; index++) {
    const data = toBase64(bytes.subarray(index * DECK_CHUNK_BYTES, (index + 1) * DECK_CHUNK_BYTES));
    if (send({ type: "deck-chunk", body: { for: to, id, index, data } }) === 0) return;
    await new Promise((resolve) => window.setTimeout(resolve, 1000 / CHUNKS_PER_SECOND));
  }
}

export interface ReceivedDeck {
  readonly pdf: ArrayBuffer;
  readonly title: string;
}

/**
 * Asks the devices already in the talk for the slides. Rejects with NoTalkError when nobody
 * answers (no such talk), and with NetworkError when the transfer breaks off.
 */
export function receiveDeck(keys: TalkKeys, onProgress: (fraction: number) => void): Promise<ReceivedDeck> {
  if (!RELAY_URL) return Promise.reject(new NoTalkError("no relay in this build"));
  return new Promise((resolve, reject) => {
    const sid = randomSid();
    let transfer: { id: string; bytes: number; title: string; parts: (Uint8Array | undefined)[]; got: number } | null = null;
    let asking: number | undefined;
    let deadline: number | undefined;
    const finish = (result: ReceivedDeck | Error): void => {
      window.clearInterval(asking);
      window.clearTimeout(deadline);
      void relay.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const arm = (ms: number, error: Error): void => {
      window.clearTimeout(deadline);
      deadline = window.setTimeout(() => finish(error), ms);
    };
    const onMessage = (envelope: Envelope): void => {
      if (envelope.type === "deck-info" && envelope.body.for === sid && !transfer) {
        window.clearInterval(asking); // the first device to answer is the one listened to
        const { id, bytes, chunks, title } = envelope.body;
        transfer = { id, bytes, title, parts: new Array<Uint8Array | undefined>(chunks), got: 0 };
        arm(STALL_MS, new NetworkError("the slides stopped arriving"));
        return;
      }
      if (envelope.type !== "deck-chunk" || !transfer || envelope.body.id !== transfer.id || envelope.body.for !== sid) return;
      const { index, data } = envelope.body;
      if (index >= transfer.parts.length || transfer.parts[index]) return;
      transfer.parts[index] = fromBase64(data);
      transfer.got += 1;
      onProgress(transfer.got / transfer.parts.length);
      arm(STALL_MS, new NetworkError("the slides stopped arriving"));
      if (transfer.got < transfer.parts.length) return;
      const pdf = new Uint8Array(transfer.bytes);
      let offset = 0;
      for (const part of transfer.parts) {
        if (!part || offset + part.length > pdf.length) return finish(new NetworkError("the slides arrived damaged"));
        pdf.set(part, offset);
        offset += part.length;
      }
      finish(offset === pdf.length ? { pdf: pdf.buffer, title: transfer.title } : new NetworkError("the slides arrived damaged"));
    };
    const relay = new RelayClient({
      roomId: keys.roomId,
      channelKey: keys.channelKey,
      sid,
      onMessage,
      onStatus: (status) => {
        if (status !== "connected" || transfer) return;
        const ask = (): void => void relay.send({ type: "deck-request", body: {} });
        ask();
        window.clearInterval(asking);
        asking = window.setInterval(ask, 1200);
      },
    });
    arm(ANSWER_WAIT_MS, new NoTalkError("nobody answered"));
  });
}

/**
 * A code for a talk that starts on this device: one word, as Ben prefers for typing on a lectern
 * PC. It lives only as long as the talk.
 */
export async function makeJoinCode(): Promise<{ code: string; keys: TalkKeys }> {
  const { default: list } = await import("../../tools/lib/eff-short-wordlist.txt?raw");
  const words = list.split("\n").filter((w) => /^[a-z]{3,}$/.test(w));
  const pick = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const code = words[pick % words.length] ?? "lectern";
  return { code, keys: await deriveKeys(code) };
}

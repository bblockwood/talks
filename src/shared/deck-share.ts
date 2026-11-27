// Slides that were never published (Ben, 2026-11-27): a talk started from a PDF on one device
// gets a code made on the spot, and a device that joins with it is sent the PDF through the
// relay, in pieces, encrypted with the key the code gives. Nothing is stored anywhere: the relay
// forwards each piece and forgets it.
import { deriveKeys } from "../core/crypto";
import type { TalkKeys } from "../core/crypto";
import { DECK_CHUNK_BYTES, MAX_MISSING, randomSid } from "../core/protocol";
import type { Envelope, Message } from "../core/protocol";
import { NetworkError, NoTalkError } from "./fetch-deck";
import { RELAY_URL, RelayClient } from "./relay-client";

/** Pieces a second: well under the relay's limit of 120 messages a second per device. */
const CHUNKS_PER_SECOND = 40;
/** How long a joining device waits for anyone to answer before deciding there is no such talk. */
const ANSWER_WAIT_MS = 4000;
const STALL_MS = 12_000;
/** With pieces still missing, this long without one and the missing ones are asked for again. */
const GAP_MS = 2000;

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

/**
 * Sends the PDF to devices that ask for it. However many ask at once, the pieces go out at one
 * steady rate, taking turns, so the relay's limit is never reached (it drops what is over it);
 * a device that missed pieces anyway asks for those again.
 */
export class DeckSender {
  private readonly bytes: Uint8Array;
  private readonly chunks: number;
  private jobs: { to: string; id: string; pending: number[] }[] = [];
  /** The transfer each device was last given. */
  private readonly ids = new Map<string, string>();
  private timer: number | undefined;

  constructor(
    private readonly send: (message: Message) => number,
    pdf: ArrayBuffer,
    private readonly title: string,
  ) {
    this.bytes = new Uint8Array(pdf);
    this.chunks = Math.ceil(this.bytes.length / DECK_CHUNK_BYTES);
  }

  /** A `deck-request` from the device `to`. */
  request(to: string, body: { readonly id?: string; readonly missing?: readonly number[] }): void {
    const running = this.jobs.find((job) => job.to === to);
    if (body.id !== undefined && body.missing) {
      if (this.ids.get(to) !== body.id) return; // not a transfer of ours
      const wanted = body.missing.filter((index) => index < this.chunks);
      if (running) running.pending.push(...wanted.filter((index) => !running.pending.includes(index)));
      else if (wanted.length > 0) this.jobs.push({ to, id: body.id, pending: wanted });
    } else {
      if (running) return; // already on its way
      const id = randomSid();
      if (this.send({ type: "deck-info", body: { for: to, id, bytes: this.bytes.length, chunks: this.chunks, title: this.title } }) === 0) return;
      this.ids.set(to, id);
      this.jobs.push({ to, id, pending: Array.from({ length: this.chunks }, (_, index) => index) });
    }
    this.timer ??= window.setInterval(() => this.step(), 1000 / CHUNKS_PER_SECOND);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.jobs = [];
  }

  /** One piece, for whichever device's turn it is. */
  private step(): void {
    const job = this.jobs.shift();
    const index = job?.pending.shift();
    if (!job || index === undefined) {
      if (this.jobs.length === 0) this.stop();
      return;
    }
    const data = toBase64(this.bytes.subarray(index * DECK_CHUNK_BYTES, (index + 1) * DECK_CHUNK_BYTES));
    // Not sent: the connection has gone. The device asks again when it is back.
    if (this.send({ type: "deck-chunk", body: { for: to(job), id: job.id, index, data } }) === 0) return;
    if (job.pending.length > 0) this.jobs.push(job);
  }
}
const to = (job: { to: string }): string => job.to;

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
    let lastPieceAt = 0;
    let asked = 0;
    /** Pieces can be lost on the way (the relay drops what is over its rate): ask for those again, a few times. */
    const askAgain = (): void => {
      if (!transfer || transfer.got >= transfer.parts.length) return;
      const missing: number[] = [];
      for (let i = 0; i < transfer.parts.length && missing.length < MAX_MISSING; i++) if (!transfer.parts[i]) missing.push(i);
      asked = performance.now();
      relay.send({ type: "deck-request", body: { id: transfer.id, missing } });
    };
    const gaps = window.setInterval(() => {
      const now = performance.now();
      if (transfer && now - lastPieceAt > GAP_MS && now - asked > GAP_MS) askAgain();
    }, 500);
    const finish = (result: ReceivedDeck | Error): void => {
      window.clearInterval(asking);
      window.clearInterval(gaps);
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
        lastPieceAt = performance.now();
        arm(STALL_MS, new NetworkError("the slides stopped arriving"));
        return;
      }
      if (envelope.type !== "deck-chunk" || !transfer || envelope.body.id !== transfer.id || envelope.body.for !== sid) return;
      const { index, data } = envelope.body;
      if (index >= transfer.parts.length || transfer.parts[index]) return;
      transfer.parts[index] = fromBase64(data);
      transfer.got += 1;
      lastPieceAt = performance.now();
      onProgress(transfer.got / transfer.parts.length);
      arm(STALL_MS, new NetworkError("the slides stopped arriving"));
      if (transfer.got < transfer.parts.length) {
        // The last piece is here but earlier ones are not: no need to wait to ask.
        if (index === transfer.parts.length - 1 && performance.now() - asked > GAP_MS) askAgain();
        return;
      }
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

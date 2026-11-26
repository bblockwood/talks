// W0 throwaway relay client. Messages are plain JSON in binary frames: no encryption yet (W3).

export type W0Message =
  | { type: "hello"; from: "room" | "phone" }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  | { type: "command"; name: "next" | "prev" }
  | { type: "state"; page: number; pageCount: number }
  | { type: "report"; text: string };

export type RelayStatus = "not configured" | "connecting" | "connected" | "reconnecting";

export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? "";

/** W0 pairing: both pages derive the room id from the 6-digit number shown on the room PC. */
export async function roomIdFromPairing(digits: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lectern-w0:${digits}`));
  return Array.from(new Uint8Array(hash).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomPairing(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(n % 1_000_000).padStart(6, "0");
}

export interface RelayHandle {
  send(msg: W0Message): boolean;
  close(): void;
}

export function connectRelay(
  roomId: string,
  onMessage: (msg: W0Message) => void,
  onStatus: (status: RelayStatus, detail: string) => void,
): RelayHandle {
  if (!RELAY_URL) {
    onStatus("not configured", "no relay URL in this build");
    return { send: () => false, close: () => {} };
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;

  const open = () => {
    onStatus(attempt === 0 ? "connecting" : "reconnecting", attempt === 0 ? "" : `attempt ${attempt + 1}`);
    const sock = new WebSocket(`${RELAY_URL}/room/${roomId}`);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      onStatus("connected", "");
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      try {
        onMessage(JSON.parse(dec.decode(ev.data)) as W0Message);
      } catch {
        // Not ours; ignore.
      }
    };
    sock.onclose = (ev: CloseEvent) => {
      if (closed || ws !== sock) return;
      ws = null;
      // Backoff 0.5 s → 10 s with jitter (SPEC §8.4).
      const delay = Math.min(10_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
      attempt += 1;
      onStatus("reconnecting", `closed (code ${ev.code}); retrying in ${(delay / 1000).toFixed(1)} s`);
      timer = window.setTimeout(open, delay);
    };
  };
  open();

  return {
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(enc.encode(JSON.stringify(msg)));
      return true;
    },
    close() {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
      ws = null;
    },
  };
}

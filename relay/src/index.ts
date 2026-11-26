// Lectern relay (SPEC §8). Forwards opaque binary frames between the sockets in a room.
// It never parses, stores or logs payloads.
import { DurableObject } from "cloudflare:workers";
import {
  IDLE_CLOSE_MS,
  MAX_FRAME_BYTES,
  MAX_SOCKETS_PER_ROOM,
  RateLimiter,
  isOriginAllowed,
  parseAllowedOrigins,
  roomIdFromPath,
} from "./limits";

const IDLE_CHECK_MS = 15 * 60 * 1000;
/** How stale a socket's recorded last-seen time may get before it is rewritten. */
const LAST_SEEN_GRANULARITY_MS = 60 * 1000;

interface Attachment {
  lastSeen: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }

    const roomId = roomIdFromPath(url.pathname);
    if (roomId === null) return new Response("not found", { status: 404 });

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!isOriginAllowed(request.headers.get("Origin"), parseAllowedOrigins(env.ALLOWED_ORIGINS))) {
      return new Response("forbidden", { status: 403 });
    }

    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  // In-memory only. Hibernation clears it, which is fine: a room hibernates only when it is quiet.
  private limiters = new Map<WebSocket, RateLimiter>();

  override async fetch(_request: Request): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return new Response("room full", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ lastSeen: Date.now() } satisfies Attachment);

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_CHECK_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") return; // text frames are dropped
    if (message.byteLength > MAX_FRAME_BYTES) return;

    const now = Date.now();
    let limiter = this.limiters.get(ws);
    if (!limiter) {
      limiter = new RateLimiter();
      this.limiters.set(ws, limiter);
    }
    const verdict = limiter.check(now);
    if (verdict === "close") {
      console.warn("rate limit: closing socket");
      this.limiters.delete(ws);
      ws.close(1008, "rate limit");
      return;
    }
    if (verdict === "drop") return;

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || now - attachment.lastSeen > LAST_SEEN_GRANULARITY_MS) {
      ws.serializeAttachment({ lastSeen: now } satisfies Attachment);
    }

    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.send(message);
      } catch {
        // The peer is closing; its close handler cleans up.
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.limiters.delete(ws);
    try {
      // 1005/1006 are reserved and can't be sent back.
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.limiters.delete(ws);
    console.error("socket error");
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let open = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment && now - attachment.lastSeen > IDLE_CLOSE_MS) {
        this.limiters.delete(ws);
        ws.close(1001, "idle");
      } else {
        open += 1;
      }
    }
    if (open > 0) await this.ctx.storage.setAlarm(now + IDLE_CHECK_MS);
  }
}

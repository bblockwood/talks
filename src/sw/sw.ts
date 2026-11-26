// Service worker (SPEC §9): keeps the app shell and PDF.js available so a reload works on bad
// Wi-Fi, and keeps encrypted deck files so a deck opened once on this device opens again offline.
// It only ever sees what the server serves: ciphertext. Decryption happens in the page, in
// memory, and nothing decrypted is ever handed to this worker or to any cache.
import { classify, staleBins, withoutQuery } from "../core/sw-routes";

// Filled in at build time (vite.config.ts).
const VERSION = "__SW_VERSION__";
const PRECACHE: string[] = JSON.parse('__SW_PRECACHE__') as string[];

const SHELL = `lectern-shell-${VERSION}`;
const DECKS = "lectern-decks-v1";
const PAGE_TIMEOUT_MS = 4000;
// These are static files: whatever `Vary` header the server sends (e.g. Origin, which differs
// between the install-time fetch and a page's script request) must not cause a cache miss.
const ANY_VARIANT: CacheQueryOptions = { ignoreVary: true };

// The DOM typings don't describe a service worker's globals; these are the few used here.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly registration: { readonly scope: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (ev: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (ev: FetchEvent) => void): void;
}
const sw = self as unknown as WorkerScope;
const scope = sw.registration.scope; // e.g. https://benlockwood.com/talks/
const base = new URL(scope).pathname;

sw.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(scope + path, { cache: "reload" }))))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("lectern-shell-") && n !== SHELL).map((n) => caches.delete(n))))
      .then(() => sw.clients.claim()),
  );
});

async function cacheFirst(cacheName: string, request: Request): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, ANY_VARIANT);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function page(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PAGE_TIMEOUT_MS)),
    ]);
    if (response.ok) await cache.put(withoutQuery(request.url), response.clone());
    return response;
  } catch (e) {
    const key = withoutQuery(request.url);
    const hit = (await cache.match(key, ANY_VARIANT)) ?? (await cache.match(key.replace(/\/?$/, "/"), ANY_VARIANT));
    if (hit) return hit;
    throw e;
  }
}

/** `current.json` says which file is the deck. Fresh whenever the network answers; the last known copy otherwise. */
async function current(request: Request, deckDir: string): Promise<Response> {
  const cache = await caches.open(DECKS);
  const key = withoutQuery(request.url);
  let response: Response;
  try {
    response = await fetch(request);
  } catch (e) {
    const hit = await cache.match(key, ANY_VARIANT);
    if (hit) return hit;
    throw e;
  }
  if (response.ok) {
    await cache.put(key, response.clone());
    try {
      const file = ((await response.clone().json()) as { file?: unknown }).file;
      if (typeof file === "string") {
        const urls = (await cache.keys()).map((r) => r.url);
        await Promise.all(staleBins(urls, scope + deckDir, file).map((url) => cache.delete(url)));
      }
    } catch {
      // Not JSON: the page will report it.
    }
  } else if (response.status === 404) {
    // The deck was revoked: forget it here too.
    const dir = scope + deckDir;
    for (const r of await cache.keys()) if (r.url.startsWith(dir)) await cache.delete(r);
  }
  return response;
}

sw.addEventListener("fetch", (ev) => {
  const { request } = ev;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== new URL(scope).origin) return;
  const route = classify(url.pathname, base);
  if (route.kind === "page") ev.respondWith(page(request));
  else if (route.kind === "asset") ev.respondWith(cacheFirst(SHELL, request));
  else if (route.kind === "bin") ev.respondWith(cacheFirst(DECKS, request));
  else if (route.kind === "current") ev.respondWith(current(request, route.deckDir ?? ""));
});

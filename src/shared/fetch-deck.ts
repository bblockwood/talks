// Fetches and decrypts a published deck by talk code (SPEC §4–5.1). Everything stays in memory.
import { normalizeCode } from "../core/code";
import { DeckDecryptError, decryptDeck, deriveKeys } from "../core/crypto";
import type { TalkKeys } from "../core/crypto";
import { PayloadError, unpackPayload } from "../core/payload";
import type { DeckPayload } from "../core/payload";

/** No deck at that code's path, or it would not decrypt. The user sees "No talk found for that code". */
export class NoTalkError extends Error {
  override name = "NoTalkError";
  /** The keys the code gives, when it got that far: the talk may still exist on another device. */
  keys: TalkKeys | null = null;
}

/** The site could not be reached, or answered with something other than the deck. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

export interface FetchedDeck {
  readonly keys: TalkKeys;
  readonly payload: DeckPayload;
}

const BIN_NAME = /^[0-9a-f]{16}\.bin$/;

async function get(url: string, noStore: boolean): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, noStore ? { cache: "no-store" } : {});
  } catch {
    throw new NetworkError("request failed");
  }
  if (response.status === 404) throw new NoTalkError("not found");
  if (!response.ok) throw new NetworkError(`HTTP ${response.status}`);
  return response;
}

/**
 * `baseUrl` ends with a slash (the app's base path). `onProgress` reports the two slow steps:
 * key derivation ("unlocking") and the download ("loading").
 */
export async function fetchDeck(
  code: string,
  baseUrl: string,
  onProgress: (step: "unlocking" | "loading") => void = () => {},
): Promise<FetchedDeck> {
  const normalized = normalizeCode(code);
  if (normalized === "") throw new NoTalkError("empty code");

  onProgress("unlocking");
  const keys = await deriveKeys(normalized);

  onProgress("loading");
  const dir = `${baseUrl}d/${keys.deckId}/`;
  // Pages caches for ten minutes; a republished deck must still be picked up at once (SPEC §4.5).
  const currentResponse = await get(`${dir}current.json?t=${Date.now()}`, true).catch((e: unknown) => {
    if (e instanceof NoTalkError) e.keys = keys; // nothing published under this code
    throw e;
  });
  let file: unknown;
  try {
    file = ((await currentResponse.json()) as { file?: unknown }).file;
  } catch {
    throw new NetworkError("current.json is not JSON");
  }
  if (typeof file !== "string" || !BIN_NAME.test(file)) throw new NetworkError("current.json names no deck file");

  // Content-hashed name, so the normal HTTP cache is safe here.
  const binResponse = await get(`${dir}${file}`, false);
  let bin: Uint8Array;
  try {
    bin = new Uint8Array(await binResponse.arrayBuffer());
  } catch {
    throw new NetworkError("download interrupted");
  }

  try {
    return { keys, payload: unpackPayload(await decryptDeck(keys.deckKey, bin)) };
  } catch (e) {
    if (e instanceof DeckDecryptError || e instanceof PayloadError) throw new NoTalkError(e.message);
    throw e;
  }
}

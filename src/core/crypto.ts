// Cryptography and identifiers (SPEC §3) and the encrypted deck format (SPEC §4.2).
// WebCrypto only, so this exact code runs in the browser and, for the publish tool, in Node.
// It has no imports, and must pass fixtures/crypto-vectors.json in both.

export const PBKDF2_SALT = "lectern-web-v1";
export const PBKDF2_ITERATIONS = 600_000;

const MAGIC = [0x4c, 0x43, 0x54, 0x57] as const; // "LCTW"
const VERSION = 0x01;
const IV_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES;
const GCM_TAG_BYTES = 16;

type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = (text: string): Bytes => new TextEncoder().encode(text);

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Everything derived from a talk code, as raw bytes. Only tests and the key import below need these. */
export interface RawTalkKeys {
  readonly deckId: Bytes; // 16 bytes
  readonly deckKey: Bytes; // 32 bytes
  readonly roomId: Bytes; // 16 bytes
  readonly channelKey: Bytes; // 32 bytes
}

export interface TalkKeys {
  /** 32 hex characters: the public path `d/<deckId>/`. */
  readonly deckId: string;
  /** Decrypts the deck payload. */
  readonly deckKey: CryptoKey;
  /** 32 hex characters: the relay room name. */
  readonly roomId: string;
  /** Encrypts relay messages end to end. */
  readonly channelKey: CryptoKey;
}

/**
 * `code` must already be normalised (see code.ts). The PBKDF2 step is deliberately slow (about a
 * second); run it once per device per session. Ids come out of the same slow derivation, so a
 * public deck id can't be cheaply turned back into a code.
 */
export async function deriveRawKeys(code: string): Promise<RawTalkKeys> {
  const subtle = crypto.subtle;
  const password = await subtle.importKey("raw", utf8(code), "PBKDF2", false, ["deriveBits"]);
  const base = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: utf8(PBKDF2_SALT), iterations: PBKDF2_ITERATIONS },
    password,
    256,
  );
  const hkdf = await subtle.importKey("raw", base, "HKDF", false, ["deriveBits"]);
  const expand = async (info: string, bytes: number): Promise<Bytes> =>
    new Uint8Array(
      await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) }, hkdf, bytes * 8),
    );
  return {
    deckId: await expand("deck-id", 16),
    deckKey: await expand("deck-key", 32),
    roomId: await expand("room-id", 16),
    channelKey: await expand("channel-key", 32),
  };
}

const aesKey = (raw: Bytes): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function deriveKeys(code: string): Promise<TalkKeys> {
  const raw = await deriveRawKeys(code);
  return {
    deckId: toHex(raw.deckId),
    deckKey: await aesKey(raw.deckKey),
    roomId: toHex(raw.roomId),
    channelKey: await aesKey(raw.channelKey),
  };
}

/** The file is not a Lectern deck, or the key is wrong, or the file was altered. */
export class DeckDecryptError extends Error {
  override name = "DeckDecryptError";
}

/**
 * Encrypts a payload into the `.bin` format: "LCTW", version 1, a 12-byte iv, then
 * AES-256-GCM ciphertext with the tag appended. `iv` is random per publish; pass one only in tests.
 */
export async function encryptDeck(key: CryptoKey, payload: Uint8Array, iv?: Uint8Array): Promise<Bytes> {
  const nonce = new Uint8Array(IV_BYTES);
  if (iv) {
    if (iv.length !== IV_BYTES) throw new Error(`iv must be ${IV_BYTES} bytes`);
    nonce.set(iv);
  } else {
    crypto.getRandomValues(nonce);
  }
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new Uint8Array(payload)),
  );
  const out = new Uint8Array(HEADER_BYTES + ciphertext.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(nonce, MAGIC.length + 1);
  out.set(ciphertext, HEADER_BYTES);
  return out;
}

export async function decryptDeck(key: CryptoKey, file: Uint8Array): Promise<Bytes> {
  if (file.length < HEADER_BYTES + GCM_TAG_BYTES) throw new DeckDecryptError("file too short");
  for (let i = 0; i < MAGIC.length; i++) {
    if (file[i] !== MAGIC[i]) throw new DeckDecryptError("not a Lectern deck");
  }
  if (file[MAGIC.length] !== VERSION) throw new DeckDecryptError("unsupported deck version");
  const iv = new Uint8Array(file.subarray(MAGIC.length + 1, HEADER_BYTES));
  const ciphertext = new Uint8Array(file.subarray(HEADER_BYTES));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
  } catch {
    throw new DeckDecryptError("wrong key or damaged file");
  }
}

/** First 16 hex characters of SHA-256: the content-hashed `.bin` file name (SPEC §4.1). */
export async function contentHash16(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

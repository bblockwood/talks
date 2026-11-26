// npm run codes: lists published decks and their talk codes, from ~/.config/lectern/codes.json.
import { SITE_URL } from "./lib/config.ts";
import { loadStore, storePath } from "./lib/store.ts";

const decks = Object.entries(loadStore().decks);
if (decks.length === 0) {
  console.error(`No decks published yet (${storePath()}).`);
} else {
  const width = Math.max(4, ...decks.map(([, d]) => d.code.length));
  console.log(`${"Code".padEnd(width)}  Published         Deck`);
  for (const [key, deck] of decks.sort((a, b) => b[1].published.localeCompare(a[1].published))) {
    const when = deck.published.slice(0, 16).replace("T", " ");
    console.log(`${deck.code.padEnd(width)}  ${when}  ${key}${key === deck.source ? "" : `  (${deck.source})`}`);
  }
  console.error(`\nOpen ${SITE_URL} and type a code.`);
}

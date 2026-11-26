// npm run revoke -- <name|file.pdf>: removes a deck from the site and forgets its code.
import { deriveKeys } from "../src/core/crypto.ts";
import { triggerDeploy, updateDecksBranch } from "./lib/branch.ts";
import { findDeck, loadStore, saveStore } from "./lib/store.ts";

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || process.argv.length !== 3) {
    console.error("Usage: npm run revoke -- <name|file.pdf>     (npm run codes lists them)");
    process.exit(1);
  }
  const store = loadStore();
  const key = findDeck(store, target);
  const deck = key === null ? undefined : store.decks[key];
  if (key === null || !deck) {
    console.error(`revoke: no published deck matches “${target}”. Run: npm run codes`);
    process.exit(1);
  }
  updateDecksBranch({ remove: [(await deriveKeys(deck.code)).deckId] });
  delete store.decks[key];
  saveStore(store);
  triggerDeploy();
  console.error(`Revoked ${key}. It disappears from the site in about a minute.`);
}

main().catch((e: unknown) => {
  console.error(`revoke: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

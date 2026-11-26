import os from "node:os";
import path from "node:path";

/** Where the site is served. The room PC opens this; the publish tool polls it with --wait. */
export const SITE_URL = "https://benlockwood.com/talks";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Codes live only here, outside the repo (SPEC §4.4). LECTERN_CONFIG_DIR overrides it for tests. */
export function configDir(): string {
  return process.env["LECTERN_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "lectern");
}

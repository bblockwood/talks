// W0 only: verifies SPEC §4.5. Publishes a fresh d/w0cachetest/current.json the way the real
// publish tool will (single-commit orphan `decks` branch, force-push, workflow_dispatch), then
// times how long the new file takes to appear, with and without the ?t= cache-buster.
//
//   node tools/w0-cachetest.mjs [site-url]
//
// It REPLACES the `decks` branch, so it must not be run once real decks are published.
import { execFileSync } from "node:child_process";

const site = (process.argv[2] ?? "https://benlockwood.com/talks").replace(/\/$/, "");
const run = (cmd, args, input) =>
  execFileSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }).trim();

const existing = run("git", ["ls-remote", "--heads", "origin", "decks"]);
if (existing) {
  const sha = existing.split(/\s+/)[0];
  run("git", ["fetch", "--quiet", "origin", "decks"]);
  const files = run("git", ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
  if (files.some((f) => !f.startsWith("d/w0cachetest/"))) {
    console.error("The decks branch holds real decks. Refusing to overwrite it.");
    process.exit(1);
  }
}

const nonce = String(Date.now());
const blob = run("git", ["hash-object", "-w", "--stdin"], JSON.stringify({ v: 1, w0cachetest: nonce }) + "\n");
const t1 = run("git", ["mktree"], `100644 blob ${blob}\tcurrent.json\n`);
const t2 = run("git", ["mktree"], `040000 tree ${t1}\tw0cachetest\n`);
const t3 = run("git", ["mktree"], `040000 tree ${t2}\td\n`);
const commit = run("git", ["commit-tree", t3, "-m", "W0 cache test"]);
run("git", ["push", "--quiet", "--force", "origin", `${commit}:refs/heads/decks`]);
run("gh", ["workflow", "run", "deploy.yml", "--ref", "main"]);
const start = Date.now();
console.log(`Pushed nonce ${nonce} and triggered the deploy. Polling ${site}/d/w0cachetest/current.json …`);

const url = `${site}/d/w0cachetest/current.json`;
const seen = { busted: null, plain: null };
const probe = async (u) => {
  try {
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return `HTTP ${r.status}`;
    const body = await r.json();
    return body.w0cachetest === nonce ? "new" : "old";
  } catch (e) {
    return `error ${e.message}`;
  }
};

while (Date.now() - start < 25 * 60 * 1000 && !(seen.busted && seen.plain)) {
  const secs = Math.round((Date.now() - start) / 1000);
  const [busted, plain] = await Promise.all([probe(`${url}?t=${Date.now()}`), seen.plain ? "new" : probe(url)]);
  if (busted === "new" && !seen.busted) seen.busted = secs;
  if (plain === "new" && !seen.plain) seen.plain = secs;
  console.log(`${String(secs).padStart(5)} s   with ?t=: ${busted.padEnd(10)} without: ${plain}`);
  await new Promise((r) => setTimeout(r, 5000));
}

console.log(`\nNew file visible with ?t= after ${seen.busted ?? "more than 1500"} s (includes the workflow run).`);
console.log(`New file visible without ?t= after ${seen.plain ?? "more than 1500"} s.`);

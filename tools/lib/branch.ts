// The orphan `decks` branch (SPEC §4.3). Every change rewrites it as a single commit and
// force-pushes, so encrypted PDFs never pile up in history. Done with git plumbing and a
// temporary index, so the working tree and the current branch are never touched.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./config.ts";

const BRANCH = "refs/heads/decks";

/**
 * Which files of one deck directory to delete when `newFile` is published: everything except
 * `current.json`, the new `.bin`, and the `.bin` that was current until now (kept for rollback).
 */
export function filesToPrune(existing: readonly string[], previousFile: string | null, newFile: string): string[] {
  const keep = new Set(["current.json", newFile]);
  if (previousFile !== null) keep.add(previousFile);
  return existing.filter((f) => !keep.has(f));
}

export interface DeckChange {
  /** Deck directories to delete entirely (revoke, or the old id after a code rotation). */
  remove?: string[];
  /** A deck to add or update. */
  put?: { deckId: string; fileName: string; bin: Uint8Array; currentJson: string };
}

export interface Git {
  (args: string[], input?: Uint8Array | string): string;
}

export function gitIn(cwd: string, extraEnv: Record<string, string> = {}): Git {
  return (args, input) =>
    execFileSync("git", args, {
      cwd,
      input,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
}

/** Applies a change to the decks branch on `remote` and force-pushes it. Returns the new commit. */
export function updateDecksBranch(change: DeckChange, repo: string = REPO_ROOT, remote = "origin"): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lectern-index-"));
  try {
    const git = gitIn(repo, { GIT_INDEX_FILE: path.join(tmp, "index") });

    const listed = git(["ls-remote", remote, BRANCH]);
    const remoteSha = listed === "" ? null : (listed.split(/\s+/)[0] ?? null);
    if (remoteSha) {
      git(["fetch", "--quiet", "--no-tags", remote, BRANCH]);
      git(["read-tree", `${remoteSha}^{tree}`]);
    } else {
      git(["read-tree", "--empty"]);
    }

    const filesIn = (dir: string): string[] =>
      git(["ls-files", "--", `${dir}/`])
        .split("\n")
        .filter((f) => f !== "");
    const removePaths = (paths: string[]): void => {
      if (paths.length > 0) git(["update-index", "--force-remove", "--", ...paths]);
    };

    for (const deckId of change.remove ?? []) removePaths(filesIn(`d/${deckId}`));

    if (change.put) {
      const { deckId, fileName, bin, currentJson } = change.put;
      const dir = `d/${deckId}`;
      let previousFile: string | null = null;
      if (remoteSha) {
        try {
          const current = JSON.parse(git(["cat-file", "-p", `${remoteSha}:${dir}/current.json`])) as { file?: unknown };
          if (typeof current.file === "string") previousFile = current.file;
        } catch {
          // First publish of this deck.
        }
      }
      const existing = filesIn(dir).map((f) => f.slice(dir.length + 1));
      removePaths(filesToPrune(existing, previousFile, fileName).map((f) => `${dir}/${f}`));
      const add = (name: string, content: Uint8Array | string): void => {
        const blob = git(["hash-object", "-w", "--stdin"], content);
        git(["update-index", "--add", "--cacheinfo", `100644,${blob},${dir}/${name}`]);
      };
      add(fileName, bin);
      add("current.json", currentJson);
    }

    const tree = git(["write-tree"]);
    // No parent: the branch is always exactly one commit. The message says nothing about the decks.
    const commit = git(["commit-tree", tree, "-m", "Decks"]);
    git(["push", "--quiet", `--force-with-lease=${BRANCH}:${remoteSha ?? ""}`, remote, `${commit}:${BRANCH}`]);
    return commit;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A push to `decks` can't trigger the workflow (the workflow file isn't on that branch), so ask for a run. */
export function triggerDeploy(repo: string = REPO_ROOT): void {
  execFileSync("gh", ["workflow", "run", "deploy.yml", "--ref", "main"], { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
}

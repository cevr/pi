/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * sync git mention helpers for autocomplete and other non-Effect entry points.
 *
 * the reusable parsing + service layer lives in commit-index.ts. this shim exists
 * only because mention autocomplete is synchronous today.
 */

import { execFileSync } from "node:child_process";
import { createCache, getOrSet } from "./cache";
import { createCommitIndex, parseCommitLog, type CommitIndex } from "./commit-index";

const commitIndexCache = createCache<string, CommitIndex>();

export function clearCommitIndexCache(): void {
  commitIndexCache.clear();
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveGitRoot(cwd: string): string | null {
  try {
    return runGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

export function getCommitIndex(cwd: string): CommitIndex | null {
  const root = resolveGitRoot(cwd);
  if (!root) return null;

  return getOrSet(commitIndexCache, root, () =>
    createCommitIndex(
      root,
      parseCommitLog(runGit(root, ["log", "--all", "--format=%H%x09%cI%x09%s"])),
    ),
  );
}

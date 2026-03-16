/**
 * Git helpers for the audit extension.
 *
 * Uses GitClient Effect service via ManagedRuntime (same pattern as editor extension).
 */

import { GitClient } from "@cvr/pi-git-client";
import { Effect, type ManagedRuntime } from "effect";

type GitRuntime = ManagedRuntime.ManagedRuntime<GitClient, never>;

/**
 * Resolve the base branch to diff against.
 * Tries: origin/HEAD → origin/main → origin/master → HEAD~20
 */
export async function resolveBaseBranch(cwd: string, runtime: GitRuntime): Promise<string> {
  // Try origin/HEAD (set by `git remote set-head origin --auto`)
  try {
    const ref = await runtime.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.exec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
      }),
    );
    const trimmed = ref.trim();
    // "refs/remotes/origin/main" → "origin/main"
    if (trimmed.startsWith("refs/remotes/")) return trimmed.slice("refs/remotes/".length);
  } catch {
    /* not set */
  }

  // Try origin/main
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.exec(["rev-parse", "--verify", "origin/main"], cwd);
      }),
    );
    return "origin/main";
  } catch {
    /* doesn't exist */
  }

  // Try origin/master
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.exec(["rev-parse", "--verify", "origin/master"], cwd);
      }),
    );
    return "origin/master";
  } catch {
    /* doesn't exist */
  }

  return "HEAD~20";
}

/** Run `git diff --stat {base}...HEAD` */
export async function getDiffStat(cwd: string, base: string, runtime: GitRuntime): Promise<string> {
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.exec(["diff", "--stat", `${base}...HEAD`], cwd);
      }),
    );
  } catch {
    return "";
  }
}

/** Run `git diff --name-only {base}...HEAD` */
export async function getChangedFiles(
  cwd: string,
  base: string,
  runtime: GitRuntime,
): Promise<string[]> {
  try {
    const out = await runtime.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.exec(["diff", "--name-only", `${base}...HEAD`], cwd);
      }),
    );
    return out
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

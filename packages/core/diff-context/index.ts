/**
 * diff-context — shared diff + skill catalog gathering for audit and plan-mode.
 *
 * Git helpers use GitClient Effect service via ManagedRuntime.
 * Skill catalog uses the shared pi skill discovery helper.
 */

import { GitClient } from "@cvr/pi-git-client";
import { getDiscoveredSkills } from "@cvr/pi-skill-paths";
import { Effect, type ManagedRuntime } from "effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitRuntime = ManagedRuntime.ManagedRuntime<GitClient, never>;

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

export interface DiffContext {
  baseBranch: string;
  diffStat: string;
  changedFiles: string[];
  skillCatalog: SkillCatalogEntry[];
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the base branch to diff against.
 * Tries: origin/HEAD → origin/main → origin/master → HEAD~20
 */
export async function resolveBaseBranch(cwd: string, runtime: GitRuntime): Promise<string> {
  try {
    const ref = await runtime.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.exec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
      }),
    );
    const trimmed = ref.trim();
    if (trimmed.startsWith("refs/remotes/")) return trimmed.slice("refs/remotes/".length);
  } catch {
    /* not set */
  }

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

// ---------------------------------------------------------------------------
// Skill catalog
// ---------------------------------------------------------------------------

export function buildSkillCatalog(cwd: string): SkillCatalogEntry[] {
  return getDiscoveredSkills(cwd)
    .filter((skill) => skill.description.length > 0)
    .map((skill) => ({ name: skill.token, description: skill.description }));
}

/**
 * Gather full diff context: base branch, diff stat, changed files, and skill catalog.
 * Convenience wrapper that combines all the above.
 */
export async function gatherDiffContext(cwd: string, runtime: GitRuntime): Promise<DiffContext> {
  const baseBranch = await resolveBaseBranch(cwd, runtime);
  const diffStat = await getDiffStat(cwd, baseBranch, runtime);
  const changedFiles = await getChangedFiles(cwd, baseBranch, runtime);
  const skillCatalog = buildSkillCatalog(cwd);
  return { baseBranch, diffStat, changedFiles, skillCatalog };
}

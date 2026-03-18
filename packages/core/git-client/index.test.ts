/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { describe, expect, it, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { GitClient } from "./index";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const repos: string[] = [];

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-client-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  repos.push(dir);
  return dir;
}

function commitFile(repo: string, name: string, message: string): string {
  writeFileSync(join(repo, name), name);
  execFileSync("git", ["add", name], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

const liveLayer = GitClient.layer.pipe(Layer.provide(ProcessRunner.layer));

const runWithGit = <A, E>(effect: Effect.Effect<A, E, GitClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, liveLayer));

// ---------------------------------------------------------------------------
// real git tests
// ---------------------------------------------------------------------------

describe("GitClient (real)", () => {
  it("detects a git repo", async () => {
    const repo = createRepo();
    const result = await runWithGit(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.isRepo(repo);
      }),
    );
    expect(result).toBe(true);
  });

  it("detects non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "not-git-"));
    repos.push(dir);
    const result = await runWithGit(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.isRepo(dir);
      }),
    );
    expect(result).toBe(false);
  });

  it("returns head sha", async () => {
    const repo = createRepo();
    const sha = commitFile(repo, "a.txt", "first");
    const result = await runWithGit(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.headSha(repo);
      }),
    );
    expect(result).toBe(sha);
  });

  it("reads git log", async () => {
    const repo = createRepo();
    commitFile(repo, "a.txt", "first commit");
    commitFile(repo, "b.txt", "second commit");

    const result = await runWithGit(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.log(repo);
      }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.subject).toBe("second commit");
    expect(result[1]!.subject).toBe("first commit");
    expect(result[0]!.sha).toHaveLength(40);
    expect(result[0]!.shortSha).toHaveLength(12);
  });

  it("returns None for remoteUrl when no remote", async () => {
    const repo = createRepo();
    commitFile(repo, "a.txt", "first");
    const result = await runWithGit(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.remoteUrl(repo);
      }),
    );
    expect(Option.isNone(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// layerTest tests
// ---------------------------------------------------------------------------

describe("GitClient (layerTest)", () => {
  it("returns canned log entries", async () => {
    const entries = [
      {
        sha: "abc",
        shortSha: "abc",
        subject: "test",
        committedAt: "2026-01-01",
      },
    ];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.log("/repo");
      }).pipe(Effect.provide(GitClient.layerTest({ log: entries }))),
    );

    expect(result).toEqual(entries);
  });

  it("returns canned isRepo", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitClient;
        return yield* git.isRepo("/fake");
      }).pipe(Effect.provide(GitClient.layerTest({ isRepo: false }))),
    );

    expect(result).toBe(false);
  });
});

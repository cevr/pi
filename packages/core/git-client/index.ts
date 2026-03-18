/**
 * git client service — typed wrapper around git CLI operations.
 *
 * uses ProcessRunner internally. provides the git operations that
 * pi extensions commonly need: log, diff, status, remote, rev-parse.
 */

import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { ProcessRunner } from "@cvr/pi-process-runner";

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  command: Schema.String,
  message: Schema.String,
  stderr: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class GitClient extends ServiceMap.Service<
  GitClient,
  {
    /** run arbitrary git command, return stdout */
    readonly exec: (args: string[], cwd: string) => Effect.Effect<string, GitError>;

    /** git log with format: sha, date, subject */
    readonly log: (
      cwd: string,
      opts?: { maxCount?: number; all?: boolean },
    ) => Effect.Effect<GitLogEntry[], GitError>;

    /** git rev-parse --show-toplevel */
    readonly root: (cwd: string) => Effect.Effect<Option.Option<string>, GitError>;

    /** git diff --stat */
    readonly diffStat: (
      cwd: string,
      opts?: { timeoutMs?: number },
    ) => Effect.Effect<string, GitError>;

    /** git remote get-url origin */
    readonly remoteUrl: (cwd: string) => Effect.Effect<Option.Option<string>, GitError>;

    /** git rev-parse HEAD */
    readonly headSha: (cwd: string) => Effect.Effect<string, GitError>;

    /** check if cwd is inside a git repo */
    readonly isRepo: (cwd: string) => Effect.Effect<boolean>;
  }
>()("@cvr/pi-git-client/index/GitClient") {
  static layer = Layer.effect(
    GitClient,
    Effect.gen(function* () {
      const runner = yield* ProcessRunner;

      const git = (args: string[], cwd: string, opts?: { timeoutMs?: number }) =>
        runner.run("git", { args, cwd, timeoutMs: opts?.timeoutMs }).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode !== 0) {
              return Effect.fail(
                new GitError({
                  command: `git ${args.join(" ")}`,
                  message: `exit code ${result.exitCode}`,
                  stderr: result.stderr,
                }),
              );
            }
            return Effect.succeed(result.stdout);
          }),
          Effect.catchTags({
            GitError: (err) => Effect.fail(err),
            CommandError: (err) =>
              Effect.fail(
                new GitError({
                  command: `git ${args.join(" ")}`,
                  message: err.message,
                  stderr: err.stderr,
                }),
              ),
            CommandTimeout: (err) =>
              Effect.fail(
                new GitError({
                  command: `git ${args.join(" ")}`,
                  message: `timeout after ${err.timeoutMs}ms`,
                }),
              ),
            CommandAborted: () =>
              Effect.fail(new GitError({ command: `git ${args.join(" ")}`, message: "aborted" })),
          }),
        );

      return {
        exec: git,

        log: (cwd: string, opts?: { maxCount?: number; all?: boolean }) => {
          const args = ["log"];
          if (opts?.all) args.push("--all");
          if (opts?.maxCount !== undefined) args.push(`--max-count=${opts.maxCount}`);
          args.push("--format=%H\t%aI\t%s");

          return git(args, cwd).pipe(
            Effect.map((stdout) =>
              stdout
                .trim()
                .split("\n")
                .filter((l) => l.includes("\t"))
                .map((line) => {
                  const [sha = "", committedAt = "", subject = ""] = line.split("\t");
                  return { sha, shortSha: sha.slice(0, 12), subject, committedAt };
                }),
            ),
          );
        },

        root: (cwd: string) =>
          git(["rev-parse", "--show-toplevel"], cwd).pipe(
            Effect.map((s) => Option.some(s.trim())),
            Effect.catch(() => Effect.succeed(Option.none())),
          ),

        diffStat: (cwd: string, opts?: { timeoutMs?: number }) =>
          git(["diff", "--stat"], cwd, opts),

        remoteUrl: (cwd: string) =>
          git(["remote", "get-url", "origin"], cwd).pipe(
            Effect.map((s) => Option.some(s.trim())),
            Effect.catch(() => Effect.succeed(Option.none())),
          ),

        headSha: (cwd: string) => git(["rev-parse", "HEAD"], cwd).pipe(Effect.map((s) => s.trim())),

        isRepo: (cwd: string) =>
          runner
            .run("git", {
              args: ["rev-parse", "--is-inside-work-tree"],
              cwd,
            })
            .pipe(
              Effect.map((r) => r.exitCode === 0),
              Effect.catch(() => Effect.succeed(false)),
            ),
      };
    }),
  );

  /**
   * test layer — canned responses, no real git.
   */
  static layerTest = (responses?: {
    log?: GitLogEntry[];
    root?: string;
    diffStat?: string;
    remoteUrl?: string;
    headSha?: string;
    isRepo?: boolean;
  }) =>
    Layer.succeed(GitClient, {
      exec: (_args: string[], _cwd: string) => Effect.succeed(""),

      log: () => Effect.succeed(responses?.log ?? []),

      root: () => Effect.succeed(responses?.root ? Option.some(responses.root) : Option.none()),

      diffStat: () => Effect.succeed(responses?.diffStat ?? ""),

      remoteUrl: () =>
        Effect.succeed(responses?.remoteUrl ? Option.some(responses.remoteUrl) : Option.none()),

      headSha: () => Effect.succeed(responses?.headSha ?? "abc1234"),

      isRepo: () => Effect.succeed(responses?.isRepo ?? true),
    });
}

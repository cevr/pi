/**
 * process execution service — thin Effect wrapper around child_process.
 *
 * standardizes process lifecycle: spawn, collect output, handle timeout,
 * SIGTERM → SIGKILL escalation, AbortSignal bridging.
 *
 * domain APIs (GitClient, PiSpawn) sit on top. this service owns the
 * shared spawn patterns and provides a test seam.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Cause, Effect, Layer, Queue, Ref, Schema, ServiceMap, Stream } from "effect";

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class CommandError extends Schema.TaggedErrorClass<CommandError>()("CommandError", {
  command: Schema.String,
  message: Schema.String,
  stderr: Schema.optional(Schema.String),
}) {}

export class CommandTimeout extends Schema.TaggedErrorClass<CommandTimeout>()("CommandTimeout", {
  command: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class CommandAborted extends Schema.TaggedErrorClass<CommandAborted>()("CommandAborted", {
  command: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface RunOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
  result: ProcessResult;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/** Kill a child process and its entire process group. SIGTERM then SIGKILL after 3s. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    // kill the process group (negative pid) — catches grandchildren from sh -c
    process.kill(-pid, signal);
  } catch {
    // group kill failed (already dead, or not a group leader) — try direct
    try {
      child.kill(signal);
    } catch {
      // already dead
    }
  }
}

/** SIGTERM the tree, then SIGKILL after 3s. Returns cleanup fn for the escalation timer. */
export function killTreeWithEscalation(child: ChildProcess): () => void {
  killTree(child, "SIGTERM");
  const escalation = setTimeout(() => killTree(child, "SIGKILL"), 3000);
  escalation.unref();
  return () => clearTimeout(escalation);
}

// ---------------------------------------------------------------------------
// internal spawn helper
// ---------------------------------------------------------------------------

function spawnCollect(command: string, opts?: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const args = opts?.args ?? [];
    const spawnOpts: SpawnOptions = {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group for tree kill
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, spawnOpts);
    } catch (err) {
      reject(
        new CommandError({
          command,
          message: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let escalationCleanup: (() => void) | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (opts?.stdin) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    // timeout: SIGTERM then SIGKILL (tree kill)
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        escalationCleanup = killTreeWithEscalation(child);
      }, opts.timeoutMs);
    }

    // AbortSignal bridging
    const onAbort = () => {
      aborted = true;
      escalationCleanup = killTreeWithEscalation(child);
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      cleanup();
      reject(
        new CommandError({
          command,
          message: err.message,
          stderr,
        }),
      );
    });

    child.on("close", (code) => {
      cleanup();
      if (aborted) {
        reject(new CommandAborted({ command }));
        return;
      }
      if (timedOut) {
        reject(
          new CommandTimeout({
            command,
            timeoutMs: opts?.timeoutMs ?? 0,
          }),
        );
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    function cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      escalationCleanup?.();
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Type guard for tagged error classes from spawnCollect rejections. */
function isCommandError(err: unknown): err is CommandError | CommandTimeout | CommandAborted {
  if (err == null || typeof err !== "object" || !("_tag" in err)) return false;
  const tag = (err as { _tag: string })._tag;
  return tag === "CommandError" || tag === "CommandTimeout" || tag === "CommandAborted";
}

/** Maps unknown promise rejection to typed command error. */
function toCommandError(
  command: string,
  err: unknown,
): CommandError | CommandTimeout | CommandAborted {
  if (isCommandError(err)) return err;
  return new CommandError({
    command,
    message: err instanceof Error ? err.message : String(err),
  });
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class ProcessRunner extends ServiceMap.Service<
  ProcessRunner,
  {
    readonly run: (
      command: string,
      opts?: RunOptions,
    ) => Effect.Effect<ProcessResult, CommandError | CommandTimeout | CommandAborted>;

    readonly runStream: (
      command: string,
      opts?: RunOptions,
    ) => Stream.Stream<string, CommandError | CommandTimeout | CommandAborted>;
  }
>()("@cvr/pi-process-runner/index/ProcessRunner") {
  static layer = Layer.succeed(ProcessRunner, {
    run: (command: string, opts?: RunOptions) =>
      Effect.tryPromise({
        try: (signal) => {
          // bridge Effect interruption to AbortSignal
          const combinedController = new AbortController();
          signal.addEventListener("abort", () => combinedController.abort(), {
            once: true,
          });
          opts?.signal?.addEventListener("abort", () => combinedController.abort(), { once: true });
          return spawnCollect(command, {
            ...opts,
            signal: combinedController.signal,
          });
        },
        catch: (err) => toCommandError(command, err),
      }),

    runStream: (command: string, opts?: RunOptions) =>
      Stream.callback<string, CommandError | CommandTimeout | CommandAborted>((queue) =>
        Effect.gen(function* () {
          const args = opts?.args ?? [];
          const spawnOpts: SpawnOptions = {
            cwd: opts?.cwd,
            env: opts?.env ? { ...process.env, ...opts.env } : undefined,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true, // own process group for tree kill
          };

          const child = yield* Effect.try({
            try: () => spawn(command, args, spawnOpts),
            catch: (err) =>
              new CommandError({
                command,
                message: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
          });

          let stderr = "";
          let timedOut = false;
          let aborted = false;
          let closed = false;
          let escalationCleanup: (() => void) | undefined;

          // stream stdout chunks as they arrive
          child.stdout?.on("data", (chunk: Buffer) => {
            Queue.offerUnsafe(queue, chunk.toString());
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          if (opts?.stdin) {
            child.stdin?.write(opts.stdin);
            child.stdin?.end();
          } else {
            child.stdin?.end();
          }

          // timeout: tree kill with escalation
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          if (opts?.timeoutMs) {
            timeoutId = setTimeout(() => {
              timedOut = true;
              escalationCleanup = killTreeWithEscalation(child);
            }, opts.timeoutMs);
          }

          // AbortSignal bridging
          const onAbort = () => {
            aborted = true;
            escalationCleanup = killTreeWithEscalation(child);
          };
          opts?.signal?.addEventListener("abort", onAbort, { once: true });

          const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            escalationCleanup?.();
            opts?.signal?.removeEventListener("abort", onAbort);
          };

          child.on("error", (err) => {
            closed = true;
            cleanup();
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new CommandError({ command, message: err.message, stderr })),
            );
          });

          child.on("close", (code) => {
            closed = true;
            cleanup();
            if (aborted) {
              Queue.failCauseUnsafe(queue, Cause.fail(new CommandAborted({ command })));
              return;
            }
            if (timedOut) {
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(new CommandTimeout({ command, timeoutMs: opts?.timeoutMs ?? 0 })),
              );
              return;
            }
            if ((code ?? 1) !== 0) {
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(
                  new CommandError({
                    command,
                    message: `exit code ${code ?? 1}`,
                    stderr,
                  }),
                ),
              );
              return;
            }
            Queue.endUnsafe(queue);
          });

          // cleanup on scope finalization (Effect interruption / early consumer stop)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleanup();
              if (!closed) {
                // child still running — kill tree with escalation
                const esc = killTreeWithEscalation(child);
                // unref so we don't block process exit
                child.on("close", esc);
              }
            }),
          );
        }),
      ),
  });

  static layerTest = (
    spawnLog: Ref.Ref<Array<SpawnRecord>>,
    results?: Map<string, ProcessResult>,
  ) =>
    Layer.succeed(ProcessRunner, {
      run: (command: string, opts?: RunOptions) => {
        const result = results?.get(command) ?? { exitCode: 0, stdout: "", stderr: "" };
        return Ref.update(spawnLog, (log) => [
          ...log,
          { command, args: opts?.args ?? [], cwd: opts?.cwd, result },
        ]).pipe(Effect.as(result));
      },

      runStream: (command: string, opts?: RunOptions) => {
        const result = results?.get(command) ?? { exitCode: 0, stdout: "", stderr: "" };
        return Stream.fromEffect(
          Ref.update(spawnLog, (log) => [
            ...log,
            { command, args: opts?.args ?? [], cwd: opts?.cwd, result },
          ]).pipe(
            Effect.flatMap(() => {
              if (result.exitCode !== 0) {
                return Effect.fail(
                  new CommandError({
                    command,
                    message: `exit code ${result.exitCode}`,
                    stderr: result.stderr,
                  }),
                );
              }
              return Effect.succeed(result.stdout);
            }),
          ),
        ).pipe(Stream.flatMap((s) => (s ? Stream.make(s) : Stream.empty)));
      },
    });
}

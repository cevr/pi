/**
 * process execution service — thin Effect wrapper around child_process.
 *
 * standardizes process lifecycle: spawn, collect output, handle timeout,
 * SIGTERM → SIGKILL escalation, AbortSignal bridging.
 *
 * domain APIs (GitClient, PiSpawn) sit on top. this service owns the
 * shared spawn patterns and provides a test seam.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Effect, Layer, Ref, Schema, ServiceMap, Stream } from "effect";

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
// internal spawn helper
// ---------------------------------------------------------------------------

function spawnCollect(command: string, opts?: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const args = opts?.args ?? [];
    const spawnOpts: SpawnOptions = {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      stdio: ["pipe", "pipe", "pipe"],
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

    // timeout: SIGTERM then SIGKILL
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let killId: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killId = setTimeout(() => child.kill("SIGKILL"), 3000);
      }, opts.timeoutMs);
    }

    // AbortSignal bridging
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
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
      if (killId) clearTimeout(killId);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
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
        catch: (err) => {
          if (err instanceof CommandError) return err;
          if (err instanceof CommandTimeout) return err;
          if (err instanceof CommandAborted) return err;
          return new CommandError({
            command,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      }),

    runStream: (command: string, opts?: RunOptions) =>
      Stream.fromEffect(
        Effect.tryPromise({
          try: (signal) => {
            const combinedController = new AbortController();
            signal.addEventListener("abort", () => combinedController.abort(), { once: true });
            opts?.signal?.addEventListener("abort", () => combinedController.abort(), {
              once: true,
            });
            return spawnCollect(command, {
              ...opts,
              signal: combinedController.signal,
            });
          },
          catch: (err) => {
            if (err instanceof CommandError) return err;
            if (err instanceof CommandTimeout) return err;
            if (err instanceof CommandAborted) return err;
            return new CommandError({
              command,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        }),
      ).pipe(Stream.flatMap((result) => Stream.fromIterable(result.stdout.split("\n")))),
  });

  static layerTest = (
    spawnLog: Ref.Ref<Array<SpawnRecord>>,
    results?: Map<string, ProcessResult>,
  ) =>
    Layer.succeed(ProcessRunner, {
      run: (command: string, opts?: RunOptions) =>
        Effect.gen(function* () {
          const result = results?.get(command) ?? {
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
          yield* Ref.update(spawnLog, (log) => [
            ...log,
            {
              command,
              args: opts?.args ?? [],
              cwd: opts?.cwd,
              result,
            },
          ]);
          return result;
        }),

      runStream: (command: string, opts?: RunOptions) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            const result = results?.get(command) ?? {
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
            yield* Ref.update(spawnLog, (log) => [
              ...log,
              {
                command,
                args: opts?.args ?? [],
                cwd: opts?.cwd,
                result,
              },
            ]);
            return result.stdout;
          }),
        ).pipe(Stream.flatMap((s) => Stream.fromIterable(s.split("\n")))),
    });
}

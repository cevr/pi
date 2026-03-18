import { describe, expect, it } from "bun:test";
import { Effect, ManagedRuntime, Ref, Stream } from "effect";
import { ProcessRunner, type SpawnRecord } from "./index";

// ---------------------------------------------------------------------------
// real process tests (production layer)
// ---------------------------------------------------------------------------

const realRuntime = ManagedRuntime.make(ProcessRunner.layer);

const runWithReal = <A, E>(effect: Effect.Effect<A, E, ProcessRunner>): Promise<A> =>
  realRuntime.runPromise(effect);

async function runWithProcessRunnerLayer<A, E>(
  layer: ReturnType<typeof ProcessRunner.layerTest>,
  effect: Effect.Effect<A, E, ProcessRunner>,
): Promise<A> {
  const runtime = ManagedRuntime.make(layer);
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

describe("ProcessRunner (real)", () => {
  it("runs echo and captures stdout", async () => {
    const result = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("echo", { args: ["hello world"] });
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("captures stderr", async () => {
    const result = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("sh", {
          args: ["-c", "echo err >&2"],
        });
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("err");
  });

  it("returns non-zero exit code", async () => {
    const result = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("sh", { args: ["-c", "exit 42"] });
      }),
    );

    expect(result.exitCode).toBe(42);
  });

  it("fails on nonexistent command", async () => {
    const result = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("nonexistent-binary-xyz").pipe(Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
  });

  it("handles timeout", async () => {
    const result = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("sleep", { args: ["10"], timeoutMs: 100 }).pipe(Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
  });

  it("streams stdout chunks incrementally", async () => {
    const chunks = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner
          .runStream("sh", { args: ["-c", "echo line1; echo line2; echo line3"] })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          );
      }),
    );

    // chunks are raw strings (may arrive as one or many), join and split to verify content
    const combined = chunks.join("");
    expect(combined).toContain("line1");
    expect(combined).toContain("line2");
    expect(combined).toContain("line3");
  });

  it("streams stdout can be split into lines by consumer", async () => {
    const lines = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner
          .runStream("sh", { args: ["-c", "echo line1; echo line2; echo line3"] })
          .pipe(
            Stream.splitLines,
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          );
      }),
    );

    expect(lines.filter((l) => l.trim())).toEqual(["line1", "line2", "line3"]);
  });

  it("stream fails on non-zero exit code", async () => {
    const result = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner
          .runStream("sh", { args: ["-c", "echo partial; exit 1"] })
          .pipe(Stream.runCollect, Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
  });

  it("passes stdin to process", async () => {
    const result = await runWithReal(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("cat", { stdin: "hello from stdin" });
      }),
    );

    expect(result.stdout).toBe("hello from stdin");
  });
});

// ---------------------------------------------------------------------------
// test layer tests
// ---------------------------------------------------------------------------

describe("ProcessRunner (layerTest)", () => {
  it("records commands in the ref", async () => {
    const logRef = Ref.makeUnsafe<Array<SpawnRecord>>([]);
    const testLayer = ProcessRunner.layerTest(logRef);

    const result = await runWithProcessRunnerLayer(
      testLayer,
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        yield* runner.run("git", { args: ["status"], cwd: "/repo" });
        yield* runner.run("echo", { args: ["hi"] });
        return yield* Ref.get(logRef);
      }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.command).toBe("git");
    expect(result[0]!.args).toEqual(["status"]);
    expect(result[0]!.cwd).toBe("/repo");
    expect(result[1]!.command).toBe("echo");
  });

  it("returns configurable results", async () => {
    const logRef = Ref.makeUnsafe<Array<SpawnRecord>>([]);
    const results = new Map([["git", { exitCode: 0, stdout: "main\n", stderr: "" }]]);
    const testLayer = ProcessRunner.layerTest(logRef, results);

    const result = await runWithProcessRunnerLayer(
      testLayer,
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("git", { args: ["branch", "--show-current"] });
      }),
    );

    expect(result.stdout).toBe("main\n");
  });

  it("streams stdout as single chunk from test results", async () => {
    const logRef = Ref.makeUnsafe<Array<SpawnRecord>>([]);
    const results = new Map([["cat", { exitCode: 0, stdout: "a\nb\nc", stderr: "" }]]);
    const testLayer = ProcessRunner.layerTest(logRef, results);

    const chunks = await runWithProcessRunnerLayer(
      testLayer,
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.runStream("cat").pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk]),
        );
      }),
    );

    expect(chunks).toEqual(["a\nb\nc"]);
  });

  it("stream fails on non-zero exit in test layer", async () => {
    const logRef = Ref.makeUnsafe<Array<SpawnRecord>>([]);
    const results = new Map([["fail", { exitCode: 1, stdout: "", stderr: "bad" }]]);
    const testLayer = ProcessRunner.layerTest(logRef, results);

    const result = await runWithProcessRunnerLayer(
      testLayer,
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.runStream("fail").pipe(Stream.runCollect, Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
  });
});

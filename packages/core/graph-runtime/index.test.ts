import { describe, expect, it } from "bun:test";
import { Deferred, Effect, ManagedRuntime, Ref } from "effect";
import { GraphRuntime } from "./index";

const graphRuntime = ManagedRuntime.make(GraphRuntime.layer);

const runWithGraphRuntime = <A, E>(effect: Effect.Effect<A, E, GraphRuntime>): Promise<A> =>
  graphRuntime.runPromise(effect);

describe("GraphRuntime service", () => {
  it("runs a frontier with bounded parallelism", async () => {
    const result = await runWithGraphRuntime(
      Effect.gen(function* () {
        const runtime = yield* GraphRuntime;
        const active = yield* Ref.make(0);
        const maxObserved = yield* Ref.make(0);

        const values = yield* runtime.runFrontier(
          ["1", "2", "3", "4"],
          (taskId) =>
            Effect.gen(function* () {
              const current = yield* Ref.updateAndGet(active, (count) => count + 1);
              yield* Ref.update(maxObserved, (count) => Math.max(count, current));
              yield* Effect.sleep("10 millis");
              yield* Ref.update(active, (count) => count - 1);
              return `task-${taskId}`;
            }),
          { maxParallel: 2 },
        );

        return { values, maxObserved: yield* Ref.get(maxObserved) };
      }),
    );

    expect(result.values).toEqual([
      { taskId: "1", value: "task-1" },
      { taskId: "2", value: "task-2" },
      { taskId: "3", value: "task-3" },
      { taskId: "4", value: "task-4" },
    ]);
    expect(result.maxObserved).toBe(2);
  });

  it("falls back to serial execution for invalid maxParallel", async () => {
    const result = await runWithGraphRuntime(
      Effect.gen(function* () {
        const runtime = yield* GraphRuntime;
        const active = yield* Ref.make(0);
        const maxObserved = yield* Ref.make(0);

        yield* runtime.runFrontier(
          ["1", "2", "3"],
          () =>
            Effect.gen(function* () {
              const current = yield* Ref.updateAndGet(active, (count) => count + 1);
              yield* Ref.update(maxObserved, (count) => Math.max(count, current));
              yield* Effect.sleep("5 millis");
              yield* Ref.update(active, (count) => count - 1);
            }),
          { maxParallel: 0 },
        );

        return yield* Ref.get(maxObserved);
      }),
    );

    expect(result).toBe(1);
  });

  it("preserves frontier order even when tasks finish out of order", async () => {
    const result = await runWithGraphRuntime(
      Effect.gen(function* () {
        const runtime = yield* GraphRuntime;
        return yield* runtime.runFrontier(
          ["1", "2"],
          (taskId) =>
            Effect.gen(function* () {
              yield* Effect.sleep(taskId === "1" ? "20 millis" : "5 millis");
              return `task-${taskId}`;
            }),
          { maxParallel: 2 },
        );
      }),
    );

    expect(result).toEqual([
      { taskId: "1", value: "task-1" },
      { taskId: "2", value: "task-2" },
    ]);
  });

  it("fails fast without starting later tasks in the frontier", async () => {
    const result = await runWithGraphRuntime(
      Effect.gen(function* () {
        const runtime = yield* GraphRuntime;
        const started = yield* Ref.make<Array<string>>([]);
        const gate = yield* Deferred.make<void>();

        const exit = yield* runtime
          .runFrontier(
            ["1", "2", "3"],
            (taskId) =>
              Ref.update(started, (items) => [...items, taskId]).pipe(
                Effect.andThen(
                  taskId === "1"
                    ? Deferred.await(gate)
                    : taskId === "2"
                      ? Effect.fail("boom")
                      : Effect.succeed("never"),
                ),
              ),
            { maxParallel: 2 },
          )
          .pipe(Effect.exit);

        return { exit, started: yield* Ref.get(started) };
      }),
    );

    expect(result.exit._tag).toBe("Failure");
    expect(result.started).toEqual(["1", "2"]);
  });
});

import { describe, expect, it } from "bun:test";
import { Effect, Ref } from "effect";
import { Mutex } from "./index";

const runWithMutex = <A, E>(effect: Effect.Effect<A, E, Mutex>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, Mutex.layer));

describe("Mutex service", () => {
  it("executes effect and returns result", async () => {
    const result = await runWithMutex(
      Effect.gen(function* () {
        const mutex = yield* Mutex;
        return yield* mutex.withLock("/tmp/effect-test.txt", Effect.succeed("hello"));
      }),
    );
    expect(result).toBe("hello");
  });

  it("serializes concurrent effects for the same path", async () => {
    const result = await runWithMutex(
      Effect.gen(function* () {
        const mutex = yield* Mutex;
        const order: string[] = [];

        const makeOp = (id: string, delayMs: number) =>
          mutex.withLock(
            "/tmp/effect-serial.txt",
            Effect.gen(function* () {
              order.push(`${id}-start`);
              yield* Effect.sleep(`${delayMs} millis`);
              order.push(`${id}-end`);
              return id;
            }),
          );

        const results = yield* Effect.all([makeOp("a", 50), makeOp("b", 30), makeOp("c", 10)], {
          concurrency: "unbounded",
        });

        return { results, order };
      }),
    );

    expect(result.results).toEqual(["a", "b", "c"]);
    expect(result.order).toEqual(["a-start", "a-end", "b-start", "b-end", "c-start", "c-end"]);
  });

  it("allows parallel execution for different paths", async () => {
    const result = await runWithMutex(
      Effect.gen(function* () {
        const mutex = yield* Mutex;
        const order: string[] = [];

        const makeOp = (path: string, id: string, delayMs: number) =>
          mutex.withLock(
            path,
            Effect.gen(function* () {
              order.push(`${id}-start`);
              yield* Effect.sleep(`${delayMs} millis`);
              order.push(`${id}-end`);
              return id;
            }),
          );

        const results = yield* Effect.all(
          [
            makeOp("/tmp/a.txt", "a", 50),
            makeOp("/tmp/b.txt", "b", 50),
            makeOp("/tmp/c.txt", "c", 50),
          ],
          { concurrency: "unbounded" },
        );

        return { results, order };
      }),
    );

    expect(result.results).toEqual(["a", "b", "c"]);
    const starts = result.order.filter((o) => o.endsWith("-start"));
    expect(starts).toHaveLength(3);
    expect(result.order.slice(0, 3).every((o) => o.endsWith("-start"))).toBe(true);
  });

  it("releases lock after error", async () => {
    const result = await runWithMutex(
      Effect.gen(function* () {
        const mutex = yield* Mutex;
        const path = "/tmp/effect-error.txt";

        const failed = yield* mutex.withLock(path, Effect.fail("boom")).pipe(Effect.result);

        const ok = yield* mutex.withLock(path, Effect.succeed("recovered"));
        return { failed, ok };
      }),
    );

    expect(result.failed._tag).toBe("Failure");
    expect(result.ok).toBe("recovered");
  });

  it("layerTest records lock acquisitions without blocking", async () => {
    const logRef = Ref.makeUnsafe<Array<string>>([]);
    const testLayer = Mutex.layerTest(logRef);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const mutex = yield* Mutex;
        yield* mutex.withLock("/a.txt", Effect.succeed("one"));
        yield* mutex.withLock("/b.txt", Effect.succeed("two"));
        return yield* Ref.get(logRef);
      }).pipe(Effect.provide(testLayer)),
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toContain("a.txt");
    expect(result[1]).toContain("b.txt");
  });
});

/**
 * per-path async mutex for file operations.
 *
 * serializes concurrent edits to the same file path to prevent
 * partial writes and race conditions. keyed by resolved absolute path —
 * two relative paths pointing to the same file share one lock.
 */

import * as nodePath from "node:path";
import { Effect, Ref, Schema, ServiceMap, Layer, Semaphore } from "effect";

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class MutexError extends Schema.TaggedErrorClass<MutexError>()("MutexError", {
  path: Schema.String,
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class Mutex extends ServiceMap.Service<
  Mutex,
  {
    /**
     * execute `effect` while holding an exclusive lock on `filePath`.
     * concurrent calls for the same resolved path queue sequentially.
     */
    readonly withLock: <A, E, R>(
      filePath: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | MutexError, R>;
  }
>()("@cvr/pi-mutex/index/Mutex") {
  /**
   * production layer — per-path Semaphore(1) stored in a Ref<Map>.
   */
  static layer = Layer.effect(
    Mutex,
    Effect.gen(function* () {
      const semaphores = yield* Ref.make(new Map<string, Semaphore.Semaphore>());

      const getSemaphore = (key: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(semaphores);
          const existing = current.get(key);
          if (existing) return existing;

          const sem = Semaphore.makeUnsafe(1);
          yield* Ref.update(semaphores, (map) => {
            const next = new Map(map);
            next.set(key, sem);
            return next;
          });
          return sem;
        });

      return {
        withLock: <A, E, R>(filePath: string, effect: Effect.Effect<A, E, R>) => {
          const key = nodePath.resolve(filePath);
          return Effect.gen(function* () {
            const sem = yield* getSemaphore(key);
            return yield* sem.withPermits(1)(effect);
          });
        },
      };
    }),
  );

  /**
   * test layer — no actual locking, just records lock acquisitions.
   */
  static layerTest = (lockLog: Ref.Ref<Array<string>>) =>
    Layer.succeed(Mutex, {
      withLock: <A, E, R>(filePath: string, effect: Effect.Effect<A, E, R>) => {
        const key = nodePath.resolve(filePath);
        return Ref.update(lockLog, (log) => [...log, key]).pipe(Effect.andThen(effect));
      },
    });
}

// ---------------------------------------------------------------------------
// sync API — bridges to encapsulated state (no bare module-level singletons)
// ---------------------------------------------------------------------------

const _state = { locks: new Map<string, Promise<void>>() };

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = nodePath.resolve(filePath);

  while (_state.locks.has(key)) {
    await _state.locks.get(key);
  }

  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  _state.locks.set(key, promise);

  try {
    return await fn();
  } finally {
    _state.locks.delete(key);
    resolve();
  }
}

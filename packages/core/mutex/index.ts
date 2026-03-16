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
    Ref.make(new Map<string, Semaphore.Semaphore>()).pipe(
      Effect.map((semaphores) => {
        const getSemaphore = (key: string) =>
          Ref.get(semaphores).pipe(
            Effect.flatMap((current) => {
              const existing = current.get(key);
              if (existing) return Effect.succeed(existing);
              const sem = Semaphore.makeUnsafe(1);
              return Ref.update(semaphores, (map) => new Map(map).set(key, sem)).pipe(
                Effect.as(sem),
              );
            }),
          );

        return {
          withLock: <A, E, R>(filePath: string, effect: Effect.Effect<A, E, R>) => {
            const key = nodePath.resolve(filePath);
            return getSemaphore(key).pipe(Effect.flatMap((sem) => sem.withPermits(1)(effect)));
          },
        };
      }),
    ),
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

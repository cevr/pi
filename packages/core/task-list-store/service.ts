import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Mutex, type MutexError } from "@cvr/pi-mutex";
import type { TaskListItem } from "@cvr/pi-task-list";
import { Effect, FileSystem, Layer, ManagedRuntime, Option, Path, Schema, ServiceMap } from "effect";
import { TaskListStoreDecodeError, TaskListStoreIoError } from "./errors";
import { resolveTaskListStorePath, type TaskListScope } from "./paths";
import { PersistedTaskListFromJson, type PersistedTaskList } from "./schema";

export interface TaskListSnapshot {
  readonly tasks: TaskListItem[];
  readonly updatedAt: number;
}

export interface TaskListStoreConfig {
  readonly cwd: string;
  readonly scope: TaskListScope;
  readonly sessionId?: string;
}

const decodePersistedTaskList = Schema.decodeUnknownEffect(PersistedTaskListFromJson);
const encodePersistedTaskList = Schema.encodeUnknownEffect(PersistedTaskListFromJson);

const toIoError = (message: string, filePath?: string) =>
  new TaskListStoreIoError({ message, path: filePath });

const toDecodeError = (message: string, filePath?: string) =>
  new TaskListStoreDecodeError({ message, path: filePath });

const cloneTask = (task: TaskListItem): TaskListItem => ({
  ...task,
  blockedBy: [...task.blockedBy],
  metadata: task.metadata ? { ...task.metadata } : undefined,
});

const cloneTasks = (tasks: readonly TaskListItem[]): TaskListItem[] => tasks.map(cloneTask);

const toSnapshot = (persisted: PersistedTaskList): TaskListSnapshot => ({
  tasks: persisted.tasks.map((task) => ({
    ...task,
    blockedBy: [...task.blockedBy],
    metadata: task.metadata ? { ...task.metadata } : undefined,
  })),
  updatedAt: persisted.updatedAt,
});

const createPersistedTaskList = (tasks: readonly TaskListItem[]): PersistedTaskList => ({
  version: 1,
  updatedAt: Date.now(),
  tasks: cloneTasks(tasks),
});

const createMemoryStore = Effect.sync(() => {
  let snapshot: TaskListSnapshot | undefined;

  return {
    load: Effect.sync(() => (snapshot ? Option.some({ ...snapshot, tasks: cloneTasks(snapshot.tasks) }) : Option.none())),
    save: (tasks: readonly TaskListItem[]) =>
      Effect.sync(() => {
        snapshot = {
          tasks: cloneTasks(tasks),
          updatedAt: Date.now(),
        };
        return { ...snapshot, tasks: cloneTasks(snapshot.tasks) };
      }),
    clear: Effect.sync(() => {
      snapshot = undefined;
    }),
  };
});

const createFileStore = Effect.fn("@cvr/pi-task-list-store/service/createFileStore")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Mutex;

  const load = mutex.withLock(
    filePath,
    Effect.gen(function* () {
      const exists = yield* fs.exists(filePath).pipe(
        Effect.mapError((error) => toIoError(String(error), filePath)),
      );
      if (!exists) {
        return Option.none<TaskListSnapshot>();
      }

      const text = yield* fs.readFileString(filePath).pipe(
        Effect.mapError((error) => toIoError(String(error), filePath)),
      );
      const persisted = yield* decodePersistedTaskList(text).pipe(
        Effect.mapError((error) => toDecodeError(String(error), filePath)),
      );
      return Option.some(toSnapshot(persisted));
    }),
  );

  const save = (tasks: readonly TaskListItem[]) =>
    mutex.withLock(
      filePath,
      Effect.gen(function* () {
        const persisted = createPersistedTaskList(tasks);
        const dirPath = path.dirname(filePath);
        const tempPath = `${filePath}.tmp`;
        const text = yield* encodePersistedTaskList(persisted).pipe(
          Effect.mapError((error) => toDecodeError(String(error), filePath)),
        );

        yield* fs.makeDirectory(dirPath, { recursive: true }).pipe(
          Effect.mapError((error) => toIoError(String(error), dirPath)),
        );
        yield* fs.writeFileString(tempPath, text).pipe(
          Effect.mapError((error) => toIoError(String(error), tempPath)),
        );
        yield* fs.rename(tempPath, filePath).pipe(
          Effect.mapError((error) => toIoError(String(error), filePath)),
        );

        return toSnapshot(persisted);
      }),
    );

  const clear = mutex.withLock(
    filePath,
    Effect.gen(function* () {
      const exists = yield* fs.exists(filePath).pipe(
        Effect.mapError((error) => toIoError(String(error), filePath)),
      );
      if (!exists) return;
      yield* fs.remove(filePath).pipe(Effect.mapError((error) => toIoError(String(error), filePath)));
    }),
  );

  return { load, save, clear };
});

const runtimeCache = new Map<string, ManagedRuntime.ManagedRuntime<TaskListStore, never>>();

function getTaskListStoreRuntimeKey(config: TaskListStoreConfig): string {
  return `${config.scope}:${config.cwd}:${config.sessionId ?? ""}`;
}

export class TaskListStore extends ServiceMap.Service<
  TaskListStore,
  {
    readonly load: Effect.Effect<
      Option.Option<TaskListSnapshot>,
      TaskListStoreIoError | TaskListStoreDecodeError | MutexError
    >;
    readonly save: (
      tasks: readonly TaskListItem[],
    ) => Effect.Effect<TaskListSnapshot, TaskListStoreIoError | TaskListStoreDecodeError | MutexError>;
    readonly clear: Effect.Effect<void, TaskListStoreIoError | MutexError>;
  }
>()("@cvr/pi/task-list-store/service/TaskListStore") {
  static layer = (config: TaskListStoreConfig) =>
    Layer.effect(
      TaskListStore,
      Effect.gen(function* () {
        const storePath = resolveTaskListStorePath(config);
        if (!storePath) {
          return yield* createMemoryStore;
        }
        return yield* createFileStore(storePath);
      }),
    );

  static runtime = (config: TaskListStoreConfig) => {
    const key = getTaskListStoreRuntimeKey(config);
    const existing = runtimeCache.get(key);
    if (existing) return existing;

    const runtime = ManagedRuntime.make(
      TaskListStore.layer(config).pipe(
        Layer.provide(Mutex.layer),
        Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
      ),
    );
    runtimeCache.set(key, runtime);
    return runtime;
  };

  static clearRuntimeCache = async (): Promise<void> => {
    const runtimes = [...runtimeCache.values()];
    runtimeCache.clear();
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  };
}

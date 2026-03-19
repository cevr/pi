import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Option } from "effect";
import { createTaskList } from "@cvr/pi-task-list";
import { resolveTaskListStorePath, TaskListStore } from "./index";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-list-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await TaskListStore.clearRuntimeCache();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveTaskListStorePath", () => {
  it("returns null for memory scope", () => {
    expect(resolveTaskListStorePath({ cwd: "/tmp/work", scope: "memory" })).toBeNull();
  });

  it("returns session-scoped path when session id exists", () => {
    expect(
      resolveTaskListStorePath({ cwd: "/tmp/work", scope: "session", sessionId: "abc123" }),
    ).toBe(path.join("/tmp/work", ".pi", "modes", "tasks-abc123.json"));
  });

  it("returns project-scoped path", () => {
    expect(resolveTaskListStorePath({ cwd: "/tmp/work", scope: "project" })).toBe(
      path.join("/tmp/work", ".pi", "modes", "tasks.json"),
    );
  });
});

describe("TaskListStore", () => {
  it("supports in-memory snapshots", async () => {
    const runtime = TaskListStore.runtime({ cwd: "/tmp/work", scope: "memory" });
    const tasks = createTaskList(["First", "Second"]);

    const initial = await runtime.runPromise(Effect.gen(function* () {
      const store = yield* TaskListStore;
      return yield* store.load;
    }));
    expect(Option.isNone(initial)).toBe(true);

    const saved = await runtime.runPromise(Effect.gen(function* () {
      const store = yield* TaskListStore;
      return yield* store.save(tasks);
    }));
    expect(saved.tasks).toEqual(tasks);

    const loaded = await runtime.runPromise(Effect.gen(function* () {
      const store = yield* TaskListStore;
      return yield* store.load;
    }));
    expect(Option.isSome(loaded)).toBe(true);
    if (Option.isSome(loaded)) {
      expect(loaded.value.tasks).toEqual(tasks);
    }

    await runtime.runPromise(Effect.gen(function* () {
      const store = yield* TaskListStore;
      yield* store.clear;
    }));

    const cleared = await runtime.runPromise(Effect.gen(function* () {
      const store = yield* TaskListStore;
      return yield* store.load;
    }));
    expect(Option.isNone(cleared)).toBe(true);
  });

  it("persists project-scoped snapshots to disk", async () => {
    const cwd = makeTempDir();
    const runtime = TaskListStore.runtime({ cwd, scope: "project" });
    const tasks = createTaskList(["Audit", "Ship"]);

    const saved = await runtime.runPromise(Effect.gen(function* () {
      const store = yield* TaskListStore;
      return yield* store.save(tasks);
    }));

    const filePath = path.join(cwd, ".pi", "modes", "tasks.json");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(saved.tasks).toEqual(tasks);

    const loaded = await runtime.runPromise(Effect.gen(function* () {
      const store = yield* TaskListStore;
      return yield* store.load;
    }));
    expect(Option.isSome(loaded)).toBe(true);
    if (Option.isSome(loaded)) {
      expect(loaded.value.tasks).toEqual(tasks);
    }
  });

  it("fails with a decode error on malformed persisted data", async () => {
    const cwd = makeTempDir();
    const filePath = path.join(cwd, ".pi", "modes", "tasks.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, updatedAt: "bad", tasks: [] }), "utf-8");

    const runtime = TaskListStore.runtime({ cwd, scope: "project" });
    await expect(
      runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* TaskListStore;
          return yield* store.load;
        }),
      ),
    ).rejects.toMatchObject({ _tag: "TaskListStoreDecodeError", path: filePath });
  });

  it("serializes concurrent saves for the same file", async () => {
    const cwd = makeTempDir();
    const runtime = TaskListStore.runtime({ cwd, scope: "project" });
    const first = createTaskList(["One"]);
    const second = createTaskList(["One", "Two"]);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* TaskListStore;
        yield* Effect.all([store.save(first), store.save(second)], { concurrency: "unbounded" });
      }),
    );

    const filePath = path.join(cwd, ".pi", "modes", "tasks.json");
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as { tasks: unknown[] };
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect([1, 2]).toContain(parsed.tasks.length);
  });
});

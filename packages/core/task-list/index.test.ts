import { describe, expect, it } from "bun:test";
import {
  claimTasks,
  completeTasks,
  countTaskStatuses,
  createTaskList,
  findTaskById,
  findTaskByOrder,
  getBlockedTaskIds,
  getReadyTaskIds,
  setTaskStatus,
  setTaskStatuses,
  validateTaskGraph,
} from "./index";

describe("createTaskList", () => {
  it("creates ordered pending tasks", () => {
    expect(createTaskList(["First", "Second"])).toEqual([
      {
        id: "1",
        order: 1,
        subject: "First",
        status: "pending",
        blockedBy: [],
      },
      {
        id: "2",
        order: 2,
        subject: "Second",
        status: "pending",
        blockedBy: [],
      },
    ]);
  });
});

describe("findTaskById / findTaskByOrder", () => {
  it("returns the matching task", () => {
    const tasks = createTaskList(["First", "Second"]);
    expect(findTaskById(tasks, "2")?.subject).toBe("Second");
    expect(findTaskById(tasks, "3")).toBeUndefined();
    expect(findTaskByOrder(tasks, 2)?.subject).toBe("Second");
    expect(findTaskByOrder(tasks, 3)).toBeUndefined();
  });
});

describe("setTaskStatus / setTaskStatuses", () => {
  it("updates tasks immutably", () => {
    const tasks = createTaskList(["First", "Second", "Third"]);
    const single = setTaskStatus(tasks, 1, "in_progress");
    const batch = setTaskStatuses(single, ["2", "3"], "completed");

    expect(single[0]?.status).toBe("in_progress");
    expect(batch.map((task) => task.status)).toEqual(["in_progress", "completed", "completed"]);
    expect(tasks.map((task) => task.status)).toEqual(["pending", "pending", "pending"]);
  });
});

describe("claimTasks / completeTasks", () => {
  it("claims and completes batches by id", () => {
    const tasks = createTaskList(["First", "Second", "Third"]);
    const claimed = claimTasks(tasks, ["1", "2"]);
    const completed = completeTasks(claimed, ["1"]);

    expect(claimed.map((task) => task.status)).toEqual(["in_progress", "in_progress", "pending"]);
    expect(completed.map((task) => task.status)).toEqual(["completed", "in_progress", "pending"]);
  });
});

describe("getReadyTaskIds / getBlockedTaskIds", () => {
  it("finds ready tasks from dependency topology", () => {
    const tasks = [
      { ...createTaskList(["First", "Second", "Third"])[0]!, blockedBy: [] },
      { ...createTaskList(["First", "Second", "Third"])[1]!, blockedBy: ["1"] },
      { ...createTaskList(["First", "Second", "Third"])[2]!, blockedBy: ["1"] },
    ];

    expect(getReadyTaskIds(tasks)).toEqual(["1"]);
    expect(getBlockedTaskIds(tasks)).toEqual(["2", "3"]);

    const completed = completeTasks(tasks, ["1"]);
    expect(getReadyTaskIds(completed)).toEqual(["2", "3"]);
    expect(getBlockedTaskIds(completed)).toEqual([]);
  });

  it("does not treat in-progress tasks as ready", () => {
    const tasks = claimTasks(createTaskList(["First", "Second"]), ["1"]);
    expect(getReadyTaskIds(tasks)).toEqual(["2"]);
  });
});

describe("validateTaskGraph", () => {
  it("accepts a valid DAG", () => {
    const tasks = [
      { ...createTaskList(["First", "Second", "Third"])[0]!, blockedBy: [] },
      { ...createTaskList(["First", "Second", "Third"])[1]!, blockedBy: ["1"] },
      { ...createTaskList(["First", "Second", "Third"])[2]!, blockedBy: ["1", "2"] },
    ];

    expect(validateTaskGraph(tasks)).toEqual([]);
  });

  it("reports missing blockers and self-blocks", () => {
    const tasks = [{ ...createTaskList(["First"])[0]!, blockedBy: ["1", "missing"] }];

    expect(validateTaskGraph(tasks)).toEqual([
      { type: "self_block", taskId: "1", blockerId: "1" },
      { type: "missing_blocker", taskId: "1", blockerId: "missing" },
    ]);
  });

  it("reports cycles", () => {
    const tasks = [
      { ...createTaskList(["First", "Second", "Third"])[0]!, blockedBy: ["3"] },
      { ...createTaskList(["First", "Second", "Third"])[1]!, blockedBy: ["1"] },
      { ...createTaskList(["First", "Second", "Third"])[2]!, blockedBy: ["2"] },
    ];

    expect(validateTaskGraph(tasks)).toEqual([{ type: "cycle", taskIds: ["1", "3", "2", "1"] }]);
  });
});

describe("countTaskStatuses", () => {
  it("counts each status", () => {
    const tasks = setTaskStatus(
      setTaskStatus(createTaskList(["First", "Second", "Third"]), 1, "completed"),
      2,
      "in_progress",
    );
    expect(countTaskStatuses(tasks)).toEqual({
      pending: 1,
      in_progress: 1,
      completed: 1,
    });
  });
});

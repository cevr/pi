import { describe, expect, it } from "bun:test";
import { countTaskStatuses, createTaskList, findTaskByOrder, setTaskStatus } from "./index";

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

describe("findTaskByOrder", () => {
  it("returns the matching task", () => {
    const tasks = createTaskList(["First", "Second"]);
    expect(findTaskByOrder(tasks, 2)?.subject).toBe("Second");
    expect(findTaskByOrder(tasks, 3)).toBeUndefined();
  });
});

describe("setTaskStatus", () => {
  it("updates one task immutably", () => {
    const tasks = createTaskList(["First", "Second"]);
    const next = setTaskStatus(tasks, 1, "in_progress");

    expect(next[0]?.status).toBe("in_progress");
    expect(next[1]?.status).toBe("pending");
    expect(tasks[0]?.status).toBe("pending");
  });
});

describe("countTaskStatuses", () => {
  it("counts each status", () => {
    const tasks = setTaskStatus(setTaskStatus(createTaskList(["First", "Second", "Third"]), 1, "completed"), 2, "in_progress");
    expect(countTaskStatuses(tasks)).toEqual({
      pending: 1,
      in_progress: 1,
      completed: 1,
    });
  });
});

import { describe, expect, it } from "bun:test";
import { claimTasks, completeTasks, createTaskList, type TaskListItem } from "@cvr/pi-task-list";
import {
  recordGraphTaskCompletion,
  resolveGraphExecutionCounsel,
  resolveGraphExecutionGate,
  startGraphExecution,
} from "./index";

function graphTasks(): TaskListItem[] {
  const tasks = createTaskList(["A", "B", "C", "D"]);
  return [
    { ...tasks[0]!, blockedBy: [] },
    { ...tasks[1]!, blockedBy: [] },
    { ...tasks[2]!, blockedBy: ["1"] },
    { ...tasks[3]!, blockedBy: ["2"] },
  ];
}

describe("startGraphExecution", () => {
  it("claims a frontier batch up to maxParallel", () => {
    expect(startGraphExecution(graphTasks(), { maxParallel: 2 })).toEqual({
      phase: "running",
      frontierTaskIds: ["1", "2"],
      activeTaskIds: ["1", "2"],
      total: 4,
    });
  });

  it("falls back to serial when maxParallel is invalid", () => {
    expect(startGraphExecution(graphTasks(), { maxParallel: 0 })).toEqual({
      phase: "running",
      frontierTaskIds: ["1"],
      activeTaskIds: ["1"],
      total: 4,
    });
  });
});

describe("recordGraphTaskCompletion", () => {
  it("keeps running until the full frontier batch is done", () => {
    const cursor = startGraphExecution(graphTasks(), { maxParallel: 2 });
    expect(cursor).not.toBeNull();
    const next = recordGraphTaskCompletion(cursor!, "1");
    expect(next).toEqual({
      phase: "running",
      frontierTaskIds: ["1", "2"],
      activeTaskIds: ["2"],
      total: 4,
    });
  });

  it("enters gating when the last active task completes", () => {
    const cursor = {
      phase: "running" as const,
      frontierTaskIds: ["1", "2"],
      activeTaskIds: ["2"],
      total: 4,
    };
    expect(recordGraphTaskCompletion(cursor, "2")).toEqual({
      phase: "gating",
      frontierTaskIds: ["1", "2"],
      activeTaskIds: [],
      total: 4,
    });
  });
});

describe("resolveGraphExecutionGate", () => {
  it("moves gating to counseling on pass", () => {
    expect(
      resolveGraphExecutionGate(
        { phase: "gating", frontierTaskIds: ["1", "2"], activeTaskIds: [], total: 4 },
        "pass",
      ),
    ).toEqual({
      phase: "counseling",
      frontierTaskIds: ["1", "2"],
      activeTaskIds: [],
      total: 4,
    });
  });

  it("reopens the whole frontier on gate fail", () => {
    expect(
      resolveGraphExecutionGate(
        { phase: "gating", frontierTaskIds: ["1", "2"], activeTaskIds: [], total: 4 },
        "fail",
      ),
    ).toEqual({
      phase: "running",
      frontierTaskIds: ["1", "2"],
      activeTaskIds: ["1", "2"],
      total: 4,
    });
  });
});

describe("resolveGraphExecutionCounsel", () => {
  it("retries the same frontier on counsel fail", () => {
    expect(
      resolveGraphExecutionCounsel(
        { phase: "counseling", frontierTaskIds: ["1", "2"], activeTaskIds: [], total: 4 },
        "fail",
        graphTasks(),
        { maxParallel: 2 },
      ),
    ).toEqual({
      type: "retry",
      phase: "running",
      frontierTaskIds: ["1", "2"],
      activeTaskIds: ["1", "2"],
      total: 4,
    });
  });

  it("advances to the next ready frontier on counsel pass", () => {
    const completed = completeTasks(claimTasks(graphTasks(), ["1", "2"]), ["1", "2"]);
    expect(
      resolveGraphExecutionCounsel(
        { phase: "counseling", frontierTaskIds: ["1", "2"], activeTaskIds: [], total: 4 },
        "pass",
        completed,
        { maxParallel: 2 },
      ),
    ).toEqual({
      type: "advance",
      phase: "running",
      frontierTaskIds: ["3", "4"],
      activeTaskIds: ["3", "4"],
      total: 4,
    });
  });

  it("completes when no ready work remains", () => {
    const completed = completeTasks(graphTasks(), ["1", "2", "3", "4"]);
    expect(
      resolveGraphExecutionCounsel(
        { phase: "counseling", frontierTaskIds: ["3", "4"], activeTaskIds: [], total: 4 },
        "pass",
        completed,
        { maxParallel: 2 },
      ),
    ).toEqual({ type: "complete" });
  });
});

import { describe, expect, it } from "bun:test";
import { enterSequentialExecutionCounsel, resolveSequentialExecutionCounsel } from "./index";

describe("enterSequentialExecutionCounsel", () => {
  it("enters counseling for a valid running item", () => {
    expect(
      enterSequentialExecutionCounsel({ phase: "running", currentIndex: null, total: 3 }, 1),
    ).toEqual({ phase: "counseling", currentIndex: 1 });
  });

  it("rejects when not in running phase", () => {
    expect(
      enterSequentialExecutionCounsel({ phase: "counseling", currentIndex: 0, total: 3 }, 1),
    ).toBeNull();
  });

  it("rejects out-of-bounds index", () => {
    expect(
      enterSequentialExecutionCounsel({ phase: "running", currentIndex: null, total: 3 }, -1),
    ).toBeNull();
    expect(
      enterSequentialExecutionCounsel({ phase: "running", currentIndex: null, total: 3 }, 3),
    ).toBeNull();
  });
});

describe("resolveSequentialExecutionCounsel", () => {
  it("moves counseling back to running on fail", () => {
    expect(
      resolveSequentialExecutionCounsel({ phase: "counseling", currentIndex: 1, total: 3 }, "fail"),
    ).toEqual({ type: "retry", phase: "running", currentIndex: 1 });
  });

  it("advances to the next item on pass when more remain", () => {
    expect(
      resolveSequentialExecutionCounsel({ phase: "counseling", currentIndex: 1, total: 3 }, "pass"),
    ).toEqual({ type: "advance", phase: "running", currentIndex: 2 });
  });

  it("finishes when the last item is approved", () => {
    expect(
      resolveSequentialExecutionCounsel({ phase: "counseling", currentIndex: 2, total: 3 }, "pass"),
    ).toEqual({ type: "complete" });
  });
});

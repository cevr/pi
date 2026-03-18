import { describe, expect, it } from "bun:test";
import {
  enterSequentialExecutionGate,
  resolveSequentialExecutionCounsel,
  resolveSequentialExecutionGate,
} from "./index";

describe("enterSequentialExecutionGate", () => {
  it("enters gating for a valid running item", () => {
    expect(
      enterSequentialExecutionGate({ phase: "running", currentIndex: null, total: 3 }, 1),
    ).toEqual({ phase: "gating", currentIndex: 1 });
  });

  it("rejects invalid phase or index", () => {
    expect(
      enterSequentialExecutionGate({ phase: "gating", currentIndex: 0, total: 3 }, 1),
    ).toBeNull();
    expect(
      enterSequentialExecutionGate({ phase: "running", currentIndex: null, total: 3 }, -1),
    ).toBeNull();
    expect(
      enterSequentialExecutionGate({ phase: "running", currentIndex: null, total: 3 }, 3),
    ).toBeNull();
  });
});

describe("resolveSequentialExecutionGate", () => {
  it("moves gating to counseling on pass", () => {
    expect(
      resolveSequentialExecutionGate({ phase: "gating", currentIndex: 1, total: 3 }, "pass"),
    ).toEqual({ phase: "counseling", currentIndex: 1 });
  });

  it("moves gating back to running on fail", () => {
    expect(
      resolveSequentialExecutionGate({ phase: "gating", currentIndex: 1, total: 3 }, "fail"),
    ).toEqual({ phase: "running", currentIndex: 1 });
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

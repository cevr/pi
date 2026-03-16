import { describe, expect, it } from "bun:test";
import {
  stackedReducer,
  type StackBranch,
  type StackedEffect,
  type StackedState,
  type StackIssue,
} from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | StackedEffect;

const STACK: StackBranch[] = [
  { name: "feat/auth", parent: "main" },
  { name: "feat/auth-ui", parent: "feat/auth" },
];

function idle(): StackedState {
  return { _tag: "Idle" };
}

function analyzing(stack = STACK): StackedState {
  return { _tag: "Analyzing", stack };
}

function hasEffect(effects: readonly Effect[] | undefined, type: string): boolean {
  return effects?.some((e) => e.type === type) ?? false;
}

function getEffect<T extends Effect>(
  effects: readonly Effect[] | undefined,
  type: string,
): T | undefined {
  return effects?.find((e) => e.type === type) as T | undefined;
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

describe("stackedReducer — Analyze", () => {
  it("Idle → Analyzing", () => {
    const r = stackedReducer(idle(), { _tag: "Analyze", stack: STACK });
    expect(r.state._tag).toBe("Analyzing");
    if (r.state._tag === "Analyzing") {
      expect(r.state.stack).toEqual(STACK);
    }
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("already Analyzing → no-op", () => {
    const state = analyzing();
    const r = stackedReducer(state, { _tag: "Analyze", stack: STACK });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// AnalysisComplete
// ---------------------------------------------------------------------------

describe("stackedReducer — AnalysisComplete", () => {
  it("Analyzing + issues → Reporting with warning", () => {
    const issues: StackIssue[] = [
      { type: "leaked-commit", branch: "feat/auth-ui", details: "commit abc leaked" },
    ];
    const r = stackedReducer(analyzing(), { _tag: "AnalysisComplete", issues });
    expect(r.state._tag).toBe("Reporting");
    if (r.state._tag === "Reporting") {
      expect(r.state.issues).toHaveLength(1);
    }
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify?.level).toBe("warning");
  });

  it("Analyzing + no issues → Reporting healthy", () => {
    const r = stackedReducer(analyzing(), { _tag: "AnalysisComplete", issues: [] });
    expect(r.state._tag).toBe("Reporting");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify?.level).toBe("info");
  });

  it("non-Analyzing → no-op", () => {
    const state = idle();
    const r = stackedReducer(state, { _tag: "AnalysisComplete", issues: [] });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Dismiss / Reset
// ---------------------------------------------------------------------------

describe("stackedReducer — Dismiss", () => {
  it("non-Idle → Idle", () => {
    const r = stackedReducer(analyzing(), { _tag: "Dismiss" });
    expect(r.state._tag).toBe("Idle");
  });

  it("Idle → no-op", () => {
    const state = idle();
    const r = stackedReducer(state, { _tag: "Dismiss" });
    expect(r.state).toBe(state);
  });
});

describe("stackedReducer — Reset", () => {
  it("any → Idle", () => {
    const r = stackedReducer(analyzing(), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
  });
});

import { describe, expect, it } from "bun:test";
import { ciReducer, type CiEffect, type CiState } from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | CiEffect;

function idle(): CiState {
  return { _tag: "Idle" };
}

function watching(branch = "feat/foo", runId?: string): CiState {
  return { _tag: "Watching", branch, runId };
}

function hasEffect(effects: readonly Effect[] | undefined, type: string): boolean {
  return effects?.some((e) => e.type === type) ?? false;
}

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

describe("ciReducer — Watch", () => {
  it("Idle → Watching with polling", () => {
    const r = ciReducer(idle(), { _tag: "Watch", branch: "feat/ci" });
    expect(r.state._tag).toBe("Watching");
    if (r.state._tag === "Watching") {
      expect(r.state.branch).toBe("feat/ci");
    }
    expect(hasEffect(r.effects, "startPolling")).toBe(true);
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("already Watching → no-op", () => {
    const state = watching();
    const r = ciReducer(state, { _tag: "Watch", branch: "other" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// RunDetected
// ---------------------------------------------------------------------------

describe("ciReducer — RunDetected", () => {
  it("Watching → Watching with runId", () => {
    const r = ciReducer(watching(), { _tag: "RunDetected", runId: "123" });
    expect(r.state._tag).toBe("Watching");
    if (r.state._tag === "Watching") {
      expect(r.state.runId).toBe("123");
    }
  });

  it("non-Watching → no-op", () => {
    const state = idle();
    const r = ciReducer(state, { _tag: "RunDetected", runId: "123" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// RunPassed / RunFailed
// ---------------------------------------------------------------------------

describe("ciReducer — RunPassed", () => {
  it("Watching → Passed with stop polling", () => {
    const r = ciReducer(watching(), { _tag: "RunPassed", runId: "456" });
    expect(r.state._tag).toBe("Passed");
    if (r.state._tag === "Passed") {
      expect(r.state.runId).toBe("456");
    }
    expect(hasEffect(r.effects, "stopPolling")).toBe(true);
    expect(hasEffect(r.effects, "notify")).toBe(true);
  });
});

describe("ciReducer — RunFailed", () => {
  it("Watching → Failed with output", () => {
    const r = ciReducer(watching(), { _tag: "RunFailed", runId: "789", output: "lint error" });
    expect(r.state._tag).toBe("Failed");
    if (r.state._tag === "Failed") {
      expect(r.state.runId).toBe("789");
      expect(r.state.output).toBe("lint error");
    }
    expect(hasEffect(r.effects, "stopPolling")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dismiss / Reset
// ---------------------------------------------------------------------------

describe("ciReducer — Dismiss", () => {
  it("any non-Idle → Idle", () => {
    const r = ciReducer(watching(), { _tag: "Dismiss" });
    expect(r.state._tag).toBe("Idle");
    expect(hasEffect(r.effects, "stopPolling")).toBe(true);
  });

  it("Idle → no-op", () => {
    const state = idle();
    const r = ciReducer(state, { _tag: "Dismiss" });
    expect(r.state).toBe(state);
  });
});

describe("ciReducer — Reset", () => {
  it("any → Idle", () => {
    const r = ciReducer(watching("main", "123"), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
    expect(hasEffect(r.effects, "stopPolling")).toBe(true);
  });
});

import { describe, expect, it } from "bun:test";
import {
  breakoutReducer,
  type BreakoutEffect,
  type BreakoutSlice,
  type BreakoutState,
} from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | BreakoutEffect;

const SLICES: BreakoutSlice[] = [
  { name: "auth-core", files: ["src/auth.ts", "src/token.ts"], description: "Auth service core" },
  { name: "auth-ui", files: ["src/login.tsx"], description: "Auth UI components" },
];

function idle(): BreakoutState {
  return { _tag: "Idle" };
}

function planning(): BreakoutState {
  return { _tag: "Planning", sourceBranch: "feat/auth", slices: SLICES };
}

function executing(currentSlice = 0): BreakoutState {
  return { _tag: "Executing", slices: SLICES, currentSlice, results: [] };
}

function hasEffect(effects: readonly Effect[] | undefined, type: string): boolean {
  return effects?.some((e) => e.type === type) ?? false;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

describe("breakoutReducer — Plan", () => {
  it("Idle → Planning", () => {
    const r = breakoutReducer(idle(), { _tag: "Plan", sourceBranch: "feat/auth", slices: SLICES });
    expect(r.state._tag).toBe("Planning");
    if (r.state._tag === "Planning") {
      expect(r.state.slices).toHaveLength(2);
    }
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    expect(hasEffect(r.effects, "notify")).toBe(true);
  });

  it("non-Idle → no-op", () => {
    const state = planning();
    const r = breakoutReducer(state, { _tag: "Plan", sourceBranch: "x", slices: SLICES });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

describe("breakoutReducer — Confirm", () => {
  it("Planning → Executing first slice", () => {
    const r = breakoutReducer(planning(), { _tag: "Confirm" });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.currentSlice).toBe(0);
    }
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
  });

  it("non-Planning → no-op", () => {
    const state = idle();
    const r = breakoutReducer(state, { _tag: "Confirm" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// SliceDone
// ---------------------------------------------------------------------------

describe("breakoutReducer — SliceDone", () => {
  it("first slice done → advances to next", () => {
    const r = breakoutReducer(executing(0), {
      _tag: "SliceDone",
      result: { name: "auth-core", success: true },
    });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.currentSlice).toBe(1);
      expect(r.state.results).toHaveLength(1);
    }
  });

  it("last slice done → Done", () => {
    const state: BreakoutState = {
      _tag: "Executing",
      slices: SLICES,
      currentSlice: 1,
      results: [{ name: "auth-core", success: true }],
    };
    const r = breakoutReducer(state, {
      _tag: "SliceDone",
      result: { name: "auth-ui", success: true },
    });
    expect(r.state._tag).toBe("Done");
    if (r.state._tag === "Done") {
      expect(r.state.results).toHaveLength(2);
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
  });

  it("non-Executing → no-op", () => {
    const state = idle();
    const r = breakoutReducer(state, {
      _tag: "SliceDone",
      result: { name: "x", success: true },
    });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Cancel / Reset
// ---------------------------------------------------------------------------

describe("breakoutReducer — Cancel", () => {
  it("Executing → Done (preserves results)", () => {
    const state: BreakoutState = {
      _tag: "Executing",
      slices: SLICES,
      currentSlice: 1,
      results: [{ name: "auth-core", success: true }],
    };
    const r = breakoutReducer(state, { _tag: "Cancel" });
    expect(r.state._tag).toBe("Done");
    if (r.state._tag === "Done") {
      expect(r.state.results).toHaveLength(1);
    }
  });

  it("Planning → Idle", () => {
    const r = breakoutReducer(planning(), { _tag: "Cancel" });
    expect(r.state._tag).toBe("Idle");
  });

  it("Idle → no-op", () => {
    const state = idle();
    const r = breakoutReducer(state, { _tag: "Cancel" });
    expect(r.state).toBe(state);
  });
});

describe("breakoutReducer — Reset", () => {
  it("any → Idle", () => {
    const r = breakoutReducer(executing(), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
  });
});

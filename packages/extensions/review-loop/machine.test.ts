import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MAX_ITERATIONS,
  REVIEW_LOOP_RESULT_TOOL,
  reviewReducer,
  type PersistPayload,
  type ReviewEffect,
  type ReviewState,
} from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inactive(max = DEFAULT_MAX_ITERATIONS): ReviewState {
  return { _tag: "Inactive", maxIterations: max };
}

function reviewing(
  iteration = 0,
  max = DEFAULT_MAX_ITERATIONS,
  scope: "diff" | "paths" = "diff",
): ReviewState {
  return {
    _tag: "Reviewing",
    maxIterations: max,
    iteration,
    userPrompt: "check for bugs",
    scope,
    diffStat: scope === "diff" ? " 2 files changed" : "",
    targetPaths: ["src/app.ts", "src/lib.ts"],
  };
}

type Effect = BuiltinEffect | ReviewEffect;

function hasEffect(effects: readonly Effect[] | undefined, type: string): boolean {
  return effects?.some((e) => e.type === type) ?? false;
}

function getEffect<T extends Effect>(
  effects: readonly Effect[] | undefined,
  type: string,
): T | undefined {
  return effects?.find((e) => e.type === type) as T | undefined;
}

function getPersistPayload(effects: readonly Effect[] | undefined): PersistPayload | undefined {
  return getEffect<ReviewEffect & { type: "persistState" }>(effects, "persistState")?.state;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

describe("reviewReducer — Start", () => {
  it("Inactive → Reviewing", () => {
    const r = reviewReducer(inactive(), {
      _tag: "Start",
      prompt: "check it",
      scope: "diff",
      diffStat: " 2 files changed",
      targetPaths: ["a.ts", "b.ts"],
    });
    expect(r.state._tag).toBe("Reviewing");
    if (r.state._tag === "Reviewing") {
      expect(r.state.iteration).toBe(0);
      expect(r.state.userPrompt).toBe("check it");
      expect(r.state.scope).toBe("diff");
      expect(r.state.targetPaths).toEqual(["a.ts", "b.ts"]);
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(hasEffect(r.effects, "sendUserMessage")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({
      mode: "Reviewing",
      iteration: 0,
      userPrompt: "check it",
      scope: "diff",
      targetPaths: ["a.ts", "b.ts"],
    });
  });

  it("includes diff scope in the initial follow-up prompt", () => {
    const r = reviewReducer(inactive(), {
      _tag: "Start",
      prompt: "",
      scope: "diff",
      diffStat: " 2 files changed",
      targetPaths: ["a.ts", "b.ts"],
    });
    expect(getEffect<BuiltinEffect>(r.effects, "sendUserMessage")).toMatchObject({
      content: expect.stringContaining("Changed files: a.ts, b.ts"),
    });
  });

  it("Reviewing + Start is no-op", () => {
    const state = reviewing();
    const r = reviewReducer(state, {
      _tag: "Start",
      prompt: "x",
      scope: "diff",
      diffStat: "",
      targetPaths: [],
    });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// IterationResult
// ---------------------------------------------------------------------------

describe("reviewReducer — IterationResult", () => {
  it("done → Inactive", () => {
    const r = reviewReducer(reviewing(), { _tag: "IterationResult", outcome: "done" });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect(r.effects, "notify")!).toMatchObject({
      message: expect.stringContaining("no further issues"),
    });
  });

  it("continue → advances loop", () => {
    const r = reviewReducer(reviewing(0), { _tag: "IterationResult", outcome: "continue" });
    expect(r.state._tag).toBe("Reviewing");
    if (r.state._tag === "Reviewing") {
      expect(r.state.iteration).toBe(1);
    }
    expect(hasEffect(r.effects, "sendUserMessage")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({ mode: "Reviewing", iteration: 1 });
  });

  it("max iterations → Inactive", () => {
    const r = reviewReducer(reviewing(4, 5), { _tag: "IterationResult", outcome: "continue" });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect(r.effects, "notify")!).toMatchObject({
      message: expect.stringContaining("max iterations"),
    });
  });

  it("missing tool signal → Inactive error", () => {
    const r = reviewReducer(reviewing(), { _tag: "IterationSignalMissing" });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect(r.effects, "notify")!).toMatchObject({
      level: "error",
      message: expect.stringContaining(REVIEW_LOOP_RESULT_TOOL),
    });
  });

  it("Inactive + IterationResult is no-op", () => {
    const state = inactive();
    const r = reviewReducer(state, { _tag: "IterationResult", outcome: "done" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// UserInterrupt / Exit
// ---------------------------------------------------------------------------

describe("reviewReducer — UserInterrupt / Exit", () => {
  it("UserInterrupt → Inactive", () => {
    const r = reviewReducer(reviewing(), { _tag: "UserInterrupt" });
    expect(r.state._tag).toBe("Inactive");
  });

  it("Exit → Inactive", () => {
    const r = reviewReducer(reviewing(), { _tag: "Exit" });
    expect(r.state._tag).toBe("Inactive");
  });

  it("UserInterrupt from Inactive is no-op", () => {
    const state = inactive();
    expect(reviewReducer(state, { _tag: "UserInterrupt" }).state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// SetMax
// ---------------------------------------------------------------------------

describe("reviewReducer — SetMax", () => {
  it("updates maxIterations on Inactive and notifies", () => {
    const r = reviewReducer(inactive(), { _tag: "SetMax", max: 10 });
    expect(r.state._tag).toBe("Inactive");
    expect(r.state.maxIterations).toBe(10);
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({ mode: "Inactive", maxIterations: 10 });
  });

  it("updates maxIterations on Reviewing", () => {
    const r = reviewReducer(reviewing(2, 5), { _tag: "SetMax", max: 20 });
    expect(r.state._tag).toBe("Reviewing");
    expect(r.state.maxIterations).toBe(20);
    expect(getPersistPayload(r.effects)).toMatchObject({ mode: "Reviewing", maxIterations: 20 });
  });
});

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

describe("reviewReducer — Hydrate", () => {
  it("restores Reviewing state", () => {
    const r = reviewReducer(inactive(), {
      _tag: "Hydrate",
      mode: "Reviewing",
      maxIterations: 7,
      iteration: 2,
      userPrompt: "check effect stuff",
      scope: "paths",
      diffStat: "",
      targetPaths: ["packages/core/fs"],
    });
    expect(r.state).toEqual({
      _tag: "Reviewing",
      maxIterations: 7,
      iteration: 2,
      userPrompt: "check effect stuff",
      scope: "paths",
      diffStat: "",
      targetPaths: ["packages/core/fs"],
    });
    expect(getEffect<BuiltinEffect>(r.effects, "setStatus")).toMatchObject({
      key: "review-loop",
      text: "🔄 review 3/7",
    });
  });

  it("restores Inactive with persisted maxIterations", () => {
    const r = reviewReducer(inactive(), {
      _tag: "Hydrate",
      mode: "Inactive",
      maxIterations: 9,
    });
    expect(r.state).toEqual({ _tag: "Inactive", maxIterations: 9 });
    expect(getEffect<BuiltinEffect>(r.effects, "setStatus")).toMatchObject({ key: "review-loop" });
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("reviewReducer — Reset", () => {
  it("any state → Inactive (preserves maxIterations)", () => {
    const r = reviewReducer(reviewing(3, 10), { _tag: "Reset" });
    expect(r.state._tag).toBe("Inactive");
    expect(r.state.maxIterations).toBe(10);
  });
});

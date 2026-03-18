import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MAX_ITERATIONS,
  hasExitPhrase,
  hasIssuesFixed,
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

function getEffect<T extends Effect>(effects: readonly Effect[] | undefined, type: string): T | undefined {
  return effects?.find((e) => e.type === type) as T | undefined;
}

function getPersistPayload(effects: readonly Effect[] | undefined): PersistPayload | undefined {
  return getEffect<ReviewEffect & { type: "persistState" }>(effects, "persistState")?.state;
}

// ---------------------------------------------------------------------------
// Exit phrase detection
// ---------------------------------------------------------------------------

describe("exit/fix phrase detection", () => {
  it("detects exit phrases", () => {
    expect(hasExitPhrase("No issues found.")).toBe(true);
    expect(hasExitPhrase("LGTM")).toBe(true);
    expect(hasExitPhrase("All good!")).toBe(true);
    expect(hasExitPhrase("random text")).toBe(false);
  });

  it("detects fix phrases", () => {
    expect(hasIssuesFixed("I fixed the bug")).toBe(true);
    expect(hasIssuesFixed("Addressed all concerns")).toBe(true);
    expect(hasIssuesFixed("random text")).toBe(false);
  });
});

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
// AgentEnd
// ---------------------------------------------------------------------------

describe("reviewReducer — AgentEnd", () => {
  it("exit phrase without fixed → Inactive (done)", () => {
    const r = reviewReducer(reviewing(), { _tag: "AgentEnd", text: "No issues found." });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect(r.effects, "notify")!).toMatchObject({
      message: expect.stringContaining("no issues"),
    });
  });

  it("exit phrase WITH fixed → continues loop", () => {
    const r = reviewReducer(reviewing(0), {
      _tag: "AgentEnd",
      text: "Fixed the bug. No issues found.",
    });
    expect(r.state._tag).toBe("Reviewing");
    if (r.state._tag === "Reviewing") {
      expect(r.state.iteration).toBe(1);
    }
  });

  it("no exit phrase → continues loop", () => {
    const r = reviewReducer(reviewing(0), { _tag: "AgentEnd", text: "I made some changes." });
    expect(r.state._tag).toBe("Reviewing");
    if (r.state._tag === "Reviewing") {
      expect(r.state.iteration).toBe(1);
    }
    expect(hasEffect(r.effects, "sendUserMessage")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({ mode: "Reviewing", iteration: 1 });
  });

  it("max iterations → Inactive", () => {
    const r = reviewReducer(reviewing(4, 5), { _tag: "AgentEnd", text: "Still working" });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect(r.effects, "notify")!).toMatchObject({
      message: expect.stringContaining("max iterations"),
    });
  });

  it("empty text → Inactive (aborted)", () => {
    const r = reviewReducer(reviewing(), { _tag: "AgentEnd", text: "" });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect(r.effects, "notify")!).toMatchObject({
      message: expect.stringContaining("aborted"),
    });
  });

  it("Inactive + AgentEnd is no-op", () => {
    const state = inactive();
    const r = reviewReducer(state, { _tag: "AgentEnd", text: "whatever" });
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

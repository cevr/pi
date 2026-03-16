import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MAX_ITERATIONS,
  hasExitPhrase,
  hasIssuesFixed,
  reviewReducer,
  type ReviewState,
} from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inactive(max = DEFAULT_MAX_ITERATIONS): ReviewState {
  return { _tag: "Inactive", maxIterations: max };
}

function reviewing(iteration = 0, max = DEFAULT_MAX_ITERATIONS): ReviewState {
  return { _tag: "Reviewing", maxIterations: max, iteration, userPrompt: "check for bugs" };
}

function hasEffect(effects: readonly BuiltinEffect[] | undefined, type: string): boolean {
  return effects?.some((e) => e.type === type) ?? false;
}

function getEffect<T extends BuiltinEffect>(
  effects: readonly BuiltinEffect[] | undefined,
  type: string,
): T | undefined {
  return effects?.find((e) => e.type === type) as T | undefined;
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
    const r = reviewReducer(inactive(), { _tag: "Start", prompt: "check it" });
    expect(r.state._tag).toBe("Reviewing");
    if (r.state._tag === "Reviewing") {
      expect(r.state.iteration).toBe(0);
      expect(r.state.userPrompt).toBe("check it");
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(hasEffect(r.effects, "sendUserMessage")).toBe(true);
  });

  it("Reviewing + Start is no-op", () => {
    const state = reviewing();
    const r = reviewReducer(state, { _tag: "Start", prompt: "x" });
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
  });

  it("updates maxIterations on Reviewing", () => {
    const r = reviewReducer(reviewing(2, 5), { _tag: "SetMax", max: 20 });
    expect(r.state._tag).toBe("Reviewing");
    expect(r.state.maxIterations).toBe(20);
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

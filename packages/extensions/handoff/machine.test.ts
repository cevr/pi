import { describe, expect, it } from "bun:test";
import { handoffReducer, type HandoffState, type HandoffEffect } from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | HandoffEffect;

function idle(): HandoffState {
  return { _tag: "Idle" };
}

function generating(parentSessionFile = "/sessions/parent.jsonl"): HandoffState {
  return { _tag: "Generating", parentSessionFile };
}

function ready(
  prompt = "continue the task",
  parentSessionFile = "/sessions/parent.jsonl",
): HandoffState {
  return { _tag: "Ready", prompt, parentSessionFile };
}

function switching(
  prompt = "continue the task",
  parentSessionFile = "/sessions/parent.jsonl",
): HandoffState {
  return { _tag: "Switching", prompt, parentSessionFile };
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
// GenerateStart
// ---------------------------------------------------------------------------

describe("handoffReducer — GenerateStart", () => {
  it("Idle → Generating", () => {
    const r = handoffReducer(idle(), {
      _tag: "GenerateStart",
      parentSessionFile: "/sessions/p.jsonl",
    });
    expect(r.state).toEqual({ _tag: "Generating", parentSessionFile: "/sessions/p.jsonl" });
  });

  it("Generating + GenerateStart is no-op", () => {
    const state = generating();
    const r = handoffReducer(state, {
      _tag: "GenerateStart",
      parentSessionFile: "/sessions/other.jsonl",
    });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// GenerateComplete
// ---------------------------------------------------------------------------

describe("handoffReducer — GenerateComplete", () => {
  it("Generating → Ready with effects", () => {
    const r = handoffReducer(generating("/sessions/p.jsonl"), {
      _tag: "GenerateComplete",
      prompt: "the handoff prompt",
    });
    expect(r.state).toEqual({
      _tag: "Ready",
      prompt: "the handoff prompt",
      parentSessionFile: "/sessions/p.jsonl",
    });
    expect(hasEffect(r.effects, "setEditorText")).toBe(true);
    expect(hasEffect(r.effects, "setEditorLabel")).toBe(true);
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    expect(hasEffect(r.effects, "notify")).toBe(true);
  });

  it("Idle + GenerateComplete is no-op", () => {
    const state = idle();
    const r = handoffReducer(state, { _tag: "GenerateComplete", prompt: "x" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// GenerateFail
// ---------------------------------------------------------------------------

describe("handoffReducer — GenerateFail", () => {
  it("Generating → Idle with error notify", () => {
    const r = handoffReducer(generating(), { _tag: "GenerateFail", error: "timeout" });
    expect(r.state).toEqual({ _tag: "Idle" });
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({
      message: expect.stringContaining("timeout"),
      level: "error",
    });
  });

  it("Idle + GenerateFail is no-op", () => {
    const state = idle();
    const r = handoffReducer(state, { _tag: "GenerateFail", error: "err" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// ManualReady
// ---------------------------------------------------------------------------

describe("handoffReducer — ManualReady", () => {
  it("Idle → Ready with effects", () => {
    const r = handoffReducer(idle(), {
      _tag: "ManualReady",
      prompt: "manual prompt",
      parentSessionFile: "/sessions/m.jsonl",
    });
    expect(r.state).toEqual({
      _tag: "Ready",
      prompt: "manual prompt",
      parentSessionFile: "/sessions/m.jsonl",
    });
    expect(hasEffect(r.effects, "setEditorText")).toBe(true);
    expect(hasEffect(r.effects, "setEditorLabel")).toBe(true);
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("overwrites existing Ready state", () => {
    const r = handoffReducer(ready("old", "/sessions/old.jsonl"), {
      _tag: "ManualReady",
      prompt: "new prompt",
      parentSessionFile: "/sessions/new.jsonl",
    });
    expect(r.state).toEqual({
      _tag: "Ready",
      prompt: "new prompt",
      parentSessionFile: "/sessions/new.jsonl",
    });
  });
});

// ---------------------------------------------------------------------------
// SwitchStart
// ---------------------------------------------------------------------------

describe("handoffReducer — SwitchStart", () => {
  it("Ready → Switching, clears status + label", () => {
    const r = handoffReducer(ready("p", "/sessions/x.jsonl"), { _tag: "SwitchStart" });
    expect(r.state).toEqual({
      _tag: "Switching",
      prompt: "p",
      parentSessionFile: "/sessions/x.jsonl",
    });
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    expect(hasEffect(r.effects, "removeEditorLabel")).toBe(true);
  });

  it("Idle + SwitchStart is no-op", () => {
    const state = idle();
    const r = handoffReducer(state, { _tag: "SwitchStart" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// SwitchComplete
// ---------------------------------------------------------------------------

describe("handoffReducer — SwitchComplete", () => {
  it("Switching → Idle", () => {
    const r = handoffReducer(switching(), { _tag: "SwitchComplete" });
    expect(r.state).toEqual({ _tag: "Idle" });
  });

  it("Ready + SwitchComplete is no-op", () => {
    const state = ready();
    const r = handoffReducer(state, { _tag: "SwitchComplete" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// SwitchCancelled
// ---------------------------------------------------------------------------

describe("handoffReducer — SwitchCancelled", () => {
  it("Switching → Ready, restores status + label", () => {
    const r = handoffReducer(switching("p", "/sessions/x.jsonl"), { _tag: "SwitchCancelled" });
    expect(r.state).toEqual({
      _tag: "Ready",
      prompt: "p",
      parentSessionFile: "/sessions/x.jsonl",
    });
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    expect(hasEffect(r.effects, "setEditorLabel")).toBe(true);
  });

  it("Ready + SwitchCancelled is no-op", () => {
    const state = ready();
    const r = handoffReducer(state, { _tag: "SwitchCancelled" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("handoffReducer — Reset", () => {
  it("any state → Idle with cleanup effects", () => {
    const r = handoffReducer(ready(), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
    expect(hasEffect(r.effects, "removeEditorLabel")).toBe(true);
    expect(hasEffect(r.effects, "clearWidget")).toBe(true);
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("Generating → Idle on Reset", () => {
    const r = handoffReducer(generating(), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
  });

  it("Switching → Idle on Reset", () => {
    const r = handoffReducer(switching(), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
  });
});

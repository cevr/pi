import { describe, expect, it } from "bun:test";
import { handoffReducer, type HandoffEffect, type HandoffState } from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

type Effect = BuiltinEffect | HandoffEffect;

function idle(): HandoffState {
  return { _tag: "Idle" };
}

function generating(parentSessionFile = "/sessions/parent.jsonl"): HandoffState {
  return { _tag: "Generating", parentSessionFile };
}

function switching(parentSessionFile = "/sessions/parent.jsonl"): HandoffState {
  return { _tag: "Switching", parentSessionFile };
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

describe("handoffReducer — GenerateComplete", () => {
  it("Generating → Idle and clears status", () => {
    const r = handoffReducer(generating("/sessions/p.jsonl"), {
      _tag: "GenerateComplete",
    });
    expect(r.state).toEqual({ _tag: "Idle" });
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("Idle + GenerateComplete is no-op", () => {
    const state = idle();
    const r = handoffReducer(state, { _tag: "GenerateComplete" });
    expect(r.state).toBe(state);
  });
});

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

describe("handoffReducer — SwitchStart", () => {
  it("Idle → Switching", () => {
    const r = handoffReducer(idle(), {
      _tag: "SwitchStart",
      parentSessionFile: "/sessions/x.jsonl",
    });
    expect(r.state).toEqual({
      _tag: "Switching",
      parentSessionFile: "/sessions/x.jsonl",
    });
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("Switching + SwitchStart is no-op", () => {
    const state = switching();
    const r = handoffReducer(state, {
      _tag: "SwitchStart",
      parentSessionFile: "/sessions/other.jsonl",
    });
    expect(r.state).toBe(state);
  });
});

describe("handoffReducer — SwitchComplete", () => {
  it("Switching → Idle", () => {
    const r = handoffReducer(switching(), { _tag: "SwitchComplete" });
    expect(r.state).toEqual({ _tag: "Idle" });
  });

  it("Idle + SwitchComplete is no-op", () => {
    const state = idle();
    const r = handoffReducer(state, { _tag: "SwitchComplete" });
    expect(r.state).toBe(state);
  });
});

describe("handoffReducer — SwitchCancelled", () => {
  it("Switching → Idle and clears status", () => {
    const r = handoffReducer(switching("/sessions/x.jsonl"), { _tag: "SwitchCancelled" });
    expect(r.state).toEqual({ _tag: "Idle" });
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("Idle + SwitchCancelled is no-op", () => {
    const state = idle();
    const r = handoffReducer(state, { _tag: "SwitchCancelled" });
    expect(r.state).toBe(state);
  });
});

describe("handoffReducer — Reset", () => {
  it("any state → Idle with cleanup effects", () => {
    const r = handoffReducer(generating(), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
    expect(hasEffect(r.effects, "removeEditorLabel")).toBe(true);
    expect(hasEffect(r.effects, "clearWidget")).toBe(true);
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
  });

  it("Switching → Idle on Reset", () => {
    const r = handoffReducer(switching(), { _tag: "Reset" });
    expect(r.state).toEqual({ _tag: "Idle" });
  });
});

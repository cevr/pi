import { describe, expect, it } from "bun:test";
import {
  MAX_CONCERNS,
  auditReducer,
  type AuditConcern,
  type AuditEffect,
  type AuditState,
  type SkillCatalogEntry,
} from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | AuditEffect;

const CATALOG: SkillCatalogEntry[] = [
  { name: "react", description: "React patterns" },
  { name: "effect-v4", description: "Effect TS v4" },
  { name: "code-style", description: "Code style" },
];

const CONCERNS: AuditConcern[] = [
  { name: "correctness", description: "Bugs and soundness", skills: ["code-review"] },
  { name: "frontend", description: "React patterns", skills: ["react", "ui"] },
];

function idle(): AuditState {
  return { _tag: "Idle" };
}

function detecting(userPrompt = ""): AuditState {
  return {
    _tag: "Detecting",
    diffStat: " 3 files changed",
    changedFiles: ["src/app.tsx", "src/lib.ts"],
    skillCatalog: CATALOG,
    userPrompt,
  };
}

function auditing(concerns = CONCERNS): AuditState {
  return {
    _tag: "Auditing",
    concerns,
    diffStat: " 3 files changed",
    changedFiles: ["src/app.tsx", "src/lib.ts"],
    userPrompt: "",
  };
}

function synthesizing(concerns = CONCERNS): AuditState {
  return { _tag: "Synthesizing", concerns, userPrompt: "" };
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
// Start
// ---------------------------------------------------------------------------

describe("auditReducer — Start", () => {
  it("Idle → Detecting with trigger + status + UI", () => {
    const r = auditReducer(idle(), {
      _tag: "Start",
      diffStat: " 2 files changed",
      changedFiles: ["a.ts", "b.tsx"],
      skillCatalog: CATALOG,
      userPrompt: "check react",
    });
    expect(r.state._tag).toBe("Detecting");
    if (r.state._tag === "Detecting") {
      expect(r.state.changedFiles).toEqual(["a.ts", "b.tsx"]);
      expect(r.state.userPrompt).toBe("check react");
    }
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
  });

  it("non-Idle + Start is no-op", () => {
    const state = detecting();
    const r = auditReducer(state, {
      _tag: "Start",
      diffStat: "",
      changedFiles: [],
      skillCatalog: [],
      userPrompt: "",
    });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// ConcernsDetected
// ---------------------------------------------------------------------------

describe("auditReducer — ConcernsDetected", () => {
  it("Detecting + concerns → Auditing", () => {
    const r = auditReducer(detecting(), { _tag: "ConcernsDetected", concerns: CONCERNS });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.concerns).toEqual(CONCERNS);
    }
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
  });

  it("Detecting + empty concerns → Idle with notify", () => {
    const r = auditReducer(detecting(), { _tag: "ConcernsDetected", concerns: [] });
    expect(r.state._tag).toBe("Idle");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({ message: expect.stringContaining("no audit concerns") });
  });

  it("caps concerns at MAX_CONCERNS", () => {
    const many: AuditConcern[] = Array.from({ length: 10 }, (_, i) => ({
      name: `concern-${i}`,
      description: `desc ${i}`,
      skills: [],
    }));
    const r = auditReducer(detecting(), { _tag: "ConcernsDetected", concerns: many });
    if (r.state._tag === "Auditing") {
      expect(r.state.concerns).toHaveLength(MAX_CONCERNS);
    }
  });

  it("non-Detecting + ConcernsDetected is no-op", () => {
    const state = auditing();
    const r = auditReducer(state, { _tag: "ConcernsDetected", concerns: CONCERNS });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// DetectionFailed
// ---------------------------------------------------------------------------

describe("auditReducer — DetectionFailed", () => {
  it("Detecting → Idle with error notify", () => {
    const r = auditReducer(detecting(), { _tag: "DetectionFailed" });
    expect(r.state._tag).toBe("Idle");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({ level: "error" });
  });

  it("non-Detecting + DetectionFailed is no-op", () => {
    const state = idle();
    const r = auditReducer(state, { _tag: "DetectionFailed" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// AuditingComplete
// ---------------------------------------------------------------------------

describe("auditReducer — AuditingComplete", () => {
  it("Auditing → Synthesizing", () => {
    const r = auditReducer(auditing(), { _tag: "AuditingComplete" });
    expect(r.state._tag).toBe("Synthesizing");
    if (r.state._tag === "Synthesizing") {
      expect(r.state.concerns).toEqual(CONCERNS);
    }
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
  });

  it("non-Auditing + AuditingComplete is no-op", () => {
    const state = detecting();
    const r = auditReducer(state, { _tag: "AuditingComplete" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// SynthesisComplete
// ---------------------------------------------------------------------------

describe("auditReducer — SynthesisComplete", () => {
  it("Synthesizing → Idle with notify", () => {
    const r = auditReducer(synthesizing(), { _tag: "SynthesisComplete" });
    expect(r.state._tag).toBe("Idle");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({ message: "audit complete" });
  });

  it("non-Synthesizing + SynthesisComplete is no-op", () => {
    const state = auditing();
    const r = auditReducer(state, { _tag: "SynthesisComplete" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe("auditReducer — Cancel", () => {
  it("Detecting → Idle", () => {
    const r = auditReducer(detecting(), { _tag: "Cancel" });
    expect(r.state._tag).toBe("Idle");
    expect(hasEffect(r.effects, "notify")).toBe(true);
  });

  it("Auditing → Idle", () => {
    const r = auditReducer(auditing(), { _tag: "Cancel" });
    expect(r.state._tag).toBe("Idle");
  });

  it("Synthesizing → Idle", () => {
    const r = auditReducer(synthesizing(), { _tag: "Cancel" });
    expect(r.state._tag).toBe("Idle");
  });

  it("Idle + Cancel is no-op", () => {
    const state = idle();
    const r = auditReducer(state, { _tag: "Cancel" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("auditReducer — Reset", () => {
  it("any state → Idle", () => {
    for (const state of [detecting(), auditing(), synthesizing()]) {
      const r = auditReducer(state, { _tag: "Reset" });
      expect(r.state).toEqual({ _tag: "Idle" });
      expect(hasEffect(r.effects, "setStatus")).toBe(true);
      expect(hasEffect(r.effects, "updateUI")).toBe(true);
    }
  });
});

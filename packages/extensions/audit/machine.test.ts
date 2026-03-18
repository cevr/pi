import { describe, expect, it } from "bun:test";
import type { ExecutionEffect } from "@cvr/pi-execution";
import {
  MAX_CONCERNS,
  auditReducer,
  type AuditConcern,
  type AuditConcernTask,
  type AuditEffect,
  type AuditFinding,
  type AuditState,
  type FixPhase,
  type PersistPayload,
  type SkillCatalogEntry,
} from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | ExecutionEffect | AuditEffect;

const CATALOG: SkillCatalogEntry[] = [
  { name: "react", description: "React patterns" },
  { name: "effect-v4", description: "Effect TS v4" },
  { name: "code-style", description: "Code style" },
];

const CONCERNS: AuditConcern[] = [
  { name: "correctness", description: "Bugs and soundness", skills: ["code-review"] },
  { name: "frontend", description: "React patterns", skills: ["react", "ui"] },
];

const FINDINGS: AuditFinding[] = [
  { file: "src/app.tsx", description: "Missing null check", severity: "critical" },
  { file: "src/lib.ts", description: "Unused import", severity: "warning" },
  { file: "src/utils.ts", description: "Consider memoizing", severity: "suggestion" },
];

function idle(): AuditState {
  return { _tag: "Idle" };
}

function detecting(userPrompt = "", scope: "diff" | "paths" = "diff"): AuditState {
  return {
    _tag: "Detecting",
    scope,
    diffStat: scope === "diff" ? " 3 files changed" : "",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    skillCatalog: CATALOG,
    userPrompt,
  };
}

function createConcernTasks(
  concerns = CONCERNS,
  currentConcern = 1,
): AuditConcernTask[] {
  return concerns.map((concern, index) => ({
    id: String(index + 1),
    order: index + 1,
    subject: concern.name,
    activeForm: `Auditing ${concern.name}`,
    status: index + 1 === currentConcern ? "in_progress" : "pending",
    blockedBy: [],
    metadata: {
      description: concern.description,
      skills: concern.skills,
    },
  }));
}

function createConcernCursor(currentConcern = 1, total = CONCERNS.length) {
  const concernId = String(currentConcern);
  return {
    phase: "running" as const,
    frontierTaskIds: [concernId],
    activeTaskIds: [concernId],
    total,
  };
}

function auditing(
  concerns = createConcernTasks(),
  scope: "diff" | "paths" = "diff",
  currentConcern = 1,
): AuditState {
  return {
    _tag: "Auditing",
    scope,
    concerns,
    diffStat: scope === "diff" ? " 3 files changed" : "",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    userPrompt: "",
    cursor: createConcernCursor(currentConcern, concerns.length),
  };
}

function synthesizing(concerns = createConcernTasks(CONCERNS, CONCERNS.length)): AuditState {
  return { _tag: "Synthesizing", concerns, userPrompt: "" };
}

function fixing(findings = FINDINGS, currentFinding = 0, phase: FixPhase = "running"): AuditState {
  return {
    _tag: "Fixing",
    concerns: createConcernTasks(CONCERNS, CONCERNS.length),
    findings,
    currentFinding,
    phase,
  };
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

function getPersistPayload(effects: readonly Effect[] | undefined): PersistPayload | undefined {
  return getEffect<AuditEffect & { type: "persistState" }>(effects, "persistState")?.state;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

describe("auditReducer — Start", () => {
  it("Idle → Detecting with trigger + status + UI", () => {
    const r = auditReducer(idle(), {
      _tag: "Start",
      scope: "diff",
      diffStat: " 2 files changed",
      targetPaths: ["a.ts", "b.tsx"],
      skillCatalog: CATALOG,
      userPrompt: "check react",
    });
    expect(r.state._tag).toBe("Detecting");
    if (r.state._tag === "Detecting") {
      expect(r.state.scope).toBe("diff");
      expect(r.state.targetPaths).toEqual(["a.ts", "b.tsx"]);
      expect(r.state.userPrompt).toBe("check react");
    }
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    expect(hasEffect(r.effects, "executeTurn")).toBe(true);
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({
      mode: "Detecting",
      scope: "diff",
      targetPaths: ["a.ts", "b.tsx"],
      userPrompt: "check react",
    });
  });

  it("non-Idle + Start is no-op", () => {
    const state = detecting();
    const r = auditReducer(state, {
      _tag: "Start",
      scope: "diff",
      diffStat: "",
      targetPaths: [],
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
      expect(r.state.concerns.map((concern) => concern.subject)).toEqual(["correctness", "frontend"]);
      expect(r.state.concerns.every((concern) => concern.status === "in_progress")).toBe(true);
      expect(r.state.cursor).toEqual({
        phase: "running",
        frontierTaskIds: ["1", "2"],
        activeTaskIds: ["1", "2"],
        total: 2,
      });
    }
    const batch = getEffect<AuditEffect & { type: "runConcernBatch" }>(r.effects, "runConcernBatch");
    expect(batch?.state._tag).toBe("Auditing");
    expect(batch?.state.cursor).toEqual({
      phase: "running",
      frontierTaskIds: ["1", "2"],
      activeTaskIds: ["1", "2"],
      total: 2,
    });
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({
      mode: "Auditing",
      concernCursor: {
        phase: "running",
        frontierTaskIds: ["1", "2"],
        activeTaskIds: ["1", "2"],
        total: 2,
      },
    });
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
// ConcernAudited
// ---------------------------------------------------------------------------

describe("auditReducer — ConcernAudited", () => {
  it("Auditing → advances to the next concern batch and stores notes", () => {
    const r = auditReducer(auditing(), {
      _tag: "ConcernAudited",
      taskId: "1",
      notes: "found issues in src/app.tsx",
    });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.cursor).toEqual(createConcernCursor(2, 2));
      expect(r.state.concerns[0]!.status).toBe("completed");
      expect(r.state.concerns[0]!.metadata.notes).toBe("found issues in src/app.tsx");
      expect(r.state.concerns[1]!.status).toBe("in_progress");
    }
    const batch = getEffect<AuditEffect & { type: "runConcernBatch" }>(r.effects, "runConcernBatch");
    expect(batch?.state._tag).toBe("Auditing");
    expect(batch?.state.cursor).toEqual(createConcernCursor(2, 2));
  });

  it("last concern → Synthesizing", () => {
    const concerns = createConcernTasks(CONCERNS, 2).map((concern, index) => ({
      ...concern,
      status: index === 0 ? "completed" : concern.status,
    }));
    const r = auditReducer(auditing(concerns, "diff", 2), {
      _tag: "ConcernAudited",
      taskId: "2",
      notes: "frontend looks fine",
    });
    expect(r.state._tag).toBe("Synthesizing");
    if (r.state._tag === "Synthesizing") {
      expect(r.state.concerns.map((concern) => concern.subject)).toEqual(["correctness", "frontend"]);
      expect(r.state.concerns.every((concern) => concern.status === "completed")).toBe(true);
      expect(r.state.concerns[1]!.metadata.notes).toBe("frontend looks fine");
    }
    expect(hasEffect(r.effects, "executeTurn")).toBe(true);
  });

  it("non-Auditing + ConcernAudited is no-op", () => {
    const state = detecting();
    const r = auditReducer(state, {
      _tag: "ConcernAudited",
      taskId: "1",
      notes: "ignored",
    });
    expect(r.state).toBe(state);
  });
});

describe("auditReducer — ConcernAuditFailed", () => {
  it("Auditing → Idle with error notify", () => {
    const r = auditReducer(auditing(), {
      _tag: "ConcernAuditFailed",
      message: "audit: concern batch failed",
    });
    expect(r.state._tag).toBe("Idle");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({
      level: "error",
      message: "audit: concern batch failed",
    });
  });

  it("non-Auditing + ConcernAuditFailed is no-op", () => {
    const state = detecting();
    const r = auditReducer(state, {
      _tag: "ConcernAuditFailed",
      message: "ignored",
    });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// SynthesisComplete
// ---------------------------------------------------------------------------

describe("auditReducer — SynthesisComplete", () => {
  it("Synthesizing + findings → Fixing first finding", () => {
    const r = auditReducer(synthesizing(), { _tag: "SynthesisComplete", findings: FINDINGS });
    expect(r.state._tag).toBe("Fixing");
    if (r.state._tag === "Fixing") {
      expect(r.state.currentFinding).toBe(0);
      expect(r.state.phase).toBe("running");
      expect(r.state.findings).toEqual(FINDINGS);
    }
    expect(hasEffect(r.effects, "executeTurn")).toBe(true);
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({
      mode: "Fixing",
      currentFinding: 0,
      phase: "running",
    });
  });

  it("Synthesizing + empty findings → Idle", () => {
    const r = auditReducer(synthesizing(), { _tag: "SynthesisComplete", findings: [] });
    expect(r.state._tag).toBe("Idle");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({ message: expect.stringContaining("no findings") });
  });

  it("non-Synthesizing + SynthesisComplete is no-op", () => {
    const state = auditing();
    const r = auditReducer(state, { _tag: "SynthesisComplete", findings: FINDINGS });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Fixing — gated loop
// ---------------------------------------------------------------------------

describe("auditReducer — FindingFixed", () => {
  it("Fixing(running) → Fixing(gating)", () => {
    const r = auditReducer(fixing(), { _tag: "FindingFixed" });
    expect(r.state._tag).toBe("Fixing");
    if (r.state._tag === "Fixing") {
      expect(r.state.phase).toBe("gating");
    }
    expect(hasEffect(r.effects, "executeTurn")).toBe(true);
    expect(getPersistPayload(r.effects)).toMatchObject({ mode: "Fixing", phase: "gating" });
  });

  it("wrong phase → no-op", () => {
    const state = fixing(FINDINGS, 0, "gating");
    const r = auditReducer(state, { _tag: "FindingFixed" });
    expect(r.state).toBe(state);
  });
});

describe("auditReducer — FixSkip", () => {
  it("skips to next finding", () => {
    const r = auditReducer(fixing(), { _tag: "FixSkip" });
    expect(r.state._tag).toBe("Fixing");
    if (r.state._tag === "Fixing") {
      expect(r.state.currentFinding).toBe(1);
      expect(r.state.phase).toBe("running");
    }
    const send = getEffect<ExecutionEffect>(r.effects, "executeTurn");
    expect(send).toMatchObject({ request: { customType: "audit-fix" } });
    expect(send?.request.content).toContain("Commit the fix for src/app.tsx, then proceed.");
    expect(send?.request.content).toContain("Fix finding 2/3: [warning] src/lib.ts");
  });

  it("skipping last finding → Idle", () => {
    const r = auditReducer(fixing(FINDINGS, 2), { _tag: "FixSkip" });
    expect(r.state._tag).toBe("Idle");
    const send = getEffect<ExecutionEffect>(r.effects, "executeTurn");
    expect(send).toMatchObject({ request: { customType: "audit-commit" } });
    expect(send?.request.content).toContain("Commit the fix for src/utils.ts, then say \"AUDIT_LOOP_DONE\".");
  });
});

describe("auditReducer — FixGatePass", () => {
  it("gating → counseling", () => {
    const r = auditReducer(fixing(FINDINGS, 0, "gating"), { _tag: "FixGatePass" });
    expect(r.state._tag).toBe("Fixing");
    if (r.state._tag === "Fixing") {
      expect(r.state.phase).toBe("counseling");
    }
  });

  it("wrong phase → no-op", () => {
    const state = fixing(FINDINGS, 0, "running");
    const r = auditReducer(state, { _tag: "FixGatePass" });
    expect(r.state).toBe(state);
  });
});

describe("auditReducer — FixGateFail", () => {
  it("gating → back to running", () => {
    const r = auditReducer(fixing(FINDINGS, 0, "gating"), { _tag: "FixGateFail" });
    expect(r.state._tag).toBe("Fixing");
    if (r.state._tag === "Fixing") {
      expect(r.state.phase).toBe("running");
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
  });
});

describe("auditReducer — FixCounselPass", () => {
  it("counseling → advances to next finding", () => {
    const r = auditReducer(fixing(FINDINGS, 0, "counseling"), { _tag: "FixCounselPass" });
    expect(r.state._tag).toBe("Fixing");
    if (r.state._tag === "Fixing") {
      expect(r.state.currentFinding).toBe(1);
      expect(r.state.phase).toBe("running");
    }
    const send = getEffect<ExecutionEffect>(r.effects, "executeTurn");
    expect(send).toMatchObject({ request: { customType: "audit-fix" } });
    expect(send?.request.content).toContain("Commit the fix for src/app.tsx, then proceed.");
    expect(send?.request.content).toContain("Fix finding 2/3: [warning] src/lib.ts");
  });

  it("counseling last finding → Idle", () => {
    const r = auditReducer(fixing(FINDINGS, 2, "counseling"), { _tag: "FixCounselPass" });
    expect(r.state._tag).toBe("Idle");
    expect(hasEffect(r.effects, "notify")).toBe(true);
    const send = getEffect<ExecutionEffect>(r.effects, "executeTurn");
    expect(send).toMatchObject({ request: { customType: "audit-commit" } });
    expect(send?.request.content).toContain("Commit the fix for src/utils.ts, then say \"AUDIT_LOOP_DONE\".");
  });

  it("wrong phase → no-op", () => {
    const state = fixing(FINDINGS, 0, "running");
    const r = auditReducer(state, { _tag: "FixCounselPass" });
    expect(r.state).toBe(state);
  });
});

describe("auditReducer — FixCounselFail", () => {
  it("counseling → back to running", () => {
    const r = auditReducer(fixing(FINDINGS, 0, "counseling"), { _tag: "FixCounselFail" });
    expect(r.state._tag).toBe("Fixing");
    if (r.state._tag === "Fixing") {
      expect(r.state.phase).toBe("running");
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
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

  it("Fixing → Idle", () => {
    const r = auditReducer(fixing(), { _tag: "Cancel" });
    expect(r.state._tag).toBe("Idle");
  });

  it("Idle + Cancel is no-op", () => {
    const state = idle();
    const r = auditReducer(state, { _tag: "Cancel" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

describe("auditReducer — Hydrate", () => {
  it("restores Auditing with the persisted concern cursor", () => {
    const result = auditReducer(idle(), {
      _tag: "Hydrate",
      mode: "Auditing",
      scope: "diff",
      concerns: [
        { ...createConcernTasks()[0]!, status: "completed" },
        { ...createConcernTasks()[1]!, status: "pending" },
      ],
      diffStat: " 3 files changed",
      targetPaths: ["src/app.tsx", "src/lib.ts"],
      userPrompt: "focus on correctness",
      concernCursor: createConcernCursor(2, 2),
    });

    expect(result.state._tag).toBe("Auditing");
    if (result.state._tag === "Auditing") {
      expect(result.state.cursor).toEqual(createConcernCursor(2, 2));
      expect(result.state.concerns[0]!.status).toBe("completed");
      expect(result.state.concerns[1]!.status).toBe("in_progress");
      expect(result.state.userPrompt).toBe("focus on correctness");
    }
    const batch = getEffect<AuditEffect & { type: "runConcernBatch" }>(result.effects, "runConcernBatch");
    expect(batch?.state._tag).toBe("Auditing");
    expect(hasEffect(result.effects, "setStatus")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });

  it("restores Synthesizing with persisted concerns", () => {
    const concerns = createConcernTasks(CONCERNS, 2).map((concern) => ({
      ...concern,
      status: "completed" as const,
    }));
    const result = auditReducer(idle(), {
      _tag: "Hydrate",
      mode: "Synthesizing",
      concerns,
      userPrompt: "keep it tight",
    });

    expect(result.state).toEqual({
      _tag: "Synthesizing",
      concerns,
      userPrompt: "keep it tight",
    });
    expect(hasEffect(result.effects, "setStatus")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });

  it("restores Fixing with persisted gate phase", () => {
    const result = auditReducer(idle(), {
      _tag: "Hydrate",
      mode: "Fixing",
      concerns: createConcernTasks(CONCERNS, 2).map((concern) => ({
        ...concern,
        status: "completed" as const,
      })),
      findings: FINDINGS,
      currentFinding: 1,
      phase: "gating",
    });

    expect(result.state._tag).toBe("Fixing");
    if (result.state._tag === "Fixing") {
      expect(result.state.currentFinding).toBe(1);
      expect(result.state.phase).toBe("gating");
      expect(result.state.findings).toEqual(FINDINGS);
    }
    expect(hasEffect(result.effects, "setStatus")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("auditReducer — Reset", () => {
  it("any state → Idle", () => {
    for (const state of [detecting(), auditing(), synthesizing(), fixing()]) {
      const r = auditReducer(state, { _tag: "Reset" });
      expect(r.state).toEqual({ _tag: "Idle" });
      expect(hasEffect(r.effects, "setStatus")).toBe(true);
      expect(hasEffect(r.effects, "updateUI")).toBe(true);
    }
  });
});

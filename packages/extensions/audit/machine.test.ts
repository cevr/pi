import { describe, expect, it } from "bun:test";
import type { ExecutionEffect } from "@cvr/pi-execution";
import {
  auditReducer,
  type AuditConcern,
  type AuditConcernTask,
  type AuditEffect,
  type AuditFinding,
  type AuditState,
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
    detectionFeedback: undefined,
    previousThinkingLevel: "medium",
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: [],
    previousExecutionSessionPaths: [],
  };
}

function createConcernTasks(concerns = CONCERNS, currentConcern = 1): AuditConcernTask[] {
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

function awaitingConcernApproval(
  concerns = CONCERNS,
  scope: "diff" | "paths" = "diff",
): AuditState {
  return {
    _tag: "AwaitingConcernApproval",
    scope,
    concerns,
    diffStat: scope === "diff" ? " 3 files changed" : "",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    skillCatalog: CATALOG,
    userPrompt: "",
    detectionFeedback: undefined,
    previousThinkingLevel: "medium",
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: [],
    previousExecutionSessionPaths: [],
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
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: [],
    previousExecutionSessionPaths: [],
  };
}

function synthesizing(concerns = createConcernTasks(CONCERNS, CONCERNS.length)): AuditState {
  return {
    _tag: "Synthesizing",
    concerns,
    scope: "diff",
    diffStat: " 3 files changed",
    targetPaths: ["src/app.tsx", "src/lib.ts"],
    userPrompt: "",
    iteration: 1,
    maxIterations: 5,
    previousConcernSessionPaths: [],
    previousExecutionSessionPaths: [],
  };
}

function fixing(findings = FINDINGS): any {
  return {
    _tag: "Executing",
    ...auditing(),
    findings,
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

function getEffects<T extends Effect>(effects: readonly Effect[] | undefined, type: string): T[] {
  return (effects?.filter((e) => e.type === type) as T[]) ?? [];
}

function getPersistPayload(effects: readonly Effect[] | undefined): PersistPayload | undefined {
  return getEffect<AuditEffect & { type: "persistState" }>(effects, "persistState")?.state;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

describe("auditReducer — Start", () => {
  it("Idle → Detecting with runDetection + status + UI", () => {
    const r = auditReducer(idle(), {
      _tag: "Start",
      scope: "diff",
      diffStat: " 2 files changed",
      targetPaths: ["a.ts", "b.tsx"],
      skillCatalog: CATALOG,
      userPrompt: "check react",
      previousThinkingLevel: "medium",
    });
    expect(r.state._tag).toBe("Detecting");
    if (r.state._tag === "Detecting") {
      expect(r.state.scope).toBe("diff");
      expect(r.state.targetPaths).toEqual(["a.ts", "b.tsx"]);
      expect(r.state.userPrompt).toBe("check react");
    }
    expect(hasEffect(r.effects, "setStatus")).toBe(true);
    const turns = getEffects<ExecutionEffect>(r.effects, "executeTurn");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.request).toMatchObject({ customType: "audit-progress", triggerTurn: false });
    expect(
      getEffect<AuditEffect & { type: "runDetection" }>(r.effects, "runDetection")?.state,
    ).toMatchObject({
      _tag: "Detecting",
      userPrompt: "check react",
    });
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
      previousThinkingLevel: "medium",
    });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Concern proposal / approval
// ---------------------------------------------------------------------------

describe("auditReducer — ConcernsProposed", () => {
  it("Detecting + concerns → AwaitingConcernApproval", () => {
    const r = auditReducer(detecting("check react"), {
      _tag: "ConcernsProposed",
      concerns: CONCERNS,
    });
    expect(r.state._tag).toBe("AwaitingConcernApproval");
    if (r.state._tag === "AwaitingConcernApproval") {
      expect(r.state.concerns).toEqual(CONCERNS);
      expect(r.state.userPrompt).toBe("check react");
    }
    const turns = getEffects<ExecutionEffect>(r.effects, "executeTurn");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.request).toMatchObject({ customType: "audit-progress", triggerTurn: false });
    expect(turns[0]?.request.content).toContain("Concern proposal ready. Waiting for approval");
    expect(getPersistPayload(r.effects)).toMatchObject({
      mode: "AwaitingConcernApproval",
      proposedConcerns: CONCERNS,
      userPrompt: "check react",
    });
  });

  it("Detecting + empty concerns → Idle with notify", () => {
    const r = auditReducer(detecting(), { _tag: "ConcernsProposed", concerns: [] });
    expect(r.state._tag).toBe("Idle");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({ message: expect.stringContaining("no audit concerns") });
  });
});

describe("auditReducer — concern approval", () => {
  it("AwaitingConcernApproval + ConcernsApproved → Auditing", () => {
    const r = auditReducer(awaitingConcernApproval(CONCERNS), { _tag: "ConcernsApproved" });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.concerns.map((concern) => concern.subject)).toEqual([
        "correctness",
        "frontend",
      ]);
      expect(r.state.concerns.every((concern) => concern.status === "in_progress")).toBe(true);
      expect(r.state.cursor).toEqual({
        phase: "running",
        frontierTaskIds: ["1", "2"],
        activeTaskIds: ["1", "2"],
        total: 2,
      });
    }
    const batch = getEffect<AuditEffect & { type: "runConcernBatch" }>(
      r.effects,
      "runConcernBatch",
    );
    expect(batch?.state._tag).toBe("Auditing");
  });

  it("AwaitingConcernApproval + ConcernsRejected → Idle", () => {
    const r = auditReducer(awaitingConcernApproval(), { _tag: "ConcernsRejected" });
    expect(r.state._tag).toBe("Idle");
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({
      message: "audit cancelled before concern approval",
      level: "info",
    });
  });

  it("AwaitingConcernApproval + ConcernsEdited → Detecting with runDetection", () => {
    const r = auditReducer(awaitingConcernApproval(), {
      _tag: "ConcernsEdited",
      feedback: "merge correctness into architecture",
    });
    expect(r.state._tag).toBe("Detecting");
    if (r.state._tag === "Detecting") {
      expect(r.state.detectionFeedback).toBe("merge correctness into architecture");
    }
    expect(
      getEffect<AuditEffect & { type: "runDetection" }>(r.effects, "runDetection")?.state,
    ).toMatchObject({
      _tag: "Detecting",
      detectionFeedback: "merge correctness into architecture",
    });
    const turns = getEffects<ExecutionEffect>(r.effects, "executeTurn");
    expect(turns.at(0)?.request).toMatchObject({
      customType: "audit-progress",
      triggerTurn: false,
    });
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

describe("auditReducer — ConcernSessionsPrepared", () => {
  it("stores per-concern session paths without emitting extra transcript chatter", () => {
    const r = auditReducer(auditing(), {
      _tag: "ConcernSessionsPrepared",
      sessions: [
        { taskId: "1", sessionPath: "/tmp/audit-1.jsonl" },
        { taskId: "2", sessionPath: "/tmp/audit-2.jsonl" },
      ],
    });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.concerns[0]?.metadata.sessionPath).toBe("/tmp/audit-1.jsonl");
      expect(r.state.concerns[1]?.metadata.sessionPath).toBe("/tmp/audit-2.jsonl");
    }
    const turns = getEffects<ExecutionEffect>(r.effects, "executeTurn");
    expect(turns).toHaveLength(0);
  });
});

describe("auditReducer — ConcernAudited", () => {
  it("Auditing → advances to the next concern batch and stores notes", () => {
    const r = auditReducer(auditing(), {
      _tag: "ConcernAudited",
      taskId: "1",
      notes: "found issues in src/app.tsx",
      sessionPath: "/tmp/audit-1.jsonl",
    });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.cursor).toEqual(createConcernCursor(2, 2));
      expect(r.state.concerns[0]!.status).toBe("completed");
      expect(r.state.concerns[0]!.metadata.notes).toBe("found issues in src/app.tsx");
      expect(r.state.concerns[1]!.status).toBe("in_progress");
    }
    const batch = getEffect<AuditEffect & { type: "runConcernBatch" }>(
      r.effects,
      "runConcernBatch",
    );
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
      sessionPath: "/tmp/audit-2.jsonl",
    });
    expect(r.state._tag).toBe("Synthesizing");
    if (r.state._tag === "Synthesizing") {
      expect(r.state.concerns.map((concern) => concern.subject)).toEqual([
        "correctness",
        "frontend",
      ]);
      expect(r.state.concerns.every((concern) => concern.status === "completed")).toBe(true);
      expect(r.state.concerns[1]!.metadata.notes).toBe("frontend looks fine");
    }
    const turns = getEffects<ExecutionEffect>(r.effects, "executeTurn");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.request).toMatchObject({ customType: "audit-progress", triggerTurn: false });
    expect(
      getEffect<AuditEffect & { type: "runSynthesis" }>(r.effects, "runSynthesis")?.state,
    ).toMatchObject({
      _tag: "Synthesizing",
    });
  });

  it("non-Auditing + ConcernAudited is no-op", () => {
    const state = detecting();
    const r = auditReducer(state, {
      _tag: "ConcernAudited",
      taskId: "1",
      notes: "ignored",
      sessionPath: "/tmp/ignored.jsonl",
    });
    expect(r.state).toBe(state);
  });
});

describe("auditReducer — ConcernAuditFailed", () => {
  it("Auditing self-heals into the next loop with prior session paths", () => {
    const r = auditReducer(auditing(), {
      _tag: "ConcernAuditFailed",
      message: "audit: concern batch failed\n\nConcern transcript: /tmp/audit-1.jsonl",
      sessionPaths: ["/tmp/audit-1.jsonl"],
    });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.iteration).toBe(2);
      expect(r.state.previousConcernSessionPaths).toContain("/tmp/audit-1.jsonl");
    }
    const notify = getEffect<BuiltinEffect>(r.effects, "notify");
    expect(notify).toMatchObject({
      level: "warning",
      message: "audit: concern batch failed\n\nConcern transcript: /tmp/audit-1.jsonl",
    });
  });

  it("non-Auditing + ConcernAuditFailed is no-op", () => {
    const state = detecting();
    const r = auditReducer(state, {
      _tag: "ConcernAuditFailed",
      message: "ignored",
      sessionPaths: [],
    });
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
  it("restores Detecting and reruns background detection", () => {
    const result = auditReducer(idle(), {
      _tag: "Hydrate",
      mode: "Detecting",
      scope: "diff",
      diffStat: " 3 files changed",
      targetPaths: ["src/app.tsx", "src/lib.ts"],
      skillCatalog: CATALOG,
      userPrompt: "focus on correctness",
      previousThinkingLevel: "medium",
    });

    expect(result.state).toMatchObject({
      _tag: "Detecting",
      scope: "diff",
      diffStat: " 3 files changed",
      targetPaths: ["src/app.tsx", "src/lib.ts"],
      skillCatalog: CATALOG,
      userPrompt: "focus on correctness",
      detectionFeedback: undefined,
      previousThinkingLevel: "medium",
      iteration: 1,
      maxIterations: 5,
      previousConcernSessionPaths: [],
      previousExecutionSessionPaths: [],
    });
    expect(
      getEffect<AuditEffect & { type: "runDetection" }>(result.effects, "runDetection")?.state,
    ).toMatchObject({
      _tag: "Detecting",
      userPrompt: "focus on correctness",
    });
  });

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
    const batch = getEffect<AuditEffect & { type: "runConcernBatch" }>(
      result.effects,
      "runConcernBatch",
    );
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
      scope: "diff",
      concerns,
      diffStat: " 3 files changed",
      targetPaths: ["src/app.tsx", "src/lib.ts"],
      userPrompt: "keep it tight",
    });

    expect(result.state).toMatchObject({
      _tag: "Synthesizing",
      concerns,
      scope: "diff",
      userPrompt: "keep it tight",
      iteration: 1,
      maxIterations: 5,
    });
    expect(
      getEffect<AuditEffect & { type: "runSynthesis" }>(result.effects, "runSynthesis")?.state,
    ).toMatchObject({
      _tag: "Synthesizing",
    });
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("auditReducer — Reset", () => {
  it("any state → Idle", () => {
    for (const state of [
      detecting(),
      auditing(),
      synthesizing(),
      { _tag: "Executing", ...auditing(), findings: FINDINGS } as any,
    ]) {
      const r = auditReducer(state, { _tag: "Reset" });
      expect(r.state).toEqual({ _tag: "Idle" });
      expect(hasEffect(r.effects, "setStatus")).toBe(true);
      expect(hasEffect(r.effects, "updateUI")).toBe(true);
    }
  });
});

describe("auditReducer — self-healing loop", () => {
  it("last concern completion moves into spawned synthesis", () => {
    const concerns = createConcernTasks(CONCERNS, 2).map((concern, index) => ({
      ...concern,
      status: index === 0 ? "completed" : concern.status,
    }));
    const r = auditReducer(auditing(concerns, "diff", 2), {
      _tag: "ConcernAudited",
      taskId: "2",
      notes: "frontend looks fine",
      sessionPath: "/tmp/audit-2.jsonl",
    });
    expect(r.state._tag).toBe("Synthesizing");
    expect(
      getEffect<AuditEffect & { type: "runSynthesis" }>(r.effects, "runSynthesis")?.state,
    ).toMatchObject({
      _tag: "Synthesizing",
    });
  });

  it("execution completion loops back into auditing with execution history", () => {
    const executing: AuditState = {
      ...auditing(),
      _tag: "Executing",
      findings: FINDINGS,
    } as any;
    const r = auditReducer(executing, {
      _tag: "ExecutionComplete",
      sessionPath: "/tmp/exec-1.jsonl",
    });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.iteration).toBe(2);
      expect(r.state.previousExecutionSessionPaths).toContain("/tmp/exec-1.jsonl");
    }
  });

  it("execution failure also loops back into auditing", () => {
    const executing: AuditState = {
      ...auditing(),
      _tag: "Executing",
      findings: FINDINGS,
    } as any;
    const r = auditReducer(executing, {
      _tag: "ExecutionFailed",
      sessionPath: "/tmp/exec-1.jsonl",
      message: "ran out of context",
    });
    expect(r.state._tag).toBe("Auditing");
    if (r.state._tag === "Auditing") {
      expect(r.state.iteration).toBe(2);
      expect(r.state.previousExecutionSessionPaths).toContain("/tmp/exec-1.jsonl");
    }
  });

  it("hydrate restores Executing and reruns spawned execution", () => {
    const result = auditReducer(idle(), {
      _tag: "Hydrate",
      mode: "Executing",
      scope: "diff",
      concerns: createConcernTasks(CONCERNS, 2).map((concern) => ({
        ...concern,
        status: "completed" as const,
      })),
      findings: FINDINGS,
      diffStat: " 3 files changed",
      targetPaths: ["src/app.tsx", "src/lib.ts"],
      userPrompt: "keep it tight",
      iteration: 2,
      maxIterations: 5,
    });

    expect(result.state._tag).toBe("Executing");
    expect(
      getEffect<AuditEffect & { type: "runExecution" }>(result.effects, "runExecution")?.state,
    ).toMatchObject({
      _tag: "Executing",
      iteration: 2,
    });
  });

  it("walks a full two-iteration self-healing loop", () => {
    const firstPassConcerns = createConcernTasks(CONCERNS, 2).map((concern, index) => ({
      ...concern,
      status: index === 0 ? "completed" : concern.status,
      metadata: {
        ...concern.metadata,
        notes: index === 0 ? "found issue in src/app.tsx" : undefined,
      },
    }));

    const afterConcern2 = auditReducer(auditing(firstPassConcerns, "diff", 2), {
      _tag: "ConcernAudited",
      taskId: "2",
      notes: "frontend issue tied to app fix",
      sessionPath: "/tmp/audit-2.jsonl",
    });
    expect(afterConcern2.state._tag).toBe("Synthesizing");

    const afterSynthesis = auditReducer(afterConcern2.state, {
      _tag: "SynthesisComplete",
      findings: FINDINGS.slice(0, 2),
    });
    expect(afterSynthesis.state._tag).toBe("Executing");

    const afterExecution = auditReducer(afterSynthesis.state, {
      _tag: "ExecutionComplete",
      sessionPath: "/tmp/exec-1.jsonl",
    });
    expect(afterExecution.state._tag).toBe("Auditing");
    if (afterExecution.state._tag === "Auditing") {
      expect(afterExecution.state.iteration).toBe(2);
      expect(afterExecution.state.previousExecutionSessionPaths).toEqual(["/tmp/exec-1.jsonl"]);
      expect(
        afterExecution.state.concerns.every((concern) => concern.metadata.notes === undefined),
      ).toBe(true);
      expect(
        afterExecution.state.concerns.some((concern) => concern.status === "in_progress"),
      ).toBe(true);
    }

    const secondPassState = afterExecution.state;
    if (secondPassState._tag !== "Auditing") throw new Error("expected auditing state");
    const cleanSynthesis: AuditState = {
      _tag: "Synthesizing",
      concerns: secondPassState.concerns.map((concern) => ({
        ...concern,
        status: "completed" as const,
        metadata: {
          ...concern.metadata,
          notes: "clean",
        },
      })),
      scope: secondPassState.scope,
      diffStat: secondPassState.diffStat,
      targetPaths: secondPassState.targetPaths,
      userPrompt: secondPassState.userPrompt,
      iteration: secondPassState.iteration,
      maxIterations: secondPassState.maxIterations,
      previousConcernSessionPaths: secondPassState.previousConcernSessionPaths,
      previousExecutionSessionPaths: secondPassState.previousExecutionSessionPaths,
    };

    const done = auditReducer(cleanSynthesis, {
      _tag: "SynthesisComplete",
      findings: [],
    });
    expect(done.state).toEqual({ _tag: "Idle" });
  });
});

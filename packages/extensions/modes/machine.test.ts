import { describe, expect, it } from "bun:test";
import type { ExecutionEffect } from "@cvr/pi-execution";
import { createTaskList, type TaskListItem } from "@cvr/pi-task-list";
import type { BuiltinEffect } from "@cvr/pi-state-machine";
import {
  EXECUTION_SIGNAL_TOOLS,
  PLAN_SIGNAL_TOOLS,
  PLAN_TOOLS,
  modesReducer,
  type ModesEffect,
  type ModesState,
} from "./machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tasks(...subjects: string[]): TaskListItem[] {
  return createTaskList(subjects);
}

function auto(): ModesState {
  return { _tag: "Auto" };
}

function planning(savedTools = ["read", "bash", "edit"]): ModesState {
  return { _tag: "Planning", savedTools };
}

function awaitingChoice(savedTools = ["read", "bash", "edit"]): ModesState {
  return {
    _tag: "AwaitingChoice",
    savedTools,
    pending: {
      todoItems: tasks("First step", "Second step"),
      planFilePath: "/tmp/plan.md",
      planText: "Full plan text",
    },
  };
}

function executing(
  items?: TaskListItem[],
  options?: { phase?: "running" | "gating" | "counseling"; currentStep?: number | null },
): ModesState {
  const currentStep = options?.currentStep ?? 1;
  const baseItems = items ?? tasks("First step", "Second step", "Third step");
  const todoItems = baseItems.map((task) => ({
    ...task,
    status:
      task.order === currentStep && task.status === "pending" ? "in_progress" : task.status,
  }));

  return {
    _tag: "Executing",
    savedTools: ["read", "bash", "edit", "write"],
    todoItems,
    planFilePath: "/tmp/plan.md",
    phase: options?.phase ?? "running",
    currentStep,
  };
}

type AnyEffect = BuiltinEffect | ExecutionEffect | ModesEffect;

function hasEffect(effects: readonly AnyEffect[] | undefined, type: string): boolean {
  return effects?.some((effect) => effect.type === type) ?? false;
}

function getEffect<T extends AnyEffect>(
  effects: readonly AnyEffect[] | undefined,
  type: string,
): T | undefined {
  return effects?.find((effect) => effect.type === type) as T | undefined;
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

describe("modesReducer — Toggle", () => {
  it("Auto → Planning", () => {
    const result = modesReducer(auto(), { _tag: "Toggle", currentTools: ["read", "bash", "edit"] });
    expect(result.state._tag).toBe("Planning");
    if (result.state._tag === "Planning") {
      expect(result.state.savedTools).toEqual(["read", "bash", "edit"]);
    }
    expect(hasEffect(result.effects, "setActiveTools")).toBe(true);
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: [...PLAN_TOOLS, ...PLAN_SIGNAL_TOOLS],
    });
    expect(hasEffect(result.effects, "notify")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
    expect(hasEffect(result.effects, "persistState")).toBe(true);
  });

  it("Planning → Auto (restores tools)", () => {
    const result = modesReducer(planning(["my", "tools"]), { _tag: "Toggle", currentTools: [] });
    expect(result.state._tag).toBe("Auto");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["my", "tools"],
    });
  });

  it("AwaitingChoice → Auto (restores tools)", () => {
    const result = modesReducer(awaitingChoice(["a", "b"]), { _tag: "Toggle", currentTools: [] });
    expect(result.state._tag).toBe("Auto");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["a", "b"],
    });
  });

  it("Executing + Toggle warns instead of dropping execution state", () => {
    const state = executing();
    const result = modesReducer(state, { _tag: "Toggle", currentTools: [] });
    expect(result.state).toBe(state);
    expect(getEffect<BuiltinEffect>(result.effects, "notify")).toMatchObject({
      level: "warning",
    });
  });
});

// ---------------------------------------------------------------------------
// PlanWithPrompt
// ---------------------------------------------------------------------------

describe("modesReducer — PlanWithPrompt", () => {
  it("enters Planning and sends prompt", () => {
    const result = modesReducer(auto(), {
      _tag: "PlanWithPrompt",
      prompt: "audit auth",
      currentTools: ["read"],
    });
    expect(result.state._tag).toBe("Planning");
    expect(hasEffect(result.effects, "sendUserMessage")).toBe(true);
    expect(getEffect<BuiltinEffect>(result.effects, "sendUserMessage")).toMatchObject({
      content: "audit auth",
      deliverAs: "followUp",
    });
  });

  it("preserves pending when already in AwaitingChoice", () => {
    const state = awaitingChoice();
    const result = modesReducer(state, {
      _tag: "PlanWithPrompt",
      prompt: "refine it",
      currentTools: ["read"],
    });
    expect(result.state._tag).toBe("Planning");
    if (result.state._tag === "Planning" && state._tag === "AwaitingChoice") {
      expect(result.state.pending).toBe(state.pending);
    }
  });

  it("blocks drafting a new plan while executing", () => {
    const state = executing();
    const result = modesReducer(state, {
      _tag: "PlanWithPrompt",
      prompt: "start over",
      currentTools: ["read"],
    });
    expect(result.state).toBe(state);
    expect(getEffect<BuiltinEffect>(result.effects, "notify")).toMatchObject({
      level: "warning",
    });
  });
});

// ---------------------------------------------------------------------------
// PlanReady (plan signal)
// ---------------------------------------------------------------------------

describe("modesReducer — PlanReady", () => {
  it("Planning + todos → AwaitingChoice", () => {
    const todos = tasks("Step one", "Step two");
    const result = modesReducer(planning(), {
      _tag: "PlanReady",
      todoItems: todos,
      planText: "The plan",
      planFilePath: "/tmp/plan.md",
    });
    expect(result.state._tag).toBe("AwaitingChoice");
    expect(hasEffect(result.effects, "writePlanFile")).toBe(true);
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
    expect(hasEffect(result.effects, "persistState")).toBe(true);
  });

  it("Planning + empty todos → no change", () => {
    const state = planning();
    const result = modesReducer(state, {
      _tag: "PlanReady",
      todoItems: [],
      planText: "",
      planFilePath: "/tmp/plan.md",
    });
    expect(result.state).toBe(state);
  });

  it("Auto + PlanReady → no change", () => {
    const state = auto();
    const result = modesReducer(state, {
      _tag: "PlanReady",
      todoItems: tasks("x"),
      planText: "x",
      planFilePath: "/tmp/plan.md",
    });
    expect(result.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// ChooseExecute / ChooseStay / ChooseRefine
// ---------------------------------------------------------------------------

describe("modesReducer — Choice transitions", () => {
  it("ChooseExecute → Executing (restores tools)", () => {
    const result = modesReducer(awaitingChoice(["full", "tools"]), { _tag: "ChooseExecute" });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.todoItems[0]!.status).toBe("in_progress");
      expect(result.state.currentStep).toBe(1);
    }
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["full", "tools", ...EXECUTION_SIGNAL_TOOLS],
    });
    expect(hasEffect(result.effects, "executeTurn")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });

  it("ChooseStay → Planning (keeps pending)", () => {
    const state = awaitingChoice();
    const result = modesReducer(state, { _tag: "ChooseStay" });
    expect(result.state._tag).toBe("Planning");
    if (result.state._tag === "Planning" && state._tag === "AwaitingChoice") {
      expect(result.state.pending).toBe(state.pending);
    }
    expect(hasEffect(result.effects, "persistState")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });

  it("ChooseRefine → Planning (sends refinement)", () => {
    const result = modesReducer(awaitingChoice(), {
      _tag: "ChooseRefine",
      refinement: "add tests",
    });
    expect(result.state._tag).toBe("Planning");
    expect(getEffect<BuiltinEffect>(result.effects, "sendUserMessage")).toMatchObject({
      content: "add tests",
    });
    expect(hasEffect(result.effects, "persistState")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });

  it("ChooseExecute from non-AwaitingChoice is no-op", () => {
    const state = auto();
    const result = modesReducer(state, { _tag: "ChooseExecute" });
    expect(result.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// StepDone (execution progress signal)
// ---------------------------------------------------------------------------

describe("modesReducer — StepDone", () => {
  it("keeps the active task in progress and enters gating", () => {
    const result = modesReducer(executing(), { _tag: "StepDone", step: 1 });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.todoItems[0]!.status).toBe("in_progress");
      expect(result.state.phase).toBe("gating");
      expect(result.state.currentStep).toBe(1);
    }
    expect(hasEffect(result.effects, "executeTurn")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
    expect(hasEffect(result.effects, "persistState")).toBe(true);
    expect(hasEffect(result.effects, "updatePlanFile")).toBe(true);
  });

  it("wrong active step is no-op", () => {
    const state = executing(undefined, { currentStep: 1 });
    const result = modesReducer(state, { _tag: "StepDone", step: 2 });
    expect(result.state).toBe(state);
  });

  it("non-running execution state is no-op", () => {
    const state = executing(undefined, { phase: "gating" });
    const result = modesReducer(state, { _tag: "StepDone", step: 1 });
    expect(result.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// ExecutionComplete
// ---------------------------------------------------------------------------

describe("modesReducer — ExecutionComplete", () => {
  it("Executing → Auto with completion message", () => {
    const result = modesReducer(executing(), { _tag: "ExecutionComplete" });
    expect(result.state._tag).toBe("Auto");
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["read", "bash", "edit", "write"],
    });
    expect(hasEffect(result.effects, "updatePlanFile")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
    expect(hasEffect(result.effects, "persistState")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("modesReducer — Reset", () => {
  it("any state → Auto", () => {
    expect(modesReducer(planning(), { _tag: "Reset" }).state._tag).toBe("Auto");
    expect(modesReducer(executing(), { _tag: "Reset" }).state._tag).toBe("Auto");
    expect(modesReducer(awaitingChoice(), { _tag: "Reset" }).state._tag).toBe("Auto");
  });
});

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

describe("modesReducer — Hydrate", () => {
  const base = {
    todoItems: [] as TaskListItem[],
    planFilePath: null,
    savedTools: null,
    flagPlan: false,
    currentTools: ["read", "bash"],
  };

  it("hydrates to AwaitingChoice when a pending choice was persisted", () => {
    const pending = {
      todoItems: tasks("Do it"),
      planFilePath: "/tmp/plan.md",
      planText: "Plan:\n1. Do it",
    };
    const result = modesReducer(auto(), {
      _tag: "Hydrate",
      ...base,
      mode: "AwaitingChoice",
      todoItems: pending.todoItems,
      planFilePath: pending.planFilePath,
      pending,
    });
    expect(result.state._tag).toBe("AwaitingChoice");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: [...PLAN_TOOLS, ...PLAN_SIGNAL_TOOLS],
    });
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });

  it("hydrates to Executing when persisted executing state", () => {
    const items = tasks("Do it");
    const result = modesReducer(auto(), {
      _tag: "Hydrate",
      ...base,
      mode: "Executing",
      todoItems: items,
      planFilePath: "/tmp/plan.md",
    });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.todoItems[0]!.status).toBe("in_progress");
      expect(result.state.currentStep).toBe(1);
    }
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: [...base.currentTools, ...EXECUTION_SIGNAL_TOOLS],
    });
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
  });

  it("hydrates to Planning when persisted planning state", () => {
    const result = modesReducer(auto(), { _tag: "Hydrate", ...base, mode: "Planning" });
    expect(result.state._tag).toBe("Planning");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: [...PLAN_TOOLS, ...PLAN_SIGNAL_TOOLS],
    });
  });

  it("hydrates to Planning when --plan flag is set", () => {
    const result = modesReducer(auto(), { _tag: "Hydrate", ...base, flagPlan: true });
    expect(result.state._tag).toBe("Planning");
  });

  it("hydrates to Auto when nothing persisted", () => {
    const result = modesReducer(auto(), { _tag: "Hydrate", ...base });
    expect(result.state._tag).toBe("Auto");
  });

  it("hydrates executing state in running phase", () => {
    const items = tasks("Do it");
    const result = modesReducer(auto(), {
      _tag: "Hydrate",
      ...base,
      mode: "Executing",
      todoItems: items,
      planFilePath: "/tmp/plan.md",
    });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("running");
      expect(result.state.todoItems[0]!.status).toBe("in_progress");
    }
  });

  it("hydrates persisted gate phase and current step", () => {
    const result = modesReducer(auto(), {
      _tag: "Hydrate",
      ...base,
      mode: "Executing",
      todoItems: [
        { id: "1", order: 1, subject: "First", status: "completed", blockedBy: [] },
        { id: "2", order: 2, subject: "Second", status: "in_progress", blockedBy: [] },
        { id: "3", order: 3, subject: "Third", status: "pending", blockedBy: [] },
      ],
      planFilePath: "/tmp/plan.md",
      currentStep: 2,
      phase: "gating",
    });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("gating");
      expect(result.state.currentStep).toBe(2);
      expect(result.state.todoItems[1]!.status).toBe("in_progress");
    }
    expect(getEffect<ModesEffect>(result.effects, "updatePlanFile")).toMatchObject({
      todoItems: [
        { id: "1", order: 1, subject: "First", status: "completed", blockedBy: [] },
        { id: "2", order: 2, subject: "Second", status: "in_progress", blockedBy: [] },
        { id: "3", order: 3, subject: "Third", status: "pending", blockedBy: [] },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// GateResult / CounselResult
// ---------------------------------------------------------------------------

describe("modesReducer — GateResult / CounselResult", () => {
  it("GateResult pass → counseling with counsel prompt", () => {
    const result = modesReducer(executing(undefined, { phase: "gating", currentStep: 1 }), {
      _tag: "GateResult",
      status: "pass",
    });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("counseling");
    }
    expect(hasEffect(result.effects, "executeTurn")).toBe(true);
  });

  it("GateResult fail → back to running with fix prompt", () => {
    const result = modesReducer(executing(undefined, { phase: "gating", currentStep: 2 }), {
      _tag: "GateResult",
      status: "fail",
    });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("running");
      expect(result.state.currentStep).toBe(2);
      expect(result.state.todoItems[1]!.status).toBe("in_progress");
    }
    expect(hasEffect(result.effects, "notify")).toBe(true);
    expect(hasEffect(result.effects, "executeTurn")).toBe(true);
  });

  it("CounselResult pass → complete when all steps are done", () => {
    const result = modesReducer(
      executing([{ id: "1", order: 1, subject: "Only step", status: "in_progress", blockedBy: [] }], {
        phase: "counseling",
        currentStep: 1,
      }),
      {
        _tag: "CounselResult",
        status: "pass",
      },
    );
    expect(result.state._tag).toBe("Auto");
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
    expect(hasEffect(result.effects, "setActiveTools")).toBe(true);
  });

  it("CounselResult fail → back to running with fix prompt", () => {
    const result = modesReducer(executing(undefined, { phase: "counseling", currentStep: 3 }), {
      _tag: "CounselResult",
      status: "fail",
    });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("running");
      expect(result.state.currentStep).toBe(3);
    }
    expect(hasEffect(result.effects, "notify")).toBe(true);
    expect(hasEffect(result.effects, "executeTurn")).toBe(true);
  });

  it("ChooseExecute always enables signal-driven execution", () => {
    const result = modesReducer(awaitingChoice(), { _tag: "ChooseExecute" });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("running");
    }
  });
});

import { describe, expect, it } from "bun:test";
import type { BuiltinEffect } from "@cvr/pi-state-machine";
import {
  EXECUTION_SIGNAL_TOOLS,
  PLAN_SIGNAL_TOOLS,
  PLAN_TOOLS,
  modesReducer,
  type ModesEffect,
  type ModesState,
} from "./machine";
import type { TodoItem } from "./utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      todoItems: [
        { step: 1, text: "First step", completed: false },
        { step: 2, text: "Second step", completed: false },
      ],
      planFilePath: "/tmp/plan.md",
      planText: "Full plan text",
    },
  };
}

function executing(
  items?: TodoItem[],
  options?: { phase?: "running" | "gating" | "counseling"; currentStep?: number | null },
): ModesState {
  return {
    _tag: "Executing",
    savedTools: ["read", "bash", "edit", "write"],
    todoItems: items ?? [
      { step: 1, text: "First step", completed: false },
      { step: 2, text: "Second step", completed: false },
      { step: 3, text: "Third step", completed: false },
    ],
    planFilePath: "/tmp/plan.md",
    phase: options?.phase ?? "running",
    currentStep: options?.currentStep ?? null,
  };
}

type AnyEffect = BuiltinEffect | ModesEffect;

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
    const todos: TodoItem[] = [
      { step: 1, text: "Step one", completed: false },
      { step: 2, text: "Step two", completed: false },
    ];
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
      todoItems: [{ step: 1, text: "x", completed: false }],
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
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["full", "tools", ...EXECUTION_SIGNAL_TOOLS],
    });
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
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
  it("marks the step complete and enters gating", () => {
    const result = modesReducer(executing(), { _tag: "StepDone", step: 1 });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.todoItems[0]!.completed).toBe(true);
      expect(result.state.phase).toBe("gating");
      expect(result.state.currentStep).toBe(1);
    }
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
    expect(hasEffect(result.effects, "updateUI")).toBe(true);
    expect(hasEffect(result.effects, "persistState")).toBe(true);
    expect(hasEffect(result.effects, "updatePlanFile")).toBe(true);
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
    todoItems: [] as TodoItem[],
    planFilePath: null,
    savedTools: null,
    flagPlan: false,
    currentTools: ["read", "bash"],
  };

  it("hydrates to AwaitingChoice when a pending choice was persisted", () => {
    const pending = {
      todoItems: [{ step: 1, text: "Do it", completed: false }],
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
    const items: TodoItem[] = [{ step: 1, text: "Do it", completed: false }];
    const result = modesReducer(auto(), {
      _tag: "Hydrate",
      ...base,
      mode: "Executing",
      todoItems: items,
      planFilePath: "/tmp/plan.md",
    });
    expect(result.state._tag).toBe("Executing");
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
    const items: TodoItem[] = [{ step: 1, text: "Do it", completed: false }];
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
    }
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
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
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
    }
    expect(hasEffect(result.effects, "notify")).toBe(true);
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
  });

  it("CounselResult pass → complete when all steps are done", () => {
    const result = modesReducer(
      executing([{ step: 1, text: "Only step", completed: true }], {
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
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
  });

  it("ChooseExecute always enables signal-driven execution", () => {
    const result = modesReducer(awaitingChoice(), { _tag: "ChooseExecute" });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("running");
    }
  });
});

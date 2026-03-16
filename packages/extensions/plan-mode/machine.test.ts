import { describe, expect, it } from "bun:test";
import { PLAN_MODE_TOOLS, planReducer, type PlanState, type PlanEffect } from "./machine";
import type { BuiltinEffect } from "@cvr/pi-state-machine";
import type { TodoItem } from "./utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inactive(): PlanState {
  return { _tag: "Inactive" };
}

function planning(savedTools = ["read", "bash", "edit"]): PlanState {
  return { _tag: "Planning", savedTools };
}

function awaitingChoice(savedTools = ["read", "bash", "edit"]): PlanState {
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
  opts?: { gated?: boolean; phase?: "running" | "gating" | "counseling" },
): PlanState {
  return {
    _tag: "Executing",
    todoItems: items ?? [
      { step: 1, text: "First step", completed: false },
      { step: 2, text: "Second step", completed: false },
      { step: 3, text: "Third step", completed: false },
    ],
    planFilePath: "/tmp/plan.md",
    gated: opts?.gated ?? false,
    phase: opts?.phase ?? "running",
  };
}

type AnyEffect = BuiltinEffect | PlanEffect;

function hasEffect(effects: readonly AnyEffect[] | undefined, type: string): boolean {
  return effects?.some((e) => e.type === type) ?? false;
}

function getEffect<T extends AnyEffect>(
  effects: readonly AnyEffect[] | undefined,
  type: string,
): T | undefined {
  return effects?.find((e) => e.type === type) as T | undefined;
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

describe("planReducer — Toggle", () => {
  it("Inactive → Planning", () => {
    const r = planReducer(inactive(), { _tag: "Toggle", currentTools: ["read", "bash", "edit"] });
    expect(r.state._tag).toBe("Planning");
    if (r.state._tag === "Planning") {
      expect(r.state.savedTools).toEqual(["read", "bash", "edit"]);
    }
    expect(hasEffect(r.effects, "setActiveTools")).toBe(true);
    expect(getEffect<BuiltinEffect>(r.effects, "setActiveTools")).toMatchObject({
      tools: PLAN_MODE_TOOLS,
    });
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
    expect(hasEffect(r.effects, "persistState")).toBe(true);
  });

  it("Planning → Inactive (restores tools)", () => {
    const r = planReducer(planning(["my", "tools"]), { _tag: "Toggle", currentTools: [] });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect<BuiltinEffect>(r.effects, "setActiveTools")).toMatchObject({
      tools: ["my", "tools"],
    });
  });

  it("AwaitingChoice → Inactive (restores tools)", () => {
    const r = planReducer(awaitingChoice(["a", "b"]), { _tag: "Toggle", currentTools: [] });
    expect(r.state._tag).toBe("Inactive");
    expect(getEffect<BuiltinEffect>(r.effects, "setActiveTools")).toMatchObject({
      tools: ["a", "b"],
    });
  });

  it("Executing + Toggle is ignored", () => {
    const state = executing();
    const r = planReducer(state, { _tag: "Toggle", currentTools: [] });
    expect(r.state).toBe(state);
    expect(r.effects).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PlanWithPrompt
// ---------------------------------------------------------------------------

describe("planReducer — PlanWithPrompt", () => {
  it("enters Planning and sends prompt", () => {
    const r = planReducer(inactive(), {
      _tag: "PlanWithPrompt",
      prompt: "audit auth",
      currentTools: ["read"],
    });
    expect(r.state._tag).toBe("Planning");
    expect(hasEffect(r.effects, "sendUserMessage")).toBe(true);
    expect(getEffect<BuiltinEffect>(r.effects, "sendUserMessage")).toMatchObject({
      content: "audit auth",
      deliverAs: "followUp",
    });
  });

  it("preserves pending when already in AwaitingChoice", () => {
    const state = awaitingChoice();
    const r = planReducer(state, {
      _tag: "PlanWithPrompt",
      prompt: "refine it",
      currentTools: ["read"],
    });
    expect(r.state._tag).toBe("Planning");
    if (r.state._tag === "Planning" && state._tag === "AwaitingChoice") {
      expect(r.state.pending).toBe(state.pending);
    }
  });
});

// ---------------------------------------------------------------------------
// AgentEnd (plan extraction)
// ---------------------------------------------------------------------------

describe("planReducer — AgentEnd", () => {
  it("Planning + todos → AwaitingChoice", () => {
    const todos: TodoItem[] = [
      { step: 1, text: "Step one", completed: false },
      { step: 2, text: "Step two", completed: false },
    ];
    const r = planReducer(planning(), {
      _tag: "AgentEnd",
      todoItems: todos,
      planText: "The plan",
      planFilePath: "/tmp/plan.md",
    });
    expect(r.state._tag).toBe("AwaitingChoice");
    expect(hasEffect(r.effects, "writePlanFile")).toBe(true);
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
    expect(hasEffect(r.effects, "persistState")).toBe(true);
  });

  it("Planning + empty todos → no change", () => {
    const state = planning();
    const r = planReducer(state, {
      _tag: "AgentEnd",
      todoItems: [],
      planText: "",
      planFilePath: "/tmp/plan.md",
    });
    expect(r.state).toBe(state);
  });

  it("Inactive + AgentEnd → no change", () => {
    const state = inactive();
    const r = planReducer(state, {
      _tag: "AgentEnd",
      todoItems: [{ step: 1, text: "x", completed: false }],
      planText: "x",
      planFilePath: "/tmp/plan.md",
    });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// ChooseExecute / ChooseStay / ChooseRefine
// ---------------------------------------------------------------------------

describe("planReducer — Choice transitions", () => {
  it("ChooseExecute → Executing (restores tools)", () => {
    const r = planReducer(awaitingChoice(["full", "tools"]), { _tag: "ChooseExecute" });
    expect(r.state._tag).toBe("Executing");
    expect(getEffect<BuiltinEffect>(r.effects, "setActiveTools")).toMatchObject({
      tools: ["full", "tools"],
    });
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
  });

  it("ChooseStay → Planning (keeps pending)", () => {
    const state = awaitingChoice();
    const r = planReducer(state, { _tag: "ChooseStay" });
    expect(r.state._tag).toBe("Planning");
    if (r.state._tag === "Planning" && state._tag === "AwaitingChoice") {
      expect(r.state.pending).toBe(state.pending);
    }
  });

  it("ChooseRefine → Planning (sends refinement)", () => {
    const r = planReducer(awaitingChoice(), { _tag: "ChooseRefine", refinement: "add tests" });
    expect(r.state._tag).toBe("Planning");
    expect(getEffect<BuiltinEffect>(r.effects, "sendUserMessage")).toMatchObject({
      content: "add tests",
    });
  });

  it("ChooseExecute from non-AwaitingChoice is no-op", () => {
    const state = inactive();
    const r = planReducer(state, { _tag: "ChooseExecute" });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// TurnEnd (execution progress)
// ---------------------------------------------------------------------------

describe("planReducer — TurnEnd", () => {
  it("updates todoItems in Executing state", () => {
    const updatedItems: TodoItem[] = [
      { step: 1, text: "First step", completed: true },
      { step: 2, text: "Second step", completed: false },
      { step: 3, text: "Third step", completed: false },
    ];
    const r = planReducer(executing(), { _tag: "TurnEnd", todoItems: updatedItems });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.todoItems[0]!.completed).toBe(true);
    }
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
    expect(hasEffect(r.effects, "persistState")).toBe(true);
    expect(hasEffect(r.effects, "updatePlanFile")).toBe(true);
  });

  it("non-Executing state is no-op", () => {
    const state = planning();
    const r = planReducer(state, { _tag: "TurnEnd", todoItems: [] });
    expect(r.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// ExecutionComplete
// ---------------------------------------------------------------------------

describe("planReducer — ExecutionComplete", () => {
  it("Executing → Inactive with completion message", () => {
    const r = planReducer(executing(), { _tag: "ExecutionComplete" });
    expect(r.state._tag).toBe("Inactive");
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
    expect(hasEffect(r.effects, "updatePlanFile")).toBe(true);
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
    expect(hasEffect(r.effects, "persistState")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("planReducer — Reset", () => {
  it("any state → Inactive", () => {
    expect(planReducer(planning(), { _tag: "Reset" }).state._tag).toBe("Inactive");
    expect(planReducer(executing(), { _tag: "Reset" }).state._tag).toBe("Inactive");
    expect(planReducer(awaitingChoice(), { _tag: "Reset" }).state._tag).toBe("Inactive");
  });
});

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

describe("planReducer — Hydrate", () => {
  const base = {
    enabled: false,
    todoItems: [] as TodoItem[],
    executing: false,
    planFilePath: null,
    savedTools: null,
    flagPlan: false,
    currentTools: ["read", "bash"],
  };

  it("hydrates to Executing when persisted executing state", () => {
    const items: TodoItem[] = [{ step: 1, text: "Do it", completed: false }];
    const r = planReducer(inactive(), {
      _tag: "Hydrate",
      ...base,
      executing: true,
      todoItems: items,
      planFilePath: "/tmp/plan.md",
    });
    expect(r.state._tag).toBe("Executing");
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
  });

  it("hydrates to Planning when enabled", () => {
    const r = planReducer(inactive(), { _tag: "Hydrate", ...base, enabled: true });
    expect(r.state._tag).toBe("Planning");
    expect(hasEffect(r.effects, "setActiveTools")).toBe(true);
  });

  it("hydrates to Planning when --plan flag", () => {
    const r = planReducer(inactive(), { _tag: "Hydrate", ...base, flagPlan: true });
    expect(r.state._tag).toBe("Planning");
  });

  it("hydrates to Inactive when nothing persisted", () => {
    const r = planReducer(inactive(), { _tag: "Hydrate", ...base });
    expect(r.state._tag).toBe("Inactive");
  });

  it("hydrates with gated flag", () => {
    const items: TodoItem[] = [{ step: 1, text: "Do it", completed: false }];
    const r = planReducer(inactive(), {
      _tag: "Hydrate",
      ...base,
      executing: true,
      todoItems: items,
      planFilePath: "/tmp/plan.md",
      gated: true,
    });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.gated).toBe(true);
      expect(r.state.phase).toBe("running");
    }
  });
});

// ---------------------------------------------------------------------------
// Gated execution
// ---------------------------------------------------------------------------

describe("planReducer — Gated execution", () => {
  it("TaskDone in gated running → gating with gate prompt", () => {
    const r = planReducer(executing(undefined, { gated: true }), { _tag: "TaskDone" });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.phase).toBe("gating");
    }
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
    expect(hasEffect(r.effects, "updateUI")).toBe(true);
  });

  it("TaskDone in non-gated → no-op", () => {
    const state = executing();
    const r = planReducer(state, { _tag: "TaskDone" });
    expect(r.state).toBe(state);
  });

  it("TaskDone in gating phase → no-op", () => {
    const state = executing(undefined, { gated: true, phase: "gating" });
    const r = planReducer(state, { _tag: "TaskDone" });
    expect(r.state).toBe(state);
  });

  it("GatePass → counseling with counsel prompt", () => {
    const r = planReducer(executing(undefined, { gated: true, phase: "gating" }), {
      _tag: "GatePass",
    });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.phase).toBe("counseling");
    }
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
  });

  it("GatePass in wrong phase → no-op", () => {
    const state = executing(undefined, { gated: true, phase: "running" });
    const r = planReducer(state, { _tag: "GatePass" });
    expect(r.state).toBe(state);
  });

  it("GateFail → back to running with fix prompt", () => {
    const r = planReducer(executing(undefined, { gated: true, phase: "gating" }), {
      _tag: "GateFail",
    });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.phase).toBe("running");
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
  });

  it("CounselPass → back to running with commit prompt", () => {
    const r = planReducer(executing(undefined, { gated: true, phase: "counseling" }), {
      _tag: "CounselPass",
    });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.phase).toBe("running");
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
  });

  it("CounselFail → back to running with fix prompt", () => {
    const r = planReducer(executing(undefined, { gated: true, phase: "counseling" }), {
      _tag: "CounselFail",
    });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.phase).toBe("running");
    }
    expect(hasEffect(r.effects, "notify")).toBe(true);
    expect(hasEffect(r.effects, "sendMessage")).toBe(true);
  });

  it("ChooseExecute with gated flag sets gated state", () => {
    const r = planReducer(awaitingChoice(), { _tag: "ChooseExecute", gated: true });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.gated).toBe(true);
      expect(r.state.phase).toBe("running");
    }
  });

  it("ChooseExecute without gated flag defaults to false", () => {
    const r = planReducer(awaitingChoice(), { _tag: "ChooseExecute" });
    expect(r.state._tag).toBe("Executing");
    if (r.state._tag === "Executing") {
      expect(r.state.gated).toBe(false);
    }
  });
});

import { describe, expect, it } from "bun:test";
import type { ExecutionEffect } from "@cvr/pi-execution";
import { createTaskList, type TaskListItem } from "@cvr/pi-task-list";
import type { BuiltinEffect } from "@cvr/pi-state-machine";
import {
  AUTO_SIGNAL_TOOLS,
  EXECUTION_SIGNAL_TOOLS,
  SPEC_SIGNAL_TOOLS,
  SPEC_TOOLS,
  TASK_LIST_SIGNAL_TOOLS,
  modesReducer,
  type ModesEffect,
  type ModesState,
  type SpecDraft,
} from "./machine";

function tasks(...subjects: string[]): TaskListItem[] {
  return createTaskList(subjects);
}

function auto(spec?: SpecDraft): ModesState {
  return spec ? { _tag: "Auto", spec } : { _tag: "Auto" };
}

function specMode(savedTools = ["read", "bash", "edit"], spec?: SpecDraft): ModesState {
  return { _tag: "Spec", savedTools, spec };
}

function awaitingChoice(
  savedTools = ["read", "bash", "edit"],
): Extract<ModesState, { _tag: "AwaitingChoice" }> {
  return {
    _tag: "AwaitingChoice",
    savedTools,
    spec: { specFilePath: "/tmp/spec.md", specText: "# Spec" },
    pending: {
      todoItems: tasks("First step", "Second step"),
      planFilePath: "/tmp/task-list.md",
      planText: "# Task List\n1. First step",
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
    status: task.order === currentStep && task.status === "pending" ? "in_progress" : task.status,
  }));
  return {
    _tag: "Executing",
    savedTools: ["read", "bash", "edit", "write"],
    todoItems,
    planFilePath: "/tmp/task-list.md",
    phase: options?.phase ?? "running",
    currentStep,
    spec: { specFilePath: "/tmp/spec.md", specText: "# Spec" },
  };
}

type AnyEffect = BuiltinEffect | ExecutionEffect | ModesEffect;

function getEffect<T extends AnyEffect>(
  effects: readonly AnyEffect[] | undefined,
  type: string,
): T | undefined {
  return effects?.find((effect) => effect.type === type) as T | undefined;
}

function hasEffect(effects: readonly AnyEffect[] | undefined, type: string): boolean {
  return getEffect(effects, type) !== undefined;
}

describe("modesReducer", () => {
  it("toggles Auto → Spec with spec tools", () => {
    const result = modesReducer(auto(), { _tag: "Toggle", currentTools: ["read", "bash", "edit"] });
    expect(result.state._tag).toBe("Spec");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: [...SPEC_TOOLS, ...SPEC_SIGNAL_TOOLS],
    });
    expect(getEffect<BuiltinEffect>(result.effects, "setThinkingLevel")).toMatchObject({
      level: "xhigh",
    });
    expect(hasEffect(result.effects, "persistState")).toBe(true);
  });

  it("toggles Spec → Auto, restores tools, and requests a task list from the spec", () => {
    const result = modesReducer(
      specMode(["read", "bash"], { specFilePath: "/tmp/spec.md", specText: "# Spec" }),
      {
        _tag: "Toggle",
        currentTools: [],
      },
    );
    expect(result.state._tag).toBe("Auto");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["read", "bash", ...AUTO_SIGNAL_TOOLS, ...TASK_LIST_SIGNAL_TOOLS],
    });
    expect(getEffect<BuiltinEffect>(result.effects, "setThinkingLevel")).toMatchObject({
      level: "medium",
    });
    expect(hasEffect(result.effects, "executeTurn")).toBe(true);
  });

  it("enters SpecWithPrompt and sends the prompt", () => {
    const result = modesReducer(auto(), {
      _tag: "SpecWithPrompt",
      prompt: "write a PRD",
      currentTools: ["read"],
    });
    expect(result.state._tag).toBe("Spec");
    expect(getEffect<BuiltinEffect>(result.effects, "sendUserMessage")).toMatchObject({
      content: "write a PRD",
      deliverAs: "followUp",
    });
    expect(getEffect<BuiltinEffect>(result.effects, "setThinkingLevel")).toMatchObject({
      level: "xhigh",
    });
  });

  it("captures a spec without creating tasks", () => {
    const result = modesReducer(specMode(), {
      _tag: "SpecReady",
      spec: { specFilePath: "/tmp/spec.md", specText: "# Spec" },
    });
    expect(result.state._tag).toBe("Spec");
    if (result.state._tag === "Spec") {
      expect(result.state.spec?.specFilePath).toBe("/tmp/spec.md");
      expect(result.state.pending).toBeUndefined();
    }
    expect(hasEffect(result.effects, "writeSpecFile")).toBe(true);
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
  });

  it("captures a task list in Auto and moves to AwaitingChoice", () => {
    const pending = {
      todoItems: tasks("Step one", "Step two"),
      planFilePath: "/tmp/task-list.md",
      planText: "# Task List\n1. Step one",
    };
    const result = modesReducer(auto(), {
      _tag: "TaskListReady",
      pending,
      currentTools: ["read", "bash"],
    });
    expect(result.state._tag).toBe("AwaitingChoice");
    expect(getEffect<BuiltinEffect>(result.effects, "setThinkingLevel")).toMatchObject({
      level: "medium",
    });
    expect(hasEffect(result.effects, "writePlanFile")).toBe(true);
    expect(hasEffect(result.effects, "sendMessage")).toBe(true);
    expect(hasEffect(result.effects, "persistTaskList")).toBe(true);
  });

  it("restores a stored task list into AwaitingChoice from Auto", () => {
    const result = modesReducer(auto(), {
      _tag: "RestoreTaskList",
      todoItems: tasks("Recovered step"),
      currentTools: ["read", "bash"],
    });
    expect(result.state._tag).toBe("AwaitingChoice");
    if (result.state._tag === "AwaitingChoice") {
      expect(result.state.pending.todoItems[0]?.subject).toBe("Recovered step");
      expect(result.state.pending.planFilePath).toBeNull();
    }
    expect(hasEffect(result.effects, "persistState")).toBe(true);
  });

  it("ChooseExecute enters Executing with task-list signals enabled", () => {
    const result = modesReducer(awaitingChoice(["full", "tools"]), { _tag: "ChooseExecute" });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.todoItems[0]!.status).toBe("in_progress");
      expect(result.state.currentStep).toBe(1);
    }
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["full", "tools", ...TASK_LIST_SIGNAL_TOOLS, ...EXECUTION_SIGNAL_TOOLS],
    });
    expect(getEffect<BuiltinEffect>(result.effects, "setThinkingLevel")).toMatchObject({
      level: "medium",
    });
    expect(hasEffect(result.effects, "persistTaskList")).toBe(true);
  });

  it("ChooseStay and ChooseRefine return to Auto with pending tasks intact", () => {
    const state = awaitingChoice();
    const expectedPending = state.pending;
    const stay = modesReducer(state, { _tag: "ChooseStay" });
    expect(stay.state).toMatchObject({ _tag: "Auto", pending: expectedPending });
    expect(getEffect<BuiltinEffect>(stay.effects, "setThinkingLevel")).toMatchObject({
      level: "medium",
    });

    const refine = modesReducer(state, { _tag: "ChooseRefine", refinement: "split step two" });
    expect(refine.state._tag).toBe("Auto");
    expect(getEffect<BuiltinEffect>(refine.effects, "setThinkingLevel")).toMatchObject({
      level: "medium",
    });
    expect(getEffect<BuiltinEffect>(refine.effects, "sendUserMessage")).toMatchObject({
      content: "split step two",
    });
  });

  it("StepDone enters gating and keeps the active task in progress", () => {
    const result = modesReducer(executing(), { _tag: "StepDone", step: 1 });
    expect(result.state._tag).toBe("Executing");
    if (result.state._tag === "Executing") {
      expect(result.state.phase).toBe("gating");
      expect(result.state.todoItems[0]!.status).toBe("in_progress");
    }
    expect(hasEffect(result.effects, "updatePlanFile")).toBe(true);
  });

  it("ExecutionComplete returns to Auto and restores auto-mode tools", () => {
    const result = modesReducer(executing(), { _tag: "ExecutionComplete" });
    expect(result.state._tag).toBe("Auto");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["read", "bash", "edit", "write", ...AUTO_SIGNAL_TOOLS, ...TASK_LIST_SIGNAL_TOOLS],
    });
    expect(getEffect<BuiltinEffect>(result.effects, "setThinkingLevel")).toMatchObject({
      level: "medium",
    });
    expect(hasEffect(result.effects, "updatePlanFile")).toBe(true);
    expect(hasEffect(result.effects, "clearTaskList")).toBe(true);
  });

  it("hydrates AwaitingChoice with auto-mode tools and preserved spec", () => {
    const pending = {
      todoItems: tasks("Do it"),
      planFilePath: "/tmp/task-list.md",
      planText: "# Task List\n1. Do it",
    };
    const result = modesReducer(auto(), {
      _tag: "Hydrate",
      mode: "AwaitingChoice",
      todoItems: pending.todoItems,
      planFilePath: pending.planFilePath,
      savedTools: ["read", "bash"],
      pending,
      spec: { specFilePath: "/tmp/spec.md", specText: "# Spec" },
      flagSpec: false,
      flagPlan: false,
      currentTools: ["read", "bash"],
    });
    expect(result.state._tag).toBe("AwaitingChoice");
    expect(getEffect<BuiltinEffect>(result.effects, "setActiveTools")).toMatchObject({
      tools: ["read", "bash", ...AUTO_SIGNAL_TOOLS, ...TASK_LIST_SIGNAL_TOOLS],
    });
    expect(getEffect<BuiltinEffect>(result.effects, "setThinkingLevel")).toMatchObject({
      level: "medium",
    });
  });

  it("hydrates Spec from the new flag and legacy Planning mode", () => {
    const byFlag = modesReducer(auto(), {
      _tag: "Hydrate",
      mode: undefined,
      todoItems: [],
      planFilePath: null,
      savedTools: ["read"],
      pending: undefined,
      spec: undefined,
      flagSpec: true,
      flagPlan: false,
      currentTools: ["read"],
    });
    expect(byFlag.state._tag).toBe("Spec");
    expect(getEffect<BuiltinEffect>(byFlag.effects, "setThinkingLevel")).toMatchObject({
      level: "xhigh",
    });

    const legacy = modesReducer(auto(), {
      _tag: "Hydrate",
      mode: "Planning",
      todoItems: [],
      planFilePath: null,
      savedTools: ["read"],
      pending: undefined,
      spec: undefined,
      flagSpec: false,
      flagPlan: false,
      currentTools: ["read"],
    });
    expect(legacy.state._tag).toBe("Spec");
    expect(getEffect<BuiltinEffect>(legacy.effects, "setThinkingLevel")).toMatchObject({
      level: "xhigh",
    });
  });
});

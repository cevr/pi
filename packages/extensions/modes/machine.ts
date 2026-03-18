/**
 * Modes — pure state machine.
 *
 * Zero pi imports. Tested by calling the reducer directly.
 */

import type { DiffContext } from "@cvr/pi-diff-context";
import { executeTurn, type ExecutionEffect } from "@cvr/pi-execution";
import {
  enterSequentialExecutionGate,
  resolveSequentialExecutionCounsel,
  resolveSequentialExecutionGate,
  type SequentialExecutionPhase,
} from "@cvr/pi-sequential-execution";
import { findTaskByOrder, setTaskStatus, type TaskListItem } from "@cvr/pi-task-list";
import type { BuiltinEffect, Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPEC_TOOLS = ["read", "bash", "grep", "find", "ls", "interview"];
export const AUTO_SIGNAL_TOOLS = ["modes_enter_spec"] as const;
export const SPEC_SIGNAL_TOOLS = ["modes_spec_ready"] as const;
export const TASK_LIST_SIGNAL_TOOLS = ["modes_task_list_ready"] as const;
export const EXECUTION_SIGNAL_TOOLS = [
  "modes_step_done",
  "modes_gate_result",
  "modes_counsel_result",
] as const;
export const AUTO_DEFAULT_THINKING = "medium" as const;
export const SPEC_DEFAULT_THINKING = "xhigh" as const;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SpecDraft {
  specFilePath: string | null;
  specText: string;
}

/** Pending executable task list carried across Auto/AwaitingChoice for refine + execute flows. */
export interface PendingTaskList {
  todoItems: TaskListItem[];
  planFilePath: string | null;
  planText: string;
}

export type ExecutionPhase = SequentialExecutionPhase;

export type ModesState =
  | { _tag: "Auto"; spec?: SpecDraft; pending?: PendingTaskList }
  | {
      _tag: "Spec";
      savedTools: string[];
      spec?: SpecDraft;
      pending?: PendingTaskList;
      diffContext?: DiffContext;
    }
  | { _tag: "AwaitingChoice"; savedTools: string[]; pending: PendingTaskList; spec?: SpecDraft }
  | {
      _tag: "Executing";
      savedTools: string[];
      todoItems: TaskListItem[];
      planFilePath: string | null;
      phase: ExecutionPhase;
      currentStep: number | null;
      spec?: SpecDraft;
    };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ModesEvent =
  | { _tag: "Toggle"; currentTools: string[]; diffContext?: DiffContext }
  | { _tag: "SpecWithPrompt"; prompt: string; currentTools: string[]; diffContext?: DiffContext }
  | { _tag: "SpecReady"; spec: SpecDraft }
  | { _tag: "TaskListReady"; pending: PendingTaskList; currentTools: string[] }
  | { _tag: "ChooseExecute" }
  | { _tag: "ChooseStay" }
  | { _tag: "ChooseRefine"; refinement: string }
  | { _tag: "Reset" }
  | {
      _tag: "Hydrate";
      mode?: ModesState["_tag"] | "Planning";
      todoItems: TaskListItem[];
      planFilePath: string | null;
      savedTools: string[] | null;
      pending?: PendingTaskList;
      spec?: SpecDraft;
      flagSpec: boolean;
      flagPlan: boolean;
      currentTools: string[];
      currentStep?: number | null;
      phase?: ExecutionPhase;
    }
  | { _tag: "StepDone"; step: number }
  | { _tag: "GateResult"; status: "pass" | "fail" }
  | { _tag: "CounselResult"; status: "pass" | "fail" }
  | { _tag: "ExecutionComplete" };

// ---------------------------------------------------------------------------
// Extension-specific effects
// ---------------------------------------------------------------------------

export type ModesEffect =
  | ExecutionEffect
  | { type: "writePlanFile"; planFilePath: string; planText: string; todoItems: TaskListItem[] }
  | { type: "writeSpecFile"; specFilePath: string; specText: string }
  | { type: "updatePlanFile"; planFilePath: string; todoItems: TaskListItem[] }
  | { type: "persistState"; state: PersistPayload }
  | { type: "updateUI" };

export interface PersistPayload {
  mode: ModesState["_tag"];
  todoItems: TaskListItem[];
  planFilePath: string | null;
  savedTools: string[] | null;
  pending?: PendingTaskList;
  spec?: SpecDraft;
  phase?: ExecutionPhase;
  currentStep?: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | ModesEffect;
type Result = TransitionResult<ModesState, ModesEffect>;

function persist(state: ModesState): ModesEffect {
  const payload: PersistPayload = (() => {
    switch (state._tag) {
      case "Auto":
        return {
          mode: "Auto",
          todoItems: state.pending?.todoItems ?? [],
          planFilePath: state.pending?.planFilePath ?? null,
          savedTools: null,
          pending: state.pending,
          spec: state.spec,
        };
      case "Spec":
        return {
          mode: "Spec",
          todoItems: state.pending?.todoItems ?? [],
          planFilePath: state.pending?.planFilePath ?? null,
          savedTools: state.savedTools,
          pending: state.pending,
          spec: state.spec,
        };
      case "AwaitingChoice":
        return {
          mode: "AwaitingChoice",
          todoItems: state.pending.todoItems,
          planFilePath: state.pending.planFilePath,
          savedTools: state.savedTools,
          pending: state.pending,
          spec: state.spec,
        };
      case "Executing":
        return {
          mode: "Executing",
          todoItems: state.todoItems,
          planFilePath: state.planFilePath,
          savedTools: state.savedTools,
          spec: state.spec,
          phase: state.phase,
          currentStep: state.currentStep,
        };
    }
  })();

  return { type: "persistState", state: payload };
}

const UI: ModesEffect = { type: "updateUI" };

function mergeTools(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat())];
}

function getAutoModeTools(savedTools: readonly string[]): string[] {
  return mergeTools(savedTools, AUTO_SIGNAL_TOOLS, TASK_LIST_SIGNAL_TOOLS);
}

function getSpecModeTools(): string[] {
  return mergeTools(SPEC_TOOLS, SPEC_SIGNAL_TOOLS);
}

function getModeThinkingLevel(
  state: ModesState,
): typeof AUTO_DEFAULT_THINKING | typeof SPEC_DEFAULT_THINKING {
  return state._tag === "Spec" ? SPEC_DEFAULT_THINKING : AUTO_DEFAULT_THINKING;
}

function setModeThinking(state: ModesState): BuiltinEffect {
  return { type: "setThinkingLevel", level: getModeThinkingLevel(state) };
}

function getExecutionTools(savedTools: readonly string[]): string[] {
  return mergeTools(savedTools, TASK_LIST_SIGNAL_TOOLS, EXECUTION_SIGNAL_TOOLS);
}

function requestTaskListFromSpec(spec: SpecDraft): ExecutionEffect {
  const specRef = spec.specFilePath
    ? `Read the saved spec at: ${spec.specFilePath}`
    : `Use this spec as the source of truth:\n\n${spec.specText}`;
  return executeTurn({
    customType: "modes-auto-task-list",
    content:
      `You are back in AUTO mode. ${specRef}\n\n` +
      "Convert the spec into an executable task list, then call modes_task_list_ready with:\n" +
      "- planText: the full executable task list markdown/text\n" +
      "- steps: the ordered implementation steps\n\n" +
      "Do not start executing the work until the tool has been called and the user's choice is resolved.",
    display: false,
    triggerTurn: true,
  });
}

function startTaskExecution(items: readonly TaskListItem[]): TaskListItem[] {
  const firstTask = items[0];
  return firstTask ? setTaskStatus(items, firstTask.order, "in_progress") : [...items];
}

function completeTask(items: readonly TaskListItem[], step: number): TaskListItem[] {
  return setTaskStatus(items, step, "completed");
}

function continueWithNextTask(items: readonly TaskListItem[], step: number): TaskListItem[] {
  const completed = completeTask(items, step);
  const nextTask = findTaskByOrder(completed, step + 1);
  return nextTask ? setTaskStatus(completed, nextTask.order, "in_progress") : completed;
}

function ensureActiveTask(
  items: readonly TaskListItem[],
  currentStep: number | null,
): TaskListItem[] {
  if (items.some((task) => task.status === "in_progress")) {
    return items.map((task) => ({ ...task }));
  }

  const nextTask =
    (currentStep === null ? undefined : findTaskByOrder(items, currentStep)) ??
    items.find((task) => task.status !== "completed");
  if (!nextTask) return items.map((task) => ({ ...task }));
  return setTaskStatus(items, nextTask.order, "in_progress");
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const modesReducer: Reducer<ModesState, ModesEvent, ModesEffect> = (
  state,
  event,
): Result => {
  switch (event._tag) {
    // ----- Toggle -----
    case "Toggle": {
      if (state._tag === "Auto") {
        const next: ModesState = {
          _tag: "Spec",
          savedTools: event.currentTools,
          spec: state.spec,
          pending: state.pending,
          diffContext: event.diffContext,
        };

        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: getSpecModeTools() },
            setModeThinking(next),
            {
              type: "notify",
              message: `SPEC mode enabled. Tools: ${getSpecModeTools().join(", ")}`,
            },
            UI,
            persist(next),
          ],
        };
      }

      if (state._tag === "Spec") {
        const next: ModesState = { _tag: "Auto", spec: state.spec, pending: state.pending };
        const effects: Effect[] = [
          { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
          setModeThinking(next),
          { type: "notify", message: "AUTO mode restored. Full access enabled." },
          UI,
          persist(next),
        ];
        if (state.spec) {
          effects.splice(3, 0, requestTaskListFromSpec(state.spec));
        }
        return { state: next, effects };
      }

      if (state._tag === "AwaitingChoice") {
        const next: ModesState = { _tag: "Auto", spec: state.spec, pending: state.pending };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
            setModeThinking(next),
            { type: "notify", message: "AUTO mode restored. Full access enabled." },
            UI,
            persist(next),
          ],
        };
      }

      if (state._tag === "Executing") {
        return {
          state,
          effects: [
            {
              type: "notify",
              message: "Finish or cancel task execution before returning to AUTO mode.",
              level: "warning",
            },
          ],
        };
      }

      return { state };
    }

    // ----- SpecWithPrompt -----
    case "SpecWithPrompt": {
      if (state._tag === "Executing") {
        return {
          state,
          effects: [
            {
              type: "notify",
              message: "Finish or cancel task execution before drafting a new spec.",
              level: "warning",
            },
          ],
        };
      }

      const savedTools =
        state._tag === "Auto"
          ? event.currentTools
          : state._tag === "Spec" || state._tag === "AwaitingChoice"
            ? state.savedTools
            : event.currentTools;
      const pending = state._tag === "Executing" ? undefined : state.pending;
      const spec = state._tag === "Executing" ? state.spec : state.spec;
      const diffContext =
        event.diffContext ?? (state._tag === "Spec" ? state.diffContext : undefined);
      const next: ModesState = { _tag: "Spec", savedTools, spec, pending, diffContext };

      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getSpecModeTools() },
          setModeThinking(next),
          {
            type: "notify",
            message: `SPEC mode enabled. Tools: ${getSpecModeTools().join(", ")}`,
          },
          UI,
          { type: "sendUserMessage", content: event.prompt, deliverAs: "followUp" },
          persist(next),
        ],
      };
    }

    // ----- SpecReady -----
    case "SpecReady": {
      if (state._tag !== "Spec") return { state };

      const next: ModesState = { ...state, spec: event.spec };
      const pathInfo = event.spec.specFilePath ? `\n\nSaved to: ${event.spec.specFilePath}` : "";
      const effects: Effect[] = [
        {
          type: "sendMessage",
          customType: "modes-spec",
          content: `**Spec Captured**${pathInfo}`,
          display: true,
        },
      ];
      if (event.spec.specFilePath) {
        effects.push({
          type: "writeSpecFile",
          specFilePath: event.spec.specFilePath,
          specText: event.spec.specText,
        });
      }
      effects.push(UI, persist(next));
      return { state: next, effects };
    }

    // ----- TaskListReady -----
    case "TaskListReady": {
      if (state._tag !== "Auto") return { state };
      if (event.pending.todoItems.length === 0) return { state };

      const next: ModesState = {
        _tag: "AwaitingChoice",
        savedTools: event.currentTools,
        pending: event.pending,
        spec: state.spec,
      };
      const todoListText = event.pending.todoItems
        .map((task) => `${task.order}. ◻ ${task.subject}`)
        .join("\n");
      const pathInfo = event.pending.planFilePath
        ? `\n\nSaved to: ${event.pending.planFilePath}`
        : "";

      const effects: Effect[] = [
        setModeThinking(next),
        {
          type: "sendMessage",
          customType: "modes-todo-list",
          content: `**Task List (${event.pending.todoItems.length}):**\n\n${todoListText}${pathInfo}`,
          display: true,
        },
        persist(next),
      ];
      if (event.pending.planFilePath) {
        effects.unshift({
          type: "writePlanFile",
          planFilePath: event.pending.planFilePath,
          planText: event.pending.planText,
          todoItems: event.pending.todoItems,
        });
      }

      return {
        state: next,
        effects,
      };
    }

    // ----- ChooseExecute -----
    case "ChooseExecute": {
      if (state._tag !== "AwaitingChoice") return { state };

      const { pending, savedTools } = state;
      const todoItems = startTaskExecution(pending.todoItems);
      const firstTask = todoItems[0];
      const next: ModesState = {
        _tag: "Executing",
        savedTools,
        todoItems,
        planFilePath: pending.planFilePath,
        phase: "running",
        currentStep: firstTask?.order ?? null,
        spec: state.spec,
      };
      const execMessage =
        firstTask !== undefined
          ? `Execute the task list. Start with step ${firstTask.order}: ${firstTask.subject}`
          : "Execute the task list you just created.";

      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getExecutionTools(savedTools) },
          setModeThinking(next),
          UI,
          executeTurn({
            customType: "modes-execute",
            content: execMessage,
            display: true,
            triggerTurn: true,
          }),
          persist(next),
        ],
      };
    }

    // ----- ChooseStay -----
    case "ChooseStay": {
      if (state._tag !== "AwaitingChoice") return { state };

      const next: ModesState = {
        _tag: "Auto",
        spec: state.spec,
        pending: state.pending,
      };

      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
          setModeThinking(next),
          UI,
          persist(next),
        ],
      };
    }

    // ----- ChooseRefine -----
    case "ChooseRefine": {
      if (state._tag !== "AwaitingChoice") return { state };

      const next: ModesState = {
        _tag: "Auto",
        spec: state.spec,
        pending: state.pending,
      };

      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
          setModeThinking(next),
          UI,
          { type: "sendUserMessage", content: event.refinement, deliverAs: "followUp" },
          persist(next),
        ],
      };
    }

    // ----- StepDone (execution progress signal) -----
    case "StepDone": {
      if (state._tag !== "Executing" || state.phase !== "running" || state.todoItems.length === 0) {
        return { state };
      }
      if (state.currentStep !== null && event.step !== state.currentStep) {
        return { state };
      }

      const currentIndex = state.todoItems.findIndex((task) => task.order === event.step);
      const progress = enterSequentialExecutionGate(
        {
          phase: state.phase,
          currentIndex: state.currentStep === null ? null : state.currentStep - 1,
          total: state.todoItems.length,
        },
        currentIndex,
      );
      if (!progress) return { state };

      const next: ModesState = {
        _tag: "Executing",
        savedTools: state.savedTools,
        todoItems: state.todoItems.map((task) => ({ ...task })),
        planFilePath: state.planFilePath,
        phase: progress.phase,
        currentStep: progress.currentIndex + 1,
        spec: state.spec,
      };
      const effects: Effect[] = [
        executeTurn({
          customType: "modes-gate",
          content:
            "Run the full gate (typecheck, lint, format, test) for the completed step. When finished, call modes_gate_result with status 'pass' or 'fail'.",
          display: false,
          triggerTurn: true,
        }),
        UI,
        persist(next),
      ];
      if (state.planFilePath) {
        effects.push({
          type: "updatePlanFile",
          planFilePath: state.planFilePath,
          todoItems: next.todoItems,
        });
      }
      return { state: next, effects };
    }

    // ----- GateResult -----
    case "GateResult": {
      if (state._tag !== "Executing" || state.phase !== "gating") return { state };

      const progress = resolveSequentialExecutionGate(
        {
          phase: state.phase,
          currentIndex: state.currentStep === null ? null : state.currentStep - 1,
          total: state.todoItems.length,
        },
        event.status,
      );
      if (!progress) return { state };

      if (event.status === "pass") {
        const next: ModesState = { ...state, phase: progress.phase };
        return {
          state: next,
          effects: [
            executeTurn({
              customType: "modes-counsel",
              content:
                "Gate passed. Run counsel for cross-vendor review of the changes for this step. When finished, call modes_counsel_result with status 'pass' or 'fail'.",
              display: false,
              triggerTurn: true,
            }),
            UI,
            persist(next),
          ],
        };
      }

      const next: ModesState = { ...state, phase: progress.phase };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Gate failed — fix and retry", level: "warning" },
          executeTurn({
            customType: "modes-gate-fix",
            content:
              state.currentStep === null
                ? "Gate failed. Fix the failures, rerun the gate, then call modes_step_done again when the step is truly complete."
                : `Gate failed for step ${state.currentStep}. Fix the failures, rerun the gate, then call modes_step_done for step ${state.currentStep} again when it is truly complete.`,
            display: false,
            triggerTurn: true,
          }),
          UI,
          persist(next),
        ],
      };
    }

    // ----- CounselResult -----
    case "CounselResult": {
      if (state._tag !== "Executing" || state.phase !== "counseling") return { state };

      const progress = resolveSequentialExecutionCounsel(
        {
          phase: state.phase,
          currentIndex: state.currentStep === null ? null : state.currentStep - 1,
          total: state.todoItems.length,
        },
        event.status,
      );
      if (!progress) return { state };

      if (progress.type === "retry") {
        const next: ModesState = { ...state, phase: progress.phase };
        return {
          state: next,
          effects: [
            {
              type: "notify",
              message: "Counsel found issues — address feedback",
              level: "warning",
            },
            executeTurn({
              customType: "modes-counsel-fix",
              content:
                state.currentStep === null
                  ? "Counsel found issues. Address the feedback, then call modes_step_done again when the step is actually complete."
                  : `Counsel found issues on step ${state.currentStep}. Address the feedback, then call modes_step_done for step ${state.currentStep} again when it is actually complete.`,
              display: false,
              triggerTurn: true,
            }),
            UI,
            persist(next),
          ],
        };
      }

      if (progress.type === "complete") {
        const completedStep = state.currentStep;
        const todoItems =
          completedStep === null ? state.todoItems : completeTask(state.todoItems, completedStep);
        return modesReducer({ ...state, todoItems }, { _tag: "ExecutionComplete" });
      }

      const currentStep = state.currentStep;
      const todoItems =
        currentStep === null ? state.todoItems : continueWithNextTask(state.todoItems, currentStep);
      const nextStep = findTaskByOrder(todoItems, progress.currentIndex + 1);
      const next: ModesState = {
        ...state,
        todoItems,
        phase: progress.phase,
        currentStep: progress.currentIndex + 1,
      };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Counsel approved — continue to the next step" },
          executeTurn({
            customType: "modes-counsel-pass",
            content: nextStep
              ? `Counsel approved. Continue with step ${nextStep.order}: ${nextStep.subject}. When that step is complete, call modes_step_done for step ${nextStep.order}.`
              : "Counsel approved. Continue the task list and call modes_step_done when the next step is complete.",
            display: false,
            triggerTurn: true,
          }),
          UI,
          persist(next),
        ],
      };
    }

    // ----- ExecutionComplete -----
    case "ExecutionComplete": {
      if (state._tag !== "Executing") return { state };

      const completedList = state.todoItems.map((task) => `~~${task.subject}~~`).join("\n");
      const pathInfo = state.planFilePath ? `\n\nTask list file: ${state.planFilePath}` : "";
      const effects: Effect[] = [
        {
          type: "sendMessage",
          customType: "modes-complete",
          content: `**Task List Complete!**\n\n${completedList}${pathInfo}`,
          display: true,
        },
        { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
      ];
      if (state.planFilePath) {
        effects.push({
          type: "updatePlanFile",
          planFilePath: state.planFilePath,
          todoItems: state.todoItems,
        });
      }
      const next: ModesState = { _tag: "Auto", spec: state.spec };
      effects.push(setModeThinking(next), UI, persist(next));
      return { state: next, effects };
    }

    // ----- Reset -----
    case "Reset": {
      const next: ModesState = { _tag: "Auto" };
      return { state: next, effects: [setModeThinking(next), UI] };
    }

    // ----- Hydrate (session resume) -----
    case "Hydrate": {
      const effects: Effect[] = [];
      const savedTools = event.savedTools ?? event.currentTools;

      if (event.mode === "AwaitingChoice" && event.pending) {
        const next: ModesState = {
          _tag: "AwaitingChoice",
          savedTools,
          pending: event.pending,
          spec: event.spec,
        };
        effects.push(
          { type: "setActiveTools", tools: getAutoModeTools(savedTools) },
          setModeThinking(next),
          UI,
        );
        return { state: next, effects };
      }

      if (event.mode === "Executing" && event.todoItems.length > 0) {
        const currentStep =
          event.currentStep ??
          event.todoItems.find((task) => task.status !== "completed")?.order ??
          null;
        const todoItems = ensureActiveTask(event.todoItems, currentStep);
        const next: ModesState = {
          _tag: "Executing",
          savedTools,
          todoItems,
          planFilePath: event.planFilePath,
          phase: event.phase ?? "running",
          currentStep,
          spec: event.spec,
        };
        effects.push(
          { type: "setActiveTools", tools: getExecutionTools(savedTools) },
          setModeThinking(next),
          UI,
        );
        if (event.planFilePath) {
          effects.push({
            type: "updatePlanFile",
            planFilePath: event.planFilePath,
            todoItems,
          });
        }
        return { state: next, effects };
      }

      if (
        event.mode === "Spec" ||
        event.flagSpec ||
        (!event.pending && (event.mode === "Planning" || event.flagPlan))
      ) {
        const next: ModesState = {
          _tag: "Spec",
          savedTools,
          spec: event.spec,
          diffContext: undefined,
        };
        effects.push(
          { type: "setActiveTools", tools: getSpecModeTools() },
          setModeThinking(next),
          UI,
        );
        return { state: next, effects };
      }

      if (event.pending) {
        const next: ModesState = {
          _tag: "Auto",
          spec: event.spec,
          pending: event.pending,
        };
        effects.push(
          { type: "setActiveTools", tools: getAutoModeTools(savedTools) },
          setModeThinking(next),
          UI,
        );
        return { state: next, effects };
      }

      const next: ModesState = { _tag: "Auto", spec: event.spec };
      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getAutoModeTools(savedTools) },
          setModeThinking(next),
          UI,
        ],
      };
    }
  }
};

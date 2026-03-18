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
import {
  findTaskByOrder,
  setTaskStatus,
  type TaskListItem,
} from "@cvr/pi-task-list";
import type { BuiltinEffect, Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "interview"];
export const PLAN_SIGNAL_TOOLS = ["modes_plan_ready"] as const;
export const EXECUTION_SIGNAL_TOOLS = [
  "modes_step_done",
  "modes_gate_result",
  "modes_counsel_result",
] as const;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Pending plan data — carried across Planning/AwaitingChoice so /todos and refine work. */
export interface PendingPlan {
  todoItems: TaskListItem[];
  planFilePath: string | null;
  planText: string;
}

export type ExecutionPhase = SequentialExecutionPhase;

export type ModesState =
  | { _tag: "Auto" }
  | { _tag: "Planning"; savedTools: string[]; pending?: PendingPlan; diffContext?: DiffContext }
  | { _tag: "AwaitingChoice"; savedTools: string[]; pending: PendingPlan }
  | {
      _tag: "Executing";
      savedTools: string[];
      todoItems: TaskListItem[];
      planFilePath: string | null;
      phase: ExecutionPhase;
      currentStep: number | null;
    };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ModesEvent =
  | { _tag: "Toggle"; currentTools: string[]; diffContext?: DiffContext }
  | { _tag: "PlanWithPrompt"; prompt: string; currentTools: string[]; diffContext?: DiffContext }
  | { _tag: "PlanReady"; todoItems: TaskListItem[]; planText: string; planFilePath: string }
  | { _tag: "ChooseExecute" }
  | { _tag: "ChooseStay" }
  | { _tag: "ChooseRefine"; refinement: string }
  | { _tag: "Reset" }
  | {
      _tag: "Hydrate";
      mode?: ModesState["_tag"];
      todoItems: TaskListItem[];
      planFilePath: string | null;
      savedTools: string[] | null;
      pending?: PendingPlan;
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
  | { type: "updatePlanFile"; planFilePath: string; todoItems: TaskListItem[] }
  | { type: "persistState"; state: PersistPayload }
  | { type: "updateUI" };

export interface PersistPayload {
  mode: ModesState["_tag"];
  todoItems: TaskListItem[];
  planFilePath: string | null;
  savedTools: string[] | null;
  pending?: PendingPlan;
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
          todoItems: [],
          planFilePath: null,
          savedTools: null,
        };
      case "Planning":
        return {
          mode: "Planning",
          todoItems: state.pending?.todoItems ?? [],
          planFilePath: state.pending?.planFilePath ?? null,
          savedTools: state.savedTools,
          pending: state.pending,
        };
      case "AwaitingChoice":
        return {
          mode: "AwaitingChoice",
          todoItems: state.pending.todoItems,
          planFilePath: state.pending.planFilePath,
          savedTools: state.savedTools,
          pending: state.pending,
        };
      case "Executing":
        return {
          mode: "Executing",
          todoItems: state.todoItems,
          planFilePath: state.planFilePath,
          savedTools: state.savedTools,
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

function getPlanModeTools(): string[] {
  return mergeTools(PLAN_TOOLS, PLAN_SIGNAL_TOOLS);
}

function getExecutionTools(savedTools: readonly string[]): string[] {
  return mergeTools(savedTools, EXECUTION_SIGNAL_TOOLS);
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

function ensureActiveTask(items: readonly TaskListItem[], currentStep: number | null): TaskListItem[] {
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
          _tag: "Planning",
          savedTools: event.currentTools,
          diffContext: event.diffContext,
        };

        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: getPlanModeTools() },
            {
              type: "notify",
              message: `PLAN mode enabled. Tools: ${getPlanModeTools().join(", ")}`,
            },
            UI,
            persist(next),
          ],
        };
      }

      if (state._tag === "Planning" || state._tag === "AwaitingChoice") {
        const next: ModesState = { _tag: "Auto" };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: state.savedTools },
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
              message: "Finish or cancel PLAN execution before returning to AUTO mode.",
              level: "warning",
            },
          ],
        };
      }

      return { state };
    }

    // ----- PlanWithPrompt -----
    case "PlanWithPrompt": {
      if (state._tag === "Executing") {
        return {
          state,
          effects: [
            {
              type: "notify",
              message: "Finish or cancel PLAN execution before drafting a new plan.",
              level: "warning",
            },
          ],
        };
      }

      const savedTools =
        state._tag === "Auto"
          ? event.currentTools
          : state._tag === "Planning" || state._tag === "AwaitingChoice"
            ? state.savedTools
            : event.currentTools;
      const pending =
        state._tag === "Planning"
          ? state.pending
          : state._tag === "AwaitingChoice"
            ? state.pending
            : undefined;
      const diffContext =
        event.diffContext ?? (state._tag === "Planning" ? state.diffContext : undefined);
      const next: ModesState = { _tag: "Planning", savedTools, pending, diffContext };

      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getPlanModeTools() },
          {
            type: "notify",
            message: `PLAN mode enabled. Tools: ${getPlanModeTools().join(", ")}`,
          },
          UI,
          { type: "sendUserMessage", content: event.prompt, deliverAs: "followUp" },
          persist(next),
        ],
      };
    }

    // ----- PlanReady (agent signal) -----
    case "PlanReady": {
      if (state._tag !== "Planning") return { state };
      if (event.todoItems.length === 0) return { state };

      const pending: PendingPlan = {
        todoItems: event.todoItems,
        planFilePath: event.planFilePath,
        planText: event.planText,
      };
      const next: ModesState = { _tag: "AwaitingChoice", savedTools: state.savedTools, pending };

      const todoListText = event.todoItems
        .map((task) => `${task.order}. ◻ ${task.subject}`)
        .join("\n");
      const pathInfo = event.planFilePath ? `\n\nSaved to: ${event.planFilePath}` : "";

      return {
        state: next,
        effects: [
          {
            type: "writePlanFile",
            planFilePath: event.planFilePath,
            planText: event.planText,
            todoItems: event.todoItems,
          },
          {
            type: "sendMessage",
            customType: "modes-todo-list",
            content: `**Plan Steps (${event.todoItems.length}):**\n\n${todoListText}${pathInfo}`,
            display: true,
          },
          persist(next),
        ],
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
      };
      const execMessage =
        firstTask !== undefined
          ? `Execute the plan. Start with step ${firstTask.order}: ${firstTask.subject}`
          : "Execute the plan you just created.";

      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getExecutionTools(savedTools) },
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
        _tag: "Planning",
        savedTools: state.savedTools,
        pending: state.pending,
      };

      return {
        state: next,
        effects: [UI, persist(next)],
      };
    }

    // ----- ChooseRefine -----
    case "ChooseRefine": {
      if (state._tag !== "AwaitingChoice") return { state };

      const next: ModesState = {
        _tag: "Planning",
        savedTools: state.savedTools,
        pending: state.pending,
      };

      return {
        state: next,
        effects: [
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
              : "Counsel approved. Continue the plan and call modes_step_done when the next step is complete.",
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
      const pathInfo = state.planFilePath ? `\n\nPlan file: ${state.planFilePath}` : "";
      const effects: Effect[] = [
        {
          type: "sendMessage",
          customType: "modes-complete",
          content: `**Plan Complete!**\n\n${completedList}${pathInfo}`,
          display: true,
        },
        { type: "setActiveTools", tools: state.savedTools },
      ];
      if (state.planFilePath) {
        effects.push({
          type: "updatePlanFile",
          planFilePath: state.planFilePath,
          todoItems: state.todoItems,
        });
      }
      const next: ModesState = { _tag: "Auto" };
      effects.push(UI, persist(next));
      return { state: next, effects };
    }

    // ----- Reset -----
    case "Reset": {
      return { state: { _tag: "Auto" }, effects: [UI] };
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
        };
        effects.push({ type: "setActiveTools", tools: getPlanModeTools() }, UI);
        return { state: next, effects };
      }

      if (event.mode === "Executing" && event.todoItems.length > 0) {
        const currentStep =
          event.currentStep ?? event.todoItems.find((task) => task.status !== "completed")?.order ?? null;
        const todoItems = ensureActiveTask(event.todoItems, currentStep);
        const next: ModesState = {
          _tag: "Executing",
          savedTools,
          todoItems,
          planFilePath: event.planFilePath,
          phase: event.phase ?? "running",
          currentStep,
        };
        effects.push({ type: "setActiveTools", tools: getExecutionTools(savedTools) }, UI);
        if (event.planFilePath) {
          effects.push({
            type: "updatePlanFile",
            planFilePath: event.planFilePath,
            todoItems,
          });
        }
        return { state: next, effects };
      }

      if (event.mode === "Planning" || event.flagPlan) {
        const next: ModesState = {
          _tag: "Planning",
          savedTools,
          pending: event.pending,
        };
        effects.push({ type: "setActiveTools", tools: getPlanModeTools() }, UI);
        return { state: next, effects };
      }

      return { state: { _tag: "Auto" }, effects: [UI] };
    }
  }
};

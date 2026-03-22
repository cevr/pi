/**
 * Modes — pure state machine.
 *
 * Zero pi imports. Tested by calling the reducer directly.
 */

import type { DiffContext } from "@cvr/pi-diff-context";
import { executeTurn, type ExecutionEffect } from "@cvr/pi-execution";
import {
  enterSequentialExecutionCounsel,
  resolveSequentialExecutionCounsel,
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
export const EXECUTION_SIGNAL_TOOLS = ["modes_step_done", "modes_counsel_result"] as const;
export const SPEC_COUNSEL_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "counsel",
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

/** Pending executable task list carried across mode transitions and hydration. */
export interface PendingTaskList {
  todoItems: TaskListItem[];
  planFilePath: string | null;
  planText: string;
}

export type ExecutionPhase = SequentialExecutionPhase;

export type ModesState =
  | { _tag: "Auto"; spec?: SpecDraft }
  | {
      _tag: "Spec";
      savedTools: string[];
      spec?: SpecDraft;
      pending?: PendingTaskList;
      diffContext?: DiffContext;
    }
  | {
      _tag: "SpecCounseling";
      savedTools: string[];
      spec: SpecDraft;
      pending?: PendingTaskList;
      diffContext?: DiffContext;
    }
  | {
      _tag: "SpecReview";
      savedTools: string[];
      spec: SpecDraft;
      pending?: PendingTaskList;
      diffContext?: DiffContext;
    }
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
  | { _tag: "ApproveSpec" }
  | { _tag: "RejectSpec" }
  | { _tag: "EditSpec"; feedback: string }
  | { _tag: "TaskListReady"; pending: PendingTaskList; currentTools: string[] }
  | { _tag: "RestoreTaskList"; todoItems: TaskListItem[]; currentTools: string[] }
  | { _tag: "Reset" }
  | {
      _tag: "Hydrate";
      mode?: ModesState["_tag"] | "Planning" | "AwaitingSpecApproval" | "AwaitingChoice";
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
  | { type: "persistTaskList"; todoItems: TaskListItem[] }
  | { type: "clearTaskList" }
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
          todoItems: [],
          planFilePath: null,
          savedTools: null,
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
      case "SpecCounseling":
        return {
          mode: "SpecCounseling",
          todoItems: state.pending?.todoItems ?? [],
          planFilePath: state.pending?.planFilePath ?? null,
          savedTools: state.savedTools,
          pending: state.pending,
          spec: state.spec,
        };
      case "SpecReview":
        return {
          mode: "SpecReview",
          todoItems: state.pending?.todoItems ?? [],
          planFilePath: state.pending?.planFilePath ?? null,
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

function getSpecCounselTools(): string[] {
  return [...SPEC_COUNSEL_TOOLS];
}

function getModeThinkingLevel(
  state: ModesState,
): typeof AUTO_DEFAULT_THINKING | typeof SPEC_DEFAULT_THINKING {
  return state._tag === "Spec" || state._tag === "SpecCounseling" || state._tag === "SpecReview"
    ? SPEC_DEFAULT_THINKING
    : AUTO_DEFAULT_THINKING;
}

function formatRestoredPlanText(todoItems: readonly TaskListItem[]): string {
  return `# Task List\n${todoItems.map((task) => `${task.order}. ${task.subject}`).join("\n")}`;
}

function setModeThinking(state: ModesState): BuiltinEffect {
  return { type: "setThinkingLevel", level: getModeThinkingLevel(state) };
}

function getExecutionTools(savedTools: readonly string[]): string[] {
  return mergeTools(savedTools, TASK_LIST_SIGNAL_TOOLS, EXECUTION_SIGNAL_TOOLS);
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
        const next: ModesState = { _tag: "Auto", spec: state.spec };
        const effects: Effect[] = [
          { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
          setModeThinking(next),
          { type: "notify", message: "AUTO mode restored. Full access enabled." },
          UI,
          persist(next),
        ];
        return { state: next, effects };
      }

      if (state._tag === "SpecCounseling") {
        const next: ModesState = {
          _tag: "Spec",
          savedTools: state.savedTools,
          spec: state.spec,
          pending: state.pending,
          diffContext: state.diffContext,
        };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: getSpecModeTools() },
            setModeThinking(next),
            UI,
            persist(next),
          ],
        };
      }

      if (state._tag === "SpecReview") {
        const next: ModesState = {
          _tag: "Spec",
          savedTools: state.savedTools,
          spec: state.spec,
          pending: state.pending,
          diffContext: state.diffContext,
        };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: getSpecModeTools() },
            setModeThinking(next),
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
          : state._tag === "Spec" || state._tag === "SpecReview"
            ? state.savedTools
            : event.currentTools;
      const pending =
        state._tag === "Spec" || state._tag === "SpecReview" ? state.pending : undefined;
      const spec = state.spec;
      const diffContext =
        event.diffContext ??
        (state._tag === "Spec" || state._tag === "SpecReview" ? state.diffContext : undefined);
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
          {
            type: "sendMessage",
            customType: "modes-transition:spec",
            content: `AUTO → SPEC\n\nSpec goal: ${event.prompt}`,
            display: true,
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

      const next: ModesState = {
        _tag: "SpecCounseling",
        savedTools: state.savedTools,
        spec: event.spec,
        pending: state.pending,
        diffContext: state.diffContext,
      };
      const effects: Effect[] = [
        { type: "setActiveTools", tools: getSpecCounselTools() },
        setModeThinking(next),
        executeTurn({
          customType: "modes-counsel:spec",
          content:
            "The spec draft is complete. Run counsel to get a cross-vendor review of the spec before presenting it to the user. " +
            "Call the counsel tool with the spec content, then call modes_counsel_result with pass or fail.",
          display: false,
          triggerTurn: true,
        }),
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

    // ----- ApproveSpec -----
    case "ApproveSpec": {
      if (state._tag !== "SpecReview") return { state };

      const next: ModesState = { _tag: "Auto", spec: state.spec };
      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
          setModeThinking(next),
          {
            type: "notify",
            message: "Spec approved. AUTO mode restored; extracting the executable task list.",
          },
          UI,
          persist(next),
        ],
      };
    }

    // ----- RejectSpec -----
    case "RejectSpec": {
      if (state._tag !== "SpecReview") return { state };

      const next: ModesState = {
        _tag: "Spec",
        savedTools: state.savedTools,
        spec: state.spec,
        pending: state.pending,
        diffContext: state.diffContext,
      };
      return {
        state: next,
        effects: [
          setModeThinking(next),
          {
            type: "notify",
            message: "Spec rejected. Stay in SPEC mode and revise it before approval.",
            level: "warning",
          },
          UI,
          persist(next),
        ],
      };
    }

    // ----- EditSpec -----
    case "EditSpec": {
      if (state._tag !== "SpecReview") return { state };

      const next: ModesState = {
        _tag: "Spec",
        savedTools: state.savedTools,
        spec: state.spec,
        pending: state.pending,
        diffContext: state.diffContext,
      };
      return {
        state: next,
        effects: [
          setModeThinking(next),
          UI,
          { type: "sendUserMessage", content: event.feedback, deliverAs: "followUp" },
          persist(next),
        ],
      };
    }

    // ----- TaskListReady -----
    case "TaskListReady": {
      if (state._tag !== "Auto") return { state };
      if (event.pending.todoItems.length === 0) return { state };

      const todoItems = startTaskExecution(event.pending.todoItems);
      const firstTask = todoItems[0];
      const next: ModesState = {
        _tag: "Executing",
        savedTools: event.currentTools,
        todoItems,
        planFilePath: event.pending.planFilePath,
        phase: "running",
        currentStep: firstTask?.order ?? null,
        spec: state.spec,
      };
      const todoListText = todoItems.map((task) => `${task.order}. ◻ ${task.subject}`).join("\n");
      const pathInfo = event.pending.planFilePath
        ? `\n\nSaved to: ${event.pending.planFilePath}`
        : "";
      const execMessage =
        firstTask !== undefined
          ? `Execute the task list. Start with step ${firstTask.order}: ${firstTask.subject}`
          : "Execute the task list you just created.";

      const effects: Effect[] = [
        setModeThinking(next),
        {
          type: "sendMessage",
          customType: "modes-plan:task-list",
          content: `**Task List (${todoItems.length}):**\n\n${todoListText}${pathInfo}`,
          display: true,
        },
        { type: "setActiveTools", tools: getExecutionTools(event.currentTools) },
        executeTurn({
          customType: "modes-execution:start",
          content: execMessage,
          display: true,
          triggerTurn: true,
        }),
        { type: "persistTaskList", todoItems },
        UI,
        persist(next),
      ];
      if (event.pending.planFilePath) {
        effects.unshift({
          type: "writePlanFile",
          planFilePath: event.pending.planFilePath,
          planText: event.pending.planText,
          todoItems,
        });
      }

      return {
        state: next,
        effects,
      };
    }

    // ----- RestoreTaskList -----
    case "RestoreTaskList": {
      if (event.todoItems.length === 0) return { state };

      const pending: PendingTaskList = {
        todoItems: event.todoItems.map((task) => ({ ...task, blockedBy: [...task.blockedBy] })),
        planFilePath: null,
        planText: formatRestoredPlanText(event.todoItems),
      };

      if (state._tag === "Auto") {
        const todoItems = startTaskExecution(pending.todoItems);
        const firstTask = todoItems[0];
        const next: ModesState = {
          _tag: "Executing",
          savedTools: event.currentTools,
          todoItems,
          planFilePath: pending.planFilePath,
          phase: "running",
          currentStep: firstTask?.order ?? null,
          spec: state.spec,
        };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: getExecutionTools(event.currentTools) },
            setModeThinking(next),
            {
              type: "notify",
              message: "Restored executable task list from session storage and resumed execution.",
            },
            executeTurn({
              customType: "modes-execution:start",
              content: firstTask
                ? `Resume the restored task list. Continue with step ${firstTask.order}: ${firstTask.subject}`
                : "Resume the restored task list.",
              display: true,
              triggerTurn: true,
            }),
            { type: "persistTaskList", todoItems },
            UI,
            persist(next),
          ],
        };
      }

      if ((state._tag === "Spec" || state._tag === "SpecReview") && !state.pending) {
        const next: ModesState = { ...state, pending };
        return {
          state: next,
          effects: [
            {
              type: "notify",
              message: "Restored executable task list from session storage.",
            },
            persist(next),
          ],
        };
      }

      return { state };
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
      const progress = enterSequentialExecutionCounsel(
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
          customType: "modes-execution:counsel",
          content:
            "Step complete. Run the project's checks (typecheck, lint, test) if applicable, " +
            "then call the counsel tool for cross-vendor review of the changes for this step. " +
            "When counsel finishes, call modes_counsel_result with pass or fail.",
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

    // ----- CounselResult -----
    case "CounselResult": {
      // --- SpecCounseling branch ---
      if (state._tag === "SpecCounseling") {
        if (event.status === "pass") {
          const next: ModesState = {
            _tag: "SpecReview",
            savedTools: state.savedTools,
            spec: state.spec,
            pending: state.pending,
            diffContext: state.diffContext,
          };
          const pathInfo = state.spec.specFilePath
            ? `\n\nSaved to: ${state.spec.specFilePath}`
            : "";
          return {
            state: next,
            effects: [
              { type: "setActiveTools", tools: getSpecModeTools() },
              {
                type: "sendMessage",
                customType: "modes-review:spec",
                content: `**Spec Draft Ready**${pathInfo}\n\n${state.spec.specText}`,
                display: true,
              },
              UI,
              persist(next),
            ],
          };
        }

        // fail → back to Spec for revision
        const next: ModesState = {
          _tag: "Spec",
          savedTools: state.savedTools,
          spec: state.spec,
          pending: state.pending,
          diffContext: state.diffContext,
        };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: getSpecModeTools() },
            setModeThinking(next),
            executeTurn({
              customType: "modes-counsel:spec-revise",
              content:
                "Counsel found issues with the spec. Revise the spec based on counsel's feedback, then call modes_spec_ready again when the revised spec is complete.",
              display: false,
              triggerTurn: true,
            }),
            UI,
            persist(next),
          ],
        };
      }

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
              customType: "modes-execution:counsel-fix",
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
            customType: "modes-execution:next-step",
            content: nextStep
              ? `Counsel approved. Continue with step ${nextStep.order}: ${nextStep.subject}. When that step is complete, call modes_step_done for step ${nextStep.order}.`
              : "Counsel approved. Continue the task list and call modes_step_done when the next step is complete.",
            display: false,
            triggerTurn: true,
          }),
          UI,
          { type: "persistTaskList", todoItems },
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
          customType: "modes-execution:complete",
          content: `**Task List Complete!**\n\n${completedList}${pathInfo}`,
          display: true,
        },
        { type: "setActiveTools", tools: getAutoModeTools(state.savedTools) },
        { type: "clearTaskList" },
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

      if (event.mode === "SpecCounseling" && event.spec) {
        const next: ModesState = {
          _tag: "SpecCounseling",
          savedTools,
          spec: event.spec,
          pending: event.pending,
          diffContext: undefined,
        };
        effects.push(
          { type: "setActiveTools", tools: getSpecCounselTools() },
          setModeThinking(next),
          executeTurn({
            customType: "modes-counsel:spec",
            content:
              "Session resumed during spec counsel. Run counsel to review the spec, then call modes_counsel_result with pass or fail.",
            display: false,
            triggerTurn: true,
          }),
          UI,
        );
        return { state: next, effects };
      }

      if (event.mode === "SpecReview" && event.spec) {
        const next: ModesState = {
          _tag: "SpecReview",
          savedTools,
          spec: event.spec,
          pending: event.pending,
          diffContext: undefined,
        };
        effects.push(
          { type: "setActiveTools", tools: getSpecModeTools() },
          setModeThinking(next),
          UI,
        );
        return { state: next, effects };
      }

      if (event.mode === "AwaitingChoice" && event.pending) {
        const todoItems = startTaskExecution(event.pending.todoItems);
        const firstTask = todoItems[0];
        const next: ModesState = {
          _tag: "Executing",
          savedTools,
          todoItems,
          planFilePath: event.pending.planFilePath,
          phase: "running",
          currentStep: firstTask?.order ?? null,
          spec: event.spec,
        };
        effects.push(
          { type: "setActiveTools", tools: getExecutionTools(savedTools) },
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
        const todoItems = startTaskExecution(event.pending.todoItems);
        const firstTask = todoItems[0];
        const next: ModesState = {
          _tag: "Executing",
          savedTools,
          todoItems,
          planFilePath: event.pending.planFilePath,
          phase: "running",
          currentStep: firstTask?.order ?? null,
          spec: event.spec,
        };
        effects.push(
          { type: "setActiveTools", tools: getExecutionTools(savedTools) },
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

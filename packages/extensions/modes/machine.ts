/**
 * Modes — pure state machine.
 *
 * Zero pi imports. Tested by calling the reducer directly.
 */

import type { BuiltinEffect, Reducer, TransitionResult } from "@cvr/pi-state-machine";
import type { DiffContext } from "@cvr/pi-diff-context";
import type { TodoItem } from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "interview"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Pending plan data — carried across Planning/AwaitingChoice so /todos and refine work. */
export interface PendingPlan {
  todoItems: TodoItem[];
  planFilePath: string | null;
  planText: string;
}

export type ExecutionPhase = "running" | "gating" | "counseling";

export type ModesState =
  | { _tag: "Auto" }
  | { _tag: "Planning"; savedTools: string[]; pending?: PendingPlan; diffContext?: DiffContext }
  | { _tag: "AwaitingChoice"; savedTools: string[]; pending: PendingPlan }
  | {
      _tag: "Executing";
      todoItems: TodoItem[];
      planFilePath: string | null;
      phase: ExecutionPhase;
    };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ModesEvent =
  | { _tag: "Toggle"; currentTools: string[]; diffContext?: DiffContext }
  | { _tag: "PlanWithPrompt"; prompt: string; currentTools: string[]; diffContext?: DiffContext }
  | { _tag: "AgentEnd"; todoItems: TodoItem[]; planText: string; planFilePath: string }
  | { _tag: "TurnEnd"; todoItems: TodoItem[] }
  | { _tag: "ChooseExecute" }
  | { _tag: "ChooseStay" }
  | { _tag: "ChooseRefine"; refinement: string }
  | { _tag: "Reset" }
  | {
      _tag: "Hydrate";
      mode?: ModesState["_tag"];
      todoItems: TodoItem[];
      planFilePath: string | null;
      savedTools: string[] | null;
      pending?: PendingPlan;
      flagPlan: boolean;
      currentTools: string[];
    }
  | { _tag: "ExecutionComplete" }
  | { _tag: "TaskDone" }
  | { _tag: "GatePass" }
  | { _tag: "GateFail" }
  | { _tag: "CounselPass" }
  | { _tag: "CounselFail" };

// ---------------------------------------------------------------------------
// Extension-specific effects
// ---------------------------------------------------------------------------

export type ModesEffect =
  | { type: "writePlanFile"; planFilePath: string; planText: string; todoItems: TodoItem[] }
  | { type: "updatePlanFile"; planFilePath: string; todoItems: TodoItem[] }
  | { type: "persistState"; state: PersistPayload }
  | { type: "updateUI" };

export interface PersistPayload {
  mode: ModesState["_tag"];
  todoItems: TodoItem[];
  planFilePath: string | null;
  savedTools: string[] | null;
  pending?: PendingPlan;
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
          savedTools: null,
        };
    }
  })();

  return { type: "persistState", state: payload };
}

const UI: ModesEffect = { type: "updateUI" };

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
            { type: "setActiveTools", tools: PLAN_TOOLS },
            { type: "notify", message: `PLAN mode enabled. Tools: ${PLAN_TOOLS.join(", ")}` },
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
          { type: "setActiveTools", tools: PLAN_TOOLS },
          { type: "notify", message: `PLAN mode enabled. Tools: ${PLAN_TOOLS.join(", ")}` },
          UI,
          { type: "sendUserMessage", content: event.prompt, deliverAs: "followUp" },
          persist(next),
        ],
      };
    }

    // ----- AgentEnd (plan extracted) -----
    case "AgentEnd": {
      if (state._tag !== "Planning") return { state };
      if (event.todoItems.length === 0) return { state };

      const pending: PendingPlan = {
        todoItems: event.todoItems,
        planFilePath: event.planFilePath,
        planText: event.planText,
      };
      const next: ModesState = { _tag: "AwaitingChoice", savedTools: state.savedTools, pending };

      const todoListText = event.todoItems
        .map((todo, index) => `${index + 1}. ☐ ${todo.text}`)
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
      const next: ModesState = {
        _tag: "Executing",
        todoItems: pending.todoItems,
        planFilePath: pending.planFilePath,
        phase: "running",
      };
      const execMessage =
        pending.todoItems.length > 0
          ? `Execute the plan. Start with: ${pending.todoItems[0]!.text}`
          : "Execute the plan you just created.";

      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: savedTools },
          UI,
          {
            type: "sendMessage",
            customType: "modes-execute",
            content: execMessage,
            display: true,
            triggerTurn: true,
          },
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
        effects: [UI, { type: "sendUserMessage", content: event.refinement }, persist(next)],
      };
    }

    // ----- TurnEnd (execution progress) -----
    case "TurnEnd": {
      if (state._tag !== "Executing" || state.todoItems.length === 0) return { state };

      const next: ModesState = {
        _tag: "Executing",
        todoItems: event.todoItems,
        planFilePath: state.planFilePath,
        phase: state.phase,
      };
      const effects: Effect[] = [UI, persist(next)];
      if (state.planFilePath) {
        effects.push({
          type: "updatePlanFile",
          planFilePath: state.planFilePath,
          todoItems: event.todoItems,
        });
      }
      return { state: next, effects };
    }

    // ----- ExecutionComplete -----
    case "ExecutionComplete": {
      if (state._tag !== "Executing") return { state };

      const completedList = state.todoItems.map((todo) => `~~${todo.text}~~`).join("\n");
      const pathInfo = state.planFilePath ? `\n\nPlan file: ${state.planFilePath}` : "";
      const effects: Effect[] = [
        {
          type: "sendMessage",
          customType: "modes-complete",
          content: `**Plan Complete!**\n\n${completedList}${pathInfo}`,
          display: true,
        },
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

    // ----- Gated execution events -----
    case "TaskDone": {
      if (state._tag !== "Executing" || state.phase !== "running") return { state };
      const next: ModesState = { ...state, phase: "gating" };
      return {
        state: next,
        effects: [
          {
            type: "sendMessage",
            customType: "modes-gate",
            content:
              "Run the full gate (typecheck, lint, format, test). Report GATE_PASS if all pass, GATE_FAIL if any fail.",
            display: false,
            triggerTurn: true,
          },
          UI,
          persist(next),
        ],
      };
    }

    case "GatePass": {
      if (state._tag !== "Executing" || state.phase !== "gating") return { state };
      const next: ModesState = { ...state, phase: "counseling" };
      return {
        state: next,
        effects: [
          {
            type: "sendMessage",
            customType: "modes-counsel",
            content:
              "Gate passed. Run counsel for cross-vendor review of the changes. Report COUNSEL_PASS if approved, COUNSEL_FAIL if issues found.",
            display: false,
            triggerTurn: true,
          },
          UI,
          persist(next),
        ],
      };
    }

    case "GateFail": {
      if (state._tag !== "Executing" || state.phase !== "gating") return { state };
      const next: ModesState = { ...state, phase: "running" };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Gate failed — fix and retry", level: "warning" },
          {
            type: "sendMessage",
            customType: "modes-gate-fix",
            content:
              "Gate failed. Fix the failures, then mark the step as done again with [DONE:n].",
            display: false,
            triggerTurn: true,
          },
          UI,
          persist(next),
        ],
      };
    }

    case "CounselPass": {
      if (state._tag !== "Executing" || state.phase !== "counseling") return { state };
      const next: ModesState = { ...state, phase: "running" };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Counsel approved — commit and continue" },
          {
            type: "sendMessage",
            customType: "modes-counsel-pass",
            content: "Counsel approved. Commit the changes and continue to the next step.",
            display: false,
            triggerTurn: true,
          },
          UI,
          persist(next),
        ],
      };
    }

    case "CounselFail": {
      if (state._tag !== "Executing" || state.phase !== "counseling") return { state };
      const next: ModesState = { ...state, phase: "running" };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Counsel found issues — address feedback", level: "warning" },
          {
            type: "sendMessage",
            customType: "modes-counsel-fix",
            content:
              "Counsel found issues. Address the feedback, then mark the step as done again with [DONE:n].",
            display: false,
            triggerTurn: true,
          },
          UI,
          persist(next),
        ],
      };
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
        effects.push({ type: "setActiveTools", tools: PLAN_TOOLS }, UI);
        return { state: next, effects };
      }

      if (event.mode === "Executing" && event.todoItems.length > 0) {
        const next: ModesState = {
          _tag: "Executing",
          todoItems: event.todoItems,
          planFilePath: event.planFilePath,
          phase: "running",
        };
        effects.push(UI);
        if (event.planFilePath) {
          effects.push({
            type: "updatePlanFile",
            planFilePath: event.planFilePath,
            todoItems: event.todoItems,
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
        effects.push({ type: "setActiveTools", tools: PLAN_TOOLS }, UI);
        return { state: next, effects };
      }

      return { state: { _tag: "Auto" }, effects: [UI] };
    }
  }
};

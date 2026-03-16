/**
 * Plan Mode — pure state machine.
 *
 * Zero pi imports. Tested by calling the reducer directly.
 */

import type { BuiltinEffect, Reducer, TransitionResult } from "@cvr/pi-state-machine";
import type { TodoItem } from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "skill", "interview"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Pending plan data — carried across Planning/AwaitingChoice so /todos and refine work. */
export interface PendingPlan {
  todoItems: TodoItem[];
  planFilePath: string | null;
  planText: string;
}

export type PlanState =
  | { _tag: "Inactive" }
  | { _tag: "Planning"; savedTools: string[]; pending?: PendingPlan }
  | { _tag: "AwaitingChoice"; savedTools: string[]; pending: PendingPlan }
  | { _tag: "Executing"; todoItems: TodoItem[]; planFilePath: string | null };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type PlanEvent =
  | { _tag: "Toggle"; currentTools: string[] }
  | { _tag: "PlanWithPrompt"; prompt: string; currentTools: string[] }
  | { _tag: "AgentEnd"; todoItems: TodoItem[]; planText: string; planFilePath: string }
  | { _tag: "TurnEnd"; todoItems: TodoItem[] }
  | { _tag: "ChooseExecute" }
  | { _tag: "ChooseStay" }
  | { _tag: "ChooseRefine"; refinement: string }
  | { _tag: "Reset" }
  | {
      _tag: "Hydrate";
      enabled: boolean;
      todoItems: TodoItem[];
      executing: boolean;
      planFilePath: string | null;
      savedTools: string[] | null;
      flagPlan: boolean;
      currentTools: string[];
    }
  | { _tag: "ExecutionComplete" };

// ---------------------------------------------------------------------------
// Extension-specific effects
// ---------------------------------------------------------------------------

export type PlanEffect =
  | { type: "writePlanFile"; planFilePath: string; planText: string; todoItems: TodoItem[] }
  | { type: "updatePlanFile"; planFilePath: string; todoItems: TodoItem[] }
  | { type: "persistState"; state: PersistPayload }
  | { type: "updateUI" };

export interface PersistPayload {
  enabled: boolean;
  todos: TodoItem[];
  executing: boolean;
  planFilePath: string | null;
  savedTools: string[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Effect = BuiltinEffect | PlanEffect;
type Result = TransitionResult<PlanState, PlanEffect>;

function persist(s: PlanState): PlanEffect {
  const payload: PersistPayload = (() => {
    switch (s._tag) {
      case "Inactive":
        return {
          enabled: false,
          todos: [],
          executing: false,
          planFilePath: null,
          savedTools: null,
        };
      case "Planning":
        return {
          enabled: true,
          todos: s.pending?.todoItems ?? [],
          executing: false,
          planFilePath: s.pending?.planFilePath ?? null,
          savedTools: s.savedTools,
        };
      case "AwaitingChoice":
        return {
          enabled: true,
          todos: s.pending.todoItems,
          executing: false,
          planFilePath: s.pending.planFilePath,
          savedTools: s.savedTools,
        };
      case "Executing":
        return {
          enabled: false,
          todos: s.todoItems,
          executing: true,
          planFilePath: s.planFilePath,
          savedTools: null,
        };
    }
  })();
  return { type: "persistState", state: payload };
}

const UI: PlanEffect = { type: "updateUI" };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const planReducer: Reducer<PlanState, PlanEvent, PlanEffect> = (state, event): Result => {
  switch (event._tag) {
    // ----- Toggle -----
    case "Toggle": {
      if (state._tag === "Inactive") {
        const next: PlanState = { _tag: "Planning", savedTools: event.currentTools };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: PLAN_MODE_TOOLS },
            { type: "notify", message: `Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}` },
            UI,
            persist(next),
          ],
        };
      }
      if (state._tag === "Planning" || state._tag === "AwaitingChoice") {
        const next: PlanState = { _tag: "Inactive" };
        return {
          state: next,
          effects: [
            { type: "setActiveTools", tools: state.savedTools },
            { type: "notify", message: "Plan mode disabled. Full access restored." },
            UI,
            persist(next),
          ],
        };
      }
      return { state };
    }

    // ----- PlanWithPrompt -----
    case "PlanWithPrompt": {
      const savedTools =
        state._tag === "Inactive"
          ? event.currentTools
          : state._tag === "Planning" || state._tag === "AwaitingChoice"
            ? state.savedTools
            : event.currentTools;
      // Preserve pending plan when already planning/awaiting (refinement via /plan <prompt>)
      const pending =
        state._tag === "Planning"
          ? state.pending
          : state._tag === "AwaitingChoice"
            ? state.pending
            : undefined;
      const next: PlanState = { _tag: "Planning", savedTools, pending };
      return {
        state: next,
        effects: [
          { type: "setActiveTools", tools: PLAN_MODE_TOOLS },
          { type: "notify", message: `Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}` },
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
      const next: PlanState = { _tag: "AwaitingChoice", savedTools: state.savedTools, pending };

      const todoListText = event.todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
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
            customType: "plan-todo-list",
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
      const next: PlanState = {
        _tag: "Executing",
        todoItems: pending.todoItems,
        planFilePath: pending.planFilePath,
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
            customType: "plan-mode-execute",
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
      return { state: { _tag: "Planning", savedTools: state.savedTools, pending: state.pending } };
    }

    // ----- ChooseRefine -----
    case "ChooseRefine": {
      if (state._tag !== "AwaitingChoice") return { state };
      return {
        state: { _tag: "Planning", savedTools: state.savedTools, pending: state.pending },
        effects: [{ type: "sendUserMessage", content: event.refinement }],
      };
    }

    // ----- TurnEnd (execution progress) -----
    case "TurnEnd": {
      if (state._tag !== "Executing" || state.todoItems.length === 0) return { state };

      const next: PlanState = {
        _tag: "Executing",
        todoItems: event.todoItems,
        planFilePath: state.planFilePath,
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

      const completedList = state.todoItems.map((t) => `~~${t.text}~~`).join("\n");
      const pathInfo = state.planFilePath ? `\n\nPlan file: ${state.planFilePath}` : "";
      const effects: Effect[] = [
        {
          type: "sendMessage",
          customType: "plan-complete",
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
      const next: PlanState = { _tag: "Inactive" };
      effects.push(UI, persist(next));
      return { state: next, effects };
    }

    // ----- Reset -----
    case "Reset": {
      return { state: { _tag: "Inactive" }, effects: [UI] };
    }

    // ----- Hydrate (session resume) -----
    case "Hydrate": {
      const effects: Effect[] = [];
      const enabled = event.enabled || event.flagPlan;
      const savedTools = event.savedTools ?? event.currentTools;

      if (event.executing && event.todoItems.length > 0) {
        const next: PlanState = {
          _tag: "Executing",
          todoItems: event.todoItems,
          planFilePath: event.planFilePath,
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

      if (enabled) {
        const next: PlanState = { _tag: "Planning", savedTools };
        effects.push({ type: "setActiveTools", tools: PLAN_MODE_TOOLS }, UI);
        return { state: next, effects };
      }

      return { state: { _tag: "Inactive" }, effects };
    }
  }
};

/**
 * Handoff — pure state machine.
 *
 * Zero pi imports. Tested by calling the reducer directly.
 */

import type { Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type HandoffState =
  | { _tag: "Idle" }
  | { _tag: "Generating"; parentSessionFile: string }
  | { _tag: "Ready"; prompt: string; parentSessionFile: string }
  | { _tag: "Switching"; prompt: string; parentSessionFile: string };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type HandoffEvent =
  | { _tag: "GenerateStart"; parentSessionFile: string }
  | { _tag: "GenerateComplete"; prompt: string }
  | { _tag: "GenerateFail"; error: string }
  | { _tag: "ManualReady"; prompt: string; parentSessionFile: string }
  | { _tag: "Dismiss" }
  | { _tag: "SwitchStart" }
  | { _tag: "SwitchComplete" }
  | { _tag: "SwitchCancelled" }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension-specific effects
// ---------------------------------------------------------------------------

export type HandoffEffect =
  | { type: "setEditorLabel"; key: string; text: string; position: string; align: string }
  | { type: "removeEditorLabel"; key: string }
  | { type: "clearWidget"; key: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<HandoffState, HandoffEffect>;

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const handoffReducer: Reducer<HandoffState, HandoffEvent, HandoffEffect> = (
  state,
  event,
): Result => {
  switch (event._tag) {
    // ----- GenerateStart -----
    case "GenerateStart": {
      if (state._tag === "Generating") return { state };
      return {
        state: { _tag: "Generating", parentSessionFile: event.parentSessionFile },
      };
    }

    // ----- GenerateComplete -----
    case "GenerateComplete": {
      if (state._tag !== "Generating") return { state };
      const next: HandoffState = {
        _tag: "Ready",
        prompt: event.prompt,
        parentSessionFile: state.parentSessionFile,
      };
      return {
        state: next,
        effects: [
          {
            type: "setEditorLabel",
            key: "handoff",
            text: "handoff ready",
            position: "top",
            align: "right",
          },
          { type: "setStatus", key: "handoff", text: "handoff ready" },
          {
            type: "notify",
            message: "handoff prompt generated. choose whether to hand off now, skip, or edit.",
            level: "warning",
          },
        ],
      };
    }

    // ----- GenerateFail -----
    case "GenerateFail": {
      if (state._tag !== "Generating") return { state };
      return {
        state: { _tag: "Idle" },
        effects: [
          { type: "notify", message: `handoff generation failed: ${event.error}`, level: "error" },
        ],
      };
    }

    // ----- ManualReady (from tool execute or manual /handoff with goal) -----
    case "ManualReady": {
      return {
        state: {
          _tag: "Ready",
          prompt: event.prompt,
          parentSessionFile: event.parentSessionFile,
        },
        effects: [
          {
            type: "setEditorLabel",
            key: "handoff",
            text: "handoff ready",
            position: "top",
            align: "right",
          },
          { type: "setStatus", key: "handoff", text: "handoff ready" },
        ],
      };
    }

    // ----- Dismiss -----
    case "Dismiss": {
      if (state._tag !== "Ready") return { state };
      return {
        state: { _tag: "Idle" },
        effects: [
          { type: "setStatus", key: "handoff" },
          { type: "removeEditorLabel", key: "handoff" },
        ],
      };
    }

    // ----- SwitchStart -----
    case "SwitchStart": {
      if (state._tag !== "Ready") return { state };
      return {
        state: {
          _tag: "Switching",
          prompt: state.prompt,
          parentSessionFile: state.parentSessionFile,
        },
        effects: [
          { type: "setStatus", key: "handoff" },
          { type: "removeEditorLabel", key: "handoff" },
        ],
      };
    }

    // ----- SwitchComplete -----
    case "SwitchComplete": {
      if (state._tag !== "Switching") return { state };
      return { state: { _tag: "Idle" } };
    }

    // ----- SwitchCancelled -----
    case "SwitchCancelled": {
      if (state._tag !== "Switching") return { state };
      return {
        state: {
          _tag: "Ready",
          prompt: state.prompt,
          parentSessionFile: state.parentSessionFile,
        },
        effects: [
          { type: "setStatus", key: "handoff", text: "handoff ready" },
          {
            type: "setEditorLabel",
            key: "handoff",
            text: "handoff ready",
            position: "top",
            align: "right",
          },
        ],
      };
    }

    // ----- Reset -----
    case "Reset": {
      return {
        state: { _tag: "Idle" },
        effects: [
          { type: "removeEditorLabel", key: "handoff" },
          { type: "clearWidget", key: "handoff-provenance" },
          { type: "setStatus", key: "handoff" },
        ],
      };
    }
  }
};

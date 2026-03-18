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
  | { _tag: "Switching"; parentSessionFile: string };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type HandoffEvent =
  | { _tag: "GenerateStart"; parentSessionFile: string }
  | { _tag: "GenerateComplete" }
  | { _tag: "GenerateFail"; error: string }
  | { _tag: "SwitchStart"; parentSessionFile: string }
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
      return {
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "handoff" }],
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

    // ----- SwitchStart -----
    case "SwitchStart": {
      if (state._tag === "Switching") return { state };
      return {
        state: {
          _tag: "Switching",
          parentSessionFile: event.parentSessionFile,
        },
        effects: [{ type: "setStatus", key: "handoff" }],
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
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "handoff" }],
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

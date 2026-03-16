/**
 * CI Watcher — pure state machine.
 *
 * Tracks CI run status for the current branch. Zero pi imports.
 */

import type { Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CiState =
  | { _tag: "Idle" }
  | { _tag: "Watching"; branch: string; runId?: string }
  | { _tag: "Passed"; branch: string; runId: string }
  | { _tag: "Failed"; branch: string; runId: string; output: string };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type CiEvent =
  | { _tag: "Watch"; branch: string }
  | { _tag: "RunDetected"; runId: string }
  | { _tag: "RunPassed"; runId: string }
  | { _tag: "RunFailed"; runId: string; output: string }
  | { _tag: "Dismiss" }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension effects
// ---------------------------------------------------------------------------

export type CiEffect = { type: "updateUI" } | { type: "startPolling" } | { type: "stopPolling" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<CiState, CiEffect>;

const UI: CiEffect = { type: "updateUI" };
const START_POLL: CiEffect = { type: "startPolling" };
const STOP_POLL: CiEffect = { type: "stopPolling" };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const ciReducer: Reducer<CiState, CiEvent, CiEffect> = (state, event): Result => {
  switch (event._tag) {
    case "Watch": {
      if (state._tag === "Watching") return { state };
      const next: CiState = { _tag: "Watching", branch: event.branch };
      return {
        state: next,
        effects: [
          { type: "setStatus", key: "ci", text: `ci: watching ${event.branch}` },
          { type: "notify", message: `Watching CI for ${event.branch}` },
          START_POLL,
          UI,
        ],
      };
    }

    case "RunDetected": {
      if (state._tag !== "Watching") return { state };
      const next: CiState = { ...state, runId: event.runId };
      return {
        state: next,
        effects: [
          { type: "setStatus", key: "ci", text: `ci: run #${event.runId} in progress` },
          UI,
        ],
      };
    }

    case "RunPassed": {
      if (state._tag !== "Watching") return { state };
      const next: CiState = { _tag: "Passed", branch: state.branch, runId: event.runId };
      return {
        state: next,
        effects: [
          { type: "setStatus", key: "ci", text: `ci: ✓ passed` },
          { type: "notify", message: `CI passed (run #${event.runId})` },
          STOP_POLL,
          UI,
        ],
      };
    }

    case "RunFailed": {
      if (state._tag !== "Watching") return { state };
      const next: CiState = {
        _tag: "Failed",
        branch: state.branch,
        runId: event.runId,
        output: event.output,
      };
      return {
        state: next,
        effects: [
          { type: "setStatus", key: "ci", text: `ci: ✗ failed` },
          { type: "notify", message: `CI failed (run #${event.runId})`, level: "error" },
          STOP_POLL,
          UI,
        ],
      };
    }

    case "Dismiss": {
      if (state._tag === "Idle") return { state };
      return {
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "ci" }, STOP_POLL, UI],
      };
    }

    case "Reset": {
      return {
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "ci" }, STOP_POLL, UI],
      };
    }
  }
};

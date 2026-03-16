/**
 * Branch Breakout — pure state machine.
 *
 * Splits a monolithic branch into stacked branches, each with a subset of files.
 */

import type { Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface BreakoutSlice {
  name: string;
  files: string[];
  description: string;
}

export interface SliceResult {
  name: string;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type BreakoutState =
  | { _tag: "Idle" }
  | { _tag: "Planning"; sourceBranch: string; slices: BreakoutSlice[] }
  | { _tag: "Executing"; slices: BreakoutSlice[]; currentSlice: number; results: SliceResult[] }
  | { _tag: "Done"; results: SliceResult[] };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type BreakoutEvent =
  | { _tag: "Plan"; sourceBranch: string; slices: BreakoutSlice[] }
  | { _tag: "Confirm" }
  | { _tag: "SliceDone"; result: SliceResult }
  | { _tag: "Cancel" }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension effects
// ---------------------------------------------------------------------------

export type BreakoutEffect = { type: "updateUI" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<BreakoutState, BreakoutEffect>;
const UI: BreakoutEffect = { type: "updateUI" };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const breakoutReducer: Reducer<BreakoutState, BreakoutEvent, BreakoutEffect> = (
  state,
  event,
): Result => {
  switch (event._tag) {
    case "Plan": {
      if (state._tag !== "Idle") return { state };
      const next: BreakoutState = {
        _tag: "Planning",
        sourceBranch: event.sourceBranch,
        slices: event.slices,
      };
      const sliceList = event.slices
        .map((s, i) => `${i + 1}. ${s.name} (${s.files.length} files) — ${s.description}`)
        .join("\n");
      return {
        state: next,
        effects: [
          {
            type: "setStatus",
            key: "breakout",
            text: `breakout: ${event.slices.length} slices planned`,
          },
          {
            type: "notify",
            message: `Breakout plan:\n${sliceList}\n\nUse /breakout-confirm to execute.`,
          },
          UI,
        ],
      };
    }

    case "Confirm": {
      if (state._tag !== "Planning") return { state };
      const next: BreakoutState = {
        _tag: "Executing",
        slices: state.slices,
        currentSlice: 0,
        results: [],
      };
      const first = state.slices[0];
      return {
        state: next,
        effects: [
          { type: "setStatus", key: "breakout", text: `breakout: 1/${state.slices.length}` },
          {
            type: "sendMessage",
            customType: "breakout-execute",
            content: `Execute breakout slice 1/${state.slices.length}: "${first!.name}"

Files: ${first!.files.join(", ")}
Description: ${first!.description}

Steps:
1. Create stacked branch: \`stacked create ${first!.name}\`
2. Cherry-pick or apply only the listed files from the source
3. Run the gate (typecheck, lint, test)
4. Commit with a conventional commit message

Say "SLICE_DONE" when this slice is complete, or "SLICE_FAILED" if it cannot be completed.`,
            display: true,
            triggerTurn: true,
          },
          UI,
        ],
      };
    }

    case "SliceDone": {
      if (state._tag !== "Executing") return { state };
      const results = [...state.results, event.result];
      const nextIndex = state.currentSlice + 1;

      if (nextIndex >= state.slices.length) {
        const next: BreakoutState = { _tag: "Done", results };
        const successCount = results.filter((r) => r.success).length;
        return {
          state: next,
          effects: [
            {
              type: "setStatus",
              key: "breakout",
              text: `breakout: done (${successCount}/${results.length})`,
            },
            {
              type: "notify",
              message: `Breakout complete: ${successCount}/${results.length} slices succeeded`,
              level: successCount === results.length ? "info" : "warning",
            },
            UI,
          ],
        };
      }

      const nextSlice = state.slices[nextIndex]!;
      const next: BreakoutState = {
        _tag: "Executing",
        slices: state.slices,
        currentSlice: nextIndex,
        results,
      };
      return {
        state: next,
        effects: [
          {
            type: "setStatus",
            key: "breakout",
            text: `breakout: ${nextIndex + 1}/${state.slices.length}`,
          },
          {
            type: "sendMessage",
            customType: "breakout-execute",
            content: `Execute breakout slice ${nextIndex + 1}/${state.slices.length}: "${nextSlice.name}"

Files: ${nextSlice.files.join(", ")}
Description: ${nextSlice.description}

Steps:
1. Create stacked branch: \`stacked create ${nextSlice.name}\`
2. Cherry-pick or apply only the listed files from the source
3. Run the gate (typecheck, lint, test)
4. Commit with a conventional commit message

Say "SLICE_DONE" when this slice is complete, or "SLICE_FAILED" if it cannot be completed.`,
            display: true,
            triggerTurn: true,
          },
          UI,
        ],
      };
    }

    case "Cancel": {
      if (state._tag === "Idle") return { state };
      const next: BreakoutState =
        state._tag === "Executing" ? { _tag: "Done", results: state.results } : { _tag: "Idle" };
      return {
        state: next,
        effects: [
          { type: "notify", message: "breakout cancelled" },
          { type: "setStatus", key: "breakout" },
          UI,
        ],
      };
    }

    case "Reset": {
      return {
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "breakout" }, UI],
      };
    }
  }
};

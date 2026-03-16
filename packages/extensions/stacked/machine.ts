/**
 * Stacked PR Health — pure state machine.
 *
 * Analyzes a stack of branches for health issues:
 * leaked commits, CI failures, review status.
 */

import type { Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface StackBranch {
  name: string;
  parent?: string;
  pr?: string;
  ciStatus?: "pending" | "passed" | "failed" | "unknown";
  reviewStatus?: "approved" | "changes_requested" | "pending" | "unknown";
  leakedCommits?: string[];
}

export interface StackIssue {
  type: "leaked-commit" | "ci-failed" | "review-pending" | "needs-rebase";
  branch: string;
  details: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type StackedState =
  | { _tag: "Idle" }
  | { _tag: "Analyzing"; stack: StackBranch[] }
  | { _tag: "Reporting"; stack: StackBranch[]; issues: StackIssue[] };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type StackedEvent =
  | { _tag: "Analyze"; stack: StackBranch[] }
  | { _tag: "AnalysisComplete"; issues: StackIssue[] }
  | { _tag: "Dismiss" }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Extension effects
// ---------------------------------------------------------------------------

export type StackedEffect = { type: "updateUI" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<StackedState, StackedEffect>;
const UI: StackedEffect = { type: "updateUI" };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const stackedReducer: Reducer<StackedState, StackedEvent, StackedEffect> = (
  state,
  event,
): Result => {
  switch (event._tag) {
    case "Analyze": {
      if (state._tag === "Analyzing") return { state };
      const next: StackedState = { _tag: "Analyzing", stack: event.stack };
      return {
        state: next,
        effects: [
          {
            type: "setStatus",
            key: "stacked",
            text: `stack: analyzing ${event.stack.length} branches`,
          },
          UI,
        ],
      };
    }

    case "AnalysisComplete": {
      if (state._tag !== "Analyzing") return { state };
      const next: StackedState = {
        _tag: "Reporting",
        stack: state.stack,
        issues: event.issues,
      };
      const issueCount = event.issues.length;
      return {
        state: next,
        effects: [
          {
            type: "setStatus",
            key: "stacked",
            text:
              issueCount > 0
                ? `stack: ${issueCount} issue${issueCount > 1 ? "s" : ""}`
                : "stack: healthy",
          },
          {
            type: "notify",
            message:
              issueCount > 0
                ? `Stack health: ${issueCount} issue${issueCount > 1 ? "s" : ""} found`
                : "Stack health: all clear",
            level: issueCount > 0 ? "warning" : "info",
          },
          UI,
        ],
      };
    }

    case "Dismiss": {
      if (state._tag === "Idle") return { state };
      return {
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "stacked" }, UI],
      };
    }

    case "Reset": {
      return {
        state: { _tag: "Idle" },
        effects: [{ type: "setStatus", key: "stacked" }, UI],
      };
    }
  }
};

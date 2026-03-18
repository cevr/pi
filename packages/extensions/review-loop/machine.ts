/**
 * Review Loop — pure state machine.
 *
 * Zero pi imports. Tested by calling the reducer directly.
 */

import type { BuiltinEffect, Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ITERATIONS = 5;

export const REVIEW_LOOP_RESULT_TOOL = "review_loop_result" as const;

export const DEFAULT_REVIEW_PROMPT = `Review your changes. Use the counsel tool to get a cross-vendor second opinion.
Address any issues counsel raises.
When this review iteration is complete, call ${REVIEW_LOOP_RESULT_TOOL} with:
- outcome: "done" if there are no further issues
- outcome: "continue" if another review iteration is needed
Do not use prose markers as control signals.`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ReviewScopeMode = "diff" | "paths";

export type ReviewState =
  | { _tag: "Inactive"; maxIterations: number }
  | {
      _tag: "Reviewing";
      maxIterations: number;
      iteration: number;
      userPrompt: string;
      scope: ReviewScopeMode;
      diffStat: string;
      targetPaths: string[];
    };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ReviewEvent =
  | {
      _tag: "Start";
      prompt: string;
      scope: ReviewScopeMode;
      diffStat: string;
      targetPaths: string[];
    }
  | { _tag: "IterationResult"; outcome: "done" | "continue" }
  | { _tag: "IterationSignalMissing" }
  | { _tag: "UserInterrupt" }
  | { _tag: "Exit" }
  | { _tag: "SetMax"; max: number }
  | {
      _tag: "Hydrate";
      mode?: ReviewState["_tag"];
      maxIterations?: number;
      iteration?: number;
      userPrompt?: string;
      scope?: ReviewScopeMode;
      diffStat?: string;
      targetPaths?: string[];
    }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ReviewEffect = BuiltinEffect | { type: "persistState"; state: PersistPayload };

export interface PersistPayload {
  mode: ReviewState["_tag"];
  maxIterations: number;
  iteration?: number;
  userPrompt?: string;
  scope?: ReviewScopeMode;
  diffStat?: string;
  targetPaths?: string[];
}

type Result = TransitionResult<ReviewState, ReviewEffect>;

function buildFullPrompt(state: Extract<ReviewState, { _tag: "Reviewing" }>): string {
  const parts: string[] = [];
  if (state.userPrompt) parts.push(state.userPrompt);
  parts.push(buildScopePrompt(state));
  parts.push(DEFAULT_REVIEW_PROMPT);
  return parts.join("\n\n");
}

function buildScopePrompt(state: Extract<ReviewState, { _tag: "Reviewing" }>): string {
  const paths = state.targetPaths.join(", ");
  return state.scope === "diff"
    ? `Review the current branch diff.\n\n${state.diffStat}\nChanged files: ${paths}`
    : `Review these explicit paths: ${paths}`;
}

export function getReviewStatusText(state: ReviewState): string | undefined {
  return state._tag === "Reviewing"
    ? `🔄 review ${state.iteration + 1}/${state.maxIterations}`
    : undefined;
}

function persist(state: ReviewState): ReviewEffect {
  if (state._tag === "Reviewing") {
    return {
      type: "persistState",
      state: {
        mode: "Reviewing",
        maxIterations: state.maxIterations,
        iteration: state.iteration,
        userPrompt: state.userPrompt,
        scope: state.scope,
        diffStat: state.diffStat,
        targetPaths: state.targetPaths,
      },
    };
  }

  return {
    type: "persistState",
    state: {
      mode: "Inactive",
      maxIterations: state.maxIterations,
    },
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const reviewReducer: Reducer<ReviewState, ReviewEvent, ReviewEffect> = (
  state,
  event,
): Result => {
  switch (event._tag) {
    // ----- Start -----
    case "Start": {
      if (state._tag === "Reviewing") return { state }; // already active

      const next: ReviewState = {
        _tag: "Reviewing",
        maxIterations: state.maxIterations,
        iteration: 0,
        userPrompt: event.prompt,
        scope: event.scope,
        diffStat: event.diffStat,
        targetPaths: event.targetPaths,
      };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Review mode activated", level: "info" },
          { type: "setStatus", key: "review-loop", text: getReviewStatusText(next) },
          {
            type: "sendUserMessage",
            content: buildFullPrompt(next),
            deliverAs: "followUp",
          },
          persist(next),
        ],
      };
    }

    // ----- IterationResult -----
    case "IterationResult": {
      if (state._tag !== "Reviewing") return { state };

      if (event.outcome === "done") {
        const next: ReviewState = { _tag: "Inactive", maxIterations: state.maxIterations };
        return {
          state: next,
          effects: [
            { type: "notify", message: "Review mode ended: no further issues", level: "info" },
            { type: "setStatus", key: "review-loop" },
            persist(next),
          ],
        };
      }

      const nextIteration = state.iteration + 1;
      if (nextIteration >= state.maxIterations) {
        const next: ReviewState = { _tag: "Inactive", maxIterations: state.maxIterations };
        return {
          state: next,
          effects: [
            {
              type: "notify",
              message: `Review mode ended: max iterations (${state.maxIterations}) reached`,
              level: "info",
            },
            { type: "setStatus", key: "review-loop" },
            persist(next),
          ],
        };
      }

      const next: ReviewState = { ...state, iteration: nextIteration };
      return {
        state: next,
        effects: [
          {
            type: "setStatus",
            key: "review-loop",
            text: getReviewStatusText(next),
          },
          {
            type: "sendUserMessage",
            content: buildFullPrompt(next),
            deliverAs: "followUp",
          },
          persist(next),
        ],
      };
    }

    // ----- IterationSignalMissing -----
    case "IterationSignalMissing": {
      if (state._tag !== "Reviewing") return { state };
      const next: ReviewState = { _tag: "Inactive", maxIterations: state.maxIterations };
      return {
        state: next,
        effects: [
          {
            type: "notify",
            message: `Review mode ended: ${REVIEW_LOOP_RESULT_TOOL} was not called`,
            level: "error",
          },
          { type: "setStatus", key: "review-loop" },
          persist(next),
        ],
      };
    }

    // ----- UserInterrupt -----
    case "UserInterrupt": {
      if (state._tag !== "Reviewing") return { state };
      const next: ReviewState = { _tag: "Inactive", maxIterations: state.maxIterations };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Review mode ended: user interrupted", level: "info" },
          { type: "setStatus", key: "review-loop" },
          persist(next),
        ],
      };
    }

    // ----- Exit -----
    case "Exit": {
      if (state._tag !== "Reviewing") return { state };
      const next: ReviewState = { _tag: "Inactive", maxIterations: state.maxIterations };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Review mode ended: manual exit", level: "info" },
          { type: "setStatus", key: "review-loop" },
          persist(next),
        ],
      };
    }

    // ----- SetMax -----
    case "SetMax": {
      const next: ReviewState = { ...state, maxIterations: event.max };
      return {
        state: next,
        effects: [
          { type: "notify", message: `Max review iterations set to ${event.max}`, level: "info" },
          persist(next),
        ],
      };
    }

    // ----- Hydrate -----
    case "Hydrate": {
      const maxIterations = event.maxIterations ?? state.maxIterations;
      if (event.mode === "Reviewing" && event.scope) {
        const next: ReviewState = {
          _tag: "Reviewing",
          maxIterations,
          iteration:
            typeof event.iteration === "number" && event.iteration >= 0 ? event.iteration : 0,
          userPrompt: event.userPrompt ?? "",
          scope: event.scope,
          diffStat: event.diffStat ?? "",
          targetPaths: event.targetPaths ?? [],
        };
        return {
          state: next,
          effects: [{ type: "setStatus", key: "review-loop", text: getReviewStatusText(next) }],
        };
      }

      return {
        state: { _tag: "Inactive", maxIterations },
        effects: [{ type: "setStatus", key: "review-loop" }],
      };
    }

    // ----- Reset -----
    case "Reset": {
      return {
        state: { _tag: "Inactive", maxIterations: state.maxIterations },
        effects: [{ type: "setStatus", key: "review-loop" }],
      };
    }
  }
};

/**
 * Review Loop — pure state machine.
 *
 * Zero pi imports. Tested by calling the reducer directly.
 */

import type { Reducer, TransitionResult } from "@cvr/pi-state-machine";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ITERATIONS = 5;

export const DEFAULT_REVIEW_PROMPT = `Review your changes. Use the counsel tool to get a cross-vendor second opinion.
Address any issues counsel raises. If counsel approves or you're confident the changes are correct, say "No issues found."`;

export const EXIT_PATTERNS = [
  /no issues found/i,
  /no bugs found/i,
  /no problems found/i,
  /looks good/i,
  /lgtm/i,
  /all good/i,
  /changes are correct/i,
  /approved/i,
];

export const ISSUES_FIXED_PATTERNS = [
  /fixed/i,
  /addressed/i,
  /resolved/i,
  /corrected/i,
  /updated/i,
];

export function hasExitPhrase(text: string): boolean {
  return EXIT_PATTERNS.some((p) => p.test(text));
}

export function hasIssuesFixed(text: string): boolean {
  return ISSUES_FIXED_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ReviewState =
  | { _tag: "Inactive"; maxIterations: number }
  | { _tag: "Reviewing"; maxIterations: number; iteration: number; userPrompt: string };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ReviewEvent =
  | { _tag: "Start"; prompt: string }
  | { _tag: "AgentEnd"; text: string }
  | { _tag: "UserInterrupt" }
  | { _tag: "Exit" }
  | { _tag: "SetMax"; max: number }
  | { _tag: "Reset" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Result = TransitionResult<ReviewState>;

function buildFullPrompt(userPrompt: string): string {
  const parts: string[] = [];
  if (userPrompt) parts.push(userPrompt);
  parts.push(DEFAULT_REVIEW_PROMPT);
  return parts.join("\n\n");
}

function statusText(iteration: number, max: number): string {
  return `🔄 review ${iteration + 1}/${max}`;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const reviewReducer: Reducer<ReviewState, ReviewEvent> = (state, event): Result => {
  switch (event._tag) {
    // ----- Start -----
    case "Start": {
      if (state._tag === "Reviewing") return { state }; // already active

      const next: ReviewState = {
        _tag: "Reviewing",
        maxIterations: state.maxIterations,
        iteration: 0,
        userPrompt: event.prompt,
      };
      return {
        state: next,
        effects: [
          { type: "notify", message: "Review mode activated", level: "info" },
          { type: "setStatus", key: "review-loop", text: statusText(0, state.maxIterations) },
          {
            type: "sendUserMessage",
            content: event.prompt || buildFullPrompt(event.prompt),
            deliverAs: "followUp",
          },
        ],
      };
    }

    // ----- AgentEnd -----
    case "AgentEnd": {
      if (state._tag !== "Reviewing") return { state };

      // Empty/aborted
      if (!event.text.trim()) {
        return {
          state: { _tag: "Inactive", maxIterations: state.maxIterations },
          effects: [
            { type: "notify", message: "Review mode ended: aborted", level: "info" },
            { type: "setStatus", key: "review-loop" },
          ],
        };
      }

      const exit = hasExitPhrase(event.text);
      const fixed = hasIssuesFixed(event.text);

      // Clean exit: "no issues" without "fixed"
      if (exit && !fixed) {
        return {
          state: { _tag: "Inactive", maxIterations: state.maxIterations },
          effects: [
            { type: "notify", message: "Review mode ended: no issues found", level: "info" },
            { type: "setStatus", key: "review-loop" },
          ],
        };
      }

      // Continue loop
      const nextIteration = state.iteration + 1;
      if (nextIteration >= state.maxIterations) {
        return {
          state: { _tag: "Inactive", maxIterations: state.maxIterations },
          effects: [
            {
              type: "notify",
              message: `Review mode ended: max iterations (${state.maxIterations}) reached`,
              level: "info",
            },
            { type: "setStatus", key: "review-loop" },
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
            text: statusText(nextIteration, state.maxIterations),
          },
          {
            type: "sendUserMessage",
            content: buildFullPrompt(state.userPrompt),
            deliverAs: "followUp",
          },
        ],
      };
    }

    // ----- UserInterrupt -----
    case "UserInterrupt": {
      if (state._tag !== "Reviewing") return { state };
      return {
        state: { _tag: "Inactive", maxIterations: state.maxIterations },
        effects: [
          { type: "notify", message: "Review mode ended: user interrupted", level: "info" },
          { type: "setStatus", key: "review-loop" },
        ],
      };
    }

    // ----- Exit -----
    case "Exit": {
      if (state._tag !== "Reviewing") return { state };
      return {
        state: { _tag: "Inactive", maxIterations: state.maxIterations },
        effects: [
          { type: "notify", message: "Review mode ended: manual exit", level: "info" },
          { type: "setStatus", key: "review-loop" },
        ],
      };
    }

    // ----- SetMax -----
    case "SetMax": {
      return {
        state: { ...state, maxIterations: event.max },
        effects: [
          { type: "notify", message: `Max review iterations set to ${event.max}`, level: "info" },
        ],
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

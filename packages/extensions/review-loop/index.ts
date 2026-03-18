/**
 * Review Loop Extension — thin wiring layer.
 *
 * Delegates all state transitions to machine.ts via pi-state-machine.
 */

import type { AssistantMessage, Message as PiMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { register } from "@cvr/pi-state-machine";
import type { Command } from "@cvr/pi-state-machine";
import {
  DEFAULT_MAX_ITERATIONS,
  reviewReducer,
  type ReviewEvent,
  type ReviewState,
} from "./machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: PiMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function reviewLoopExtension(pi: ExtensionAPI): void {
  // ----- Commands -----
  const commands: Command<ReviewState, ReviewEvent>[] = [
    {
      mode: "event",
      name: "review",
      description: "Start review loop. /review <prompt> activates with custom instructions.",
      toEvent: (state, args, ctx): ReviewEvent | null => {
        if (state._tag === "Reviewing") {
          ctx.ui.notify("Review mode already active. Use /review-exit to stop.", "info");
          return null;
        }
        return { _tag: "Start", prompt: args.trim() };
      },
    },
    {
      mode: "event",
      name: "review-exit",
      description: "Exit review mode manually",
      toEvent: (state, _args, ctx): ReviewEvent | null => {
        if (state._tag !== "Reviewing") {
          ctx.ui.notify("Review mode is not active", "info");
          return null;
        }
        return { _tag: "Exit" };
      },
    },
    {
      mode: "event",
      name: "review-max",
      description: "Set max review iterations (default: 5)",
      toEvent: (state, args, ctx): ReviewEvent | null => {
        const num = parseInt(args, 10);
        if (isNaN(num) || num < 1) {
          ctx.ui.notify(
            `Max iterations: ${state.maxIterations}. Usage: /review-max <number>`,
            "info",
          );
          return null;
        }
        return { _tag: "SetMax", max: num };
      },
    },
    {
      mode: "query",
      name: "review-status",
      description: "Show review mode status",
      handler: (state, _args, ctx): void => {
        if (state._tag === "Reviewing") {
          ctx.ui.notify(
            `Review mode active: iteration ${state.iteration + 1}/${state.maxIterations}`,
            "info",
          );
        } else {
          ctx.ui.notify(`Review mode inactive (max: ${state.maxIterations})`, "info");
        }
      },
    },
  ];

  // ----- Register machine -----
  const machine = register<ReviewState, ReviewEvent>(pi, {
    id: "review-loop",
    initial: { _tag: "Inactive", maxIterations: DEFAULT_MAX_ITERATIONS },
    reducer: reviewReducer,

    events: {
      before_agent_start: {
        mode: "reply",
        handle: (state) => {
          if (state._tag !== "Reviewing") return;
          const principles = readPrinciples();
          const principlesBlock = principles ? `\n\n${principles}` : "";
          return {
            message: {
              customType: "review-loop-context",
              content: `[REVIEW MODE - Iteration ${state.iteration + 1}/${state.maxIterations}]

${state.userPrompt ? `Review focus: ${state.userPrompt}\n\n` : ""}After making changes, use the counsel tool to get a cross-vendor review.
If counsel or you find no issues, say "No issues found" to exit review mode.${principlesBlock}`,
              display: false,
            },
          };
        },
      },

      context: {
        mode: "reply",
        handle: (_state, event) => ({
          messages: event.messages.filter((m: any) => m.customType !== "review-loop-context"),
        }),
      },

      agent_end: {
        mode: "fire",
        toEvent: (state, event, ctx): ReviewEvent | null => {
          if (!ctx.hasUI || state._tag !== "Reviewing") return null;

          const assistantMessages = event.messages.filter(isAssistantMessage);
          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          if (!lastAssistant) return { _tag: "AgentEnd", text: "" };

          return { _tag: "AgentEnd", text: getTextContent(lastAssistant) };
        },
      },

      session_start: {
        mode: "fire",
        toEvent: (): ReviewEvent => ({ _tag: "Reset" }),
      },

      session_switch: {
        mode: "fire",
        toEvent: (): ReviewEvent => ({ _tag: "Reset" }),
      },

      // input: reply handler that also fires UserInterrupt via microtask
      input: {
        mode: "reply",
        handle: (state, event) => {
          if (state._tag === "Reviewing" && event.source === "interactive") {
            queueMicrotask(() => machine.send({ _tag: "UserInterrupt" }));
          }
          return { action: "continue" as const };
        },
      },
    },

    commands,
  });
}

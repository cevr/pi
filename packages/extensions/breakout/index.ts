/**
 * Branch Breakout Extension — splits a branch into stacked PRs.
 *
 * Commands: /breakout, /breakout-confirm, /breakout-cancel
 * Takes a source branch and a slice plan, creates stacked branches
 * with gate checks between each slice.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { register } from "@cvr/pi-state-machine";
import type { Command } from "@cvr/pi-state-machine";
import {
  breakoutReducer,
  type BreakoutEffect,
  type BreakoutEvent,
  type BreakoutSlice,
  type BreakoutState,
} from "./machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getLastAssistantText(messages: AgentMessage[]): string {
  const assistants = messages.filter(isAssistantMessage);
  const last = assistants[assistants.length - 1];
  if (!last) return "";
  return last.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function breakoutExtension(pi: ExtensionAPI): void {
  // ----- Commands -----
  const commands: Command<BreakoutState, BreakoutEvent>[] = [
    {
      mode: "event",
      name: "breakout-confirm",
      description: "Confirm and execute the breakout plan",
      toEvent: (state): BreakoutEvent | null => {
        if (state._tag !== "Planning") return null;
        return { _tag: "Confirm" };
      },
    },
    {
      mode: "event",
      name: "breakout-cancel",
      description: "Cancel the breakout",
      toEvent: (): BreakoutEvent => ({ _tag: "Cancel" }),
    },
    {
      mode: "query",
      name: "breakout-status",
      description: "Show breakout status",
      handler: (state, _args, ctx): void => {
        switch (state._tag) {
          case "Idle":
            ctx.ui.notify("No breakout active. Use /breakout to start.", "info");
            break;
          case "Planning":
            ctx.ui.notify(
              `Breakout plan: ${state.slices.length} slices from ${state.sourceBranch}\nUse /breakout-confirm to execute.`,
              "info",
            );
            break;
          case "Executing":
            ctx.ui.notify(
              `Breakout: slice ${state.currentSlice + 1}/${state.slices.length} (${state.results.length} done)`,
              "info",
            );
            break;
          case "Done": {
            const ok = state.results.filter((r) => r.success).length;
            ctx.ui.notify(`Breakout done: ${ok}/${state.results.length} succeeded`, "info");
            break;
          }
        }
      },
    },
  ];

  // ----- UI -----
  function formatUI(state: BreakoutState, ctx: ExtensionContext): void {
    if (state._tag === "Executing") {
      ctx.ui.setWidget(
        "breakout",
        state.slices.map((s, i) => {
          const result = state.results.find((r) => r.name === s.name);
          const marker = result
            ? result.success
              ? "✓"
              : "✗"
            : i === state.currentSlice
              ? "▸"
              : "○";
          return `  ${marker} ${s.name}`;
        }),
      );
    } else if (state._tag === "Done") {
      ctx.ui.setWidget(
        "breakout",
        state.results.map((r) => `  ${r.success ? "✓" : "✗"} ${r.name}`),
      );
    } else {
      ctx.ui.setWidget("breakout", undefined);
    }
  }

  // ----- Register machine -----
  const machine = register<BreakoutState, BreakoutEvent, BreakoutEffect>(
    pi,
    {
      id: "breakout",
      initial: { _tag: "Idle" },
      reducer: breakoutReducer,

      events: {
        agent_end: {
          mode: "fire",
          toEvent: (state, event): BreakoutEvent | null => {
            if (state._tag !== "Executing") return null;
            const text = getLastAssistantText(event.messages);
            if (/SLICE_DONE/i.test(text)) {
              return {
                _tag: "SliceDone",
                result: { name: state.slices[state.currentSlice]!.name, success: true },
              };
            }
            if (/SLICE_FAILED/i.test(text)) {
              return {
                _tag: "SliceDone",
                result: {
                  name: state.slices[state.currentSlice]!.name,
                  success: false,
                  error: "Slice execution failed",
                },
              };
            }
            return null;
          },
        },

        session_switch: {
          mode: "fire",
          toEvent: (): BreakoutEvent => ({ _tag: "Reset" }),
        },
      },

      commands,
    },
    (effect, _pi, ctx) => {
      if (effect.type === "updateUI") {
        formatUI(machine.getState(), ctx);
      }
    },
  );

  // ----- /breakout command (imperative — parses slice plan from args) -----
  pi.registerCommand("breakout", {
    description: "Plan a branch breakout into stacked PRs. Usage: /breakout <description>",
    handler: async (args, ctx) => {
      const state = machine.getState();
      if (state._tag !== "Idle") {
        ctx.ui.notify("Breakout already active. /breakout-cancel to stop.", "info");
        return;
      }

      const prompt = args.trim();
      if (!prompt) {
        // Ask the agent to plan the breakout
        pi.sendMessage(
          {
            customType: "breakout-plan-request",
            content: `Analyze the current branch's changes and propose a breakout plan.

1. Run \`git diff --stat origin/main...HEAD\` to see what changed
2. Group changed files into logical slices (each slice = one stacked PR)
3. Name each slice with a branch name (e.g., "feat/auth-core", "feat/auth-ui")
4. Present the plan and wait for /breakout-confirm

Output the plan as a JSON block:
\`\`\`json
{"sourceBranch": "current-branch", "slices": [{"name": "...", "files": ["..."], "description": "..."}]}
\`\`\`

Say "BREAKOUT_PLANNED" when the plan is ready.`,
            display: true,
          },
          { triggerTurn: true },
        );
        return;
      }

      // Try to parse inline JSON plan
      try {
        const parsed = JSON.parse(prompt) as {
          sourceBranch: string;
          slices: BreakoutSlice[];
        };
        if (parsed.sourceBranch && Array.isArray(parsed.slices) && parsed.slices.length > 0) {
          machine.send({
            _tag: "Plan",
            sourceBranch: parsed.sourceBranch,
            slices: parsed.slices,
          });
          return;
        }
      } catch {
        /* not JSON — treat as description */
      }

      // Use the prompt as a description for the agent to plan
      pi.sendMessage(
        {
          customType: "breakout-plan-request",
          content: `Plan a branch breakout based on this description: ${prompt}

1. Run \`git diff --stat origin/main...HEAD\` to see what changed
2. Group changed files into logical slices based on the description
3. Present the plan as JSON and wait for /breakout-confirm

Output:
\`\`\`json
{"sourceBranch": "current-branch", "slices": [{"name": "...", "files": ["..."], "description": "..."}]}
\`\`\`

Say "BREAKOUT_PLANNED" when ready.`,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });
}

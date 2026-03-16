/**
 * Plan Mode Extension — thin wiring layer.
 *
 * Delegates all state transitions to machine.ts via pi-state-machine.
 * Handles pi API interactions, theme formatting, file I/O, and async UI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { register } from "@cvr/pi-state-machine";
import type { Command, StateObserver } from "@cvr/pi-state-machine";
import {
  PLAN_MODE_TOOLS,
  planReducer,
  type PlanEffect,
  type PlanEvent,
  type PlanState,
  type PersistPayload,
} from "./machine";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils";

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const PLANS_DIR = path.join(os.homedir(), ".pi", "plans");

function ensurePlansDir(): void {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

function generatePlanPath(firstStep: string): string {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = firstStep
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return path.join(PLANS_DIR, `${timestamp}-${slug || "plan"}.md`);
}

function writePlanFileToDisk(planPath: string, fullText: string, items: TodoItem[]): void {
  ensurePlansDir();
  const checklist = items
    .map((t) => `- [${t.completed ? "x" : " "}] ${t.step}. ${t.text}`)
    .join("\n");
  fs.writeFileSync(
    planPath,
    `# Plan\n\n${checklist}\n\n---\n\n## Full Plan\n\n${fullText}\n`,
    "utf-8",
  );
}

function updatePlanFileToDisk(planPath: string, items: TodoItem[]): void {
  if (!fs.existsSync(planPath)) return;
  const content = fs.readFileSync(planPath, "utf-8");
  const checklist = items
    .map((t) => `- [${t.completed ? "x" : " "}] ${t.step}. ${t.text}`)
    .join("\n");
  fs.writeFileSync(
    planPath,
    content.replace(/# Plan\n\n[\s\S]*?\n\n---/, `# Plan\n\n${checklist}\n\n---`),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// UI formatting (theme-dependent — can't live in pure reducer)
// ---------------------------------------------------------------------------

function formatUI(state: PlanState, ctx: ExtensionContext): void {
  switch (state._tag) {
    case "Executing":
      if (state.todoItems.length > 0) {
        const completed = state.todoItems.filter((t) => t.completed).length;
        ctx.ui.setStatus(
          "plan-mode",
          ctx.ui.theme.fg("accent", `📋 ${completed}/${state.todoItems.length}`),
        );
        ctx.ui.setWidget(
          "plan-todos",
          state.todoItems.map((item) =>
            item.completed
              ? ctx.ui.theme.fg("success", "☑ ") +
                ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
              : `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`,
          ),
        );
      }
      break;
    case "Planning":
    case "AwaitingChoice":
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
      ctx.ui.setWidget("plan-todos", undefined);
      break;
    case "Inactive":
      ctx.ui.setStatus("plan-mode", undefined);
      ctx.ui.setWidget("plan-todos", undefined);
      break;
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function planModeExtension(pi: ExtensionAPI): void {
  // ----- Effect interpreter -----
  function interpretEffect(effect: PlanEffect, _pi: ExtensionAPI, ctx: ExtensionContext): void {
    switch (effect.type) {
      case "writePlanFile":
        writePlanFileToDisk(effect.planFilePath, effect.planText, effect.todoItems);
        break;
      case "updatePlanFile":
        updatePlanFileToDisk(effect.planFilePath, effect.todoItems);
        break;
      case "persistState":
        pi.appendEntry("plan-mode", effect.state);
        break;
      case "updateUI":
        formatUI(machine.getState(), ctx);
        break;
    }
  }

  // ----- Commands -----
  const commands: Command<PlanState, PlanEvent>[] = [
    {
      mode: "event",
      name: "plan",
      description: "Toggle plan mode. /plan <prompt> enters plan mode and sends the prompt.",
      toEvent: (_state, args): PlanEvent => {
        const prompt = args.trim();
        if (prompt) return { _tag: "PlanWithPrompt", prompt, currentTools: pi.getActiveTools() };
        return { _tag: "Toggle", currentTools: pi.getActiveTools() };
      },
    },
    {
      mode: "query",
      name: "todos",
      description: "Show current plan todo list",
      handler: (state, _args, ctx): void => {
        const todoItems =
          state._tag === "Planning"
            ? state.pending?.todoItems
            : state._tag === "AwaitingChoice"
              ? state.pending.todoItems
              : state._tag === "Executing"
                ? state.todoItems
                : undefined;
        if (!todoItems || todoItems.length === 0) {
          ctx.ui.notify("No todos. Create a plan first with /plan", "info");
          return;
        }
        const list = todoItems
          .map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
          .join("\n");
        const planFilePath =
          state._tag === "Planning"
            ? state.pending?.planFilePath
            : state._tag === "AwaitingChoice"
              ? state.pending.planFilePath
              : state._tag === "Executing"
                ? state.planFilePath
                : null;
        const pathInfo = planFilePath ? `\nPlan file: ${planFilePath}` : "";
        ctx.ui.notify(`Plan Progress:\n${list}${pathInfo}`, "info");
      },
    },
  ];

  // ----- Observer: AwaitingChoice async UI -----
  const awaitingChoiceObserver: StateObserver<PlanState, PlanEvent> = {
    match: (s) => s._tag === "AwaitingChoice",
    handler: async (_state, sendIfCurrent, ctx) => {
      if (!ctx.hasUI) {
        sendIfCurrent({ _tag: "ChooseExecute" });
        return;
      }
      const choice = await ctx.ui.select("Plan mode - what next?", [
        "Execute the plan (track progress)",
        "Stay in plan mode",
        "Refine the plan",
      ]);

      if (choice?.startsWith("Execute")) {
        sendIfCurrent({ _tag: "ChooseExecute" });
      } else if (choice === "Refine the plan") {
        const refinement = await ctx.ui.editor("Refine the plan:", "");
        if (refinement?.trim()) {
          sendIfCurrent({ _tag: "ChooseRefine", refinement: refinement.trim() });
        } else {
          sendIfCurrent({ _tag: "ChooseStay" });
        }
      } else {
        // "Stay in plan mode" or dismissed — transition back to Planning
        sendIfCurrent({ _tag: "ChooseStay" });
      }
    },
  };

  // ----- Register machine -----
  const machine = register<PlanState, PlanEvent, PlanEffect>(
    pi,
    {
      id: "plan-mode",
      initial: { _tag: "Inactive" },
      reducer: planReducer,

      events: {
        tool_call: {
          mode: "reply",
          handle: (state, event) => {
            if (state._tag !== "Planning" && state._tag !== "AwaitingChoice") return;
            if (event.toolName !== "bash") return;
            const command = event.input.command as string;
            if (!isSafeCommand(command)) {
              return {
                block: true,
                reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
              };
            }
          },
        },

        context: {
          mode: "reply",
          handle: (state, event) => ({
            messages: event.messages.filter((m: any) => {
              if (m.customType === "plan-mode-context") return false;
              if (m.customType === "plan-execution-context") return false;
              if (m.role !== "user") return true;
              if (state._tag === "Inactive") {
                const content = m.content;
                if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
                if (Array.isArray(content)) {
                  return !content.some(
                    (c: any) => c.type === "text" && c.text?.includes("[PLAN MODE ACTIVE]"),
                  );
                }
              }
              return true;
            }),
          }),
        },

        before_agent_start: {
          mode: "reply",
          handle: (state) => {
            if (state._tag === "Planning" || state._tag === "AwaitingChoice") {
              const principles = readPrinciples();
              const principlesBlock = principles ? `\n\n${principles}` : "";
              return {
                message: {
                  customType: "plan-mode-context",
                  content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: ${PLAN_MODE_TOOLS.join(", ")}
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands
- Use the interview tool to ask the user clarifying questions about scope

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.${principlesBlock}`,
                  display: false,
                },
              };
            }

            if (state._tag === "Executing" && state.todoItems.length > 0) {
              const remaining = state.todoItems.filter((t) => !t.completed);
              const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
              const planRef = state.planFilePath
                ? `\n\nThe full plan is saved at: ${state.planFilePath}\nRead it if you need the full context.`
                : "";
              return {
                message: {
                  customType: "plan-execution-context",
                  content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}${planRef}

Use the counsel tool for cross-vendor review before committing each batch of changes.

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
                  display: false,
                },
              };
            }
          },
        },

        turn_end: {
          mode: "fire",
          toEvent: (state, event): PlanEvent | null => {
            if (state._tag !== "Executing" || state.todoItems.length === 0) return null;
            if (!isAssistantMessage(event.message)) return null;

            const text = getTextContent(event.message);
            const updatedItems = state.todoItems.map((t) => ({ ...t }));
            const marked = markCompletedSteps(text, updatedItems);
            if (marked > 0) return { _tag: "TurnEnd", todoItems: updatedItems };
            return null;
          },
        },

        agent_end: {
          mode: "fire",
          toEvent: (state, event, ctx): PlanEvent | null => {
            if (state._tag === "Executing" && state.todoItems.length > 0) {
              return state.todoItems.every((t) => t.completed)
                ? { _tag: "ExecutionComplete" }
                : null;
            }

            if (state._tag !== "Planning" || !ctx.hasUI) return null;

            const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
            if (!lastAssistant) return null;

            const fullText = getTextContent(lastAssistant);
            const extracted = extractTodoItems(fullText);
            if (extracted.length === 0) return null;

            return {
              _tag: "AgentEnd",
              todoItems: extracted,
              planText: fullText,
              planFilePath: generatePlanPath(extracted[0]!.text),
            };
          },
        },

        session_switch: {
          mode: "fire",
          toEvent: (): PlanEvent => ({ _tag: "Reset" }),
        },

        session_start: {
          mode: "fire",
          toEvent: (_state, _event, ctx): PlanEvent => {
            const entries = ctx.sessionManager.getEntries();
            const planModeEntry = entries
              .filter((e: any) => e.type === "custom" && e.customType === "plan-mode")
              .pop() as { data?: PersistPayload } | undefined;

            const data = planModeEntry?.data;
            let todoItems = data?.todos ?? [];
            const executing = data?.executing ?? false;
            const planFilePath = data?.planFilePath ?? null;
            const savedTools = data?.savedTools ?? null;
            const enabled = data?.enabled ?? false;
            const flagPlan = pi.getFlag("plan") === true;

            // Re-scan messages for completion markers on resume
            if (planModeEntry && executing && todoItems.length > 0) {
              todoItems = todoItems.map((t) => ({ ...t }));
              let executeIndex = -1;
              for (let i = entries.length - 1; i >= 0; i--) {
                if ((entries[i] as any).customType === "plan-mode-execute") {
                  executeIndex = i;
                  break;
                }
              }
              const messages: AssistantMessage[] = [];
              for (let i = executeIndex + 1; i < entries.length; i++) {
                const entry = entries[i] as any;
                if (
                  entry.type === "message" &&
                  "message" in entry &&
                  isAssistantMessage(entry.message)
                ) {
                  messages.push(entry.message as AssistantMessage);
                }
              }
              markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
            }

            return {
              _tag: "Hydrate",
              enabled,
              todoItems,
              executing,
              planFilePath,
              savedTools,
              flagPlan,
              currentTools: pi.getActiveTools(),
            };
          },
        },
      },

      commands,

      shortcuts: [
        {
          key: Key.ctrlAlt("p"),
          description: "Toggle plan mode",
          toEvent: (): PlanEvent => ({ _tag: "Toggle", currentTools: pi.getActiveTools() }),
        },
      ],

      observers: [awaitingChoiceObserver],

      flags: [
        {
          name: "plan",
          description: "Start in plan mode (read-only exploration)",
          type: "boolean",
          default: false,
        },
      ],
    },
    interpretEffect,
  );
}

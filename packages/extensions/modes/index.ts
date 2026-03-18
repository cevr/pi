/**
 * Modes extension — thin wiring layer.
 *
 * Delegates all state transitions to machine.ts via pi-state-machine.
 * Handles pi API interactions, theme formatting, file I/O, and async UI.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import type { AssistantMessage, Message as PiMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { gatherDiffContext, type DiffContext } from "@cvr/pi-diff-context";
import { GitClient } from "@cvr/pi-git-client";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { register } from "@cvr/pi-state-machine";
import type { Command, StateObserver } from "@cvr/pi-state-machine";
import { Layer, ManagedRuntime } from "effect";
import {
  PLAN_TOOLS,
  modesReducer,
  type ModesEffect,
  type ModesEvent,
  type ModesState,
  type PersistPayload,
} from "./machine";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils";

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const PLANS_DIR = path.join(os.homedir(), ".pi", "plans");

type EditorMode = "auto" | "plan";

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
    .map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.step}. ${todo.text}`)
    .join("\n");
  fs.writeFileSync(planPath, `# Plan\n\n${checklist}\n\n---\n\n## Full Plan\n\n${fullText}\n`, "utf-8");
}

function updatePlanFileToDisk(planPath: string, items: TodoItem[]): void {
  if (!fs.existsSync(planPath)) return;

  const content = fs.readFileSync(planPath, "utf-8");
  const checklist = items
    .map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.step}. ${todo.text}`)
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

function isAssistantMessage(message: PiMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function getEditorMode(state: ModesState): EditorMode {
  return state._tag === "Auto" ? "auto" : "plan";
}

// ---------------------------------------------------------------------------
// UI formatting (theme-dependent — can't live in pure reducer)
// ---------------------------------------------------------------------------

function formatUI(state: ModesState, pi: ExtensionAPI, ctx: ExtensionContext): void {
  pi.events.emit("editor:set-mode", { mode: getEditorMode(state) });
  if (!ctx.hasUI) return;

  switch (state._tag) {
    case "Executing": {
      const completed = state.todoItems.filter((todo) => todo.completed).length;
      const phaseSuffix =
        state.phase !== "running" ? ` ${state.phase === "gating" ? "⚙ gate" : "🔍 counsel"}` : "";
      ctx.ui.setStatus(
        "modes",
        ctx.ui.theme.fg("accent", `📋 ${completed}/${state.todoItems.length}${phaseSuffix}`),
      );
      ctx.ui.setWidget(
        "modes-todos",
        state.todoItems.map((todo) =>
          todo.completed
            ? ctx.ui.theme.fg("success", "☑ ") +
              ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(todo.text))
            : `${ctx.ui.theme.fg("muted", "☐ ")}${todo.text}`,
        ),
      );
      break;
    }
    case "Planning":
    case "AwaitingChoice":
      ctx.ui.setStatus("modes", ctx.ui.theme.fg("warning", "⏸ plan"));
      ctx.ui.setWidget("modes-todos", undefined);
      break;
    case "Auto":
      ctx.ui.setStatus("modes", undefined);
      ctx.ui.setWidget("modes-todos", undefined);
      break;
  }
}

// ---------------------------------------------------------------------------
// Diff context formatting
// ---------------------------------------------------------------------------

function buildDiffContextBlock(diffContext: DiffContext): string {
  if (diffContext.changedFiles.length === 0) return "";

  const files = diffContext.changedFiles.map((file) => `- ${file}`).join("\n");
  const skills =
    diffContext.skillCatalog.length > 0
      ? `\n\n## Available Skills\n${diffContext.skillCatalog.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
      : "";

  return `\n\n## Branch Changes (vs ${diffContext.baseBranch})\n${diffContext.diffStat}\n\n${files}${skills}`;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function modesExtension(pi: ExtensionAPI): void {
  const gitRuntime = ManagedRuntime.make(GitClient.layer.pipe(Layer.provide(ProcessRunner.layer)));

  pi.on("session_shutdown" as any, async () => {
    await gitRuntime.dispose();
  });

  // ----- Effect interpreter -----
  function interpretEffect(effect: ModesEffect, pi: ExtensionAPI, ctx: ExtensionContext): void {
    switch (effect.type) {
      case "writePlanFile":
        writePlanFileToDisk(effect.planFilePath, effect.planText, effect.todoItems);
        break;
      case "updatePlanFile":
        updatePlanFileToDisk(effect.planFilePath, effect.todoItems);
        break;
      case "persistState":
        pi.appendEntry("modes", effect.state);
        break;
      case "updateUI":
        formatUI(machine.getState(), pi, ctx);
        break;
    }
  }

  // ----- Commands -----
  const commands: Command<ModesState, ModesEvent>[] = [
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
          .map((item, index) => `${index + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
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
  const awaitingChoiceObserver: StateObserver<ModesState, ModesEvent> = {
    match: (state) => state._tag === "AwaitingChoice",
    handler: async (_state, sendIfCurrent, ctx) => {
      if (!ctx.hasUI) {
        sendIfCurrent({ _tag: "ChooseExecute" });
        return;
      }

      const choice = await ctx.ui.select("PLAN mode — what next?", [
        "Execute the plan",
        "Stay in PLAN mode",
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
        sendIfCurrent({ _tag: "ChooseStay" });
      }
    },
  };

  // ----- Register machine -----
  const machine = register<ModesState, ModesEvent, ModesEffect>(
    pi,
    {
      id: "modes",
      initial: { _tag: "Auto" },
      reducer: modesReducer,

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
                reason: `PLAN mode: command blocked (not allowlisted). Use Shift+Tab or /plan to return to AUTO mode first.\nCommand: ${command}`,
              };
            }
          },
        },

        context: {
          mode: "reply",
          handle: (state, event) => ({
            messages: event.messages.filter((message: any) => {
              if (message.customType === "modes-context") return false;
              if (message.customType === "modes-execution-context") return false;
              if (typeof message.customType === "string" && message.customType.startsWith("modes-gate")) {
                return false;
              }
              if (typeof message.customType === "string" && message.customType.startsWith("modes-counsel")) {
                return false;
              }
              if (message.role !== "user") return true;
              if (state._tag === "Auto") {
                const content = message.content;
                if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
                if (Array.isArray(content)) {
                  return !content.some(
                    (block: any) => block.type === "text" && block.text?.includes("[PLAN MODE ACTIVE]"),
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
              const diffBlock =
                state._tag === "Planning" && state.diffContext
                  ? buildDiffContextBlock(state.diffContext)
                  : "";
              return {
                message: {
                  customType: "modes-context",
                  content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: ${PLAN_TOOLS.join(", ")}
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands
- Use the interview tool to ask the user clarifying questions about scope

Create a detailed plan under a "Plan:" header.
Use a numbered list or bullet points:

Plan:
1. First step description
2. Second step description
- or a bullet step

Do NOT attempt to make changes - just describe what you would do.${diffBlock}${principlesBlock}`,
                  display: false,
                },
              };
            }

            if (state._tag === "Executing" && state.todoItems.length > 0) {
              const principles = readPrinciples();
              const principlesBlock = principles ? `\n\n${principles}` : "";
              const remaining = state.todoItems.filter((todo) => !todo.completed);
              const todoList = remaining.map((todo) => `${todo.step}. ${todo.text}`).join("\n");
              const planRef = state.planFilePath
                ? `\n\nThe full plan is saved at: ${state.planFilePath}\nRead it if you need the full context.`
                : "";
              return {
                message: {
                  customType: "modes-execution-context",
                  content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}${planRef}

Use the counsel tool for cross-vendor review before committing each batch of changes.

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.${principlesBlock}`,
                  display: false,
                },
              };
            }
          },
        },

        turn_end: {
          mode: "fire",
          toEvent: (state, event): ModesEvent | null => {
            if (state._tag !== "Executing" || state.todoItems.length === 0) return null;
            if (!isAssistantMessage(event.message)) return null;

            const text = getTextContent(event.message);
            const updatedItems = state.todoItems.map((todo) => ({ ...todo }));
            const marked = markCompletedSteps(text, updatedItems);
            if (marked > 0) {
              queueMicrotask(() => {
                if (state.phase === "running") {
                  machine.send({ _tag: "TaskDone" });
                }
              });
              return { _tag: "TurnEnd", todoItems: updatedItems };
            }
            return null;
          },
        },

        agent_end: {
          mode: "fire",
          toEvent: (state, event): ModesEvent | null => {
            if (state._tag === "Executing" && state.todoItems.length > 0) {
              const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
              const text = lastAssistant ? getTextContent(lastAssistant) : "";

              if (state.phase === "gating") {
                if (/GATE_PASS/i.test(text)) return { _tag: "GatePass" };
                if (/GATE_FAIL/i.test(text)) return { _tag: "GateFail" };
                return null;
              }
              if (state.phase === "counseling") {
                if (/COUNSEL_PASS/i.test(text)) return { _tag: "CounselPass" };
                if (/COUNSEL_FAIL/i.test(text)) return { _tag: "CounselFail" };
                return null;
              }

              return state.todoItems.every((todo) => todo.completed)
                ? { _tag: "ExecutionComplete" }
                : null;
            }

            if (state._tag !== "Planning") return null;

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
          toEvent: (): ModesEvent => {
            pi.events.emit("editor:set-mode", { mode: "auto" });
            return { _tag: "Reset" };
          },
        },

        session_start: {
          mode: "fire",
          toEvent: (_state, _event, ctx): ModesEvent => {
            const entries = ctx.sessionManager.getEntries();
            const modesEntry = entries
              .filter((entry: any) => entry.type === "custom" && entry.customType === "modes")
              .pop() as { data?: PersistPayload } | undefined;

            const data = modesEntry?.data;
            const mode = data?.mode;
            const pending = data?.pending;
            let todoItems = pending?.todoItems ?? data?.todoItems ?? [];
            const planFilePath = pending?.planFilePath ?? data?.planFilePath ?? null;
            const savedTools = data?.savedTools ?? null;
            const flagPlan = pi.getFlag("plan") === true;

            if (modesEntry && mode === "Executing" && todoItems.length > 0) {
              todoItems = todoItems.map((todo) => ({ ...todo }));
              let executeIndex = -1;
              for (let index = entries.length - 1; index >= 0; index--) {
                if ((entries[index] as any).customType === "modes-execute") {
                  executeIndex = index;
                  break;
                }
              }
              const messages: AssistantMessage[] = [];
              for (let index = executeIndex + 1; index < entries.length; index++) {
                const entry = entries[index] as any;
                if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message)) {
                  messages.push(entry.message as AssistantMessage);
                }
              }
              markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
            }

            return {
              _tag: "Hydrate",
              mode,
              todoItems,
              planFilePath,
              savedTools,
              pending,
              flagPlan,
              currentTools: pi.getActiveTools(),
            };
          },
        },
      },

      commands,

      shortcuts: [
        {
          key: Key.shift("tab"),
          description: "Toggle AUTO/PLAN mode",
          toEvent: (): ModesEvent => ({ _tag: "Toggle", currentTools: pi.getActiveTools() }),
        },
      ],

      observers: [awaitingChoiceObserver],

      flags: [
        {
          name: "plan",
          description: "Start in PLAN mode (read-only exploration)",
          type: "boolean",
          default: false,
        },
      ],
    },
    interpretEffect,
  );

  // ----- /plan command (imperative — async diff context gathering) -----
  pi.registerCommand("plan", {
    description: "Toggle PLAN mode. Shift+Tab also toggles it. /plan <prompt> enters PLAN mode and sends the prompt.",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      const currentTools = pi.getActiveTools();
      const state = machine.getState();

      if (
        !prompt &&
        (state._tag === "Planning" || state._tag === "AwaitingChoice" || state._tag === "Executing")
      ) {
        machine.send({ _tag: "Toggle", currentTools });
        return;
      }

      let diffContext: DiffContext | undefined;
      try {
        diffContext = await gatherDiffContext(ctx.cwd, gitRuntime);
        if (diffContext.changedFiles.length === 0) diffContext = undefined;
      } catch {
        /* no diff context available */
      }

      if (prompt) {
        machine.send({ _tag: "PlanWithPrompt", prompt, currentTools, diffContext });
      } else {
        machine.send({ _tag: "Toggle", currentTools, diffContext });
      }
    },
  });
}

/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available and bash is restricted
 * to an allowlist of safe commands.
 *
 * Plans are persisted to ~/.pi/plans/<timestamp>-<slug>.md so they survive
 * compaction, handoff, and session boundaries. The execution context always
 * references the plan file path.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 * - Plans saved to ~/.pi/plans/ for durability
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils";

/** Read-only tools available in plan mode. */
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "skill", "interview"];

const PLANS_DIR = path.join(os.homedir(), ".pi", "plans");

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function ensurePlansDir(): void {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

/** Generate a plan file path from the first todo item text. */
function generatePlanPath(firstStep: string): string {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = firstStep
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return path.join(PLANS_DIR, `${timestamp}-${slug || "plan"}.md`);
}

/** Write the full plan text + todo checklist to a markdown file. */
function writePlanFile(planPath: string, fullText: string, items: TodoItem[]): void {
  ensurePlansDir();
  const checklist = items
    .map((t) => `- [${t.completed ? "x" : " "}] ${t.step}. ${t.text}`)
    .join("\n");
  const content = `# Plan\n\n${checklist}\n\n---\n\n## Full Plan\n\n${fullText}\n`;
  fs.writeFileSync(planPath, content, "utf-8");
}

/** Update the checklist in an existing plan file with current completion state. */
function updatePlanFile(planPath: string, items: TodoItem[]): void {
  if (!fs.existsSync(planPath)) return;
  const content = fs.readFileSync(planPath, "utf-8");
  const checklist = items
    .map((t) => `- [${t.completed ? "x" : " "}] ${t.step}. ${t.text}`)
    .join("\n");
  // Replace checklist between "# Plan\n\n" and "\n\n---"
  const updated = content.replace(/# Plan\n\n[\s\S]*?\n\n---/, `# Plan\n\n${checklist}\n\n---`);
  fs.writeFileSync(planPath, updated, "utf-8");
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  /** Path to the current plan file in ~/.pi/plans/. */
  let planFilePath: string | null = null;
  /** Tool names captured before entering plan mode, restored on exit. */
  let savedTools: string[] | null = null;

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`),
      );
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }

    if (executionMode && todoItems.length > 0) {
      const lines = todoItems.map((item) => {
        if (item.completed) {
          return (
            ctx.ui.theme.fg("success", "☑ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          );
        }
        return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
      });
      ctx.ui.setWidget("plan-todos", lines);
    } else {
      ctx.ui.setWidget("plan-todos", undefined);
    }
  }

  function enterPlanMode(ctx: ExtensionContext): void {
    savedTools = pi.getActiveTools();
    planModeEnabled = true;
    executionMode = false;
    todoItems = [];
    planFilePath = null;
    pi.setActiveTools(PLAN_MODE_TOOLS);
    ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
    updateStatus(ctx);
    persistState();
  }

  function exitPlanMode(ctx: ExtensionContext): void {
    planModeEnabled = false;
    if (savedTools) {
      pi.setActiveTools(savedTools);
      savedTools = null;
    }
    ctx.ui.notify("Plan mode disabled. Full access restored.");
    updateStatus(ctx);
    persistState();
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (planModeEnabled) {
      exitPlanMode(ctx);
    } else {
      enterPlanMode(ctx);
    }
  }

  function persistState(): void {
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
      planFilePath,
      savedTools,
    });
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode. /plan <prompt> enters plan mode and sends the prompt.",
    handler: async (args, ctx) => {
      const prompt = typeof args === "string" ? args.trim() : "";
      if (prompt) {
        // /plan <prompt> — enter plan mode and send the prompt
        if (!planModeEnabled) enterPlanMode(ctx);
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      } else {
        togglePlanMode(ctx);
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show current plan todo list",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan", "info");
        return;
      }
      const list = todoItems
        .map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
        .join("\n");
      const pathInfo = planFilePath ? `\nPlan file: ${planFilePath}` : "";
      ctx.ui.notify(`Plan Progress:\n${list}${pathInfo}`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // Block destructive bash commands in plan mode
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
      };
    }
  });

  // Filter stale plan/execution context — always strip old copies so before_agent_start
  // can inject one fresh copy per turn (prevents accumulation across turns).
  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        // always strip — before_agent_start re-injects fresh each turn
        if (msg.customType === "plan-mode-context") return false;
        if (msg.customType === "plan-execution-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (!planModeEnabled) {
          if (typeof content === "string") {
            return !content.includes("[PLAN MODE ACTIVE]");
          }
          if (Array.isArray(content)) {
            return !content.some(
              (c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
            );
          }
        }
        return true;
      }),
    };
  });

  // Inject plan/execution context before agent starts
  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
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

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed);
      const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      const planRef = planFilePath
        ? `\n\nThe full plan is saved at: ${planFilePath}\nRead it if you need the full context.`
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
  });

  // Track progress after each turn
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, todoItems) > 0) {
      updateStatus(ctx);
      if (planFilePath) updatePlanFile(planFilePath, todoItems);
    }
    persistState();
  });

  // Handle plan completion and plan mode UI
  pi.on("agent_end", async (event, ctx) => {
    // Check if execution is complete
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
        const pathInfo = planFilePath ? `\n\nPlan file: ${planFilePath}` : "";
        pi.sendMessage(
          {
            customType: "plan-complete",
            content: `**Plan Complete!**\n\n${completedList}${pathInfo}`,
            display: true,
          },
          { triggerTurn: false },
        );
        if (planFilePath) updatePlanFile(planFilePath, todoItems);
        executionMode = false;
        todoItems = [];
        planFilePath = null;
        if (savedTools) {
          pi.setActiveTools(savedTools);
          savedTools = null;
        }
        updateStatus(ctx);
        persistState();
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    // Extract todos from last assistant message
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const fullText = getTextContent(lastAssistant);
      const extracted = extractTodoItems(fullText);
      if (extracted.length > 0) {
        todoItems = extracted;
        // Save plan to ~/.pi/plans/
        planFilePath = generatePlanPath(todoItems[0].text);
        writePlanFile(planFilePath, fullText, todoItems);
        persistState();
      }
    }

    // Show plan steps and prompt for next action
    if (todoItems.length > 0) {
      const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
      const pathInfo = planFilePath ? `\n\nSaved to: ${planFilePath}` : "";
      pi.sendMessage(
        {
          customType: "plan-todo-list",
          content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}${pathInfo}`,
          display: true,
        },
        { triggerTurn: false },
      );
    }

    const choice = await ctx.ui.select("Plan mode - what next?", [
      todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice?.startsWith("Execute")) {
      planModeEnabled = false;
      executionMode = todoItems.length > 0;
      if (savedTools) {
        pi.setActiveTools(savedTools);
        savedTools = null;
      }
      updateStatus(ctx);

      const execMessage =
        todoItems.length > 0
          ? `Execute the plan. Start with: ${todoItems[0].text}`
          : "Execute the plan you just created.";
      pi.sendMessage(
        { customType: "plan-mode-execute", content: execMessage, display: true },
        { triggerTurn: true },
      );
      persistState();
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim());
      }
    }
  });

  // Reset state on session switch (prevents leaking into different session)
  pi.on("session_switch", async (_event, ctx) => {
    planModeEnabled = false;
    executionMode = false;
    todoItems = [];
    planFilePath = null;
    savedTools = null;
    updateStatus(ctx);
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // Restore persisted state
    const planModeEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-mode",
      )
      .pop() as
      | {
          data?: {
            enabled: boolean;
            todos?: TodoItem[];
            executing?: boolean;
            planFilePath?: string | null;
            savedTools?: string[] | null;
          };
        }
      | undefined;

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      todoItems = planModeEntry.data.todos ?? todoItems;
      executionMode = planModeEntry.data.executing ?? executionMode;
      planFilePath = planModeEntry.data.planFilePath ?? planFilePath;
      savedTools = planModeEntry.data.savedTools ?? savedTools;
    }

    // On resume: re-scan messages to rebuild completion state
    const isResume = planModeEntry !== undefined;
    if (isResume && executionMode && todoItems.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (
          entry.type === "message" &&
          "message" in entry &&
          isAssistantMessage(entry.message as AgentMessage)
        ) {
          messages.push(entry.message as AssistantMessage);
        }
      }
      const allText = messages.map(getTextContent).join("\n");
      markCompletedSteps(allText, todoItems);
      if (planFilePath) updatePlanFile(planFilePath, todoItems);
    }

    if (planModeEnabled) {
      // Capture current tools before restricting — needed for --plan flag and resume
      if (!savedTools) {
        savedTools = pi.getActiveTools();
      }
      pi.setActiveTools(PLAN_MODE_TOOLS);
    }
    updateStatus(ctx);
  });
}

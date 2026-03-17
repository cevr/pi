/**
 * Task tool — token-efficient sub-agent delegation.
 *
 * spawns a sub-agent to execute complex multi-step work, then collapses
 * the full exchange into a compact summary (files read/modified, commands
 * run, truncated outcome). the parent model sees ~500 chars instead of
 * potentially 50k+ tokens of raw output.
 *
 * the sub-agent inherits the parent's default model and gets most tools:
 * read/write, edit, grep, bash, finder. the full execution history is
 * preserved in the TUI's expandable result view for inspection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { PiSpawnService, zeroUsage } from "@cvr/pi-spawn";
import {
  getDisplayItems,
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@cvr/pi-sub-agent-render";
import { Effect, ManagedRuntime } from "effect";

type TaskExtConfig = {
  builtinTools: string[];
  extensionTools: string[];
};

type TaskExtensionDeps = {
  createTaskTool: (
    config: TaskConfig,
    runtime: ManagedRuntime.ManagedRuntime<PiSpawnService, never>,
  ) => ToolDefinition;
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

export const CONFIG_DEFAULTS: TaskExtConfig = {
  builtinTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  extensionTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "format_file", "finder"],
};

export const DEFAULT_DEPS: TaskExtensionDeps = {
  createTaskTool,
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTaskConfig(value: Record<string, unknown>): value is TaskExtConfig {
  return isStringArray(value.builtinTools) && isStringArray(value.extensionTools);
}

export const TASK_CONFIG_SCHEMA: ExtensionConfigSchema<TaskExtConfig> = {
  validate: isTaskConfig,
};

interface TaskParams {
  prompt: string;
  description: string;
  model?: string;
  thinking?: string;
}

export interface TaskConfig {
  builtinTools?: string[];
  extensionTools?: string[];
}

// ---------------------------------------------------------------------------
// Session path
// ---------------------------------------------------------------------------

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

function generateTaskSessionPath(): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const dir = path.join(SESSIONS_DIR, year);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `${timestamp}_task-${rand}.jsonl`);
}

// ---------------------------------------------------------------------------
// Context-collapsed summary
// ---------------------------------------------------------------------------

import type { Message } from "@mariozechner/pi-ai";

function summarizeExecution(description: string, messages: Message[], finalOutput: string): string {
  const items = getDisplayItems(messages);

  const reads = new Set<string>();
  const writes = new Set<string>();
  const commands: string[] = [];

  for (const item of items) {
    if (item.type !== "toolCall") continue;
    const args = item.args ?? {};
    const filePath: string | undefined = args.file_path ?? args.path ?? args.filePath;

    switch (item.name) {
      case "read":
      case "Read":
        if (filePath) reads.add(filePath);
        break;
      case "edit":
      case "Edit":
      case "write":
      case "Write":
      case "create_file":
        if (filePath) writes.add(filePath);
        break;
      case "bash":
      case "Bash": {
        const cmd = args.command ?? args.cmd;
        if (typeof cmd === "string") {
          commands.push(cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd);
        }
        break;
      }
      case "grep":
      case "Grep":
      case "find":
      case "Find":
      case "ls":
        // search/nav — count as reads
        break;
    }
  }

  const parts: string[] = [`[TASK COMPLETE] "${description}"`];

  const actions: string[] = [];
  if (reads.size > 0) actions.push(`read ${reads.size} file(s)`);
  if (writes.size > 0) actions.push(`modified ${[...writes].join(", ")}`);
  if (commands.length > 0) actions.push(`ran ${commands.length} command(s)`);
  if (actions.length > 0) parts.push(`Actions: ${actions.join(", ")}.`);

  // truncate outcome to ~500 chars to keep context lean
  const maxLen = 500;
  const outcome = finalOutput.length > maxLen ? finalOutput.slice(0, maxLen) + "…" : finalOutput;
  parts.push(`Outcome: ${outcome}`);

  return parts.join("\n");
}

export function createTaskTool(
  config: TaskConfig = {},
  runtime: ManagedRuntime.ManagedRuntime<PiSpawnService, never>,
): ToolDefinition {
  return {
    name: "Task",
    label: "Task",
    description:
      "Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to " +
      "the following tools: Read, Grep, Find, ls, Bash, Edit, Write, format_file, skill, finder.\n\n" +
      "When to use the Task tool:\n" +
      "- When you need to perform complex multi-step tasks\n" +
      "- When you need to run an operation that will produce a lot of output (tokens) " +
      "that is not needed after the sub-agent's task completes\n" +
      "- When you are making changes across many layers of an application, after you have " +
      "first planned and spec'd out the changes so they can be implemented independently\n" +
      '- When the user asks you to launch an "agent" or "subagent"\n\n' +
      "When NOT to use the Task tool:\n" +
      "- When you are performing a single logical task\n" +
      "- When you're reading a single file (use Read), performing a text search (use Grep), " +
      "editing a single file (use Edit)\n" +
      "- When you're not sure what changes you want to make\n\n" +
      "How to use the Task tool:\n" +
      "- Run multiple sub-agents concurrently if tasks are independent, by including " +
      "multiple tool uses in a single assistant message.\n" +
      "- Include all necessary context and a detailed plan in the task description.\n" +
      "- Tell the sub-agent how to verify its work if possible.\n" +
      "- When the agent is done, it will return a single message back to you.",

    parameters: Type.Object({
      prompt: Type.String({
        description:
          "The task for the agent to perform. Be specific and include any relevant context.",
      }),
      description: Type.String({
        description: "A very short description of the task that can be displayed to the user.",
      }),
      model: Type.Optional(
        Type.String({
          description:
            "Optional model override for the sub-agent. Format: 'provider/model-id' " +
            "(e.g. 'anthropic/claude-sonnet-4-6', 'openai-codex/gpt-5.4'). " +
            "Defaults to the parent's current model.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "Optional thinking level for the sub-agent: off, minimal, low, medium, high, xhigh. " +
            "Defaults to the parent's current thinking level.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as TaskParams;
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const taskSessionPath = generateTaskSessionPath();
      const singleResult: SingleResult = {
        agent: "Task",
        task: p.description,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      return runtime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PiSpawnService;
          const result = yield* svc.spawn({
            cwd: ctx.cwd,
            task: p.prompt,
            model: p.model,
            thinking: p.thinking,
            builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
            extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
            signal,
            sessionId,
            sessionPath: taskSessionPath,
            onUpdate: (partial) => {
              singleResult.messages = partial.messages;
              singleResult.usage = partial.usage;
              singleResult.model = partial.model;
              singleResult.stopReason = partial.stopReason;
              singleResult.errorMessage = partial.errorMessage;
              if (onUpdate) {
                onUpdate({
                  content: [
                    {
                      type: "text",
                      text: getFinalOutput(partial.messages) || "(working...)",
                    },
                  ],
                  details: singleResult,
                } as any);
              }
            },
          });

          singleResult.exitCode = result.exitCode;
          singleResult.messages = result.messages;
          singleResult.usage = result.usage;
          singleResult.model = result.model;
          singleResult.stopReason = result.stopReason;
          singleResult.errorMessage = result.errorMessage;

          const isError =
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted";
          const output = getFinalOutput(result.messages) || "(no output)";

          if (isError) {
            return subAgentResult(
              result.errorMessage || result.stderr || output,
              singleResult,
              true,
            );
          }

          // collapse context: return a compact summary instead of full output
          const summary = summarizeExecution(p.description, result.messages, output);
          const sessionRef = `Session: ${taskSessionPath}`;
          return subAgentResult(`${sessionRef}\n${summary}`, singleResult);
        }),
      );
    },

    renderCall(args: any, theme: any) {
      const desc = args.description || "...";
      const preview = desc.length > 80 ? `${desc.slice(0, 80)}...` : desc;
      return new Text(theme.fg("toolTitle", theme.bold("Task ")) + theme.fg("dim", preview), 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const details = result.details as SingleResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      const container = new Container();
      renderAgentTree(details, container, expanded, theme, {
        label: "Task",
        header: "statusOnly",
      });
      return container;
    },
  };
}

export function createTaskExtension(
  deps: TaskExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function taskExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-task",
      CONFIG_DEFAULTS,
      { schema: TASK_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const runtime = ManagedRuntime.make(PiSpawnService.layer);

    pi.registerTool(
      deps.withPromptPatch(
        deps.createTaskTool(
          {
            builtinTools: cfg.builtinTools,
            extensionTools: cfg.extensionTools,
          },
          runtime,
        ),
      ),
    );

    pi.on("session_shutdown", async () => {
      await runtime.dispose();
    });
  };
}

const taskExtension: (pi: ExtensionAPI) => void = createTaskExtension();

export default taskExtension;

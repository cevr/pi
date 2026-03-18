/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * Task tool — token-efficient sub-agent delegation.
 *
 * Sync mode behaves like the original Task tool: run a focused sub-agent,
 * collapse the exchange into a compact summary, and preserve the full transcript
 * for inspection.
 *
 * Background mode returns immediately with a task id. Use get_task_result to
 * poll for completion and steer_task to send mid-run guidance.
 */

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type { Message } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import {
  createTaskRunner,
  type TaskRecord,
  type TaskRunnerHandle,
  type TaskRunnerStatus,
  type TaskRunnerThinkingLevel,
} from "@cvr/pi-task-runner";
import {
  getDisplayItems,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@cvr/pi-sub-agent-render";

type TaskExtConfig = {
  builtinTools: string[];
  extensionTools: string[];
};

type TaskExtensionDeps = {
  createTaskRunner: typeof createTaskRunner;
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

export const CONFIG_DEFAULTS: TaskExtConfig = {
  builtinTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  extensionTools: [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "format_file",
    "finder",
    "get_task_result",
    "steer_task",
  ],
};

export const DEFAULT_DEPS: TaskExtensionDeps = {
  createTaskRunner,
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
  thinking?: TaskRunnerThinkingLevel;
  background?: boolean;
  outputFilePath?: string;
}

interface GetTaskResultParams {
  task_id: string;
  wait?: boolean;
  verbose?: boolean;
}

interface SteerTaskParams {
  task_id: string;
  message: string;
}

export interface TaskConfig {
  builtinTools?: string[];
  extensionTools?: string[];
}

type BackgroundState = {
  tasks: Map<string, TaskRunnerHandle>;
  completionListeners: Map<string, () => void>;
};

interface TaskBackgroundNotificationDetails {
  taskId: string;
  description: string;
  status: TaskRunnerStatus;
  phase: TaskRecord["progress"]["phase"];
  turnCount: number;
  outputFilePath: string | null;
  sessionFilePath: string | null;
  output: string;
  errorMessage?: string;
}

const TASK_BACKGROUND_NOTIFICATION_TYPE = "task-background-notification";
const TASK_BACKGROUND_COMPLETED_EVENT = "task:background-completed";

function createBackgroundState(): BackgroundState {
  return { tasks: new Map(), completionListeners: new Map() };
}

function cloneMessageArray(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ ...message }));
}

function summarizeExecution(
  description: string,
  messages: readonly Message[],
  finalOutput: string,
): string {
  const items = getDisplayItems([...messages]);

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
    }
  }

  const parts: string[] = [`[TASK COMPLETE] "${description}"`];
  const actions: string[] = [];
  if (reads.size > 0) actions.push(`read ${reads.size} file(s)`);
  if (writes.size > 0) actions.push(`modified ${[...writes].join(", ")}`);
  if (commands.length > 0) actions.push(`ran ${commands.length} command(s)`);
  if (actions.length > 0) parts.push(`Actions: ${actions.join(", ")}.`);

  const maxLen = 500;
  const outcome = finalOutput.length > maxLen ? finalOutput.slice(0, maxLen) + "…" : finalOutput;
  parts.push(`Outcome: ${outcome || "(no output)"}`);

  return parts.join("\n");
}

function getStatusLabel(status: TaskRunnerStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return "completed";
  }
}

function getCompletionVerb(status: Exclude<TaskRunnerStatus, "running">): string {
  switch (status) {
    case "aborted":
      return "aborted";
    case "error":
      return "failed";
    default:
      return "completed";
  }
}

function truncateNotificationOutput(value: string, maxLength = 400): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

function buildBackgroundNotificationDetails(record: TaskRecord): TaskBackgroundNotificationDetails {
  return {
    taskId: record.id,
    description: record.description,
    status: record.status,
    phase: record.progress.phase,
    turnCount: record.progress.turnCount,
    outputFilePath: record.outputFilePath,
    sessionFilePath: record.sessionFilePath,
    output: record.output,
    errorMessage: record.errorMessage,
  };
}

function isTaskBackgroundNotification(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as { role?: unknown; customType?: unknown };
  return record.role === "custom" && record.customType === TASK_BACKGROUND_NOTIFICATION_TYPE;
}

function formatBackgroundCompletionMessage(record: TaskRecord): string {
  if (record.status === "running") {
    return `Background task ${record.id} is still running.`;
  }

  const verb = getCompletionVerb(record.status);
  const references = buildReferenceBlock(record);
  const output = truncateNotificationOutput(record.output || record.errorMessage || "(no output)");
  return [
    `Background task ${record.id} ${verb}.`,
    `Task: ${record.description}`,
    `Status: ${getStatusLabel(record.status)}`,
    references || null,
    `Output: ${output}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatProgressBlock(record: TaskRecord): string {
  const lines: string[] = [];
  const { progress } = record;

  if (progress.turnCount > 0) {
    lines.push(`Turn: ${progress.turnCount}`);
  }
  lines.push(`Phase: ${progress.phase}`);

  if (progress.activeTools.length > 0) {
    lines.push(`Active tools: ${progress.activeTools.map((tool) => tool.label).join(", ")}`);
  }
  if (progress.textDelta.trim().length > 0) {
    lines.push(`Latest text delta: ${progress.textDelta.trim()}`);
  }

  return lines.join("\n");
}

function buildReferenceBlock(record: TaskRecord): string {
  return [
    record.sessionFilePath ? `Session: ${record.sessionFilePath}` : null,
    record.outputFilePath ? `Transcript: ${record.outputFilePath}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

function buildSingleResult(record: TaskRecord): SingleResult {
  return {
    agent: "Task",
    task: record.description,
    exitCode: record.status === "completed" ? 0 : 1,
    messages: cloneMessageArray(record.messages),
    usage: { ...record.usage },
    model: record.model,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
  };
}

function renderTaskToolResult(result: any, expanded: boolean, theme: any, label: string) {
  const details = result.details as SingleResult | undefined;
  if (!details || !Array.isArray((details as { messages?: unknown }).messages)) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  const container = new Container();
  renderAgentTree(details, container, expanded, theme, {
    label,
    header: "statusOnly",
  });
  return container;
}

function detachBackgroundTaskCompletion(state: BackgroundState, taskId: string): void {
  const unsubscribe = state.completionListeners.get(taskId);
  if (!unsubscribe) return;
  state.completionListeners.delete(taskId);
  unsubscribe();
}

async function cleanupBackgroundTasks(state: BackgroundState): Promise<void> {
  const handles = [...state.tasks.values()];
  state.tasks.clear();
  for (const handle of handles) {
    detachBackgroundTaskCompletion(state, handle.id);
  }
  await Promise.all(handles.map((handle) => handle.abort().catch(() => undefined)));
  for (const handle of handles) {
    handle.dispose();
  }
}

function registerBackgroundTaskCompletion(pi: ExtensionAPI, handle: TaskRunnerHandle): () => void {
  let unsubscribe: (() => void) | undefined;
  unsubscribe = handle.onCompletion((record) => {
    if (record.status === "running") return;
    unsubscribe?.();
    unsubscribe = undefined;
    const details = buildBackgroundNotificationDetails(record);
    pi.events.emit(TASK_BACKGROUND_COMPLETED_EVENT, details);
    pi.sendMessage(
      {
        customType: TASK_BACKGROUND_NOTIFICATION_TYPE,
        content: formatBackgroundCompletionMessage(record),
        display: true,
        details,
      },
      { deliverAs: "nextTurn" },
    );
  });
  return () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };
}

function createTaskTool(
  pi: ExtensionAPI,
  backgroundState: BackgroundState,
  config: TaskConfig = {},
  createTaskRunnerFn: typeof createTaskRunner,
): ToolDefinition {
  return {
    name: "Task",
    label: "Task",
    description:
      "Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to " +
      "the following tools: Read, Grep, Find, ls, Bash, Edit, Write, format_file, skill, finder, get_task_result, steer_task.\n\n" +
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
      "- Set background=true when you want to poll later with get_task_result.\n" +
      "- Use steer_task to redirect a running background task without restarting it.\n" +
      "- Include all necessary context and a detailed plan in the task description.\n" +
      "- Tell the sub-agent how to verify its work if possible.",
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
            "Optional model override for the sub-agent. Format: 'provider/model-id'. Defaults to the parent's current model.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "Optional thinking level for the sub-agent: off, minimal, low, medium, high, xhigh.",
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: "Run the task in the background and return a task id immediately.",
        }),
      ),
      outputFilePath: Type.Optional(
        Type.String({
          description: "Optional transcript path override for the task's JSONL output file.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const p = params as TaskParams;
      const handle = createTaskRunnerFn({
        cwd: ctx.cwd,
        prompt: p.prompt,
        description: p.description,
        model: p.model,
        thinking: p.thinking,
        builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
        extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
        outputFilePath: p.outputFilePath,
        currentModel: ctx.model,
        modelRegistry: ctx.modelRegistry,
        onUpdate: (record) => {
          if (!onUpdate) return;
          onUpdate({
            content: [
              {
                type: "text",
                text: record.output || "(working...)",
              },
            ],
            details: buildSingleResult(record),
          } as any);
        },
      });

      if (p.background) {
        backgroundState.tasks.set(handle.id, handle);
        backgroundState.completionListeners.set(
          handle.id,
          registerBackgroundTaskCompletion(pi, handle),
        );
        const record = handle.getRecord();
        const references = buildReferenceBlock(record);
        const progress = formatProgressBlock(record);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Started background task ${handle.id}.\n` +
                `${references ? references + "\n" : ""}` +
                `${progress ? progress + "\n" : ""}` +
                `Use get_task_result with task_id="${handle.id}" to poll, or steer_task to redirect it.`,
            },
          ],
          details: {
            taskId: handle.id,
            status: record.status,
            phase: record.progress.phase,
            turnCount: record.progress.turnCount,
            activeTools: record.progress.activeTools.map((tool) => tool.label),
            outputFilePath: record.outputFilePath,
            sessionFilePath: record.sessionFilePath,
          },
        } as any;
      }

      const record = await handle.wait();
      handle.dispose();
      const output = record.output || "(no output)";
      const references = buildReferenceBlock(record);
      const content = `${references ? references + "\n" : ""}${summarizeExecution(p.description, record.messages, output)}`;
      return subAgentResult(content, buildSingleResult(record), record.status !== "completed");
    },
    renderCall(args: any, theme: any) {
      const desc = args.description || "...";
      const background = args.background === true ? "bg " : "";
      const preview = desc.length > 76 ? `${desc.slice(0, 76)}...` : desc;
      return new Text(
        theme.fg("toolTitle", theme.bold(`Task ${background}`)) + theme.fg("muted", preview),
        0,
        0,
      );
    },
    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      return renderTaskToolResult(result, expanded, theme, "Task");
    },
  };
}

function createGetTaskResultTool(backgroundState: BackgroundState): ToolDefinition {
  return {
    name: "get_task_result",
    label: "Get Task Result",
    description:
      "Check status and retrieve results from a background Task run. Use the task id returned by Task(background=true).",
    parameters: Type.Object({
      task_id: Type.String({ description: "The background task id to inspect." }),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for completion before returning. Default: false." }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "Include the task's full expandable transcript details when complete.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as GetTaskResultParams;
      const handle = backgroundState.tasks.get(p.task_id);
      if (!handle) {
        return {
          content: [{ type: "text" as const, text: `Task not found: ${p.task_id}` }],
          details: {},
          isError: true,
        } as any;
      }

      const record = p.wait ? await handle.wait() : handle.getRecord();
      const references = buildReferenceBlock(record);

      if (record.status === "running") {
        const progress = formatProgressBlock(record);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Task ${record.id} is still running.\n` +
                `Status: ${getStatusLabel(record.status)}\n` +
                `${references ? references + "\n" : ""}` +
                `${progress ? progress + "\n" : ""}` +
                `Current output: ${record.output || "(working...)"}`,
            },
          ],
          details: {
            taskId: record.id,
            status: record.status,
            phase: record.progress.phase,
            turnCount: record.progress.turnCount,
            activeTools: record.progress.activeTools.map((tool) => tool.label),
            latestTextDelta: record.progress.textDelta,
            outputFilePath: record.outputFilePath,
            sessionFilePath: record.sessionFilePath,
          },
        } as any;
      }

      backgroundState.tasks.delete(record.id);
      detachBackgroundTaskCompletion(backgroundState, record.id);
      handle.dispose();

      const statusLine = `Task ${record.id} ${getStatusLabel(record.status)}.`;
      const output = record.output || record.errorMessage || "(no output)";
      const progress = formatProgressBlock(record);
      const text =
        `${statusLine}\n` +
        `${references ? references + "\n" : ""}` +
        `${progress ? progress + "\n" : ""}` +
        `${output}`;
      if (p.verbose) {
        return subAgentResult(text, buildSingleResult(record), record.status !== "completed");
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          taskId: record.id,
          status: record.status,
          phase: record.progress.phase,
          turnCount: record.progress.turnCount,
          activeTools: record.progress.activeTools.map((tool) => tool.label),
          latestTextDelta: record.progress.textDelta,
          outputFilePath: record.outputFilePath,
          sessionFilePath: record.sessionFilePath,
        },
        isError: record.status !== "completed",
      } as any;
    },
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("get_task_result ")) +
          theme.fg("muted", args.task_id || "..."),
        0,
        0,
      );
    },
    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      return renderTaskToolResult(result, expanded, theme, "Task");
    },
  };
}

function createSteerTaskTool(backgroundState: BackgroundState): ToolDefinition {
  return {
    name: "steer_task",
    label: "Steer Task",
    description: "Send a mid-run steering message to a running background task.",
    parameters: Type.Object({
      task_id: Type.String({ description: "The background task id to steer." }),
      message: Type.String({ description: "The steering message to inject." }),
    }),
    async execute(_toolCallId, params) {
      const p = params as SteerTaskParams;
      const handle = backgroundState.tasks.get(p.task_id);
      if (!handle) {
        return {
          content: [{ type: "text" as const, text: `Task not found: ${p.task_id}` }],
          details: {},
          isError: true,
        } as any;
      }

      const ok = await handle.steer(p.message);
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Task ${p.task_id} is no longer running.` }],
          details: {},
          isError: true,
        } as any;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Steering message queued for task ${p.task_id}.`,
          },
        ],
        details: {},
      } as any;
    },
    renderCall(args: any, theme: any) {
      const preview = args.message
        ? args.message.length > 60
          ? `${args.message.slice(0, 60)}...`
          : args.message
        : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("steer_task ")) + theme.fg("muted", preview),
        0,
        0,
      );
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

    const backgroundState = createBackgroundState();
    const extensionConfig = {
      builtinTools: cfg.builtinTools,
      extensionTools: cfg.extensionTools,
    };

    pi.on("context", async (event) => ({
      messages: event.messages.filter((message) => !isTaskBackgroundNotification(message)),
    }));

    for (const tool of [
      createTaskTool(pi, backgroundState, extensionConfig, deps.createTaskRunner),
      createGetTaskResultTool(backgroundState),
      createSteerTaskTool(backgroundState),
    ]) {
      pi.registerTool(deps.withPromptPatch(tool));
    }

    pi.on("session_switch", async () => {
      await cleanupBackgroundTasks(backgroundState);
    });

    pi.on("session_shutdown", async () => {
      await cleanupBackgroundTasks(backgroundState);
    });
  };
}

const taskExtension: (pi: ExtensionAPI) => void = createTaskExtension();

export default taskExtension;

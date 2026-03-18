/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * read_session tool — extract relevant context from a pi session via sub-agent.
 *
 * loads a full session tree (all branches), renders it as structured markdown,
 * then spawns a compact sub-agent to extract only the information
 * relevant to the stated goal. the agent sees the complete tree — including
 * abandoned branches — so it can understand decision points and context.
 *
 * branch awareness: if a leaf_id is provided, the target branch is annotated
 * in the rendered output so the agent knows which path to focus on.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  buildSessionTree,
  findSessionFileBySessionId,
  getSessionChainToRoot,
  isTextContent,
  parseSessionFile,
  type MessageEntry,
  type SessionEntry,
} from "@cvr/pi-mentions";
import { Container, Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { Type } from "@sinclair/typebox";
import { PiSpawnService, zeroUsage } from "@cvr/pi-spawn";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@cvr/pi-sub-agent-render";
import { headTailChars } from "@cvr/pi-output-buffer";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { Effect, ManagedRuntime } from "effect";

type ReadSessionExtConfig = {
  model: string;
  sessionsDir: string;
  maxChars: number;
};

export const CONFIG_DEFAULTS: ReadSessionExtConfig = {
  model: "openai-codex/gpt-5.4-mini",
  sessionsDir: path.join(os.homedir(), ".pi", "agent", "sessions"),
  maxChars: 120_000,
};

export type ReadSessionExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

export const DEFAULT_DEPS: ReadSessionExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isReadSessionConfig(value: Record<string, unknown>): value is ReadSessionExtConfig {
  return (
    isNonEmptyString(value.model) &&
    isNonEmptyString(value.sessionsDir) &&
    typeof value.maxChars === "number" &&
    Number.isInteger(value.maxChars) &&
    value.maxChars >= 1
  );
}

export const READ_SESSION_CONFIG_SCHEMA: ExtensionConfigSchema<ReadSessionExtConfig> = {
  validate: isReadSessionConfig,
};

const DEFAULT_SYSTEM_PROMPT = `You are analyzing a pi coding agent session transcript. Extract information relevant to the user's goal. Be specific — cite file paths, decisions made, code patterns discussed. If a specific branch is marked as the target, focus on that branch but use other branches for context about what was tried and abandoned.`;

export interface ReadSessionConfig {
  systemPrompt?: string;
  model?: string;
  sessionsDir: string;
  maxChars: number;
}

// --- session rendering ---

interface ReadSessionParams {
  session_id: string;
  goal: string;
  leaf_id?: string;
}

export { findSessionFileBySessionId as findSessionFile } from "@cvr/pi-mentions";

function renderSessionTree(
  filePath: string,
  targetLeafId: string | undefined,
  maxChars: number,
): { markdown: string; sessionName: string; sessionId: string } {
  const parsed = parseSessionFile(filePath);
  const sessionId = parsed.header?.id ?? "";
  const sessionName = parsed.sessionName;
  const workspace = parsed.header?.cwd ?? "";
  const startedAt = parsed.header?.timestamp ?? "";
  const { byId, childrenByParentId, rootEntries } = buildSessionTree(parsed.entries);
  const targetPath = new Set(
    targetLeafId ? getSessionChainToRoot(targetLeafId, byId).map((entry) => entry.id) : [],
  );

  const parts: string[] = [];
  parts.push(`# session: ${sessionName || sessionId}`);
  parts.push(`id: ${sessionId}`);
  parts.push(`workspace: ${workspace}`);
  parts.push(`started: ${startedAt}`);
  if (targetLeafId) parts.push(`target branch leaf: ${targetLeafId}`);
  parts.push("");

  const renderEntry = (entry: SessionEntry) => {
    const marker = targetPath.has(entry.id) ? " [TARGET BRANCH]" : "";
    const children = childrenByParentId.get(entry.id) ?? [];
    if (children.length > 1) {
      parts.push(`\n--- branch point (${children.length} paths) ---\n`);
    }

    if (entry.type === "message") {
      const msg = (entry as MessageEntry).message;
      if (msg.role === "user") {
        const textParts = msg.content
          .filter(isTextContent)
          .map((part) => part.text)
          .join("\n");
        if (textParts) {
          parts.push(`## user${marker}`);
          parts.push(textParts);
          parts.push("");
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];

        for (const part of msg.content) {
          if (isTextContent(part)) {
            textParts.push(part.text);
          } else if (part.type === "toolCall") {
            const args = part.arguments ? JSON.stringify(part.arguments).slice(0, 200) : "";
            toolCalls.push(`${part.name}(${args})`);
          }
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
          parts.push(`## assistant${marker}`);
          if (textParts.length > 0) parts.push(textParts.join("\n"));
          if (toolCalls.length > 0) parts.push(`\ntool calls: ${toolCalls.join(", ")}`);
          parts.push("");
        }
      } else if (msg.role === "toolResult") {
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "?";
        const textContent = msg.content
          .filter(isTextContent)
          .map((part) => part.text)
          .join("\n");
        const truncated =
          textContent.length > 500 ? `${textContent.slice(0, 500)}... (truncated)` : textContent;
        if (truncated) {
          parts.push(`### ${toolName} result${msg.isError === true ? " (ERROR)" : ""}${marker}`);
          parts.push(truncated);
          parts.push("");
        }
      }
    } else if (entry.type === "model_change") {
      parts.push(`*model changed to ${String(entry.modelId)}*\n`);
    }

    for (const child of children) {
      renderEntry(child);
    }
  };

  for (const rootEntry of rootEntries) {
    renderEntry(rootEntry);
  }

  const markdown = parts.join("\n");
  const truncated = headTailChars(markdown, maxChars);
  return {
    markdown: truncated.truncated ? truncated.text : markdown,
    sessionName,
    sessionId,
  };
}

// --- tool ---

export function createReadSessionTool(
  config: ReadSessionConfig,
  runtime: ManagedRuntime.ManagedRuntime<PiSpawnService, never>,
): ToolDefinition {
  return {
    name: "read_session",
    label: "Read Session",
    description:
      "Read and extract relevant content from a past pi session.\n\n" +
      "Loads the full session tree (all branches, including abandoned paths), " +
      "then uses AI to extract only the information relevant to your stated goal. " +
      "The AI sees the complete tree to understand decision points and context.\n\n" +
      "Use `search_sessions` first to find session IDs and branch leaf IDs.\n\n" +
      "WHEN TO USE:\n" +
      "- Extracting context from a previous session\n" +
      "- Understanding what was tried and decided in a past session\n" +
      "- Continuing work from a prior session\n\n" +
      "WHEN NOT TO USE:\n" +
      "- Current session context (already available)\n" +
      "- Finding sessions (use search_sessions first)",

    parameters: Type.Object({
      session_id: Type.String({
        description: "The session ID to read (from search_sessions results).",
      }),
      goal: Type.String({
        description: "What information you're looking for. Be specific about what to extract.",
      }),
      leaf_id: Type.Optional(
        Type.String({
          description:
            "Optional branch leaf ID to focus on. The AI will see all branches " +
            "but prioritize the target branch.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as ReadSessionParams;
      // find the session file
      const sessionFile = findSessionFileBySessionId(p.session_id, config.sessionsDir);
      if (!sessionFile) {
        return {
          content: [
            {
              type: "text" as const,
              text: `session not found: ${p.session_id}`,
            },
          ],
          isError: true,
        } as any;
      }

      // render session tree
      const { markdown } = renderSessionTree(sessionFile, p.leaf_id, config.maxChars);

      if (!markdown.trim()) {
        return {
          content: [{ type: "text" as const, text: "(session is empty)" }],
        } as any;
      }

      // spawn sub-agent to extract relevant content
      let sessionId = "";
      try {
        sessionId = (ctx as any).sessionManager?.getSessionId?.() ?? "";
      } catch {}

      const task = `Here is a pi coding agent session transcript:\n\n${markdown}\n\n---\n\nExtract the information relevant to this goal: ${p.goal}`;

      const singleResult: SingleResult = {
        agent: "read_session",
        task: p.goal,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      return runtime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PiSpawnService;
          const result = yield* svc.spawn({
            cwd: ctx.cwd,
            task,
            model: config.model ?? CONFIG_DEFAULTS.model,
            builtinTools: [],
            extensionTools: [],
            systemPromptBody: systemPrompt,
            signal,
            sessionId,
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
                      text: getFinalOutput(partial.messages) || "(reading session...)",
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

          return subAgentResult(output, singleResult);
        }),
      );
    },

    renderCall(args: any, theme: any) {
      const goal = args.goal
        ? args.goal.length > 60
          ? `${args.goal.slice(0, 60)}...`
          : args.goal
        : "...";
      let text = theme.fg("toolTitle", theme.bold("read_session ")) + theme.fg("muted", goal);
      if (args.session_id) {
        const shortId = args.session_id.length > 8 ? args.session_id.slice(0, 8) : args.session_id;
        text += theme.fg("muted", ` (${shortId}...)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const details = result.details as SingleResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      const container = new Container();
      renderAgentTree(details, container, expanded, theme, {
        label: "read_session",
        header: "statusOnly",
      });
      return container;
    },
  };
}

export function createReadSessionExtension(
  deps: ReadSessionExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function readSessionExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-read-session",
      CONFIG_DEFAULTS,
      { schema: READ_SESSION_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const runtime = ManagedRuntime.make(PiSpawnService.layer);

    pi.registerTool(
      deps.withPromptPatch(
        createReadSessionTool(
          {
            model: cfg.model,
            sessionsDir: cfg.sessionsDir,
            maxChars: cfg.maxChars,
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

const readSessionExtension: (pi: ExtensionAPI) => void = createReadSessionExtension();

export default readSessionExtension;

/**
 * handoff extension — replace compaction with LLM-driven context transfer.
 *
 * at ~85% context usage, generates a focused handoff prompt via LLM,
 * stages `/handoff` in the editor. user presses Enter → new session
 * with curated context, agent starts working immediately.
 *
 * manual usage anytime:
 *   /handoff implement this for teams
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 */

import {
  complete,
  type Api,
  type Model,
  type Message,
  type Tool,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { registerMentionSource } from "@cvr/pi-mentions";
import { resolvePrompt } from "@cvr/pi-spawn";
import { register, type MachineConfig } from "@cvr/pi-state-machine";
import { createHandoffMentionSource } from "./handoff-mention-source";
import {
  handoffReducer,
  type HandoffEffect,
  type HandoffEvent,
  type HandoffState,
} from "./machine";

type HandoffExtConfig = {
  threshold: number;
  model: { provider: string; id: string };
  promptFile: string;
  promptString: string;
};

export const CONFIG_DEFAULTS: HandoffExtConfig = {
  threshold: 0.85,
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
  },
  promptFile: "",
  promptString: "",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHandoffConfig(value: Record<string, unknown>): value is HandoffExtConfig {
  const threshold = value.threshold;
  if (typeof threshold !== "number" || threshold <= 0 || threshold > 1) {
    return false;
  }

  if (!isPlainObject(value.model)) {
    return false;
  }

  return (
    typeof value.model.provider === "string" &&
    value.model.provider.trim().length > 0 &&
    typeof value.model.id === "string" &&
    value.model.id.trim().length > 0 &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

export const HANDOFF_CONFIG_SCHEMA: ExtensionConfigSchema<HandoffExtConfig> = {
  validate: isHandoffConfig,
};

const MAX_RELEVANT_FILES = 10;

function parsePromptSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = content.split("\n# ");
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl === -1) continue;
    const name = part.slice(0, nl).trim();
    const body = part.slice(nl + 1).trim();
    if (name) sections[name] = body;
  }
  return sections;
}

interface HandoffExtraction {
  relevantInformation: string;
  relevantFiles: string[];
}

interface ModesPersistEntry {
  type?: string;
  customType?: string;
  data?: {
    planFilePath?: string | null;
    pending?: {
      planFilePath?: string | null;
    };
  };
}

function extractToolCallArgs(response: {
  content: ({ type: string } | ToolCall)[];
}): HandoffExtraction | null {
  const toolCall = response.content.find(
    (c): c is ToolCall =>
      c.type === "toolCall" && "name" in c && c.name === "create_handoff_context",
  );
  if (!toolCall) return null;
  const args = toolCall.arguments as Record<string, unknown>;
  return {
    relevantInformation: (args.relevantInformation as string) ?? "",
    relevantFiles: (Array.isArray(args.relevantFiles) ? args.relevantFiles : []).slice(
      0,
      MAX_RELEVANT_FILES,
    ) as string[],
  };
}

export function getPersistedModesPlanPath(entries: readonly unknown[]): string | null {
  const modesEntry = [...entries]
    .reverse()
    .find(
      (entry): entry is ModesPersistEntry =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as ModesPersistEntry).type === "custom" &&
        (entry as ModesPersistEntry).customType === "modes",
    );

  const pendingPlanPath = modesEntry?.data?.pending?.planFilePath;
  if (typeof pendingPlanPath === "string" && pendingPlanPath.trim()) return pendingPlanPath;

  const planPath = modesEntry?.data?.planFilePath;
  if (typeof planPath === "string" && planPath.trim()) return planPath;

  return null;
}

export function assembleHandoffPrompt(
  sessionId: string,
  extraction: HandoffExtraction,
  goal: string,
  planFilePath?: string | null,
): string {
  const parts: string[] = [];

  parts.push(
    `Continuing work from session ${sessionId}. Use read_session to retrieve details if needed.`,
  );

  if (planFilePath) {
    parts.push(`Plan file: ${planFilePath}`);
  }

  if (extraction.relevantFiles.length > 0) {
    parts.push(extraction.relevantFiles.map((f) => `@${f}`).join(" "));
  }

  if (extraction.relevantInformation) {
    parts.push(extraction.relevantInformation);
  }

  parts.push(goal);

  return parts.join("\n\n");
}

const PROVENANCE_PREFIX = "↳ handed off from: ";
const PROVENANCE_ELLIPSIS = "…";

interface HandoffExtensionDeps {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  registerMentionSource: typeof registerMentionSource;
  resolvePrompt: typeof resolvePrompt;
}

export const DEFAULT_DEPS: HandoffExtensionDeps = {
  getEnabledExtensionConfig,
  registerMentionSource,
  resolvePrompt,
};

function getParentDescription(parentPath: string, maxWidth: number): string {
  const budget = maxWidth - PROVENANCE_PREFIX.length - PROVENANCE_ELLIPSIS.length;
  try {
    const session = SessionManager.open(parentPath);

    const name = session.getSessionName();
    if (name)
      return name.length > budget ? name.slice(0, Math.max(0, budget)) + PROVENANCE_ELLIPSIS : name;

    const branch = session.getBranch();
    const firstUser = branch.find(
      (e): e is SessionEntry & { type: "message" } =>
        e.type === "message" && "content" in e.message && e.message.role === "user",
    );
    if (firstUser) {
      const content = (firstUser.message as { content: unknown }).content;
      const text = (Array.isArray(content) ? content : [])
        .filter(
          (c): c is { type: "text"; text: string } =>
            typeof c === "object" && c !== null && c.type === "text",
        )
        .map((c) => c.text)
        .join(" ")
        .trim();
      if (text)
        return text.length > budget
          ? text.slice(0, Math.max(0, budget)) + PROVENANCE_ELLIPSIS
          : text;
    }
    const header = session.getHeader();
    return header?.id?.slice(0, 8) ?? parentPath.split("/").pop() ?? "unknown";
  } catch {
    return parentPath.split("/").pop() ?? "unknown";
  }
}

function showProvenance(ctx: ExtensionContext, parentPath: string): void {
  ctx.ui.setWidget("handoff-provenance", (_tui, theme) => ({
    render(width: number): string[] {
      const desc = getParentDescription(parentPath, width);
      const arrow = theme.fg("muted", "↳ ");
      const text = truncateToWidth(`${PROVENANCE_PREFIX.slice(2)}${desc}`, width);
      const content = arrow + text;
      const contentWidth = visibleWidth(content);
      const pad = Math.max(0, width - contentWidth);
      return [" ".repeat(pad) + content];
    },
    invalidate() {},
  }));
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export function createHandoffExtension(deps: HandoffExtensionDeps = DEFAULT_DEPS) {
  return function handoffExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-handoff",
      CONFIG_DEFAULTS,
      { schema: HANDOFF_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    deps.registerMentionSource(createHandoffMentionSource());

    const handoffSections = parsePromptSections(
      deps.resolvePrompt(cfg.promptString, cfg.promptFile),
    );

    const HANDOFF_TOOL: Tool = {
      name: "create_handoff_context",
      description: handoffSections["tool-description"] || "Extract context for handoff",
      parameters: Type.Object({
        relevantInformation: Type.String({
          description: handoffSections["field-relevant-information"] || "Extract relevant context",
        }),
        relevantFiles: Type.Array(Type.String(), {
          description: handoffSections["field-relevant-files"] || "Relevant file paths",
        }),
      }),
    };

    function buildExtractionPrompt(conversationText: string, goal: string): string {
      const body = handoffSections["extraction-prompt"] ?? "";
      return `${conversationText}\n\n${body}\n${goal}\n\nUse the create_handoff_context tool to extract relevant information and files.`;
    }

    /** resolve the dedicated handoff model, fall back to ctx.model */
    function getHandoffModel(ctx: {
      modelRegistry: { find(p: string, id: string): Model<Api> | undefined };
      model: Model<Api> | undefined;
    }): Model<Api> | undefined {
      return ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) ?? ctx.model;
    }

    async function generateHandoffPrompt(
      ctx: { sessionManager: any; modelRegistry: any },
      handoffModel: Model<Api>,
      goal: string,
      signal?: AbortSignal,
    ): Promise<string | null> {
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((e: any): e is SessionEntry & { type: "message" } => e.type === "message")
        .map((e: any) => e.message);

      if (messages.length === 0) return null;

      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
      const sessionId = ctx.sessionManager.getSessionId();

      const apiKey = await ctx.modelRegistry.getApiKey(handoffModel);
      const userMessage: Message = {
        role: "user",
        content: [{ type: "text", text: buildExtractionPrompt(conversationText, goal) }],
        timestamp: Date.now(),
      };

      const response = await complete(
        handoffModel,
        { messages: [userMessage], tools: [HANDOFF_TOOL] },
        { apiKey, signal, toolChoice: "any" },
      );

      if (response.stopReason === "aborted") return null;

      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? "API request failed");
      }

      const extraction = extractToolCallArgs(response);
      if (!extraction) return null;

      const planFilePath = getPersistedModesPlanPath(ctx.sessionManager.getEntries());
      return assembleHandoffPrompt(sessionId, extraction, goal, planFilePath);
    }

    // -----------------------------------------------------------------------
    // Machine
    // -----------------------------------------------------------------------

    let machine: { send: (event: HandoffEvent) => void; getState: () => HandoffState };

    async function performHandoff(
      ctx: ExtensionContext,
      prompt: string,
      parentSessionFile: string,
    ): Promise<"handed-off" | "cancelled"> {
      machine.send({ _tag: "SwitchStart", parentSessionFile });

      const switchResult = await ctx.newSession({ parentSession: parentSessionFile });
      if (switchResult.cancelled) {
        machine.send({ _tag: "SwitchCancelled" });
        ctx.ui.notify("session switch cancelled", "info");
        return "cancelled";
      }

      machine.send({ _tag: "SwitchComplete" });
      if (ctx.hasUI) ctx.ui.setEditorText("");
      if (parentSessionFile) showProvenance(ctx, parentSessionFile);
      pi.sendUserMessage(prompt);
      return "handed-off";
    }

    async function chooseHandoffPrompt(
      ctx: ExtensionContext,
      prompt: string,
      parentSessionFile: string,
    ): Promise<"handed-off" | "dismissed" | "cancelled"> {
      if (!ctx.hasUI) {
        return performHandoff(ctx, prompt, parentSessionFile);
      }

      const choice = await ctx.ui.select("Handoff ready — what next?", [
        "Handoff now",
        "Do not handoff",
        "Edit handoff message",
      ]);

      if (choice === "Handoff now") {
        return performHandoff(ctx, prompt, parentSessionFile);
      }

      if (choice === "Edit handoff message") {
        const edited = await ctx.ui.editor(
          "handoff prompt — review/edit before switching",
          prompt,
        );
        if (!edited) {
          ctx.ui.notify("handoff edit cancelled", "info");
          return "cancelled";
        }
        return performHandoff(ctx, edited, parentSessionFile);
      }

      ctx.ui.notify("handoff dismissed", "info");
      return "dismissed";
    }

    async function runHandoffFlow(
      ctx: ExtensionContext,
      goal: string,
      signal?: AbortSignal,
    ): Promise<"handed-off" | "dismissed" | "cancelled"> {
      const handoffModel = getHandoffModel(ctx);
      if (!handoffModel) {
        throw new Error("no model available for handoff extraction");
      }

      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? "";
      machine.send({ _tag: "GenerateStart", parentSessionFile });

      const prompt = ctx.hasUI
        ? await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
            const loader = new BorderedLoader(
              tui,
              theme,
              `generating handoff prompt (${handoffModel.name})...`,
            );
            loader.onAbort = () => done(null);

            generateHandoffPrompt(ctx, handoffModel, goal, loader.signal)
              .then(done)
              .catch((err) => {
                console.error("handoff generation failed:", err);
                done(null);
              });

            return loader;
          })
        : await generateHandoffPrompt(ctx, handoffModel, goal, signal);

      if (!prompt) {
        machine.send({ _tag: "GenerateFail", error: "no extraction result" });
        return "cancelled";
      }

      machine.send({ _tag: "GenerateComplete" });
      return chooseHandoffPrompt(ctx, prompt, parentSessionFile);
    }

    const machineConfig: MachineConfig<HandoffState, HandoffEvent, HandoffEffect> = {
      id: "handoff",
      initial: { _tag: "Idle" },
      reducer: handoffReducer,

      events: {
        // provenance on session start — pure reply, no state change
        session_start: {
          mode: "reply" as const,
          handle: (_state, _piEvent, ctx) => {
            const parentPath = ctx.sessionManager.getHeader()?.parentSession;
            if (parentPath) showProvenance(ctx, parentPath);
          },
        },

        // always cancel compaction
        session_before_compact: {
          mode: "reply" as const,
          handle: () => ({ cancel: true }),
        },

        // monitor context after each agent turn
        agent_end: {
          mode: "fire" as const,
          toEvent: (state, _piEvent, ctx): HandoffEvent | null => {
            if (state._tag === "Generating" || state._tag === "Switching") return null;

            const usage = ctx.getContextUsage();
            if (!usage || usage.percent === null) return null;
            if (usage.percent < cfg.threshold * 100) return null;

            void runHandoffFlow(ctx, "continue the most specific pending task from the conversation").catch(
              (err) => {
                console.error("handoff generation failed:", err);
              },
            );
            return null;
          },
        },

        // reset on manual session switch
        session_switch: {
          mode: "fire" as const,
          toEvent: (): HandoffEvent => ({ _tag: "Reset" }),
        },
      },
      observers: [],
    };

    machine = register<HandoffState, HandoffEvent, HandoffEffect>(
      pi,
      machineConfig,
      (effect, _pi, ctx) => {
        switch (effect.type) {
          case "setEditorLabel":
            pi.events.emit("editor:set-label", {
              key: effect.key,
              text: effect.text,
              position: effect.position,
              align: effect.align,
            });
            break;
          case "removeEditorLabel":
            pi.events.emit("editor:remove-label", { key: effect.key });
            break;
          case "clearWidget":
            ctx.ui.setWidget(effect.key, undefined);
            break;
        }
      },
    );

    // -----------------------------------------------------------------------
    // /handoff command — imperative (async UI branches)
    // -----------------------------------------------------------------------

    pi.registerCommand("handoff", {
      description: "Transfer context to a new focused session (replaces compaction)",
      handler: async (args, ctx) => {
        const goal = args.trim();
        if (!goal) {
          ctx.ui.notify("no handoff goal provided. usage: /handoff <goal>", "error");
          return;
        }

        await runHandoffFlow(ctx, goal);
      },
    });

    // -----------------------------------------------------------------------
    // handoff tool — agent-invokable session transfer
    // -----------------------------------------------------------------------

    const handoffTool: ToolDefinition = {
      name: "handoff",
      label: "Handoff",
      description:
        "Hand off to a new session. Generates a handoff prompt from the current conversation, then lets the user hand off immediately, dismiss it, or edit the message before switching.",
      promptSnippet: "Hand off to a new session with a generated context transfer prompt",
      promptGuidelines: [
        "Use this when context is getting crowded or the user asks to continue in a fresh session.",
        "Set goal to a specific next task, not a vague continuation.",
      ],
      parameters: Type.Object({
        goal: Type.String({
          description:
            "What should be accomplished in the new session. Be specific about the next task.",
        }),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const p = params as { goal: string };
        const outcome = await runHandoffFlow(_ctx, p.goal, _signal ?? undefined);

        const text =
          outcome === "handed-off"
            ? `handed off to a new session for: "${p.goal}".`
            : outcome === "dismissed"
              ? `handoff dismissed for: "${p.goal}".`
              : `handoff cancelled for: "${p.goal}".`;

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
          details: undefined,
        };
      },
    };

    pi.registerTool(handoffTool);
  };
}

const handoffExtension: (pi: ExtensionAPI) => void = createHandoffExtension();

export default handoffExtension;

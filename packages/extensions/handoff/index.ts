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

function assembleHandoffPrompt(
  sessionId: string,
  extraction: HandoffExtraction,
  goal: string,
): string {
  const parts: string[] = [];

  parts.push(
    `Continuing work from session ${sessionId}. Use read_session to retrieve details if needed.`,
  );

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

      return assembleHandoffPrompt(sessionId, extraction, goal);
    }

    // -----------------------------------------------------------------------
    // Machine
    // -----------------------------------------------------------------------

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
            if (state._tag === "Ready" || state._tag === "Generating") return null;

            const usage = ctx.getContextUsage();
            if (!usage || usage.percent === null) return null;
            if (usage.percent < cfg.threshold * 100) return null;
            const handoffModel = getHandoffModel(ctx);
            if (!handoffModel) return null;

            const parentFile = ctx.sessionManager.getSessionFile() ?? "";

            // async generation — fire GenerateStart, then async work feeds back
            generateHandoffPrompt(
              ctx,
              handoffModel,
              "continue the most specific pending task from the conversation",
            )
              .then((prompt) => {
                if (!prompt) {
                  machine.send({ _tag: "GenerateFail", error: "no extraction result" });
                  return;
                }
                machine.send({ _tag: "GenerateComplete", prompt });
              })
              .catch((err) => {
                machine.send({ _tag: "GenerateFail", error: String(err) });
              });

            return { _tag: "GenerateStart", parentSessionFile: parentFile };
          },
        },

        // reset on manual session switch
        session_switch: {
          mode: "fire" as const,
          toEvent: (): HandoffEvent => ({ _tag: "Reset" }),
        },
      },
    };

    const machine = register<HandoffState, HandoffEvent, HandoffEffect>(
      pi,
      machineConfig,
      (effect, _pi, ctx) => {
        switch (effect.type) {
          case "setEditorText":
            ctx.ui.setEditorText(effect.text);
            break;
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
        let state = machine.getState();

        // manual invocation with a goal — generate fresh handoff
        if (goal && state._tag !== "Ready") {
          const handoffModel = getHandoffModel(ctx);
          if (!handoffModel) {
            ctx.ui.notify("no model available for handoff", "error");
            return;
          }

          const parentFile = ctx.sessionManager.getSessionFile() ?? "";

          const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
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
          });

          if (!result) {
            ctx.ui.notify("cancelled", "info");
            return;
          }

          machine.send({ _tag: "ManualReady", prompt: result, parentSessionFile: parentFile });
          state = machine.getState();
        }

        if (state._tag !== "Ready") {
          ctx.ui.notify("no handoff prompt available. usage: /handoff <goal>", "error");
          return;
        }

        // let user review/edit the handoff prompt before sending
        const edited = await ctx.ui.editor(
          "handoff prompt — ⏎ to handoff ␛ to cancel",
          state.prompt,
        );

        if (!edited) {
          ctx.ui.notify("handoff cancelled", "info");
          return;
        }

        const prompt = edited;
        const parent = state.parentSessionFile;

        machine.send({ _tag: "SwitchStart" });

        const switchResult = await ctx.newSession({ parentSession: parent });
        if (switchResult.cancelled) {
          machine.send({ _tag: "SwitchCancelled" });
          ctx.ui.notify("session switch cancelled", "info");
          return;
        }

        machine.send({ _tag: "SwitchComplete" });

        if (parent) showProvenance(ctx, parent);
        pi.sendUserMessage(prompt);
      },
    });

    // -----------------------------------------------------------------------
    // handoff tool — agent-invokable session transfer
    // -----------------------------------------------------------------------

    const handoffTool: ToolDefinition = {
      name: "handoff",
      label: "Handoff",
      description:
        "Hand off to a new session. Generates a handoff prompt from the current conversation and stages /handoff in the editor. The user presses Enter to review the prompt, then confirms to switch sessions.",
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
        const handoffModel = getHandoffModel(_ctx);
        if (!handoffModel) {
          throw new Error("no model available for handoff extraction");
        }

        const parentFile = _ctx.sessionManager.getSessionFile() ?? "";

        const prompt = await generateHandoffPrompt(
          _ctx,
          handoffModel,
          p.goal,
          _signal ?? undefined,
        );
        if (!prompt) {
          throw new Error("handoff generation failed: could not extract context");
        }

        machine.send({ _tag: "ManualReady", prompt, parentSessionFile: parentFile });

        return {
          content: [
            {
              type: "text",
              text: `handoff prompt generated for: "${p.goal}". staged /handoff — press Enter to continue in a new session.`,
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

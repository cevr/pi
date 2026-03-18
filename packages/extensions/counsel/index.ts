/**
 * counsel — opposite-model peer review tool.
 *
 * detects the current model's vendor (anthropic vs openai) and spawns
 * a pi sub-agent with the opposite vendor's model for adversarial review.
 * writes the review to ~/.pi/counsel/<id>.md for durability.
 *
 * follows the dedicated sub-agent pattern: PiSpawnService + ManagedRuntime + getEnabledExtensionConfig.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { PiSpawnService, zeroUsage, type PiSpawnConfig, type PiSpawnResult } from "@cvr/pi-spawn";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { readPrinciples } from "@cvr/pi-brain-principles";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@cvr/pi-sub-agent-render";
import { Effect, ManagedRuntime } from "effect";

// --- types ---

type CounselExtConfig = {
  /** explicit model override — bypasses auto-detect when set. */
  model: string;
  oppositeModels: { anthropic: string; openai: string };
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
  principlesDir: string;
};

type CounselExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
  readPrinciples: typeof readPrinciples;
};

export const CONFIG_DEFAULTS: CounselExtConfig = {
  model: "",
  oppositeModels: {
    anthropic: "openai-codex/gpt-5.4",
    openai: "anthropic/claude-opus-4-6",
  },
  extensionTools: ["read", "grep", "find", "ls", "bash"],
  builtinTools: ["read", "grep", "find", "ls", "bash"],
  promptFile: "",
  promptString: "",
  principlesDir: path.join(os.homedir(), ".brain", "principles"),
};

export const DEFAULT_DEPS: CounselExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
  readPrinciples,
};

// --- config validation ---

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCounselConfig(value: Record<string, unknown>): value is CounselExtConfig {
  return (
    typeof value.model === "string" &&
    typeof value.oppositeModels === "object" &&
    value.oppositeModels !== null &&
    isStringArray(value.extensionTools) &&
    isStringArray(value.builtinTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string" &&
    typeof value.principlesDir === "string"
  );
}

export const COUNSEL_CONFIG_SCHEMA: ExtensionConfigSchema<CounselExtConfig> = {
  validate: isCounselConfig,
};

// --- session path ---

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

function generateCounselSessionPath(): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const dir = path.join(SESSIONS_DIR, year);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `${timestamp}_counsel-${rand}.jsonl`);
}

// --- model resolution ---

type ModelFamily = "anthropic" | "openai";

const MISSING_INPUT_ERROR_RE =
  /invalid_request_error[\s\S]*(input|previous_response_id|prompt|conversation_id)[\s\S]*must be provided/i;

/**
 * detect model family from provider + id.
 * handles gateway providers like openrouter that carry models from both vendors.
 */
export function detectModelFamily(
  provider: string | undefined,
  modelId: string | undefined,
): ModelFamily | null {
  const p = (provider ?? "").toLowerCase();
  const id = (modelId ?? "").toLowerCase();

  // check model id first — more specific than provider
  if (id.includes("claude") || id.includes("anthropic")) return "anthropic";
  if (id.includes("gpt") || id.includes("openai") || /\bo[1-9][-/]/.test(id)) return "openai";

  // fall back to provider
  if (p.includes("anthropic")) return "anthropic";
  if (p.includes("openai")) return "openai";

  return null;
}

function resolveOppositeModel(
  ctx: ExtensionContext,
  config: { model: string; oppositeModels: { anthropic: string; openai: string } },
): string | null {
  // explicit override
  if (config.model) return config.model;

  const family = detectModelFamily(ctx.model?.provider, ctx.model?.id);
  if (!family) return null;

  return family === "anthropic" ? config.oppositeModels.openai : config.oppositeModels.anthropic;
}

function getSpawnErrorText(result: PiSpawnResult): string {
  return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "";
}

function shouldRetryCounsel(result: PiSpawnResult): boolean {
  return MISSING_INPUT_ERROR_RE.test(getSpawnErrorText(result));
}

// --- tool ---

interface CounselParams {
  prompt: string;
  context?: string;
  files?: string[];
  principles?: boolean;
}

function inlineFileForPrompt(filePath: string, cwd: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  try {
    const content = fs.readFileSync(resolved, "utf-8");
    return `\nFile: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
  } catch {
    return `\nFile: ${filePath} (could not read)`;
  }
}

function buildCounselTask(params: CounselParams, cwd: string): string {
  const parts: string[] = [params.prompt];
  if (params.context) parts.push(`\nContext: ${params.context}`);
  if (params.files && params.files.length > 0) {
    for (const filePath of params.files) {
      parts.push(inlineFileForPrompt(filePath, cwd));
    }
  }
  return parts.join("\n");
}

function buildCounselSystemPrompt(
  config: CounselConfig,
  includePrinciples: boolean | undefined,
  readPrinciplesFn: typeof readPrinciples,
): string {
  const basePrompt = config.systemPrompt || COUNSEL_SYSTEM_PROMPT;
  if (includePrinciples === false) return basePrompt;

  const principles = readPrinciplesFn(config.principlesDir ?? CONFIG_DEFAULTS.principlesDir);
  return principles ? `${basePrompt}\n\n${principles}` : basePrompt;
}

export interface CounselConfig {
  systemPrompt?: string;
  model?: string;
  oppositeModels?: { anthropic: string; openai: string };
  extensionTools?: string[];
  builtinTools?: string[];
  principlesDir?: string;
}

const COUNSEL_SYSTEM_PROMPT = `You are Counsel — an adversarial peer reviewer from the opposite side.

Your job is to challenge assumptions, find bugs, verify correctness, and ensure quality.

Guidelines:
- Ground every claim in specific file paths and line numbers
- Be direct and specific — no vague praise
- If something is wrong, say what and why
- If something is right, say so briefly and move on
- Focus on: correctness, soundness, edge cases, missed requirements, architectural concerns
- Provide a clear verdict at the top: Approve, Revise, or Reject
- List concrete findings with severity (critical, high, medium, low)`;

export function createCounselTool(
  config: CounselConfig = {},
  runtime: ManagedRuntime.ManagedRuntime<PiSpawnService, never>,
  readPrinciplesFn: typeof readPrinciples = readPrinciples,
): ToolDefinition {
  return {
    name: "counsel",
    label: "Counsel",
    description:
      "Counsel — an adversarial peer reviewer powered by the opposite vendor's model.\n\n" +
      "Spawns a sub-agent with the opposite AI model (anthropic ↔ openai) to get " +
      "a second opinion that challenges your assumptions.\n\n" +
      "WHEN TO USE COUNSEL:\n" +
      "- Before committing significant changes\n" +
      "- After completing a plan, to validate approach\n" +
      "- When reviewing architecture decisions\n" +
      "- To catch bugs or edge cases you might miss\n" +
      "- When the user asks for /counsel or a second opinion\n\n" +
      "WHEN NOT TO USE COUNSEL:\n" +
      "- For simple questions you can answer directly\n" +
      "- For codebase exploration (use librarian or finder)\n" +
      "- For trivial changes that don't need review\n\n" +
      "USAGE:\n" +
      "- Be specific about what you want reviewed\n" +
      "- Provide relevant context and file references\n" +
      "- The review is written to ~/.pi/counsel/ for durability\n" +
      "- When getting a review from counsel, show it to the user in full, do not summarize it.",

    parameters: Type.Object({
      prompt: Type.String({
        description: "The review request. Be specific about what you want challenged or reviewed.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Background context about the current situation.",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "File paths to inline in the review request.",
        }),
      ),
      principles: Type.Optional(
        Type.Boolean({
          description: "Inject engineering principles into the review context. Default: true.",
          default: true,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as CounselParams;

      const oppositeModel = resolveOppositeModel(ctx, {
        model: config.model ?? "",
        oppositeModels: config.oppositeModels ?? CONFIG_DEFAULTS.oppositeModels,
      });

      if (!oppositeModel) {
        return subAgentResult(
          "Could not determine the opposite model. Current model provider/id is ambiguous. " +
            "Configure @cvr/pi-counsel.model or oppositeModels in settings.",
          { agent: "counsel", task: p.prompt, exitCode: 1, messages: [], usage: zeroUsage() },
          true,
        );
      }

      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const fullTask = buildCounselTask(p, ctx.cwd);
      const systemPrompt = buildCounselSystemPrompt(config, p.principles, readPrinciplesFn);

      const singleResult: SingleResult = {
        agent: "counsel",
        task: p.prompt,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const counselSessionPath = generateCounselSessionPath();

      return runtime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PiSpawnService;
          const spawnConfig: PiSpawnConfig = {
            cwd: ctx.cwd,
            task: fullTask,
            model: oppositeModel,
            builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
            extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
            systemPromptBody: systemPrompt,
            signal,
            sessionId,
            sessionPath: counselSessionPath,
            promptViaStdin: true,
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
                      text: getFinalOutput(partial.messages) || "(reviewing...)",
                    },
                  ],
                  details: singleResult,
                } as any);
              }
            },
          };

          let result = yield* svc.spawn(spawnConfig);
          let usedRetry = false;
          if (shouldRetryCounsel(result)) {
            usedRetry = true;
            result = yield* svc.spawn({
              ...spawnConfig,
              sessionPath: undefined,
            });
          }

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
            return subAgentResult(getSpawnErrorText(result) || output, singleResult, true);
          }

          const sessionRef = usedRetry
            ? "Session: ephemeral retry (session file unavailable)"
            : `Session: ${counselSessionPath}`;
          return subAgentResult(`${sessionRef}\n\n${output}`, singleResult);
        }),
      );
    },

    renderCall(args: any, theme: any) {
      const preview = args.prompt
        ? args.prompt.length > 80
          ? `${args.prompt.slice(0, 80)}...`
          : args.prompt
        : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("counsel ")) + theme.fg("dim", preview),
        0,
        0,
      );
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const details = result.details as SingleResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      const container = new Container();
      renderAgentTree(details, container, expanded, theme, {
        label: "counsel",
        header: "statusOnly",
      });
      return container;
    },
  };
}

export function createCounselExtension(
  deps: CounselExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function counselExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-counsel",
      CONFIG_DEFAULTS,
      { schema: COUNSEL_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const runtime = ManagedRuntime.make(PiSpawnService.layer);

    pi.registerTool(
      deps.withPromptPatch(
        createCounselTool(
          {
            systemPrompt: cfg.promptString || undefined,
            model: cfg.model || undefined,
            oppositeModels: cfg.oppositeModels,
            extensionTools: cfg.extensionTools,
            builtinTools: cfg.builtinTools,
            principlesDir: cfg.principlesDir,
          },
          runtime,
          deps.readPrinciples,
        ),
      ),
    );

    pi.on("session_shutdown", async () => {
      await runtime.dispose();
    });
  };
}

const counselExtension: (pi: ExtensionAPI) => void = createCounselExtension();

export default counselExtension;

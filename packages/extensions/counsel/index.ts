/**
 * counsel — opposite-model peer review tool.
 *
 * detects the current model's vendor (anthropic vs openai) and spawns
 * a pi sub-agent with the opposite vendor's model for adversarial review.
 * persists the full exchange to a pi session file for later inspection.
 * returns only the session path to keep parent-agent context lean.
 *
 * important: counsel is intentionally single-shot JSON mode, not RPC stdin.
 * it's a one-prompt reviewer, and returning the session path avoids hauling
 * the full review back into the parent context.
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
import { PiSpawnService, zeroUsage, type PiSpawnResult } from "@cvr/pi-spawn";
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
    // use when the current model family is anthropic
    anthropic: "openai-codex/gpt-5.4",
    // use when the current model family is openai
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

const ANTHROPIC_TEXT_HINTS = [/\bclaude\b/, /\banthropic\b/, /\bsonnet\b/, /\bhaiku\b/, /\bopus\b/];
const OPENAI_TEXT_HINTS = [
  /\bopenai\b/,
  /\bgpt\b/,
  /\bchatgpt\b/,
  /\bcodex\b/,
  /\bcomputer-use-preview\b/,
  /\bo[1-9](?:\b|[-/])/,
];
const OPENAI_API_HINTS = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

/**
 * detect model family from model metadata.
 * prefers model id/name, then falls back to provider/api/baseUrl.
 * handles gateways and custom providers that proxy OpenAI or Anthropic models.
 */
function detectModelFamilyFromText(text: string | undefined): ModelFamily | null {
  const value = (text ?? "").toLowerCase();
  if (!value) return null;

  if (ANTHROPIC_TEXT_HINTS.some((pattern) => pattern.test(value))) return "anthropic";
  if (OPENAI_TEXT_HINTS.some((pattern) => pattern.test(value))) return "openai";

  return null;
}

function detectModelFamilyFromApi(api: string | undefined): ModelFamily | null {
  const value = (api ?? "").toLowerCase();
  if (!value) return null;

  if (value === "anthropic-messages") return "anthropic";
  if (OPENAI_API_HINTS.has(value)) return "openai";

  return detectModelFamilyFromText(value);
}

function formatParentModelMetadata(model: ExtensionContext["model"]): string {
  if (!model) return "(no active parent model)";

  const parts = [
    ["provider", model.provider],
    ["id", model.id],
    ["api", model.api],
    ["name", model.name],
    ["baseUrl", model.baseUrl],
  ].flatMap(([key, value]) => (value ? [`${key}=${JSON.stringify(value)}`] : []));

  return parts.join(", ") || "(no active parent model)";
}

export function detectModelFamily(
  provider: string | undefined,
  modelId: string | undefined,
  api?: string | undefined,
  modelName?: string | undefined,
  baseUrl?: string | undefined,
): ModelFamily | null {
  for (const hint of [modelId, modelName]) {
    const family = detectModelFamilyFromText(hint);
    if (family) return family;
  }

  const providerFamily = detectModelFamilyFromText(provider);
  if (providerFamily) return providerFamily;

  const apiFamily = detectModelFamilyFromApi(api);
  if (apiFamily) return apiFamily;

  const url = (baseUrl ?? "").toLowerCase();
  if (url.includes("anthropic.com")) return "anthropic";
  if (url.includes("openai.com") || url.includes(".openai.azure.com")) return "openai";

  return null;
}

function resolveOppositeModel(
  ctx: ExtensionContext,
  config: { model: string; oppositeModels: { anthropic: string; openai: string } },
): string | null {
  // explicit override
  if (config.model) return config.model;

  const family = detectModelFamily(
    ctx.model?.provider,
    ctx.model?.id,
    ctx.model?.api,
    ctx.model?.name,
    ctx.model?.baseUrl,
  );
  if (!family) return null;

  return family === "anthropic" ? config.oppositeModels.anthropic : config.oppositeModels.openai;
}

function getSpawnErrorText(result: PiSpawnResult): string {
  return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "";
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
      "- The full review is persisted to a session file for durability\n" +
      "- This tool returns the session path so the caller can inspect the full transcript.",

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
          "Could not determine the opposite model. Current model metadata was ambiguous: " +
            `${formatParentModelMetadata(ctx.model)}. ` +
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
          // keep counsel single-shot + token-efficient: persist the full transcript,
          // return only the session path, let the caller read the session if needed.
          const result = yield* svc.spawn({
            cwd: ctx.cwd,
            task: fullTask,
            model: oppositeModel,
            builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
            extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
            systemPromptBody: systemPrompt,
            signal,
            sessionId,
            sessionPath: counselSessionPath,
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
                      text: `Session: ${counselSessionPath}`,
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
            return subAgentResult(getSpawnErrorText(result) || output, singleResult, true);
          }

          return subAgentResult(`Session: ${counselSessionPath}`, singleResult);
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
        theme.fg("toolTitle", theme.bold("counsel ")) + theme.fg("muted", preview),
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

/**
 * counsel — opposite-model peer review tool.
 *
 * detects the current model's vendor (anthropic vs openai) and spawns
 * a pi sub-agent with the opposite vendor's model for adversarial review.
 * persists the full exchange to a pi session file for later inspection.
 * returns only the session path to keep parent-agent context lean.
 *
 * counsel stays single-shot and returns only the session path, avoiding
 * hauling the full review back into the parent context.
 *
 * transport details are delegated to @cvr/pi-spawn.
 *
 * follows the dedicated sub-agent pattern: PiSpawnService + ManagedRuntime + getEnabledExtensionConfig.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@mariozechner/pi-coding-agent";
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

function classifyCounselFailure(text: string): "input" | "transient" | "config" | "other" {
  if (COUNSEL_INPUT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "input";
  if (COUNSEL_TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "transient";
  if (COUNSEL_CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "config";
  return "other";
}

function shouldRetryCounsel(result: PiSpawnResult, mode: CounselAttempt["mode"]): boolean {
  if (mode !== "full") return false;
  if (result.stopReason === "aborted") return false;
  const failureText = getSpawnErrorText(result);
  const classification = classifyCounselFailure(failureText);
  return classification === "input" || classification === "transient";
}

function summarizeCounselFailure(result: PiSpawnResult): string {
  const text = getSpawnErrorText(result).trim() || "(no error details)";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? text;
  return firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
}

function buildCounselFailureResult(
  singleResult: SingleResult,
  attempts: readonly CounselAttemptResult[],
): ToolExecutionResult {
  const latestAttempt = attempts.at(-1);
  const latestResult = latestAttempt?.result;
  const latestText = latestResult ? getSpawnErrorText(latestResult) : "";
  const classification = classifyCounselFailure(latestText);
  const nextStep =
    classification === "config"
      ? "Fix the counsel model or provider configuration, then call counsel again."
      : classification === "input"
        ? "Do not skip counsel. Retry the counsel tool with a narrower prompt/context and fewer files. Prefer file paths the reviewer can read directly over large pasted content."
        : classification === "transient"
          ? "Do not skip counsel. Retry the counsel tool once more. If it still fails, narrow the request and try again."
          : "Do not skip counsel. Retry the counsel tool with a narrower prompt or fewer files, then inspect the failed session if it still breaks.";

  const attemptLines = attempts.map(
    (attempt, index) =>
      `- attempt ${index + 1} (${attempt.mode}) — ${summarizeCounselFailure(attempt.result)}\n  session: ${attempt.sessionPath}`,
  );

  return subAgentResult(
    [
      `Counsel failed after ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}.`,
      ...attemptLines,
      "",
      `Next step: ${nextStep}`,
    ].join("\n"),
    singleResult,
    true,
  );
}

// --- tool ---

interface CounselParams {
  prompt: string;
  context?: string;
  files?: string[];
  principles?: boolean;
}

interface NormalizedCounselParams {
  prompt: string;
  context?: string;
  files: string[];
  principles?: boolean;
}

interface CounselAttempt {
  sessionPath: string;
  task: string;
  mode: "full" | "fallback";
}

interface CounselAttemptResult extends CounselAttempt {
  result: PiSpawnResult;
}

const MAX_FILES = 12;
const MAX_INLINE_FILE_COUNT = 3;
const MAX_INLINE_FILE_BYTES = 12_000;
const MAX_CONTEXT_LENGTH = 8_000;
const MAX_PROMPT_LENGTH = 8_000;

const COUNSEL_INPUT_ERROR_PATTERNS = [
  /malformed/i,
  /invalid input/i,
  /invalid request/i,
  /request body/i,
  /json/i,
  /parse/i,
  /messages?\[/i,
  /content\[/i,
  /expected .*string/i,
  /context length/i,
  /context window/i,
  /too large/i,
  /too many tokens/i,
  /maximum context/i,
  /prompt is too long/i,
];

const COUNSEL_TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /rate limit/i,
  /temporar/i,
  /try again/i,
  /overloaded/i,
  /unavailable/i,
  /gateway/i,
  /connection reset/i,
  /econnreset/i,
  /socket hang up/i,
  /network/i,
];

const COUNSEL_CONFIG_ERROR_PATTERNS = [
  /api key/i,
  /unauthorized/i,
  /forbidden/i,
  /authentication/i,
  /auth/i,
  /permission/i,
  /model .* not found/i,
  /unknown model/i,
];

function trimToLength(text: string | undefined, maxLength: number): string | undefined {
  const value = text?.trim();
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trimEnd()}\n\n[truncated for counsel reliability]`;
}

function normalizeCounselParams(params: CounselParams): NormalizedCounselParams {
  const prompt = trimToLength(params.prompt, MAX_PROMPT_LENGTH) ?? "";
  const files = [...new Set((params.files ?? []).map((file) => file.trim()).filter(Boolean))].slice(
    0,
    MAX_FILES,
  );
  return {
    prompt,
    context: trimToLength(params.context, MAX_CONTEXT_LENGTH),
    files,
    principles: params.principles,
  };
}

function resolveCounselFilePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function buildInlineFileSection(filePath: string, cwd: string): string | null {
  const resolved = resolveCounselFilePath(filePath, cwd);
  try {
    const content = fs.readFileSync(resolved, "utf-8");
    if (content.includes("\u0000")) {
      return `### File: ${filePath}\n(binary or unsupported text — read directly if needed)`;
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_INLINE_FILE_BYTES) {
      return `### File: ${filePath}\n(not inlined — file is too large; read it directly if needed)`;
    }
    return `### File: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
  } catch {
    return `### File: ${filePath}\n(could not read — verify the path before retrying counsel)`;
  }
}

function buildCounselTask(
  params: NormalizedCounselParams,
  cwd: string,
  mode: CounselAttempt["mode"],
): string {
  const parts = [`## Review Request\n${params.prompt}`];

  if (params.context) {
    parts.push(`## Context\n${params.context}`);
  }

  if (params.files.length > 0) {
    parts.push(`## Files to Inspect\n${params.files.map((filePath) => `- ${filePath}`).join("\n")}`);
  }

  if (mode === "full" && params.files.length > 0) {
    const inlineSections = params.files
      .slice(0, MAX_INLINE_FILE_COUNT)
      .map((filePath) => buildInlineFileSection(filePath, cwd))
      .filter((section): section is string => Boolean(section));
    if (inlineSections.length > 0) {
      parts.push(
        "## Inline File Context\nSmall files are inlined below. For anything omitted or too large, read the files directly.\n\n" +
          inlineSections.join("\n\n"),
      );
    }
  }

  if (mode === "fallback") {
    parts.push(
      "## Reliability Mode\nThe previous counsel attempt failed. Read the listed files directly instead of relying on inlined file contents. Keep the review concise and grounded in explicit file references.",
    );
  }

  return parts.join("\n\n");
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
          description:
            "File paths to prioritize in the review request. Small files may be inlined; larger files are listed for the reviewer to read directly.",
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
      const p = normalizeCounselParams(params as CounselParams);

      const singleResult: SingleResult = {
        agent: "counsel",
        task: p.prompt || "(empty counsel prompt)",
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      if (!p.prompt) {
        return subAgentResult(
          "Counsel prompt must be non-empty. Do not skip counsel — call the counsel tool again with a specific review request.",
          singleResult,
          true,
        );
      }

      const oppositeModel = resolveOppositeModel(ctx, {
        model: config.model ?? "",
        oppositeModels: config.oppositeModels ?? CONFIG_DEFAULTS.oppositeModels,
      });

      if (!oppositeModel) {
        return subAgentResult(
          "Could not determine the opposite model. Current model metadata was ambiguous: " +
            `${formatParentModelMetadata(ctx.model)}. ` +
            "Configure @cvr/pi-counsel.model or oppositeModels in settings.",
          { ...singleResult, task: p.prompt, exitCode: 1 },
          true,
        );
      }

      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const systemPrompt = buildCounselSystemPrompt(config, p.principles, readPrinciplesFn);
      const attempts: CounselAttempt[] = [
        {
          mode: "full",
          task: buildCounselTask(p, ctx.cwd, "full"),
          sessionPath: generateCounselSessionPath(),
        },
        {
          mode: "fallback",
          task: buildCounselTask(p, ctx.cwd, "fallback"),
          sessionPath: generateCounselSessionPath(),
        },
      ];

      return runtime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PiSpawnService;
          const attemptResults: CounselAttemptResult[] = [];

          for (const attempt of attempts) {
            const result = yield* svc.spawn({
              cwd: ctx.cwd,
              task: attempt.task,
              model: oppositeModel,
              builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
              extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
              systemPromptBody: systemPrompt,
              signal,
              sessionId,
              sessionPath: attempt.sessionPath,
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
                        text:
                          attempt.mode === "full"
                            ? `Session: ${attempt.sessionPath}`
                            : `Retrying counsel with reduced prompt. Session: ${attempt.sessionPath}`,
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
            attemptResults.push({ ...attempt, result });

            const isError =
              result.exitCode !== 0 ||
              result.stopReason === "error" ||
              result.stopReason === "aborted";
            if (!isError) {
              return subAgentResult(`Session: ${attempt.sessionPath}`, singleResult);
            }

            if (!shouldRetryCounsel(result, attempt.mode)) {
              return buildCounselFailureResult(singleResult, attemptResults);
            }
          }

          return buildCounselFailureResult(singleResult, attemptResults);
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

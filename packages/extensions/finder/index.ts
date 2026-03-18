/**
 * finder tool — fast parallel code search via a compact sub-agent.
 *
 * replaces the generic subagent(agent: "finder", task: ...) pattern
 * with a dedicated tool. the model calls
 * finder(query: "...") instead of routing through the dispatcher.
 *
 * spawns `pi --mode json` with a compact model, constrained to
 * search-oriented tools (read, grep, find, ls, bash). bash is for
 * read-only shell search like rg/eza/git grep, not mutation. the
 * finder agent maximizes parallelism (8+ tool calls per turn) and completes
 * within ~3 turns.
 *
 * system prompt loaded from sops-decrypted prompts at init time.
 */

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { PiSpawnService, resolvePrompt, zeroUsage } from "@cvr/pi-spawn";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@cvr/pi-sub-agent-render";
import { Effect, ManagedRuntime } from "effect";

type FinderExtConfig = {
  model: string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
};

type FinderExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

export const CONFIG_DEFAULTS: FinderExtConfig = {
  model: "openai-codex/gpt-5.4-mini",
  extensionTools: ["read", "grep", "find", "ls", "bash"],
  builtinTools: ["read", "grep", "find", "ls", "bash"],
  promptFile: "",
  promptString: "",
};

export const DEFAULT_DEPS: FinderExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
  withPromptPatch,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFinderConfig(value: Record<string, unknown>): value is FinderExtConfig {
  return (
    isNonEmptyString(value.model) &&
    isStringArray(value.extensionTools) &&
    isStringArray(value.builtinTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

export const FINDER_CONFIG_SCHEMA: ExtensionConfigSchema<FinderExtConfig> = {
  validate: isFinderConfig,
};

export interface FinderConfig {
  systemPrompt?: string;
  model?: string;
  extensionTools?: string[];
  builtinTools?: string[];
}

interface FinderParams {
  query: string;
}

function normalizeFinderQuery(query: string): string {
  return query.trim();
}

export function createFinderTool(
  config: FinderConfig = {},
  runtime: ManagedRuntime.ManagedRuntime<PiSpawnService, never>,
): ToolDefinition {
  return {
    name: "finder",
    label: "Finder",
    description:
      "Intelligently search your codebase: Use it for complex, multi-step search tasks " +
      "where you need to find code based on functionality or concepts rather than exact matches. " +
      "Anytime you want to chain multiple grep calls you should use this tool.\n\n" +
      "WHEN TO USE THIS TOOL:\n" +
      "- You must locate code by behavior or concept\n" +
      "- You need to run multiple greps in sequence\n" +
      "- You must correlate or look for connection between several areas of the codebase\n" +
      "- You must filter broad terms by context\n" +
      '- You need answers to questions like "Where do we validate JWT headers?"\n\n' +
      "WHEN NOT TO USE THIS TOOL:\n" +
      "- When you know the exact file path - use Read directly\n" +
      "- When looking for specific symbols or exact strings - use Find or Grep\n" +
      "- When you need to create or modify files\n" +
      "- When you need general shell workflows instead of search-oriented commands\n\n" +
      "USAGE GUIDELINES:\n" +
      "1. Always spawn multiple search agents in parallel to maximise speed.\n" +
      "2. Formulate your query as a precise engineering request.\n" +
      "3. Name concrete artifacts, patterns, or APIs to narrow scope.\n" +
      "4. State explicit success criteria so the agent knows when to stop.\n" +
      "5. If you use bash, keep it read-only (rg, git grep, eza, pwd, etc.).\n" +
      "6. Never issue vague or exploratory commands.",

    parameters: Type.Object({
      query: Type.String({
        description:
          "The search query describing what to find. Be specific and include " +
          "technical terms, file types, or expected code patterns.",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as FinderParams;
      const query = normalizeFinderQuery(p.query);

      const singleResult: SingleResult = {
        agent: "finder",
        task: query || p.query,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      if (!query) {
        return subAgentResult("Finder query must be non-empty.", singleResult, true);
      }

      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      return runtime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PiSpawnService;
          const result = yield* svc.spawn({
            cwd: ctx.cwd,
            task: query,
            model: config.model ?? CONFIG_DEFAULTS.model,
            builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
            extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
            systemPromptBody: config.systemPrompt,
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
                      text: getFinalOutput(partial.messages) || "(searching...)",
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
      const preview = args.query
        ? args.query.length > 80
          ? `${args.query.slice(0, 80)}...`
          : args.query
        : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("finder ")) + theme.fg("muted", preview),
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
        label: "finder",
        header: "statusOnly",
      });
      return container;
    },
  };
}

export function createFinderExtension(
  deps: FinderExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function finderExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-finder",
      CONFIG_DEFAULTS,
      { schema: FINDER_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const runtime = ManagedRuntime.make(PiSpawnService.layer);

    pi.registerTool(
      deps.withPromptPatch(
        createFinderTool(
          {
            systemPrompt: deps.resolvePrompt(cfg.promptString, cfg.promptFile),
            model: cfg.model,
            extensionTools: cfg.extensionTools,
            builtinTools: cfg.builtinTools,
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

const finderExtension: (pi: ExtensionAPI) => void = createFinderExtension();

export default finderExtension;

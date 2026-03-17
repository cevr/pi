/**
 * librarian tool — cross-repo codebase understanding via sonnet sub-agent.
 *
 * replaces the generic subagent pattern with a dedicated tool. the model
 * calls librarian(query: "...", repo?: "...", context?: "...")
 * directly.
 *
 * fetches repos locally via `repo fetch` CLI, then spawns a sub-agent
 * with file tools (read, grep, glob, ls) to explore the source code.
 * the `repo` param is required — supports "owner/repo", "npm:pkg",
 * "pypi:pkg", "crates:crate" spec formats.
 *
 * system prompt loaded from sops-decrypted prompts at init time.
 */

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { PiSpawnService, resolvePrompt, zeroUsage } from "@cvr/pi-spawn";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@cvr/pi-sub-agent-render";

type LibrarianExtConfig = {
  model: string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
};

type LibrarianExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

export const CONFIG_DEFAULTS: LibrarianExtConfig = {
  model: "anthropic/claude-sonnet-4-6",
  extensionTools: ["web_search"],
  builtinTools: ["read", "bash", "grep", "find", "ls"],
  promptFile: "",
  promptString: "",
};

/**
 * Fetch a repo locally via the `repo` CLI, returning the cached path.
 * Always fetches (pulls latest if already cached).
 * Spec formats: "owner/repo", "npm:pkg", "pypi:pkg", "crates:crate"
 */
export async function repoFetch(
  spec: string,
  runtime: ManagedRuntime.ManagedRuntime<ProcessRunner | PiSpawnService, never>,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("repo", {
          args: ["fetch", spec],
          timeoutMs: 60_000,
          signal,
        });
      }),
    );
    if (result.exitCode !== 0) return null;
    const repoPath = result.stdout.trim();
    return repoPath || null;
  } catch {
    return null;
  }
}

export const DEFAULT_DEPS: LibrarianExtensionDeps = {
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

function isLibrarianConfig(value: Record<string, unknown>): value is LibrarianExtConfig {
  return (
    isNonEmptyString(value.model) &&
    isStringArray(value.extensionTools) &&
    isStringArray(value.builtinTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

export const LIBRARIAN_CONFIG_SCHEMA: ExtensionConfigSchema<LibrarianExtConfig> = {
  validate: isLibrarianConfig,
};

export interface LibrarianConfig {
  systemPrompt?: string;
  model?: string;
  extensionTools?: string[];
  builtinTools?: string[];
}

interface LibrarianParams {
  query: string;
  repo: string;
  context?: string;
}

export function createLibrarianTool(
  config: LibrarianConfig = {},
  runtime?: ManagedRuntime.ManagedRuntime<ProcessRunner | PiSpawnService, never>,
): ToolDefinition {
  return {
    name: "librarian",
    label: "Librarian",
    description:
      "The Librarian — a specialized codebase understanding agent for exploring " +
      "third-party libraries and external codebases.\n\n" +
      "Fetches repos locally via `repo fetch` and explores source code with " +
      "file tools (read, grep, glob, ls).\n\n" +
      "WHEN TO USE:\n" +
      "- Understanding how a third-party library works\n" +
      "- Exploring API surface, patterns, and internals of external packages\n" +
      "- Finding specific implementations in external codebases\n\n" +
      "WHEN NOT TO USE:\n" +
      "- Local file reading (use Read directly)\n" +
      "- Local codebase searches (use finder)\n\n" +
      "Always provide a `repo` spec. Show the Librarian's answer in full.",

    parameters: Type.Object({
      query: Type.String({
        description:
          "Your question about the codebase. Be specific about what you want to understand.",
      }),
      repo: Type.String({
        description:
          "Repo spec to fetch and explore locally. Formats: 'owner/repo', " +
          "'owner/repo@tag', 'npm:package', 'npm:@scope/pkg@version', " +
          "'pypi:package', 'crates:crate'.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Optional context about what you're trying to achieve or background information.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const p = params as LibrarianParams;

      // Fetch repo locally
      let localRepoPath: string | null = null;
      if (runtime) {
        localRepoPath = await repoFetch(p.repo, runtime, signal);
      }
      if (!localRepoPath) {
        return {
          content: [{ type: "text" as const, text: `Failed to fetch repo: ${p.repo}` }],
          isError: true,
        } as any;
      }

      const parts: string[] = [
        p.query,
        `\nThe source code for ${p.repo} is available locally at: ${localRepoPath}`,
        `Explore it using file tools (read, grep, glob, ls). Start with package.json or README.md to understand the structure, then drill into specific files.`,
      ];
      if (p.context) parts.push(`\nContext: ${p.context}`);
      const fullTask = parts.join("\n");

      const extensionTools = config.extensionTools ?? CONFIG_DEFAULTS.extensionTools;
      const builtinTools = config.builtinTools ?? CONFIG_DEFAULTS.builtinTools;

      const singleResult: SingleResult = {
        agent: "librarian",
        task: p.query,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      return runtime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PiSpawnService;
          const result = yield* svc.spawn({
            cwd: localRepoPath,
            task: fullTask,
            model: config.model ?? CONFIG_DEFAULTS.model,
            builtinTools,
            extensionTools,
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
                      text: getFinalOutput(partial.messages) || "(exploring...)",
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
        theme.fg("toolTitle", theme.bold("librarian ")) + theme.fg("dim", preview),
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
        label: "librarian",
        header: "statusOnly",
      });
      return container;
    },
  };
}

export function createLibrarianExtension(
  deps: LibrarianExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function librarianExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-librarian",
      CONFIG_DEFAULTS,
      { schema: LIBRARIAN_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const runtime = ManagedRuntime.make(Layer.mergeAll(ProcessRunner.layer, PiSpawnService.layer));

    pi.registerTool(
      deps.withPromptPatch(
        createLibrarianTool(
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

const librarianExtension: (pi: ExtensionAPI) => void = createLibrarianExtension();

export default librarianExtension;

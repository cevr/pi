/**
 * librarian tool — cross-repo codebase understanding via gemini flash sub-agent.
 *
 * replaces the generic subagent pattern with a dedicated tool. the model
 * calls librarian(query: "...", context?: "...")
 * directly.
 *
 * spawns `pi --mode json` with gemini flash, constrained to the 7
 * github tools (read_github, search_github, list_directory_github,
 * list_repositories, glob_github, commit_search, diff). the librarian
 * explores repos thoroughly before providing comprehensive answers.
 *
 * system prompt loaded from sops-decrypted prompts at init time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@cvr/pi-config";
import { piSpawn, resolvePrompt, zeroUsage } from "@cvr/pi-spawn";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { Effect, ManagedRuntime } from "effect";
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
  model: "openrouter/google/gemini-3-flash-preview",
  extensionTools: [
    "read_github",
    "search_github",
    "list_directory_github",
    "list_repositories",
    "glob_github",
    "commit_search",
    "diff",
    "web_search",
  ],
  builtinTools: [],
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
  runtime: ManagedRuntime.ManagedRuntime<ProcessRunner, never>,
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
  repo?: string;
  context?: string;
}

export function createLibrarianTool(
  config: LibrarianConfig = {},
  runtime?: ManagedRuntime.ManagedRuntime<ProcessRunner, never>,
): ToolDefinition {
  return {
    name: "librarian",
    label: "Librarian",
    description:
      "The Librarian — a specialized codebase understanding agent for exploring " +
      "third-party libraries and complex codebases.\n\n" +
      "When given a `repo` spec (e.g., 'effect-ts/effect', 'npm:@effect/cli'), " +
      "the Librarian auto-fetches the source code locally and explores it with " +
      "file tools (read, grep, glob, ls). Falls back to GitHub API tools when " +
      "no repo spec is given.\n\n" +
      "WHEN TO USE THE LIBRARIAN:\n" +
      "- Understanding how a third-party library works\n" +
      "- Exploring API surface, patterns, and internals of external packages\n" +
      "- Analyzing architectural patterns across projects\n" +
      "- Finding specific implementations in external codebases\n" +
      "- Understanding code evolution and commit history\n\n" +
      "WHEN NOT TO USE THE LIBRARIAN:\n" +
      "- Simple local file reading (use Read directly)\n" +
      "- Local codebase searches (use finder)\n" +
      "- Code modifications (use other tools)\n\n" +
      "USAGE GUIDELINES:\n" +
      "- Provide a `repo` spec when exploring a specific library\n" +
      "- Be specific about what you want to understand\n" +
      "- The Librarian explores thoroughly before providing comprehensive answers\n" +
      "- When getting an answer from the Librarian, show it to the user in full, do not summarize it.",

    parameters: Type.Object({
      query: Type.String({
        description:
          "Your question about the codebase. Be specific about what you want to understand.",
      }),
      repo: Type.Optional(
        Type.String({
          description:
            "Repo spec to fetch and explore locally. Formats: 'owner/repo', " +
            "'owner/repo@tag', 'npm:package', 'npm:@scope/pkg@version', " +
            "'pypi:package', 'crates:crate'. When provided, the librarian " +
            "fetches the source locally and explores with file tools.",
        }),
      ),
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

      // If a repo spec is given, fetch it locally
      let localRepoPath: string | null = null;
      if (p.repo && runtime) {
        localRepoPath = await repoFetch(p.repo, runtime, signal);
      }

      const parts: string[] = [p.query];
      if (p.context) parts.push(`\nContext: ${p.context}`);
      if (localRepoPath) {
        parts.push(
          `\nThe source code for ${p.repo} is available locally at: ${localRepoPath}`,
          `Explore it using file tools (read, grep, glob, ls). Start with package.json or README.md to understand the structure, then drill into specific files.`,
        );
      }
      const fullTask = parts.join("\n");

      // When exploring locally, use file tools; otherwise use GitHub tools
      const useLocalTools = localRepoPath != null;
      const extensionTools = useLocalTools
        ? []
        : (config.extensionTools ?? CONFIG_DEFAULTS.extensionTools);
      const builtinTools = useLocalTools
        ? ["read", "bash", "grep", "find", "ls"]
        : (config.builtinTools ?? CONFIG_DEFAULTS.builtinTools);

      const singleResult: SingleResult = {
        agent: "librarian",
        task: p.query,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const result = await piSpawn({
        cwd: localRepoPath ?? ctx.cwd,
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
        result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
      const output = getFinalOutput(result.messages) || "(no output)";

      if (isError) {
        return subAgentResult(result.errorMessage || result.stderr || output, singleResult, true);
      }

      return subAgentResult(output, singleResult);
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

    const runtime = ManagedRuntime.make(ProcessRunner.layer);

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

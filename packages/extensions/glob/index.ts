/**
 * glob tool — replaces pi's built-in find with enhanced file finding.
 *
 * differences from pi's built-in:
 * - uses rg --files (not fd — one less dependency)
 * - sorted by mtime (most recent first, via rg --sortr modified)
 * - pagination via offset + limit
 * - hidden files included by default (--hidden)
 * - .git/.jj excluded
 *
 * shadows pi's built-in `find` tool via same-name registration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { Type } from "@sinclair/typebox";
import { formatHeadTail } from "@cvr/pi-output-buffer";
import { boxRendererWindowed, textSection, type Excerpt } from "@cvr/pi-box-format";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@cvr/pi-config";

const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

type GlobExtConfig = {
  defaultLimit: number;
};

type GlobExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

export const CONFIG_DEFAULTS: GlobExtConfig = {
  defaultLimit: 500,
};

export const DEFAULT_DEPS: GlobExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isGlobConfig(value: Record<string, unknown>): value is GlobExtConfig {
  return (
    typeof value.defaultLimit === "number" &&
    Number.isInteger(value.defaultLimit) &&
    value.defaultLimit >= 1
  );
}

export const GLOB_CONFIG_SCHEMA: ExtensionConfigSchema<GlobExtConfig> = {
  validate: isGlobConfig,
};

interface GlobParams {
  filePattern: string;
  limit?: number;
  offset?: number;
}

export function createGlobTool(config: GlobExtConfig = CONFIG_DEFAULTS): ToolDefinition {
  return {
    name: "find",
    label: "Find Files",
    description:
      "Fast file pattern matching tool that works with any codebase size.\n\n" +
      "Returns matching file paths sorted by most recent modification time first.\n\n" +
      "## Pattern syntax\n" +
      "- `**/*.js` — All JavaScript files in any directory\n" +
      "- `src/**/*.ts` — TypeScript files under src/\n" +
      "- `*.json` — JSON files in the current directory\n" +
      '- `**/*test*` — Files with "test" in their name\n' +
      "- `**/*.{js,ts}` — JavaScript and TypeScript files\n",

    parameters: Type.Object({
      filePattern: Type.String({
        description: 'Glob pattern like "**/*.js" or "src/**/*.ts" to match files.',
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: "Number of results to skip (for pagination).",
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const pattern = args.filePattern || "...";
      return new Text(theme.fg("toolTitle", theme.bold("Find ")) + theme.fg("dim", pattern), 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any) {
      const content = result.content?.[0];
      if (!content || content.type !== "text") return new Text("(no output)", 0, 0);
      return boxRendererWindowed(
        () => [textSection(undefined, content.text)],
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = params as GlobParams;
      const searchPath = ctx.cwd;
      const limit = p.limit ?? config.defaultLimit;
      const offset = p.offset ?? 0;

      return new Promise((resolve) => {
        const args = [
          "--files",
          "--hidden",
          "--color=never",
          "--sortr",
          "modified",
          "--glob",
          "!.git",
          "--glob",
          "!.jj",
          "--glob",
          p.filePattern,
          searchPath,
        ];

        const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout! });

        let stderr = "";
        let aborted = false;
        const allPaths: string[] = [];

        const onAbort = () => {
          aborted = true;
          if (!child.killed) child.kill();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const rel = path.relative(searchPath, trimmed).replace(/\\/g, "/");
          if (rel && !rel.startsWith("..")) {
            allPaths.push(rel);
          }
        });

        child.on("error", (err) => {
          rl.close();
          signal?.removeEventListener("abort", onAbort);
          resolve({
            content: [{ type: "text" as const, text: `find error: ${err.message}` }],
            isError: true,
          } as any);
        });

        child.on("close", (code) => {
          rl.close();
          signal?.removeEventListener("abort", onAbort);

          if (aborted) {
            resolve({
              content: [{ type: "text" as const, text: "search aborted" }],
              isError: true,
            } as any);
            return;
          }

          if (code !== 0 && code !== 1 && allPaths.length === 0) {
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: stderr.trim() || `rg exited with code ${code}`,
                },
              ],
              isError: true,
            } as any);
            return;
          }

          if (allPaths.length === 0) {
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: "no files found matching pattern",
                },
              ],
            } as any);
            return;
          }

          const total = allPaths.length;

          // if paginating (offset > 0), use traditional pagination
          // otherwise use head+tail for first page
          let output: string;
          if (offset > 0) {
            const paginated = allPaths.slice(offset, offset + limit);
            output = paginated.join("\n");
            output += `\n\n(showing ${offset + 1}-${offset + paginated.length} of ${total} results)`;
          } else if (total > limit) {
            output = formatHeadTail(
              allPaths,
              limit,
              (n) => `... [${n} more results, use a more specific pattern to narrow] ...`,
            );
            output += `\n\n(${total} total results)`;
          } else {
            output = allPaths.join("\n");
          }

          resolve({
            content: [{ type: "text" as const, text: output }],
            details: { header: p.filePattern },
          } as any);
        });
      });
    },
  };
}

export function createGlobExtension(
  deps: GlobExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function globExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-glob",
      CONFIG_DEFAULTS,
      { schema: GLOB_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(deps.withPromptPatch(createGlobTool(cfg)));
  };
}

const globExtension: (pi: ExtensionAPI) => void = createGlobExtension();

export default globExtension;

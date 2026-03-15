/**
 * system-prompt — injects interpolated prompt.amp.system.md into the agent's system prompt.
 *
 * pi's built-in system prompt only provides date + cwd. this extension appends
 * the full amp system prompt with runtime-interpolated template vars: workspace root,
 * OS info, git remote, session ID, and directory listing.
 *
 * uses before_agent_start return value { systemPrompt } to modify the
 * system prompt per-turn. handlers chain — each receives the previous handler's
 * systemPrompt via event.systemPrompt.
 *
 * identity/harness decoupling: {identity} and {harness} are interpolated with
 * configurable values. {harness_docs_section} is populated by reading the
 * appropriate harness docs file (prompt.harness-docs.<harness>.md).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { interpolatePromptVars } from "@cvr/pi-interpolate";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@cvr/pi-config";
import { resolvePrompt } from "@cvr/pi-spawn";

type SystemPromptExtConfig = {
  identity: string;
  harness: string;
  promptFile: string;
  promptString: string;
  harnessDocsPromptFile: string;
  harnessDocsPromptString: string;
};

type SystemPromptExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
};

export const CONFIG_DEFAULTS: SystemPromptExtConfig = {
  identity: "Amp",
  harness: "pi",
  promptFile: "prompt.amp.system.md",
  promptString: "",
  harnessDocsPromptFile: "",
  harnessDocsPromptString: "",
};

export const DEFAULT_DEPS: SystemPromptExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSystemPromptConfig(
  value: Record<string, unknown>,
): value is SystemPromptExtConfig {
  return (
    isNonEmptyString(value.identity) &&
    isNonEmptyString(value.harness) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string" &&
    typeof value.harnessDocsPromptFile === "string" &&
    typeof value.harnessDocsPromptString === "string"
  );
}

export const SYSTEM_PROMPT_CONFIG_SCHEMA: ExtensionConfigSchema<SystemPromptExtConfig> =
  {
    validate: isSystemPromptConfig,
  };

export function createSystemPromptExtension(
  deps: SystemPromptExtensionDeps = DEFAULT_DEPS,
) {
  return function systemPromptExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-system-prompt",
      CONFIG_DEFAULTS,
      { schema: SYSTEM_PROMPT_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const body = deps.resolvePrompt(cfg.promptString, cfg.promptFile);
    if (!body) return;

    const harnessDocsFile =
      cfg.harnessDocsPromptFile || `prompt.harness-docs.${cfg.harness}.md`;
    const harnessDocs = deps.resolvePrompt(
      cfg.harnessDocsPromptString,
      harnessDocsFile,
    );

    pi.on("before_agent_start", async (event, ctx) => {
      const interpolated = interpolatePromptVars(body, ctx.cwd, {
        sessionId: ctx.sessionManager.getSessionId(),
        identity: cfg.identity,
        harness: cfg.harness,
        harnessDocsSection: harnessDocs,
      });

      if (!interpolated.trim()) return;

      return {
        systemPrompt: event.systemPrompt + "\n\n" + interpolated,
      };
    });
  };
}

const systemPromptExtension: (pi: ExtensionAPI) => void =
  createSystemPromptExtension();

export default systemPromptExtension;

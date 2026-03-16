/**
 * PR Reviewer Config Extension — per-project PR defaults.
 *
 * Reads reviewer list, auto-merge, and label config from settings.
 * Injects into system prompt so /pr and agent-driven PR creation
 * picks up project-specific conventions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getEnabledExtensionConfig } from "@cvr/pi-config";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

interface PrConfig {
  reviewers: string[];
  autoMerge: boolean;
  labels: string[];
  /** Draft PRs by default */
  draft: boolean;
}

const DEFAULTS: PrConfig = {
  reviewers: [],
  autoMerge: false,
  labels: [],
  draft: false,
};

const NAMESPACE = "@cvr/pi-pr-config";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function prConfigExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start" as any, (_event: any, ctx: any) => {
    const { enabled, config } = getEnabledExtensionConfig<PrConfig>(NAMESPACE, DEFAULTS, {
      cwd: ctx.cwd,
      allowProjectConfig: true,
    });

    if (!enabled) return;

    const parts: string[] = [];

    if (config.reviewers.length > 0) {
      parts.push(`Default reviewers: ${config.reviewers.join(", ")}`);
    }
    if (config.labels.length > 0) {
      parts.push(`Default labels: ${config.labels.join(", ")}`);
    }
    if (config.autoMerge) {
      parts.push("Auto-merge: enabled (use --auto with gh pr create)");
    }
    if (config.draft) {
      parts.push("Draft PRs: enabled by default (use --draft with gh pr create)");
    }

    if (parts.length === 0) return;

    return {
      message: {
        customType: "pr-config-context",
        content: `[PR Configuration]\n${parts.join("\n")}`,
        display: false,
      },
    };
  });

  pi.on("context" as any, (event: any) => ({
    messages: event.messages.filter((m: any) => m.customType !== "pr-config-context"),
  }));
}

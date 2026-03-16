/**
 * Skill Capture Extension — extracts session learnings into skill updates.
 *
 * Command: /skill-capture
 * Reads session history, identifies user corrections and redirections,
 * groups them by skill domain, and proposes skill file updates.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function skillCaptureExtension(pi: ExtensionAPI): void {
  pi.registerCommand("skill-capture", {
    description: "Extract session learnings into skill updates",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();

      if (entries.length < 4) {
        ctx.ui.notify("Not enough session history to extract learnings.", "info");
        return;
      }

      // Gather conversation context — user messages and assistant responses
      const userMessages: string[] = [];
      for (const entry of entries) {
        const e = entry as any;
        if (e.type === "message" && e.message?.role === "user") {
          const content = e.message.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : "";
          if (text.trim()) userMessages.push(text.trim());
        }
      }

      if (userMessages.length < 2) {
        ctx.ui.notify("Not enough user messages to analyze.", "info");
        return;
      }

      // Build a prompt that asks the agent to analyze corrections
      const sessionExcerpt = userMessages
        .slice(-30)
        .map((m, i) => `[${i + 1}] ${m.slice(0, 500)}`)
        .join("\n\n");

      pi.sendMessage(
        {
          customType: "skill-capture-trigger",
          content: `Analyze this session's user messages for corrections, redirections, or patterns that should be captured as skill updates.

## Recent User Messages
${sessionExcerpt}

## Instructions
1. Identify messages where the user corrected your approach (e.g., "no, instead do...", "don't use...", "prefer...")
2. Group corrections by skill domain (e.g., "effect", "react", "code-style", "architecture")
3. For each group, propose a specific addition or update to the skill file at ~/.claude/skills/<domain>.md
4. Present the proposals with diffs — the user will approve or reject each

Focus on patterns that would prevent the same correction in future sessions.
If no meaningful corrections were found, say so.`,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });
}

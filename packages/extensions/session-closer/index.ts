/**
 * Session Closer Extension — wraps up a session cleanly.
 *
 * Command: /done
 * Runs a sequential pipeline: gate → counsel → documenter → commit → push.
 * Each step fires as a followUp message — the agent executes and reports.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STEPS = [
  {
    label: "gate",
    prompt: `Run the full gate (typecheck, lint, format check, test).
If everything passes, say "GATE_PASS".
If anything fails, fix the failures and re-run until they pass, then say "GATE_PASS".`,
  },
  {
    label: "counsel",
    prompt: `Run the counsel tool for a cross-vendor review of all changes in this session.
If approved or no significant issues, say "COUNSEL_PASS".
If issues are found, address the feedback, then say "COUNSEL_PASS".`,
  },
  {
    label: "documenter",
    prompt: `Review the session's changes and update any relevant documentation:
- If AGENTS.md or CODEMAP.md files exist and need updating, update them.
- Use the /skill-capture command if skill files were discussed or patterns were corrected.
Say "DOCS_DONE" when finished.`,
  },
  {
    label: "commit",
    prompt: `Create a conventional commit for all staged and unstaged changes:
1. Stage all relevant files (be specific — no git add .)
2. Write a concise conventional commit message (feat|fix|refactor|chore|...)
3. Commit the changes
Say "COMMITTED" when done.`,
  },
  {
    label: "push",
    prompt: `Push the commit(s) to the remote.
Say "PUSHED" when done.`,
  },
];

export default function sessionCloserExtension(pi: ExtensionAPI): void {
  pi.registerCommand("done", {
    description: "Wrap up session: gate → counsel → document → commit → push",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Starting session wrap-up...", "info");
      ctx.ui.setStatus("session-closer", "wrapping up...");

      // Fire the first step — subsequent steps are triggered by agent_end detection
      const fullPrompt = STEPS.map((s, i) => `## Step ${i + 1}: ${s.label}\n${s.prompt}`).join(
        "\n\n",
      );

      pi.sendMessage(
        {
          customType: "session-closer",
          content: `[SESSION WRAP-UP]

Execute each step in order. Complete each step fully before moving to the next.

${fullPrompt}

After all steps are complete, say "SESSION_COMPLETE".`,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });

  // Listen for completion to clear status
  pi.on("agent_end" as any, (event: any, ctx: any) => {
    const messages = event?.messages;
    if (!messages || !Array.isArray(messages)) return;

    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;

    const text = Array.isArray(last.content)
      ? last.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
      : "";

    if (/SESSION_COMPLETE/i.test(text)) {
      ctx.ui.setStatus("session-closer", undefined);
      ctx.ui.notify("Session wrap-up complete!", "info");
    }
  });
}

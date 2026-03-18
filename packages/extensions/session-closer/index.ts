/**
 * Session Closer Extension — wraps up a session cleanly.
 *
 * Command: /done
 * Runs a sequential pipeline: gate → counsel → documenter → commit → push.
 * The agent performs the wrap-up, then calls a typed completion tool.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SESSION_CLOSER_COMPLETE_TOOL = "session_closer_complete" as const;

const STEPS = [
  {
    label: "gate",
    prompt: `Run the full gate (typecheck, lint, format check, test).
Fix any failures until the gate passes.`,
  },
  {
    label: "counsel",
    prompt: `Run the counsel tool for a cross-vendor review of all changes in this session.
Address any issues counsel finds before continuing.`,
  },
  {
    label: "documenter",
    prompt: `Review the session's changes and update any relevant documentation:
- If AGENTS.md or CODEMAP.md files exist and need updating, update them.
- Use the /skill-capture command if skill files were discussed or patterns were corrected.`,
  },
  {
    label: "commit",
    prompt: `Create a conventional commit for all staged and unstaged changes:
1. Stage all relevant files (be specific — no git add .)
2. Write a concise conventional commit message (feat|fix|refactor|chore|...)
3. Commit the changes`,
  },
  {
    label: "push",
    prompt: `Push the commit(s) to the remote.`,
  },
];

export default function sessionCloserExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SESSION_CLOSER_COMPLETE_TOOL,
    label: "Session Closer Complete",
    description: "Signal that the session wrap-up pipeline has finished successfully.",
    promptSnippet: "Call this tool when the /done wrap-up pipeline is complete.",
    promptGuidelines: [
      "Use this only after gate, counsel, documentation, commit, and push are all complete.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus("session-closer", undefined);
      ctx.ui.notify("Session wrap-up complete!", "info");
      return {
        content: [{ type: "text" as const, text: "Session wrap-up complete." }],
        details: {},
      };
    },
  });

  pi.registerCommand("done", {
    description: "Wrap up session: gate → counsel → document → commit → push",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Starting session wrap-up...", "info");
      ctx.ui.setStatus("session-closer", "wrapping up...");

      const fullPrompt = STEPS.map((s, i) => `## Step ${i + 1}: ${s.label}\n${s.prompt}`).join(
        "\n\n",
      );

      pi.sendMessage(
        {
          customType: "session-closer",
          content: `[SESSION WRAP-UP]

Execute each step in order. Complete each step fully before moving to the next.

${fullPrompt}

When all steps are complete, call ${SESSION_CLOSER_COMPLETE_TOOL}.`,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });
}

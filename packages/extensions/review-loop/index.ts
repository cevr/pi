/**
 * Review Loop Extension
 *
 * Self-review loop with counsel integration and brain principles.
 * /review <prompt> activates review mode — the agent works, then the
 * review prompt is re-injected after each agent_end to loop.
 *
 * The review prompt instructs the agent to use the counsel tool for
 * cross-vendor validation. User input exits the loop.
 *
 * Independent of plan mode — can be used on any task.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readPrinciples } from "@cvr/pi-brain-principles";

const DEFAULT_MAX_ITERATIONS = 5;

const DEFAULT_REVIEW_PROMPT = `Review your changes. Use the counsel tool to get a cross-vendor second opinion.
Address any issues counsel raises. If counsel approves or you're confident the changes are correct, say "No issues found."`;

// --- exit detection ---

const EXIT_PATTERNS = [
  /no issues found/i,
  /no bugs found/i,
  /no problems found/i,
  /looks good/i,
  /lgtm/i,
  /all good/i,
  /changes are correct/i,
  /approved/i,
];

const ISSUES_FIXED_PATTERNS = [/fixed/i, /addressed/i, /resolved/i, /corrected/i, /updated/i];

function hasExitPhrase(text: string): boolean {
  return EXIT_PATTERNS.some((p) => p.test(text));
}

function hasIssuesFixed(text: string): boolean {
  return ISSUES_FIXED_PATTERNS.some((p) => p.test(text));
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function reviewLoopExtension(pi: ExtensionAPI): void {
  let reviewActive = false;
  let currentIteration = 0;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let reviewPrompt = DEFAULT_REVIEW_PROMPT;
  let userPrompt = "";

  function updateStatus(ctx: ExtensionContext): void {
    if (reviewActive) {
      ctx.ui.setStatus(
        "review-loop",
        ctx.ui.theme.fg("accent", `🔄 review ${currentIteration + 1}/${maxIterations}`),
      );
    } else {
      ctx.ui.setStatus("review-loop", undefined);
    }
  }

  function enterReview(ctx: ExtensionContext, prompt: string): void {
    reviewActive = true;
    currentIteration = 0;
    userPrompt = prompt;
    updateStatus(ctx);
    ctx.ui.notify("Review mode activated", "info");
  }

  function exitReview(ctx: ExtensionContext, reason: string): void {
    reviewActive = false;
    currentIteration = 0;
    userPrompt = "";
    updateStatus(ctx);
    ctx.ui.notify(`Review mode ended: ${reason}`, "info");
  }

  function buildFullReviewPrompt(): string {
    const parts: string[] = [];
    if (userPrompt) parts.push(userPrompt);
    parts.push(reviewPrompt);
    return parts.join("\n\n");
  }

  // --- commands ---

  pi.registerCommand("review", {
    description: "Start review loop. /review <prompt> activates with custom instructions.",
    handler: async (args, ctx) => {
      const prompt = typeof args === "string" ? args.trim() : "";
      if (reviewActive) {
        ctx.ui.notify("Review mode already active. Use /review-exit to stop.", "info");
        return;
      }
      enterReview(ctx, prompt);
      // Send the user's prompt (or default review prompt) to kick off the first iteration
      pi.sendUserMessage(prompt || buildFullReviewPrompt(), { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("review-exit", {
    description: "Exit review mode manually",
    handler: async (_args, ctx) => {
      if (reviewActive) {
        exitReview(ctx, "manual exit");
      } else {
        ctx.ui.notify("Review mode is not active", "info");
      }
    },
  });

  pi.registerCommand("review-max", {
    description: "Set max review iterations (default: 5)",
    handler: async (args, ctx) => {
      const num = parseInt(typeof args === "string" ? args : "", 10);
      if (isNaN(num) || num < 1) {
        ctx.ui.notify(`Max iterations: ${maxIterations}. Usage: /review-max <number>`, "info");
        return;
      }
      maxIterations = num;
      ctx.ui.notify(`Max review iterations set to ${maxIterations}`, "info");
    },
  });

  pi.registerCommand("review-status", {
    description: "Show review mode status",
    handler: async (_args, ctx) => {
      if (reviewActive) {
        ctx.ui.notify(
          `Review mode active: iteration ${currentIteration + 1}/${maxIterations}`,
          "info",
        );
      } else {
        ctx.ui.notify(`Review mode inactive (max: ${maxIterations})`, "info");
      }
    },
  });

  // --- events ---

  // User typing anything exits review mode (same pattern as pi-review-loop)
  pi.on("input", async (event, ctx) => {
    if (!reviewActive) return { action: "continue" as const };
    if (event.source === "interactive") {
      exitReview(ctx, "user interrupted");
    }
    return { action: "continue" as const };
  });

  // Inject brain principles into context when review is active
  pi.on("before_agent_start", async () => {
    if (!reviewActive) return;

    const principles = readPrinciples();
    const principlesBlock = principles ? `\n\n${principles}` : "";

    return {
      message: {
        customType: "review-loop-context",
        content: `[REVIEW MODE - Iteration ${currentIteration + 1}/${maxIterations}]

${userPrompt ? `Review focus: ${userPrompt}\n\n` : ""}After making changes, use the counsel tool to get a cross-vendor review.
If counsel or you find no issues, say "No issues found" to exit review mode.${principlesBlock}`,
        display: false,
      },
    };
  });

  // Always strip old review-loop-context — before_agent_start re-injects fresh each turn
  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        return msg.customType !== "review-loop-context";
      }),
    };
  });

  // After agent finishes, decide whether to loop
  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI || !reviewActive) return;

    const assistantMessages = event.messages.filter(isAssistantMessage);
    const lastAssistant = assistantMessages[assistantMessages.length - 1];

    if (!lastAssistant) {
      exitReview(ctx, "aborted");
      return;
    }

    const text = getTextContent(lastAssistant);
    if (!text.trim()) {
      exitReview(ctx, "aborted");
      return;
    }

    // Smart exit: "no issues" + no "fixed" → done. "fixed" + "no issues" → continue (just fixed something).
    const exit = hasExitPhrase(text);
    const fixed = hasIssuesFixed(text);

    if (exit && !fixed) {
      exitReview(ctx, "no issues found");
      return;
    }

    currentIteration++;
    if (currentIteration >= maxIterations) {
      exitReview(ctx, `max iterations (${maxIterations}) reached`);
      return;
    }

    updateStatus(ctx);
    pi.sendUserMessage(buildFullReviewPrompt(), { deliverAs: "followUp" });
  });

  // Reset on session start
  pi.on("session_start", async () => {
    reviewActive = false;
    currentIteration = 0;
    userPrompt = "";
  });

  // Reset on session switch (prevents leaking into different session)
  pi.on("session_switch", async (_event, ctx) => {
    reviewActive = false;
    currentIteration = 0;
    userPrompt = "";
    updateStatus(ctx);
  });
}

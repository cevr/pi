/**
 * Review Loop Extension — thin wiring layer.
 *
 * Delegates state transitions to machine.ts via pi-state-machine.
 *
 * Usage:
 *   /review                         — review current branch diff
 *   /review check correctness       — review diff with explicit focus
 *   /review @packages/extensions/review-loop
 *   /review @packages/core/fs check path handling
 */

import type { AssistantMessage, Message as PiMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { getChangedFiles, getDiffStat, resolveBaseBranch } from "@cvr/pi-diff-context";
import { parseScopedPathArgs, toWorkspaceDisplayPath } from "@cvr/pi-fs";
import { GitClient } from "@cvr/pi-git-client";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { register } from "@cvr/pi-state-machine";
import type { Command } from "@cvr/pi-state-machine";
import { Layer, ManagedRuntime } from "effect";
import {
  DEFAULT_MAX_ITERATIONS,
  reviewReducer,
  type PersistPayload,
  type ReviewEffect,
  type ReviewEvent,
  type ReviewState,
} from "./machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: PiMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function reviewLoopExtension(pi: ExtensionAPI): void {
  const gitRuntime = ManagedRuntime.make(GitClient.layer.pipe(Layer.provide(ProcessRunner.layer)));

  pi.on("session_shutdown" as any, async () => {
    await gitRuntime.dispose();
  });

  // ----- Commands -----
  const commands: Command<ReviewState, ReviewEvent>[] = [
    {
      mode: "event",
      name: "review-exit",
      description: "Exit review mode manually",
      toEvent: (state, _args, ctx): ReviewEvent | null => {
        if (state._tag !== "Reviewing") {
          ctx.ui.notify("Review mode is not active", "info");
          return null;
        }
        return { _tag: "Exit" };
      },
    },
    {
      mode: "event",
      name: "review-max",
      description: "Set max review iterations (default: 5)",
      toEvent: (state, args, ctx): ReviewEvent | null => {
        const num = parseInt(args, 10);
        if (isNaN(num) || num < 1) {
          ctx.ui.notify(
            `Max iterations: ${state.maxIterations}. Usage: /review-max <number>`,
            "info",
          );
          return null;
        }
        return { _tag: "SetMax", max: num };
      },
    },
    {
      mode: "query",
      name: "review-status",
      description: "Show review mode status",
      handler: (state, _args, ctx): void => {
        if (state._tag === "Reviewing") {
          ctx.ui.notify(
            `Review mode active: iteration ${state.iteration + 1}/${state.maxIterations}`,
            "info",
          );
        } else {
          ctx.ui.notify(`Review mode inactive (max: ${state.maxIterations})`, "info");
        }
      },
    },
  ];

  // ----- Register machine -----
  const machine = register<ReviewState, ReviewEvent, ReviewEffect>(
    pi,
    {
      id: "review-loop",
      initial: { _tag: "Inactive", maxIterations: DEFAULT_MAX_ITERATIONS },
      reducer: reviewReducer,

      events: {
      before_agent_start: {
        mode: "reply",
        handle: (state) => {
          if (state._tag !== "Reviewing") return;
          const principles = readPrinciples();
          const principlesBlock = principles ? `\n\n${principles}` : "";
          return {
            message: {
              customType: "review-loop-context",
              content: `[REVIEW MODE - Iteration ${state.iteration + 1}/${state.maxIterations}]

${state.scope === "diff" ? `Scope: current branch diff\n${state.diffStat}\nChanged files: ${state.targetPaths.join(", ")}\n\n` : `Scope: explicit paths\nPaths: ${state.targetPaths.join(", ")}\n\n`}${state.userPrompt ? `Review focus: ${state.userPrompt}\n\n` : ""}After making changes, use the counsel tool to get a cross-vendor review.
If counsel or you find no issues, say "No issues found" to exit review mode.${principlesBlock}`,
              display: false,
            },
          };
        },
      },

      context: {
        mode: "reply",
        handle: (_state, event) => ({
          messages: event.messages.filter((m: any) => m.customType !== "review-loop-context"),
        }),
      },

      agent_end: {
        mode: "fire",
        toEvent: (state, event, ctx): ReviewEvent | null => {
          if (!ctx.hasUI || state._tag !== "Reviewing") return null;

          const assistantMessages = event.messages.filter(isAssistantMessage);
          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          if (!lastAssistant) return { _tag: "AgentEnd", text: "" };

          return { _tag: "AgentEnd", text: getTextContent(lastAssistant) };
        },
      },

      session_start: {
        mode: "fire",
        toEvent: (_state, _event, ctx): ReviewEvent => {
          const entries = ctx.sessionManager.getEntries();
          const reviewEntry = entries
            .filter((entry: any) => entry.type === "custom" && entry.customType === "review-loop")
            .pop() as { data?: PersistPayload } | undefined;
          const data = reviewEntry?.data;
          const scope = data?.scope === "diff" || data?.scope === "paths" ? data.scope : undefined;
          const maxIterations =
            typeof data?.maxIterations === "number" && data.maxIterations >= 1
              ? data.maxIterations
              : undefined;
          const iteration =
            typeof data?.iteration === "number" && data.iteration >= 0 ? data.iteration : undefined;

          return {
            _tag: "Hydrate",
            mode: data?.mode,
            maxIterations,
            iteration,
            userPrompt: typeof data?.userPrompt === "string" ? data.userPrompt : undefined,
            scope,
            diffStat: typeof data?.diffStat === "string" ? data.diffStat : undefined,
            targetPaths: Array.isArray(data?.targetPaths)
              ? data.targetPaths.filter((value): value is string => typeof value === "string")
              : undefined,
          };
        },
      },

      session_switch: {
        mode: "fire",
        toEvent: (): ReviewEvent => ({ _tag: "Reset" }),
      },

      // input: reply handler that also fires UserInterrupt via microtask
      input: {
        mode: "reply",
        handle: (state, event) => {
          if (state._tag === "Reviewing" && event.source === "interactive") {
            queueMicrotask(() => machine.send({ _tag: "UserInterrupt" }));
          }
          return { action: "continue" as const };
        },
      },
    },
    commands,
  },
    (effect) => {
      if (effect.type === "persistState") {
        pi.appendEntry("review-loop", effect.state);
      }
    },
  );

  pi.registerCommand("review", {
    description: "Review current branch changes or explicit @paths with iterative follow-up",
    handler: async (rawArgs, ctx) => {
      if (machine.getState()._tag === "Reviewing") {
        ctx.ui.notify("Review mode already active. Use /review-exit to stop.", "info");
        return;
      }

      const parsedArgs = parseScopedPathArgs(rawArgs, ctx.cwd);
      if (parsedArgs.invalidPaths.length > 0) {
        ctx.ui.notify(
          `Invalid review path${parsedArgs.invalidPaths.length > 1 ? "s" : ""}: ${parsedArgs.invalidPaths.join(", ")}`,
          "error",
        );
        return;
      }

      const targetPaths = parsedArgs.targetPaths.map((filePath) =>
        toWorkspaceDisplayPath(filePath, ctx.cwd),
      );

      if (targetPaths.length > 0) {
        machine.send({
          _tag: "Start",
          prompt: parsedArgs.userPrompt,
          scope: "paths",
          diffStat: "",
          targetPaths,
        });
        return;
      }

      const baseBranch = await resolveBaseBranch(ctx.cwd, gitRuntime);
      const diffStat = await getDiffStat(ctx.cwd, baseBranch, gitRuntime);
      const changedFiles = await getChangedFiles(ctx.cwd, baseBranch, gitRuntime);

      if (changedFiles.length === 0) {
        ctx.ui.notify(
          "No changes to review. Pass an @path to review a file or directory explicitly.",
          "info",
        );
        return;
      }

      machine.send({
        _tag: "Start",
        prompt: parsedArgs.userPrompt,
        scope: "diff",
        diffStat,
        targetPaths: changedFiles,
      });
    },
  });
}

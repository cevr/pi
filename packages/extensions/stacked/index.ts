/**
 * Stacked PR Health Extension — analyzes stacked branch health.
 *
 * Commands: /stack, /stack-dismiss
 * Reads branch topology, checks for leaked commits, CI status, review status.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { register } from "@cvr/pi-state-machine";
import type { Command } from "@cvr/pi-state-machine";
import { ManagedRuntime } from "effect";
import {
  stackedReducer,
  type StackBranch,
  type StackedEffect,
  type StackedEvent,
  type StackedState,
  type StackIssue,
} from "./machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getStackBranches(
  cwd: string,
  runtime: ManagedRuntime.ManagedRuntime<ProcessRunner, never>,
): Promise<StackBranch[]> {
  try {
    const runner = await runtime.runPromise(ProcessRunner);

    // Use `stacked ls --json` if available, otherwise fall back to git
    const result = await runtime.runPromise(
      runner.run("stacked", { args: ["ls", "--json"], cwd, timeoutMs: 5000 }),
    );

    if (result.exitCode === 0) {
      const branches = JSON.parse(result.stdout.trim()) as Array<{
        name: string;
        parent?: string;
        pr?: string;
      }>;
      return branches.map((b) => ({
        name: b.name,
        parent: b.parent,
        pr: b.pr,
        ciStatus: "unknown" as const,
        reviewStatus: "unknown" as const,
      }));
    }
  } catch {
    /* stacked CLI not available */
  }

  // Fallback: use current branch as single-branch stack
  try {
    const runner = await runtime.runPromise(ProcessRunner);
    const result = await runtime.runPromise(
      runner.run("git", { args: ["branch", "--show-current"], cwd }),
    );
    const branch = result.stdout.trim();
    if (branch) {
      return [{ name: branch, ciStatus: "unknown", reviewStatus: "unknown" }];
    }
  } catch {
    /* not a git repo */
  }

  return [];
}

async function analyzeStack(
  stack: StackBranch[],
  cwd: string,
  runtime: ManagedRuntime.ManagedRuntime<ProcessRunner, never>,
): Promise<StackIssue[]> {
  const issues: StackIssue[] = [];
  const runner = await runtime.runPromise(ProcessRunner);

  for (const branch of stack) {
    if (!branch.parent) continue;

    // Check for leaked commits: commits in this branch that are also in the parent
    try {
      const result = await runtime.runPromise(
        runner.run("git", {
          args: [
            "log",
            "--oneline",
            `${branch.parent}..${branch.name}`,
            "--not",
            `${branch.parent}`,
          ],
          cwd,
          timeoutMs: 5000,
        }),
      );
      // This is just a basic check — real leak detection compares commit SHAs
      const commits = result.stdout.trim().split("\n").filter(Boolean);
      if (commits.length > 20) {
        issues.push({
          type: "leaked-commit",
          branch: branch.name,
          details: `${commits.length} commits — may include parent commits. Consider rebasing.`,
        });
      }
    } catch {
      /* skip */
    }

    // Check CI status via gh
    if (branch.pr) {
      try {
        const result = await runtime.runPromise(
          runner.run("gh", {
            args: ["pr", "checks", branch.pr, "--json", "state"],
            cwd,
            timeoutMs: 10_000,
          }),
        );
        if (result.exitCode === 0) {
          const checks = JSON.parse(result.stdout.trim()) as Array<{ state: string }>;
          const failed = checks.some((c) => c.state === "FAILURE");
          if (failed) {
            branch.ciStatus = "failed";
            issues.push({
              type: "ci-failed",
              branch: branch.name,
              details: `PR ${branch.pr} has failing checks`,
            });
          } else if (checks.every((c) => c.state === "SUCCESS")) {
            branch.ciStatus = "passed";
          } else {
            branch.ciStatus = "pending";
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function stackedExtension(pi: ExtensionAPI): void {
  const processRuntime = ManagedRuntime.make(ProcessRunner.layer);

  pi.on("session_shutdown" as any, async () => {
    await processRuntime.dispose();
  });

  // ----- Commands -----
  const commands: Command<StackedState, StackedEvent>[] = [
    {
      mode: "event",
      name: "stack-dismiss",
      description: "Dismiss stacked PR health report",
      toEvent: (): StackedEvent => ({ _tag: "Dismiss" }),
    },
    {
      mode: "query",
      name: "stack-status",
      description: "Show stacked PR health status",
      handler: (state, _args, ctx): void => {
        switch (state._tag) {
          case "Idle":
            ctx.ui.notify("No stack analysis active. Use /stack to start.", "info");
            break;
          case "Analyzing":
            ctx.ui.notify(`Analyzing ${state.stack.length} branches...`, "info");
            break;
          case "Reporting": {
            const lines = state.stack.map((b) => {
              const status = b.ciStatus === "passed" ? "✓" : b.ciStatus === "failed" ? "✗" : "?";
              return `  ${status} ${b.name}${b.pr ? ` (#${b.pr})` : ""}`;
            });
            const issueLines = state.issues.map((i) => `  ⚠ ${i.branch}: ${i.details}`);
            ctx.ui.notify(
              `Stack Health:\n${lines.join("\n")}${issueLines.length > 0 ? `\n\nIssues:\n${issueLines.join("\n")}` : "\n\nNo issues."}`,
              state.issues.length > 0 ? "warning" : "info",
            );
            break;
          }
        }
      },
    },
  ];

  // ----- UI -----
  function formatUI(state: StackedState, ctx: ExtensionContext): void {
    if (state._tag === "Reporting") {
      ctx.ui.setWidget(
        "stacked",
        state.stack.map((b) => {
          const ci = b.ciStatus === "passed" ? "✓" : b.ciStatus === "failed" ? "✗" : "○";
          return `  ${ci} ${b.name}`;
        }),
      );
    } else {
      ctx.ui.setWidget("stacked", undefined);
    }
  }

  // ----- Register machine -----
  const machine = register<StackedState, StackedEvent, StackedEffect>(
    pi,
    {
      id: "stacked",
      initial: { _tag: "Idle" },
      reducer: stackedReducer,

      events: {
        session_switch: {
          mode: "fire",
          toEvent: (): StackedEvent => ({ _tag: "Reset" }),
        },
      },

      commands,
    },
    (effect, _pi, ctx) => {
      if (effect.type === "updateUI") {
        formatUI(machine.getState(), ctx);
      }
    },
  );

  // ----- /stack command (imperative — async branch analysis) -----
  pi.registerCommand("stack", {
    description: "Analyze stacked PR health",
    handler: async (_args, ctx) => {
      if (machine.getState()._tag === "Analyzing") {
        ctx.ui.notify("Stack analysis already in progress.", "info");
        return;
      }

      const stack = await getStackBranches(ctx.cwd, processRuntime);
      if (stack.length === 0) {
        ctx.ui.notify("No branches found to analyze.", "info");
        return;
      }

      machine.send({ _tag: "Analyze", stack });

      const issues = await analyzeStack(stack, ctx.cwd, processRuntime);
      machine.send({ _tag: "AnalysisComplete", issues });
    },
  });
}

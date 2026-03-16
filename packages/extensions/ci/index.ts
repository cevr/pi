/**
 * CI Watcher Extension — monitors GitHub Actions for the current branch.
 *
 * Commands: /ci, /ci-dismiss, /ci-status
 * Polls `gh run list` every 30s when watching.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { register } from "@cvr/pi-state-machine";
import type { Command } from "@cvr/pi-state-machine";
import { ManagedRuntime } from "effect";
import { ciReducer, type CiEffect, type CiEvent, type CiState } from "./machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;

interface RunInfo {
  databaseId: string;
  status: string;
  conclusion: string | null;
}

async function getCurrentBranch(
  cwd: string,
  runtime: ManagedRuntime.ManagedRuntime<ProcessRunner, never>,
): Promise<string> {
  const runner = await runtime.runPromise(ProcessRunner);
  const result = await runtime.runPromise(
    runner.run("git", { args: ["branch", "--show-current"], cwd }),
  );
  return result.stdout.trim();
}

async function getLatestRun(
  branch: string,
  cwd: string,
  runtime: ManagedRuntime.ManagedRuntime<ProcessRunner, never>,
): Promise<RunInfo | null> {
  try {
    const runner = await runtime.runPromise(ProcessRunner);
    const result = await runtime.runPromise(
      runner.run("gh", {
        args: [
          "run",
          "list",
          "--branch",
          branch,
          "--limit",
          "1",
          "--json",
          "databaseId,status,conclusion",
        ],
        cwd,
      }),
    );
    if (result.exitCode !== 0) return null;
    const runs = JSON.parse(result.stdout.trim()) as RunInfo[];
    return runs[0] ?? null;
  } catch {
    return null;
  }
}

async function getFailedLogs(
  runId: string,
  cwd: string,
  runtime: ManagedRuntime.ManagedRuntime<ProcessRunner, never>,
): Promise<string> {
  try {
    const runner = await runtime.runPromise(ProcessRunner);
    const result = await runtime.runPromise(
      runner.run("gh", { args: ["run", "view", runId, "--log-failed"], cwd, timeoutMs: 15_000 }),
    );
    return result.stdout.trim().slice(0, 3000);
  } catch {
    return "(failed to fetch logs)";
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function ciExtension(pi: ExtensionAPI): void {
  const processRuntime = ManagedRuntime.make(ProcessRunner.layer);

  pi.on("session_shutdown" as any, async () => {
    await processRuntime.dispose();
  });

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCwd: string = process.cwd();

  function stopPolling(): void {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(): void {
    stopPolling();
    poll();
  }

  async function poll(): Promise<void> {
    const state = machine.getState();
    if (state._tag !== "Watching") return;

    const run = await getLatestRun(state.branch, lastCwd, processRuntime);
    if (!run) {
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    const currentState = machine.getState();
    if (currentState._tag !== "Watching") return;

    // Update runId if detected
    if (!currentState.runId && run.databaseId) {
      machine.send({ _tag: "RunDetected", runId: run.databaseId });
    }

    if (run.status === "completed") {
      if (run.conclusion === "success") {
        machine.send({ _tag: "RunPassed", runId: run.databaseId });
      } else {
        const output = await getFailedLogs(run.databaseId, lastCwd, processRuntime);
        machine.send({ _tag: "RunFailed", runId: run.databaseId, output });
      }
      return;
    }

    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  // ----- Commands -----
  const commands: Command<CiState, CiEvent>[] = [
    {
      mode: "event",
      name: "ci-dismiss",
      description: "Dismiss CI watcher",
      toEvent: (): CiEvent => ({ _tag: "Dismiss" }),
    },
    {
      mode: "query",
      name: "ci-status",
      description: "Show CI status",
      handler: (state, _args, ctx): void => {
        switch (state._tag) {
          case "Idle":
            ctx.ui.notify("No CI watch active. Use /ci to start.", "info");
            break;
          case "Watching":
            ctx.ui.notify(
              `Watching ${state.branch}${state.runId ? ` (run #${state.runId})` : ""}`,
              "info",
            );
            break;
          case "Passed":
            ctx.ui.notify(`CI passed (run #${state.runId}) on ${state.branch}`, "info");
            break;
          case "Failed":
            ctx.ui.notify(
              `CI failed (run #${state.runId}) on ${state.branch}\n${state.output.slice(0, 500)}`,
              "error",
            );
            break;
        }
      },
    },
  ];

  // ----- Effect interpreter -----
  function interpretEffect(effect: CiEffect): void {
    switch (effect.type) {
      case "startPolling":
        startPolling();
        break;
      case "stopPolling":
        stopPolling();
        break;
      case "updateUI":
        break;
    }
  }

  // ----- Register machine -----
  const machine = register<CiState, CiEvent, CiEffect>(
    pi,
    {
      id: "ci",
      initial: { _tag: "Idle" },
      reducer: ciReducer,

      events: {
        session_switch: {
          mode: "fire",
          toEvent: (): CiEvent => ({ _tag: "Reset" }),
        },
      },

      commands,
    },
    (effect) => interpretEffect(effect),
  );

  // ----- /ci command (imperative — needs async git branch detection) -----
  pi.registerCommand("ci", {
    description: "Watch CI for the current branch",
    handler: async (_args, ctx) => {
      lastCwd = ctx.cwd;
      const state = machine.getState();
      if (state._tag === "Watching") {
        ctx.ui.notify(`Already watching ${state.branch}`, "info");
        return;
      }

      try {
        const branch = await getCurrentBranch(ctx.cwd, processRuntime);
        if (!branch) {
          ctx.ui.notify("Could not detect current branch", "error");
          return;
        }
        machine.send({ _tag: "Watch", branch });
      } catch {
        ctx.ui.notify("Failed to detect branch. Is this a git repo?", "error");
      }
    },
  });
}

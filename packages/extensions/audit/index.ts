/**
 * Audit Extension — skill-aware branch audit-loop.
 *
 * Full loop: detect concerns → parallel audit → synthesize findings → fix each
 * finding with gate + counsel between fixes.
 *
 * Usage:
 *   /audit                          — auto-detect concerns from diff
 *   /audit check react and effect   — with explicit focus
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { GitClient } from "@cvr/pi-git-client";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { register, type MachineConfig } from "@cvr/pi-state-machine";
import type { Command } from "@cvr/pi-state-machine";
import { Layer, ManagedRuntime } from "effect";
import {
  resolveBaseBranch,
  getDiffStat,
  getChangedFiles,
  buildSkillCatalog,
} from "@cvr/pi-diff-context";
import { auditReducer, type AuditEffect, type AuditEvent, type AuditState } from "./machine";
import { parseConcernsJson, parseFindingsJson, PHASE_MARKERS } from "./utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getLastAssistantText(messages: AgentMessage[]): string {
  const assistants = messages.filter(isAssistantMessage);
  const last = assistants[assistants.length - 1];
  if (!last) return "";
  return last.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const AUDIT_CUSTOM_TYPES = new Set([
  "audit-context",
  "audit-trigger",
  "audit-fix",
  "audit-gate",
  "audit-gate-fix",
  "audit-counsel",
  "audit-counsel-fix",
  "audit-commit",
]);

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function formatUI(state: AuditState, ctx: ExtensionContext): void {
  if (state._tag === "Auditing") {
    ctx.ui.setWidget(
      "audit-progress",
      state.concerns.map((c) => `  ○ ${c.name}`),
    );
  } else if (state._tag === "Fixing") {
    const lines = state.findings.map((f, i) => {
      const marker = i < state.currentFinding ? "✓" : i === state.currentFinding ? "▸" : "○";
      const phase =
        i === state.currentFinding && state.phase !== "running" ? ` (${state.phase})` : "";
      return `  ${marker} [${f.severity}] ${f.file}${phase}`;
    });
    ctx.ui.setWidget("audit-progress", lines);
  } else {
    ctx.ui.setWidget("audit-progress", undefined);
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function auditExtension(pi: ExtensionAPI): void {
  const gitRuntime = ManagedRuntime.make(GitClient.layer.pipe(Layer.provide(ProcessRunner.layer)));

  pi.on("session_shutdown" as any, async () => {
    await gitRuntime.dispose();
  });

  // ----- Commands -----
  const commands: Command<AuditState, AuditEvent>[] = [
    {
      mode: "event",
      name: "audit-cancel",
      description: "Cancel the running audit",
      toEvent: (state, _args, ctx): AuditEvent | null => {
        if (state._tag === "Idle") {
          ctx.ui.notify("No audit in progress", "info");
          return null;
        }
        return { _tag: "Cancel" };
      },
    },
    {
      mode: "event",
      name: "audit-skip",
      description: "Skip the current finding",
      toEvent: (state, _args, ctx): AuditEvent | null => {
        if (state._tag !== "Fixing" || state.phase !== "running") {
          ctx.ui.notify("Not currently fixing a finding", "info");
          return null;
        }
        return { _tag: "FixSkip" };
      },
    },
    {
      mode: "query",
      name: "audit-status",
      description: "Show audit status",
      handler: (state, _args, ctx): void => {
        switch (state._tag) {
          case "Idle":
            ctx.ui.notify("No audit in progress", "info");
            break;
          case "Detecting":
            ctx.ui.notify("Audit: detecting concerns...", "info");
            break;
          case "Auditing":
            ctx.ui.notify(`Audit: running ${state.concerns.length} concern audits`, "info");
            break;
          case "Synthesizing":
            ctx.ui.notify("Audit: synthesizing findings...", "info");
            break;
          case "Fixing": {
            const done = state.currentFinding;
            const total = state.findings.length;
            const current = state.findings[state.currentFinding]!;
            ctx.ui.notify(
              `Audit: fixing ${done + 1}/${total} (${state.phase}) — [${current.severity}] ${current.file}: ${current.description}`,
              "info",
            );
            break;
          }
        }
      },
    },
  ];

  // ----- Machine config -----
  const machineConfig: MachineConfig<AuditState, AuditEvent, AuditEffect> = {
    id: "audit",
    initial: { _tag: "Idle" },
    reducer: auditReducer,

    events: {
      before_agent_start: {
        mode: "reply" as const,
        handle: (state) => {
          if (state._tag === "Idle") return;

          const principles = readPrinciples();
          const principlesBlock = principles ? `\n\n${principles}` : "";

          let content: string;
          switch (state._tag) {
            case "Detecting":
              content = `[AUDIT MODE — DETECTION]\n\nYou are detecting which audit concerns apply to this branch's changes.${principlesBlock}`;
              break;
            case "Auditing":
              content = `[AUDIT MODE — AUDITING ${state.concerns.length} concerns]${principlesBlock}`;
              break;
            case "Synthesizing":
              content = `[AUDIT MODE — SYNTHESIS]\n\nSynthesize findings and output structured JSON.${principlesBlock}`;
              break;
            case "Fixing": {
              const f = state.findings[state.currentFinding]!;
              const phaseLabel =
                state.phase === "gating"
                  ? "GATING"
                  : state.phase === "counseling"
                    ? "COUNSELING"
                    : `FIXING ${state.currentFinding + 1}/${state.findings.length}`;
              content = `[AUDIT MODE — ${phaseLabel}]\n\nCurrent finding: [${f.severity}] ${f.file} — ${f.description}${principlesBlock}`;
              break;
            }
          }

          return {
            message: {
              customType: "audit-context",
              content,
              display: false,
            },
          };
        },
      },

      context: {
        mode: "reply" as const,
        handle: (_state, event) => ({
          messages: event.messages.filter((m: any) => !AUDIT_CUSTOM_TYPES.has(m.customType)),
        }),
      },

      agent_end: {
        mode: "fire" as const,
        toEvent: (state, event, ctx): AuditEvent | null => {
          if (!ctx.hasUI || state._tag === "Idle") return null;

          const text = getLastAssistantText(event.messages);
          if (!text.trim()) return { _tag: "Cancel" };

          switch (state._tag) {
            case "Detecting": {
              if (!PHASE_MARKERS.detecting.test(text)) return null;
              const concerns = parseConcernsJson(text);
              if (concerns === null) return { _tag: "DetectionFailed" };
              return { _tag: "ConcernsDetected", concerns };
            }
            case "Auditing": {
              if (PHASE_MARKERS.auditing.test(text)) return { _tag: "AuditingComplete" };
              return null;
            }
            case "Synthesizing": {
              if (!PHASE_MARKERS.synthesizing.test(text)) return null;
              const findings = parseFindingsJson(text) ?? [];
              return { _tag: "SynthesisComplete", findings };
            }
            case "Fixing": {
              if (state.phase === "running") {
                if (PHASE_MARKERS.findingFixed.test(text)) return { _tag: "FindingFixed" };
                if (PHASE_MARKERS.findingSkip.test(text)) return { _tag: "FixSkip" };
                return null;
              }
              if (state.phase === "gating") {
                if (PHASE_MARKERS.fixGatePass.test(text)) return { _tag: "FixGatePass" };
                if (PHASE_MARKERS.fixGateFail.test(text)) return { _tag: "FixGateFail" };
                return null;
              }
              if (state.phase === "counseling") {
                if (PHASE_MARKERS.fixCounselPass.test(text)) return { _tag: "FixCounselPass" };
                if (PHASE_MARKERS.fixCounselFail.test(text)) return { _tag: "FixCounselFail" };
                return null;
              }
              return null;
            }
          }
          return null;
        },
      },

      session_start: {
        mode: "fire" as const,
        toEvent: (): AuditEvent => ({ _tag: "Reset" }),
      },

      session_switch: {
        mode: "fire" as const,
        toEvent: (): AuditEvent => ({ _tag: "Reset" }),
      },

      input: {
        mode: "reply" as const,
        handle: (state, event) => {
          if (state._tag !== "Idle" && event.source === "interactive") {
            queueMicrotask(() => machine.send({ _tag: "Cancel" }));
          }
          return { action: "continue" as const };
        },
      },
    },

    commands,
  };

  const machine = register<AuditState, AuditEvent, AuditEffect>(
    pi,
    machineConfig,
    (effect, _pi, ctx) => {
      if (effect.type === "updateUI") {
        formatUI(machine.getState(), ctx);
      }
    },
  );

  // ----- /audit command (imperative — async git work) -----
  pi.registerCommand("audit", {
    description: "Audit branch changes with skill-aware parallel subagents",
    handler: async (_args, ctx) => {
      if (machine.getState()._tag !== "Idle") {
        ctx.ui.notify("Audit already in progress. /audit-cancel to stop.", "info");
        return;
      }

      const userPrompt = _args.trim();

      const baseBranch = await resolveBaseBranch(ctx.cwd, gitRuntime);
      const diffStat = await getDiffStat(ctx.cwd, baseBranch, gitRuntime);
      const changedFiles = await getChangedFiles(ctx.cwd, baseBranch, gitRuntime);

      if (changedFiles.length === 0) {
        ctx.ui.notify("No changes to audit.", "info");
        return;
      }

      const skillCatalog = buildSkillCatalog(ctx.cwd);

      machine.send({
        _tag: "Start",
        diffStat,
        changedFiles,
        skillCatalog,
        userPrompt,
      });
    },
  });
}

/**
 * Audit Extension — skill-aware branch audit-loop.
 *
 * Full loop: detect concerns → audit each concern → synthesize findings → fix each
 * finding with gate + counsel between fixes.
 *
 * Usage:
 *   /audit                                — auto-detect concerns from diff
 *   /audit check react and effect         — with explicit focus
 *   /audit packages/extensions/audit      — audit an explicit path
 *   /audit @packages/core/fs "check ts"  — force path parsing + focus
 */

import type { AssistantMessage, Message as PiMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { createInlineExecutionExecutor, isExecutionEffect } from "@cvr/pi-execution";
import { GitClient } from "@cvr/pi-git-client";
import { GraphRuntime } from "@cvr/pi-graph-runtime";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { PiSpawnService } from "@cvr/pi-spawn";
import { getFinalOutput } from "@cvr/pi-sub-agent-render";
import { register, type MachineConfig } from "@cvr/pi-state-machine";
import { renderTaskWidget } from "@cvr/pi-task-widget";
import type { Command } from "@cvr/pi-state-machine";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  resolveBaseBranch,
  getDiffStat,
  getChangedFiles,
  buildSkillCatalog,
} from "@cvr/pi-diff-context";
import {
  AUDIT_GRAPH_POLICY,
  auditReducer,
  buildConcernAuditPrompt,
  getAuditStatusText,
  type AuditConcernTask,
  type AuditEffect,
  type AuditEvent,
  type AuditFinding,
  type AuditState,
  type PersistPayload,
  type SkillCatalogEntry,
} from "./machine";
import type { GraphExecutionCursor } from "@cvr/pi-graph-execution";
import { parseAuditScopeArgs, toAuditDisplayPath } from "./scope";
import { parseConcernsJson, parseFindingsJson, PHASE_MARKERS } from "./utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(m: PiMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getLastAssistantText(messages: PiMessage[]): string {
  const assistants = messages.filter(isAssistantMessage);
  const last = assistants[assistants.length - 1];
  if (!last) return "";
  return last.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function normalizeHydratedSkillCatalog(
  entries: readonly Record<string, unknown>[] | undefined,
): SkillCatalogEntry[] {
  return (entries ?? []).flatMap((entry) => {
    if (typeof entry.name !== "string" || typeof entry.description !== "string") return [];
    return [{ name: entry.name, description: entry.description }];
  });
}

function normalizeHydratedConcernTasks(
  items: readonly Record<string, unknown>[] | undefined,
): AuditConcernTask[] {
  return (items ?? []).flatMap((item) => {
    const metadata =
      typeof item.metadata === "object" && item.metadata !== null
        ? (item.metadata as Record<string, unknown>)
        : undefined;
    if (
      typeof item.id !== "string" ||
      typeof item.order !== "number" ||
      typeof item.subject !== "string" ||
      (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") ||
      typeof metadata?.description !== "string"
    ) {
      return [];
    }

    return [
      {
        id: item.id,
        order: item.order,
        subject: item.subject,
        activeForm: typeof item.activeForm === "string" ? item.activeForm : undefined,
        owner: typeof item.owner === "string" ? item.owner : undefined,
        status: item.status,
        blockedBy: Array.isArray(item.blockedBy)
          ? item.blockedBy.filter((value): value is string => typeof value === "string")
          : [],
        metadata: {
          description: metadata.description,
          skills: Array.isArray(metadata.skills)
            ? metadata.skills.filter((value): value is string => typeof value === "string")
            : [],
          notes: typeof metadata.notes === "string" ? metadata.notes : undefined,
        },
      },
    ];
  });
}

function normalizeHydratedConcernCursor(value: unknown): GraphExecutionCursor | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const cursor = value as Record<string, unknown>;
  if (
    (cursor.phase !== "running" && cursor.phase !== "gating" && cursor.phase !== "counseling") ||
    typeof cursor.total !== "number" ||
    !Array.isArray(cursor.frontierTaskIds) ||
    !Array.isArray(cursor.activeTaskIds)
  ) {
    return undefined;
  }

  return {
    phase: cursor.phase,
    total: cursor.total,
    frontierTaskIds: cursor.frontierTaskIds.filter((taskId): taskId is string => typeof taskId === "string"),
    activeTaskIds: cursor.activeTaskIds.filter((taskId): taskId is string => typeof taskId === "string"),
  };
}

function normalizeHydratedFindings(items: readonly Record<string, unknown>[] | undefined): AuditFinding[] {
  return (items ?? []).flatMap((item) => {
    if (
      typeof item.file !== "string" ||
      typeof item.description !== "string" ||
      (item.severity !== "critical" && item.severity !== "warning" && item.severity !== "suggestion")
    ) {
      return [];
    }

    return [
      {
        file: item.file,
        description: item.description,
        severity: item.severity,
      },
    ];
  });
}

const CONCERN_AUDIT_BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const CONCERN_AUDIT_EXTENSION_TOOLS = ["read", "grep", "find", "ls", "bash", "skill"];

export class ConcernBatchError extends Schema.TaggedErrorClass<ConcernBatchError>()(
  "ConcernBatchError",
  { message: Schema.String },
) {}

export interface ConcernBatchResult {
  taskId: string;
  notes: string;
}

function buildConcernAuditSystemPrompt(
  state: Extract<AuditState, { _tag: "Auditing" }>,
  concern: AuditConcernTask,
  principles: string | undefined,
): string {
  const principlesBlock = principles ? `\n\n${principles}` : "";
  return `[AUDIT MODE — CONCERN ${concern.order}/${state.concerns.length}]\n\nCurrent concern: ${concern.subject} — ${concern.metadata.description}${principlesBlock}`;
}

function normalizeConcernAuditNotes(text: string): string {
  return text.replace(PHASE_MARKERS.auditing, "").trim();
}

export function runConcernBatch(
  state: Extract<AuditState, { _tag: "Auditing" }>,
  cwd: string,
  sessionId: string,
  principles: string | undefined,
  signal?: AbortSignal,
): Effect.Effect<ReadonlyArray<ConcernBatchResult>, ConcernBatchError, GraphRuntime | PiSpawnService> {
  return Effect.gen(function* () {
    const graphRuntime = yield* GraphRuntime;
    const spawn = yield* PiSpawnService;

    const results = yield* graphRuntime.runFrontier(
      state.cursor.frontierTaskIds,
      (taskId) =>
        Effect.gen(function* () {
          const concern = state.concerns.find((item) => item.id === taskId);
          if (!concern) {
            return yield* Effect.fail(
              new ConcernBatchError({
                message: `audit: missing concern for task ${taskId}`,
              }),
            );
          }

          const result = yield* spawn.spawn({
            cwd,
            task: buildConcernAuditPrompt(state, concern),
            builtinTools: CONCERN_AUDIT_BUILTIN_TOOLS,
            extensionTools: CONCERN_AUDIT_EXTENSION_TOOLS,
            systemPromptBody: buildConcernAuditSystemPrompt(state, concern, principles),
            signal,
            sessionId,
          });
          const output = getFinalOutput(result.messages).trim();
          const isError =
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted" ||
            !PHASE_MARKERS.auditing.test(output);

          if (isError) {
            return yield* Effect.fail(
              new ConcernBatchError({
                message:
                  result.errorMessage ||
                  result.stderr ||
                  output ||
                  `audit: concern ${concern.subject} failed`,
              }),
            );
          }

          return {
            taskId,
            notes: normalizeConcernAuditNotes(output),
          } satisfies ConcernBatchResult;
        }),
      AUDIT_GRAPH_POLICY,
    );

    return results.map((result) => result.value);
  });
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
  if (!ctx.hasUI) return;

  ctx.ui.setStatus("audit", getAuditStatusText(state));

  if (state._tag === "Auditing") {
    const widget = renderTaskWidget(state.concerns, { theme: ctx.ui.theme });
    ctx.ui.setWidget("audit-progress", widget.lines);
  } else if (state._tag === "Fixing") {
    const lines = state.findings.map((finding, index) => {
      const marker =
        index < state.currentFinding ? "✓" : index === state.currentFinding ? "▸" : "○";
      const phase =
        index === state.currentFinding && state.phase !== "running" ? ` (${state.phase})` : "";
      return `  ${marker} [${finding.severity}] ${finding.file}${phase}`;
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
  const concernRuntime = ManagedRuntime.make(Layer.mergeAll(GraphRuntime.layer, PiSpawnService.layer));
  const executor = createInlineExecutionExecutor(pi);
  let activeConcernBatchAbort: AbortController | undefined;

  pi.on("session_shutdown" as any, async () => {
    activeConcernBatchAbort?.abort();
    activeConcernBatchAbort = undefined;
    await Promise.all([gitRuntime.dispose(), concernRuntime.dispose()]);
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
              return;
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
        toEvent: (_state, _event, ctx): AuditEvent => {
          const entries = ctx.sessionManager.getEntries();
          const auditEntry = entries
            .filter((entry: any) => entry.type === "custom" && entry.customType === "audit")
            .pop() as { data?: PersistPayload } | undefined;
          const data = auditEntry?.data;
          const mode = data?.mode;
          const scope = data?.scope === "diff" || data?.scope === "paths" ? data.scope : undefined;
          const concerns = normalizeHydratedConcernTasks(
            Array.isArray(data?.concerns) ? (data.concerns as Record<string, unknown>[]) : undefined,
          );
          const findings = normalizeHydratedFindings(
            Array.isArray(data?.findings) ? (data.findings as Record<string, unknown>[]) : undefined,
          );
          const skillCatalog = normalizeHydratedSkillCatalog(
            Array.isArray(data?.skillCatalog)
              ? (data.skillCatalog as Record<string, unknown>[])
              : undefined,
          );
          const concernCursor = normalizeHydratedConcernCursor(data?.concernCursor);
          const currentFinding =
            typeof data?.currentFinding === "number" ? data.currentFinding : undefined;
          const phase =
            data?.phase === "running" || data?.phase === "gating" || data?.phase === "counseling"
              ? data.phase
              : undefined;

          return {
            _tag: "Hydrate",
            mode,
            scope,
            concerns,
            diffStat: data?.diffStat ?? "",
            targetPaths: Array.isArray(data?.targetPaths)
              ? data.targetPaths.filter((value): value is string => typeof value === "string")
              : [],
            skillCatalog,
            userPrompt: data?.userPrompt ?? "",
            concernCursor,
            findings,
            currentFinding,
            phase,
          };
        },
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
      if (isExecutionEffect(effect)) {
        executor.execute(effect.request, ctx);
        return;
      }
      if (effect.type === "persistState") {
        if (effect.state.mode !== "Auditing") {
          activeConcernBatchAbort?.abort();
          activeConcernBatchAbort = undefined;
        }
        pi.appendEntry("audit", effect.state);
        return;
      }
      if (effect.type === "runConcernBatch") {
        activeConcernBatchAbort?.abort();
        const batchAbort = new AbortController();
        activeConcernBatchAbort = batchAbort;
        const principles = readPrinciples();
        const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";

        concernRuntime
          .runPromise(
            runConcernBatch(
              effect.state,
              ctx.cwd,
              sessionId,
              principles,
              batchAbort.signal,
            ),
          )
          .then((results) => {
            if (activeConcernBatchAbort !== batchAbort || batchAbort.signal.aborted) return;
            for (const result of results) {
              machine.send({
                _tag: "ConcernAudited",
                taskId: result.taskId,
                notes: result.notes,
              });
            }
            if (activeConcernBatchAbort === batchAbort) {
              activeConcernBatchAbort = undefined;
            }
          })
          .catch((err) => {
            if (activeConcernBatchAbort !== batchAbort || batchAbort.signal.aborted) return;
            batchAbort.abort();
            const message =
              err instanceof ConcernBatchError
                ? err.message
                : `audit: concern batch failed: ${String(err)}`;
            machine.send({ _tag: "ConcernAuditFailed", message });
            if (activeConcernBatchAbort === batchAbort) {
              activeConcernBatchAbort = undefined;
            }
          });
        return;
      }
      if (effect.type === "updateUI") {
        formatUI(machine.getState(), ctx);
      }
    },
  );

  // ----- /audit command (imperative — async git work) -----
  pi.registerCommand("audit", {
    description: "Audit branch changes or explicit paths with skill-aware parallel subagents",
    handler: async (_args, ctx) => {
      if (machine.getState()._tag !== "Idle") {
        ctx.ui.notify("Audit already in progress. /audit-cancel to stop.", "info");
        return;
      }

      const parsedArgs = parseAuditScopeArgs(_args, ctx.cwd);
      if (parsedArgs.invalidPaths.length > 0) {
        ctx.ui.notify(
          `Invalid audit path${parsedArgs.invalidPaths.length > 1 ? "s" : ""}: ${parsedArgs.invalidPaths.join(", ")}`,
          "error",
        );
        return;
      }

      const skillCatalog = buildSkillCatalog(ctx.cwd);
      const targetPaths = parsedArgs.targetPaths.map((filePath) =>
        toAuditDisplayPath(filePath, ctx.cwd),
      );

      if (targetPaths.length > 0) {
        machine.send({
          _tag: "Start",
          scope: "paths",
          diffStat: "",
          targetPaths,
          skillCatalog,
          userPrompt: parsedArgs.userPrompt,
        });
        return;
      }

      const userPrompt = parsedArgs.userPrompt;
      const baseBranch = await resolveBaseBranch(ctx.cwd, gitRuntime);
      const diffStat = await getDiffStat(ctx.cwd, baseBranch, gitRuntime);
      const changedFiles = await getChangedFiles(ctx.cwd, baseBranch, gitRuntime);

      if (changedFiles.length === 0) {
        ctx.ui.notify(
          "No changes to audit. Pass a path to audit a file or directory explicitly.",
          "info",
        );
        return;
      }

      machine.send({
        _tag: "Start",
        scope: "diff",
        diffStat,
        targetPaths: changedFiles,
        skillCatalog,
        userPrompt,
      });
    },
  });
}

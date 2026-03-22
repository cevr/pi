/**
 * Modes extension — thin wiring layer.
 *
 * Delegates all state transitions to machine.ts via pi-state-machine.
 * Handles pi API interactions, theme formatting, file I/O, and async UI.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readPrinciples } from "@cvr/pi-brain-principles";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { gatherDiffContext, type DiffContext } from "@cvr/pi-diff-context";
import { createInlineExecutionExecutor, isExecutionEffect } from "@cvr/pi-execution";
import {
  createTaskList,
  TaskListItemSchema,
  type TaskListItem,
  type TaskListStatus,
} from "@cvr/pi-task-list";
import { TaskListStore, type TaskListScope } from "@cvr/pi-task-list-store";
import { TaskWidget, type WidgetUICtx } from "@cvr/pi-task-widget";
import { GitClient } from "@cvr/pi-git-client";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { register } from "@cvr/pi-state-machine";
import type { Command, StateObserver } from "@cvr/pi-state-machine";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import {
  AUTO_SIGNAL_TOOLS,
  EXECUTION_SIGNAL_TOOLS,
  SPEC_COUNSEL_TOOLS,
  SPEC_SIGNAL_TOOLS,
  SPEC_TOOLS,
  TASK_LIST_SIGNAL_TOOLS,
  modesReducer,
  type ModesEffect,
  type ModesEvent,
  type ModesState,
  type PersistPayload,
  type SpecDraft,
} from "./machine";
import { cleanStepText, isSafeCommand } from "./utils";
import { openSettingsMenu } from "./settings-menu";

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const PLANS_DIR = path.join(os.homedir(), ".pi", "plans");
const SPECS_DIR = path.join(os.homedir(), ".pi", "specs");

type EditorMode = "auto" | "spec";

type ModesExtConfig = {
  taskListScope: TaskListScope;
};

type ModesExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
};

export const CONFIG_DEFAULTS: ModesExtConfig = {
  taskListScope: "session",
};

export const DEFAULT_DEPS: ModesExtensionDeps = {
  getEnabledExtensionConfig,
};

function isTaskListScope(value: unknown): value is TaskListScope {
  return value === "memory" || value === "session" || value === "project";
}

function isModesConfig(value: Record<string, unknown>): value is ModesExtConfig {
  return isTaskListScope(value.taskListScope);
}

export const MODES_CONFIG_SCHEMA: ExtensionConfigSchema<ModesExtConfig> = {
  validate: isModesConfig,
};

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function buildSlug(seed: string, fallback: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

function generateArtifactPath(dir: string, seed: string, fallback: string): string {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return path.join(dir, `${timestamp}-${buildSlug(seed, fallback)}.md`);
}

function getFirstContentLine(text: string, fallback: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s*/, "").trim())
      .find((line) => line.length > 0) ?? fallback
  );
}

function generatePlanPath(firstStep: string): string {
  return generateArtifactPath(PLANS_DIR, firstStep, "task-list");
}

function generateSpecPath(specText: string): string {
  return generateArtifactPath(SPECS_DIR, getFirstContentLine(specText, "spec"), "spec");
}

function getChecklistMarker(status: TaskListStatus): string {
  return status === "completed" ? "x" : " ";
}

function writePlanFileToDisk(planPath: string, fullText: string, items: TaskListItem[]): void {
  ensureDir(PLANS_DIR);
  const checklist = items
    .map((task) => `- [${getChecklistMarker(task.status)}] ${task.order}. ${task.subject}`)
    .join("\n");
  fs.writeFileSync(
    planPath,
    `# Task List\n\n${checklist}\n\n---\n\n## Full Task List\n\n${fullText}\n`,
    "utf-8",
  );
}

function writeSpecFileToDisk(specPath: string, specText: string): void {
  ensureDir(SPECS_DIR);
  fs.writeFileSync(specPath, `${specText.trimEnd()}\n`, "utf-8");
}

function updatePlanFileToDisk(planPath: string, items: TaskListItem[]): void {
  if (!fs.existsSync(planPath)) return;

  const content = fs.readFileSync(planPath, "utf-8");
  const checklist = items
    .map((task) => `- [${getChecklistMarker(task.status)}] ${task.order}. ${task.subject}`)
    .join("\n");

  fs.writeFileSync(
    planPath,
    content.replace(/# Task List\n\n[\s\S]*?\n\n---/, `# Task List\n\n${checklist}\n\n---`),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Task/spec helpers
// ---------------------------------------------------------------------------

function buildTaskListFromSteps(steps: readonly string[]): TaskListItem[] {
  return createTaskList(steps.map((step) => cleanStepText(step)).filter((step) => step.length > 3));
}

const decodeTaskListItem = Schema.decodeUnknownOption(TaskListItemSchema);

function normalizeHydratedTaskList(items: readonly unknown[]): TaskListItem[] {
  const normalized: TaskListItem[] = [];

  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;

    const decoded = decodeTaskListItem(item);
    if (Option.isSome(decoded)) {
      normalized.push({
        ...decoded.value,
        blockedBy: [...decoded.value.blockedBy],
        metadata: decoded.value.metadata ? { ...decoded.value.metadata } : undefined,
      });
      continue;
    }

    const legacy = item as Record<string, unknown>;
    if (
      typeof legacy.step === "number" &&
      typeof legacy.text === "string" &&
      typeof legacy.completed === "boolean"
    ) {
      normalized.push({
        id: String(legacy.step),
        order: legacy.step,
        subject: legacy.text,
        status: legacy.completed ? "completed" : "pending",
        blockedBy: [],
      });
    }
  }

  return normalized;
}

function normalizeHydratedSpec(value: unknown): SpecDraft | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).specText === "string"
  ) {
    const spec = value as Record<string, unknown>;
    return {
      specText: spec.specText as string,
      specFilePath: typeof spec.specFilePath === "string" ? spec.specFilePath : null,
    };
  }
  return undefined;
}

function buildHydrateEvent(
  data: PersistPayload | undefined,
  pi: ExtensionAPI,
): Extract<ModesEvent, { _tag: "Hydrate" }> {
  const mode =
    (data?.mode as string) === "AwaitingSpecApproval" ? ("SpecReview" as const) : data?.mode;
  const pendingData = data?.pending;
  const rawTodoItems = pendingData?.todoItems ?? data?.todoItems;
  const todoItems = normalizeHydratedTaskList(Array.isArray(rawTodoItems) ? rawTodoItems : []);
  const pending = pendingData
    ? {
        ...pendingData,
        todoItems,
      }
    : undefined;
  const planFilePath = pending?.planFilePath ?? data?.planFilePath ?? null;
  const savedTools = data?.savedTools ?? null;
  const currentStep = typeof data?.currentStep === "number" ? data.currentStep : null;
  const phase =
    data?.phase === "running" || data?.phase === "counseling"
      ? data.phase
      : (data?.phase as string | undefined) === "gating"
        ? ("running" as const)
        : undefined;
  const spec = normalizeHydratedSpec(data?.spec);

  return {
    _tag: "Hydrate",
    mode,
    todoItems,
    planFilePath,
    savedTools,
    pending,
    spec,
    flagSpec: pi.getFlag("spec") === true,
    flagPlan: pi.getFlag("plan") === true,
    currentStep,
    phase,
    currentTools: pi.getActiveTools(),
  };
}

function getLatestPersistedModesState(entries: readonly unknown[]): PersistPayload | undefined {
  const entry = entries
    .filter((entry: any) => entry.type === "custom" && entry.customType === "modes")
    .pop() as { data?: PersistPayload } | undefined;
  return entry?.data;
}

function createTaskListStoreRuntime(ctx: ExtensionContext, scope: TaskListScope) {
  return TaskListStore.runtime({
    cwd: ctx.cwd,
    scope,
    sessionId: ctx.sessionManager.getSessionId(),
  });
}

async function persistTaskListSnapshot(
  ctx: ExtensionContext,
  scope: TaskListScope,
  todoItems: readonly TaskListItem[],
) {
  const runtime = createTaskListStoreRuntime(ctx, scope);
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* TaskListStore;
      yield* store.save(todoItems);
    }),
  );
}

async function clearTaskListSnapshot(ctx: ExtensionContext, scope: TaskListScope) {
  const runtime = createTaskListStoreRuntime(ctx, scope);
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* TaskListStore;
      yield* store.clear;
    }),
  );
}

async function loadTaskListSnapshot(
  ctx: ExtensionContext,
  scope: TaskListScope,
): Promise<TaskListItem[] | null> {
  const runtime = createTaskListStoreRuntime(ctx, scope);
  const snapshot = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* TaskListStore;
      return yield* store.load;
    }),
  );
  return Option.isSome(snapshot) ? snapshot.value.tasks : null;
}

function getEditorMode(state: ModesState): EditorMode {
  return state._tag === "Spec" || state._tag === "SpecCounseling" ? "spec" : "auto";
}

// ---------------------------------------------------------------------------
// UI formatting (theme-dependent — can't live in pure reducer)
// ---------------------------------------------------------------------------

function formatUI(
  state: ModesState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  taskWidget: TaskWidget,
): void {
  pi.events.emit("editor:set-mode", { mode: getEditorMode(state) });
  if (!ctx.hasUI) return;

  taskWidget.setUICtx(ctx.ui as unknown as WidgetUICtx);

  switch (state._tag) {
    case "Executing": {
      taskWidget.setPhase(state.phase);

      // Sync active task tracking with current step
      const currentTask =
        state.currentStep !== null
          ? state.todoItems.find((t) => t.order === state.currentStep)
          : undefined;
      if (currentTask && currentTask.status === "in_progress") {
        taskWidget.setActiveTask(currentTask.id);
      }

      ctx.ui.setStatus("modes", taskWidget.getStatusText(ctx.ui.theme));
      taskWidget.update();
      break;
    }
    case "Spec":
      ctx.ui.setStatus("modes", ctx.ui.theme.fg("toolTitle", "⏸ spec"));
      taskWidget.dispose();
      break;
    case "SpecCounseling":
      ctx.ui.setStatus("modes", ctx.ui.theme.fg("toolTitle", "⏸ spec counsel"));
      taskWidget.dispose();
      break;
    case "SpecReview":
      ctx.ui.setStatus("modes", ctx.ui.theme.fg("toolTitle", "⏸ spec review"));
      taskWidget.dispose();
      break;
    case "Auto":
      ctx.ui.setStatus("modes", undefined);
      taskWidget.dispose();
      break;
  }
}

// ---------------------------------------------------------------------------
// Diff context formatting
// ---------------------------------------------------------------------------

function buildDiffContextBlock(diffContext: DiffContext): string {
  if (diffContext.changedFiles.length === 0) return "";

  const files = diffContext.changedFiles.map((file) => `- ${file}`).join("\n");
  const skills =
    diffContext.skillCatalog.length > 0
      ? `\n\n## Available Skills\n${diffContext.skillCatalog.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
      : "";

  return `\n\n## Branch Changes (vs ${diffContext.baseBranch})\n${diffContext.diffStat}\n\n${files}${skills}`;
}

async function tryGatherDiffContext(
  cwd: string,
  gitRuntime: ManagedRuntime.ManagedRuntime<GitClient, never>,
): Promise<DiffContext | undefined> {
  try {
    const diffContext = await gatherDiffContext(cwd, gitRuntime);
    return diffContext.changedFiles.length === 0 ? undefined : diffContext;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export function createModesExtension(deps: ModesExtensionDeps = DEFAULT_DEPS) {
  return function modesExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-modes",
      CONFIG_DEFAULTS,
      {
        schema: MODES_CONFIG_SCHEMA,
        allowProjectConfig: true,
        cwd: process.cwd(),
      },
    );
    if (!enabled) return;

    const gitRuntime = ManagedRuntime.make(
      GitClient.layer.pipe(Layer.provide(ProcessRunner.layer)),
    );
    const executor = createInlineExecutionExecutor(pi);

    // ----- System reminder state (hybrid: only in Executing, N turns without step_done) -----
    const SIGNAL_TOOL_NAMES: Set<string> = new Set([
      ...AUTO_SIGNAL_TOOLS,
      ...SPEC_SIGNAL_TOOLS,
      ...TASK_LIST_SIGNAL_TOOLS,
      ...EXECUTION_SIGNAL_TOOLS,
    ]);
    const REMINDER_INTERVAL = 6;
    let turnsSinceLastStepSignal = 0;
    const SYSTEM_REMINDER = `<system-reminder>
You are executing a task list. The current step hasn't been marked complete recently.
If the current step is finished, call modes_step_done with the step number.
If you're still working on it, continue — this is just a gentle reminder.
Do not mention this reminder to the user.
</system-reminder>`;

    // ----- Task widget (animated) -----
    // getTasks closure is updated once the machine is registered (below).
    let getTasksForWidget: () => readonly TaskListItem[] = () => [];
    const taskWidget = new TaskWidget(() => getTasksForWidget());

    pi.on("session_shutdown" as any, async () => {
      taskWidget.dispose();
      await gitRuntime.dispose();
    });

    // ----- Turn tracking + system reminder injection -----
    pi.on("turn_start", async () => {
      turnsSinceLastStepSignal++;
    });

    pi.on("tool_result", async (event) => {
      const state = machine?.getState();
      if (!state || state._tag !== "Executing") return {};

      if (SIGNAL_TOOL_NAMES.has(event.toolName)) {
        turnsSinceLastStepSignal = 0;
        return {};
      }

      if (turnsSinceLastStepSignal < REMINDER_INTERVAL) return {};

      turnsSinceLastStepSignal = 0;
      return {
        content: [...(event.content ?? []), { type: "text" as const, text: SYSTEM_REMINDER }],
      };
    });

    // ----- Token usage tracking (feeds into animated widget) -----
    pi.on("turn_end", async (event) => {
      const msg = event.message as unknown as Record<string, unknown> | undefined;
      if (msg?.role === "assistant" && typeof msg.usage === "object" && msg.usage !== null) {
        const usage = msg.usage as Record<string, unknown>;
        taskWidget.addTokenUsage(
          typeof usage.input === "number" ? usage.input : 0,
          typeof usage.output === "number" ? usage.output : 0,
        );
      }
    });

    // ----- Effect interpreter -----
    function interpretEffect(effect: ModesEffect, pi: ExtensionAPI, ctx: ExtensionContext): void {
      if (isExecutionEffect(effect)) {
        executor.execute(effect.request, ctx);
        return;
      }

      switch (effect.type) {
        case "writePlanFile":
          writePlanFileToDisk(effect.planFilePath, effect.planText, effect.todoItems);
          break;
        case "writeSpecFile":
          writeSpecFileToDisk(effect.specFilePath, effect.specText);
          break;
        case "updatePlanFile":
          updatePlanFileToDisk(effect.planFilePath, effect.todoItems);
          break;
        case "persistTaskList":
          void persistTaskListSnapshot(ctx, cfg.taskListScope, effect.todoItems).catch(
            () => undefined,
          );
          break;
        case "clearTaskList":
          void clearTaskListSnapshot(ctx, cfg.taskListScope).catch(() => undefined);
          break;
        case "persistState":
          pi.appendEntry("modes", effect.state);
          break;
        case "updateUI":
          formatUI(machine.getState(), pi, ctx, taskWidget);
          break;
      }
    }

    // ----- Commands (machine-scoped, synchronous) -----
    const commands: Command<ModesState, ModesEvent>[] = [];

    // ----- Signal tools -----
    pi.registerTool({
      name: AUTO_SIGNAL_TOOLS[0],
      label: "Enter Spec Mode",
      description:
        "Signal that the current work needs deeper specification before execution and switch into SPEC mode.",
      promptSnippet: "Signal when AUTO mode should switch into SPEC mode for deeper planning.",
      promptGuidelines: [
        "In AUTO mode, call this tool when the request still needs design, scoping, discovery, or a PRD before it can become an executable task list. Call it early — before writing speculative prose.",
      ],
      parameters: Type.Object({
        prompt: Type.String({
          minLength: 1,
          description: "A focused prompt telling SPEC mode what to clarify, design, or write up.",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = machine.getState();
        if (state._tag !== "Auto") {
          return {
            content: [{ type: "text" as const, text: "AUTO mode is not currently active." }],
            details: {},
            isError: true,
          };
        }

        const prompt = params.prompt.trim();
        if (!prompt) {
          return {
            content: [{ type: "text" as const, text: "A spec prompt is required." }],
            details: {},
            isError: true,
          };
        }

        machine.send({
          _tag: "SpecWithPrompt",
          prompt,
          currentTools: pi.getActiveTools(),
          diffContext: await tryGatherDiffContext(ctx.cwd, gitRuntime),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: "Switched to SPEC mode. Draft the spec, then call modes_spec_ready when it is ready.",
            },
          ],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: SPEC_SIGNAL_TOOLS[0],
      label: "Spec Ready",
      description: "Signal that spec drafting is complete and the spec should be persisted.",
      promptSnippet:
        "In SPEC mode, call this tool ONLY AFTER your spec/PRD is fully written and complete.",
      promptGuidelines: [
        "In SPEC mode, call this tool ONLY AFTER your spec/PRD is fully written and complete. The specText parameter must contain the final, complete spec. Do not call this tool before you have finished drafting.",
      ],
      parameters: Type.Object({
        specText: Type.String({ description: "The full spec or PRD markdown/text." }),
      }),
      async execute(_toolCallId, params) {
        const state = machine.getState();
        if (state._tag !== "Spec") {
          return {
            content: [{ type: "text" as const, text: "SPEC mode is not currently active." }],
            details: {},
            isError: true,
          };
        }

        machine.send({
          _tag: "SpecReady",
          spec: {
            specText: params.specText,
            specFilePath: generateSpecPath(params.specText),
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: "Spec captured. Review the draft and approve, reject, or edit it before AUTO mode extracts the task list.",
            },
          ],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: TASK_LIST_SIGNAL_TOOLS[0],
      label: "Task List Ready",
      description:
        "Signal that an executable task list is ready so modes can persist it and begin execution.",
      promptSnippet:
        "In AUTO mode, call this tool ONLY AFTER you have fully produced the executable task list.",
      promptGuidelines: [
        "In AUTO mode, call this tool ONLY AFTER you have fully produced the executable task list. The steps array must contain all steps. Do not call this before the task list is complete.",
      ],
      parameters: Type.Object({
        planText: Type.String({ description: "The full task list markdown/text." }),
        steps: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          description: "Ordered implementation steps for the executable task list.",
        }),
      }),
      async execute(_toolCallId, params) {
        const state = machine.getState();
        if (state._tag !== "Auto") {
          return {
            content: [
              {
                type: "text" as const,
                text: "AUTO mode is not currently waiting for a task list.",
              },
            ],
            details: {},
            isError: true,
          };
        }

        const todoItems = buildTaskListFromSteps(params.steps);
        if (todoItems.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "At least one valid task-list step is required." },
            ],
            details: {},
            isError: true,
          };
        }

        machine.send({
          _tag: "TaskListReady",
          currentTools: pi.getActiveTools(),
          pending: {
            todoItems,
            planText: params.planText,
            planFilePath: generatePlanPath(todoItems[0]!.subject),
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: "Task list captured. Execution has started.",
            },
          ],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: EXECUTION_SIGNAL_TOOLS[0],
      label: "Step Done",
      description: "Signal that the current execution step is complete and ready for gating.",
      promptSnippet:
        "During execution, call this tool ONLY AFTER you have fully completed a step's implementation.",
      promptGuidelines: [
        "During execution, call this tool ONLY AFTER you have fully completed the step's implementation. All code changes for the step must be done before calling this. Do not call this preemptively.",
      ],
      parameters: Type.Object({
        step: Type.Number({ minimum: 1, description: "Completed step number." }),
        summary: Type.Optional(Type.String({ description: "Optional summary of what changed." })),
      }),
      async execute(_toolCallId, params) {
        const state = machine.getState();
        if (state._tag !== "Executing" || state.phase !== "running") {
          return {
            content: [
              { type: "text" as const, text: "A running execution step is not active right now." },
            ],
            details: {},
            isError: true,
          };
        }

        if (!state.todoItems.some((task) => task.order === params.step)) {
          return {
            content: [{ type: "text" as const, text: `Unknown plan step: ${params.step}.` }],
            details: {},
            isError: true,
          };
        }
        if (state.currentStep !== null && state.currentStep !== params.step) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Step ${state.currentStep} is currently active. Finish that step before marking step ${params.step} done.`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        turnsSinceLastStepSignal = 0;
        machine.send({ _tag: "StepDone", step: params.step });
        return {
          content: [
            {
              type: "text" as const,
              text: `Recorded step ${params.step} as complete. Run counsel next.`,
            },
          ],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: EXECUTION_SIGNAL_TOOLS[1],
      label: "Counsel Result",
      description: "Signal whether counsel approved the current step or found issues.",
      promptSnippet: "Signal counsel results during plan execution.",
      promptGuidelines: [
        "After running counsel, call this tool with the result instead of emitting COUNSEL_PASS or COUNSEL_FAIL.",
      ],
      parameters: Type.Object({
        status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
        summary: Type.Optional(Type.String({ description: "Optional counsel summary." })),
      }),
      async execute(_toolCallId, params) {
        const state = machine.getState();
        const inExecCounseling = state._tag === "Executing" && state.phase === "counseling";
        const inSpecCounseling = state._tag === "SpecCounseling";
        if (!inExecCounseling && !inSpecCounseling) {
          return {
            content: [{ type: "text" as const, text: "Counsel is not active right now." }],
            details: {},
            isError: true,
          };
        }

        machine.send({ _tag: "CounselResult", status: params.status });

        if (inSpecCounseling) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  params.status === "pass"
                    ? "Counsel approved the spec. Presenting to the user for review."
                    : "Counsel found issues with the spec. Revise and resubmit.",
              },
            ],
            details: {},
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                params.status === "pass"
                  ? "Counsel approved. Continue the plan."
                  : "Counsel found issues. Address them before continuing.",
            },
          ],
          details: {},
        };
      },
    });

    // ----- Observer: SpecReview async UI -----
    const specReviewObserver: StateObserver<ModesState, ModesEvent> = {
      match: (state) => state._tag === "SpecReview",
      handler: async (state, sendIfCurrent, ctx) => {
        if (state._tag !== "SpecReview") {
          return;
        }
        if (!ctx.hasUI) {
          sendIfCurrent({ _tag: "ApproveSpec" });
          return;
        }

        const choice = await ctx.ui.select("Spec ready — approve, reject, or edit?", [
          "Approve spec",
          "Reject spec",
          "Edit spec",
        ]);

        if (choice === "Approve spec") {
          sendIfCurrent({ _tag: "ApproveSpec" });
          return;
        }

        if (choice === "Edit spec") {
          const edited = await ctx.ui.editor(
            "Edit spec — describe what should change",
            `Current spec:\n\n${state.spec.specText}\n\nDescribe the edits you want made:\n`,
          );
          if (!edited?.trim()) {
            sendIfCurrent({ _tag: "RejectSpec" });
            return;
          }
          sendIfCurrent({ _tag: "EditSpec", feedback: edited.trim() });
          return;
        }

        sendIfCurrent({ _tag: "RejectSpec" });
      },
    };

    // ----- Register machine -----
    const machine = register<ModesState, ModesEvent, ModesEffect>(
      pi,
      {
        id: "modes",
        initial: { _tag: "Auto" },
        reducer: modesReducer,

        events: {
          tool_call: {
            mode: "reply",
            handle: (state, event) => {
              if (state._tag === "SpecReview") {
                return {
                  block: true,
                  reason:
                    "SPEC mode is waiting for the user's spec approval choice. Do not continue with more tools until the choice is resolved.",
                };
              }
              if (state._tag === "SpecCounseling") {
                const allowed = new Set(SPEC_COUNSEL_TOOLS);
                if (!allowed.has(event.toolName)) {
                  return {
                    block: true,
                    reason: `Spec counsel is in progress. Only counsel and modes_counsel_result are expected right now.`,
                  };
                }
                if (event.toolName === "bash") {
                  const command = event.input.command as string;
                  if (!isSafeCommand(command)) {
                    return {
                      block: true,
                      reason: `Spec counsel: command blocked (not allowlisted).\nCommand: ${command}`,
                    };
                  }
                }
                return;
              }
              if (state._tag !== "Spec") return;
              if (event.toolName !== "bash") return;
              const command = event.input.command as string;
              if (!isSafeCommand(command)) {
                return {
                  block: true,
                  reason: `SPEC mode: command blocked (not allowlisted). Use Shift+Tab or /spec to return to AUTO mode first.\nCommand: ${command}`,
                };
              }
            },
          },

          context: {
            mode: "reply",
            handle: (state, event) => ({
              messages: event.messages.filter((message: any) => {
                if (message.customType === "modes-context:auto") return false;
                if (message.customType === "modes-context:spec") return false;
                if (message.customType === "modes-context:spec-counsel") return false;
                if (message.customType === "modes-context:spec-review") return false;
                if (message.customType === "modes-context:executing") return false;
                if (message.customType === "modes-context:auto-task-list") return false;
                if (
                  typeof message.customType === "string" &&
                  message.customType.startsWith("modes-execution:") &&
                  message.customType !== "modes-execution:start" &&
                  message.customType !== "modes-execution:complete"
                ) {
                  return false;
                }
                if (message.role !== "user") return true;
                if (state._tag === "Auto") {
                  const content = message.content;
                  if (typeof content === "string") return !content.includes("[SPEC MODE ACTIVE]");
                  if (Array.isArray(content)) {
                    return !content.some(
                      (block: any) =>
                        block.type === "text" && block.text?.includes("[SPEC MODE ACTIVE]"),
                    );
                  }
                }
                return true;
              }),
            }),
          },

          before_agent_start: {
            mode: "reply",
            handle: (state) => {
              if (state._tag === "Auto") {
                const specBlock = state.spec
                  ? (() => {
                      const specRef = state.spec.specFilePath
                        ? `Read the saved spec at: ${state.spec.specFilePath}`
                        : `Use this spec as the source of truth:\n\n${state.spec.specText}`;
                      return (
                        `\n\nYou have an approved spec. ${specRef}\n\n` +
                        `Convert the spec into an executable task list, then call ${TASK_LIST_SIGNAL_TOOLS[0]} with:\n` +
                        "- planText: the full executable task list markdown/text\n" +
                        "- steps: the ordered implementation steps\n\n" +
                        "After calling the tool, execution will begin through the modes state machine. Do not continue manually beyond that point."
                      );
                    })()
                  : "";
                return {
                  message: {
                    customType: "modes-context:auto",
                    content: `[AUTO MODE ACTIVE]
You are in auto mode - normal working mode.

If the request is ready for execution, produce an executable task list and call ${TASK_LIST_SIGNAL_TOOLS[0]}.
After that tool call, modes will persist the task list and start execution.
If the request still needs design, scoping, discovery, or a spec before it can become executable, call ${AUTO_SIGNAL_TOOLS[0]} with:
- prompt: what SPEC mode should clarify or produce

Do not stay in AUTO mode and write a long speculative PRD when the work clearly needs SPEC mode first. Escalate with ${AUTO_SIGNAL_TOOLS[0]}.${specBlock}`,
                    display: false,
                  },
                };
              }

              if (state._tag === "Spec") {
                const principles = readPrinciples();
                const principlesBlock = principles ? `\n\n${principles}` : "";
                const diffBlock = state.diffContext ? buildDiffContextBlock(state.diffContext) : "";
                return {
                  message: {
                    customType: "modes-context:spec",
                    content: `[SPEC MODE ACTIVE]
You are in spec mode - a read-only exploration mode for safe analysis, PRDs, and specs.

Restrictions:
- You can only use: ${SPEC_TOOLS.join(", ")}
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands
- Use the interview tool to ask the user clarifying questions about scope

When your spec is ready, call ${SPEC_SIGNAL_TOOLS[0]} with:
- specText: the full spec/PRD markdown/text

IMPORTANT: Only call ${SPEC_SIGNAL_TOOLS[0]} AFTER your spec is fully drafted and complete. The specText must be the final content. Do NOT call it prematurely — finish writing first, then signal.

Do NOT generate executable task lists in SPEC mode.
Do NOT attempt to make changes - just describe the spec, then call ${SPEC_SIGNAL_TOOLS[0]}.${diffBlock}${principlesBlock}`,
                    display: false,
                  },
                };
              }

              if (state._tag === "SpecCounseling") {
                return {
                  message: {
                    customType: "modes-context:spec-counsel",
                    content: `[SPEC COUNSEL IN PROGRESS]
Run counsel to review the spec, then call modes_counsel_result with pass or fail.
Do not skip counsel. Do not present the spec to the user yet.`,
                    display: false,
                  },
                };
              }

              if (state._tag === "SpecReview") {
                return {
                  message: {
                    customType: "modes-context:spec-review",
                    content: `[SPEC REVIEW — WAITING FOR USER]
The spec is under user review. Do not continue working until the user approves, rejects, or edits.`,
                    display: false,
                  },
                };
              }

              if (state._tag === "Executing" && state.todoItems.length > 0) {
                const principles = readPrinciples();
                const principlesBlock = principles ? `\n\n${principles}` : "";
                const remaining = state.todoItems.filter((task) => task.status !== "completed");
                const todoList = remaining
                  .map((task) => {
                    const prefix = task.status === "in_progress" ? "◼" : "◻";
                    return `${task.order}. ${prefix} ${task.subject}`;
                  })
                  .join("\n");
                const planRef = state.planFilePath
                  ? `\n\nThe full task list is saved at: ${state.planFilePath}\nRead it if you need the full context.`
                  : "";
                return {
                  message: {
                    customType: "modes-context:executing",
                    content: `[EXECUTING TASK LIST - Full tool access enabled]

Remaining steps:
${todoList}${planRef}

Use ${EXECUTION_SIGNAL_TOOLS[0]} when a step is complete.
Use ${EXECUTION_SIGNAL_TOOLS[1]} after counsel review.

IMPORTANT: Only call ${EXECUTION_SIGNAL_TOOLS[0]} AFTER you have fully completed all code changes for the current step. Do NOT call it before the work is done.
Run the project's checks (typecheck, lint, test) before calling counsel. Then call modes_counsel_result with the counsel verdict.

Execute each step in order. Do not emit [DONE:n], COUNSEL_PASS, or COUNSEL_FAIL text markers — use the signal tools instead.${principlesBlock}`,
                    display: false,
                  },
                };
              }
            },
          },

          session_switch: {
            mode: "fire",
            toEvent: (_state, _event, ctx): ModesEvent => {
              const data = getLatestPersistedModesState(ctx.sessionManager.getEntries());
              return buildHydrateEvent(data, pi);
            },
          },

          session_start: {
            mode: "fire",
            toEvent: (_state, _event, ctx): ModesEvent => {
              const data = getLatestPersistedModesState(ctx.sessionManager.getEntries());
              return buildHydrateEvent(data, pi);
            },
          },
        },

        commands,

        shortcuts: [
          {
            key: Key.shift("tab"),
            description: "Toggle AUTO/SPEC mode",
            toEvent: (): ModesEvent => ({ _tag: "Toggle", currentTools: pi.getActiveTools() }),
          },
        ],

        observers: [specReviewObserver],

        flags: [
          {
            name: "spec",
            description: "Start in SPEC mode (read-only exploration)",
            type: "boolean",
            default: false,
          },
        ],
      },
      interpretEffect,
    );

    // Wire the widget's task source to the machine's live state
    getTasksForWidget = () => {
      const state = machine.getState();
      return state._tag === "Executing" ? state.todoItems : [];
    };

    const restoreSnapshotIfNeeded = async (ctx: ExtensionContext) => {
      const restoredTodoItems = await loadTaskListSnapshot(ctx, cfg.taskListScope).catch(
        () => null,
      );
      if (!restoredTodoItems || restoredTodoItems.length === 0) return;

      const state = machine.getState();
      const canRestore =
        (state._tag === "Auto" || state._tag === "Spec" || state._tag === "SpecReview") &&
        (state._tag === "Auto" || !state.pending);
      if (!canRestore) return;

      machine.send({
        _tag: "RestoreTaskList",
        todoItems: restoredTodoItems,
        currentTools: pi.getActiveTools(),
      });
    };

    pi.on("session_start", async (_event, ctx) => {
      await restoreSnapshotIfNeeded(ctx);
    });

    pi.on("session_switch", async (_event, ctx) => {
      await restoreSnapshotIfNeeded(ctx);
    });

    // ----- /todos command (interactive menu) -----
    pi.registerCommand("todos", {
      description: "Manage task list — view, clear completed, settings",
      handler: async (_args, ctx) => {
        const ui = ctx.ui;

        function getTodoItems(): TaskListItem[] {
          const state = machine.getState();
          if (state._tag === "Executing") return [...state.todoItems];
          if (
            state._tag === "Spec" ||
            state._tag === "SpecCounseling" ||
            state._tag === "SpecReview"
          ) {
            return state.pending?.todoItems ? [...state.pending.todoItems] : [];
          }
          return [];
        }

        function statusIcon(status: TaskListStatus): string {
          if (status === "completed") return "✔";
          if (status === "in_progress") return "◼";
          return "◻";
        }

        const mainMenu = async (): Promise<void> => {
          const items = getTodoItems();
          const taskCount = items.length;
          const completedCount = items.filter((t) => t.status === "completed").length;

          if (taskCount === 0) {
            ui.notify("No task list. Create one in AUTO mode.", "info");
            return;
          }

          const choices: string[] = [`View all tasks (${taskCount})`];
          if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
          if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
          choices.push("Settings");

          const choice = await ui.select("Task List", choices);
          if (!choice) return;

          if (choice.startsWith("View")) return viewTasks();
          if (choice.startsWith("Clear completed")) {
            // Clear completed tasks — notify only (actual state change happens via machine)
            ui.notify("Completed tasks cleared.", "info");
            return;
          }
          if (choice.startsWith("Clear all")) {
            ui.notify("All tasks cleared.", "info");
            return;
          }
          if (choice === "Settings") return settingsMenu();
        };

        const viewTasks = async (): Promise<void> => {
          const items = getTodoItems();
          if (items.length === 0) {
            await ui.select("No tasks", ["← Back"]);
            return mainMenu();
          }

          const choices = items.map(
            (t) => `${statusIcon(t.status)} #${t.order} [${t.status}] ${t.subject}`,
          );
          choices.push("← Back");

          const selected = await ui.select("Tasks", choices);
          if (!selected || selected === "← Back") return mainMenu();

          const match = selected.match(/#(\d+)/);
          if (match) return viewTaskDetail(Number(match[1]));
          return viewTasks();
        };

        const viewTaskDetail = async (order: number): Promise<void> => {
          const items = getTodoItems();
          const task = items.find((t) => t.order === order);
          if (!task) return viewTasks();

          const actions: string[] = [];
          if (task.status === "pending") actions.push("▸ Start (in_progress)");
          if (task.status === "in_progress") actions.push("✓ Complete");
          actions.push("← Back");

          const title = `#${task.order} [${task.status}] ${task.subject}`;
          const action = await ui.select(title, actions);

          if (!action || action === "← Back") return viewTasks();

          if (action === "▸ Start (in_progress)" || action === "✓ Complete") {
            ui.notify(
              `Task #${task.order} status change requested. Use the signal tools during execution.`,
              "info",
            );
          }
          return viewTasks();
        };

        const settingsMenu = async (): Promise<void> => {
          await openSettingsMenu(
            ui as any,
            ctx.cwd,
            cfg.taskListScope,
            (scope) => {
              cfg.taskListScope = scope;
            },
            mainMenu,
          );
        };

        await mainMenu();
      },
    });

    // ----- /spec command (imperative — async diff context gathering) -----
    pi.registerCommand("spec", {
      description:
        "Toggle SPEC mode. Shift+Tab also toggles it. /spec <prompt> enters SPEC mode and sends the prompt.",
      handler: async (args, ctx) => {
        const prompt = args.trim();
        const currentTools = pi.getActiveTools();
        const state = machine.getState();

        if (
          !prompt &&
          (state._tag === "Spec" ||
            state._tag === "SpecCounseling" ||
            state._tag === "SpecReview" ||
            state._tag === "Executing")
        ) {
          machine.send({ _tag: "Toggle", currentTools });
          return;
        }

        const diffContext = await tryGatherDiffContext(ctx.cwd, gitRuntime);

        if (prompt) {
          machine.send({ _tag: "SpecWithPrompt", prompt, currentTools, diffContext });
        } else {
          machine.send({ _tag: "Toggle", currentTools, diffContext });
        }
      },
    });
  };
}

const modesExtension: (pi: ExtensionAPI) => void = createModesExtension();

export default modesExtension;

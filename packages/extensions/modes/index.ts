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
import { gatherDiffContext, type DiffContext } from "@cvr/pi-diff-context";
import { createInlineExecutionExecutor, isExecutionEffect } from "@cvr/pi-execution";
import { createTaskList, type TaskListItem, type TaskListStatus } from "@cvr/pi-task-list";
import { renderTaskWidget } from "@cvr/pi-task-widget";
import { GitClient } from "@cvr/pi-git-client";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { register } from "@cvr/pi-state-machine";
import type { Command, StateObserver } from "@cvr/pi-state-machine";
import { Layer, ManagedRuntime } from "effect";
import {
  AUTO_SIGNAL_TOOLS,
  EXECUTION_SIGNAL_TOOLS,
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

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const PLANS_DIR = path.join(os.homedir(), ".pi", "plans");
const SPECS_DIR = path.join(os.homedir(), ".pi", "specs");

type EditorMode = "auto" | "spec";

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

function normalizeHydratedTaskList(items: readonly Record<string, unknown>[]): TaskListItem[] {
  return items.flatMap((item) => {
    if (
      typeof item.id === "string" &&
      typeof item.order === "number" &&
      typeof item.subject === "string" &&
      (item.status === "pending" || item.status === "in_progress" || item.status === "completed")
    ) {
      return [
        {
          id: item.id,
          order: item.order,
          subject: item.subject,
          status: item.status,
          blockedBy: Array.isArray(item.blockedBy)
            ? item.blockedBy.filter((value): value is string => typeof value === "string")
            : [],
          activeForm: typeof item.activeForm === "string" ? item.activeForm : undefined,
          owner: typeof item.owner === "string" ? item.owner : undefined,
          metadata:
            typeof item.metadata === "object" && item.metadata !== null
              ? (item.metadata as Record<string, unknown>)
              : undefined,
        },
      ];
    }

    if (
      typeof item.step === "number" &&
      typeof item.text === "string" &&
      typeof item.completed === "boolean"
    ) {
      return [
        {
          id: String(item.step),
          order: item.step,
          subject: item.text,
          status: item.completed ? "completed" : "pending",
          blockedBy: [],
        },
      ];
    }

    return [];
  });
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

function getEditorMode(state: ModesState): EditorMode {
  return state._tag === "Spec" ? "spec" : "auto";
}

// ---------------------------------------------------------------------------
// UI formatting (theme-dependent — can't live in pure reducer)
// ---------------------------------------------------------------------------

function formatUI(state: ModesState, pi: ExtensionAPI, ctx: ExtensionContext): void {
  pi.events.emit("editor:set-mode", { mode: getEditorMode(state) });
  if (!ctx.hasUI) return;

  switch (state._tag) {
    case "Executing": {
      const widget = renderTaskWidget(state.todoItems, {
        phase: state.phase,
        theme: ctx.ui.theme,
      });
      ctx.ui.setStatus("modes", widget.statusText);
      ctx.ui.setWidget("modes-todos", widget.lines);
      break;
    }
    case "Spec":
      ctx.ui.setStatus("modes", ctx.ui.theme.fg("toolTitle", "⏸ spec"));
      ctx.ui.setWidget("modes-todos", undefined);
      break;
    case "AwaitingChoice":
      ctx.ui.setStatus("modes", ctx.ui.theme.fg("toolTitle", "⏸ task list"));
      ctx.ui.setWidget("modes-todos", undefined);
      break;
    case "Auto":
      ctx.ui.setStatus("modes", undefined);
      ctx.ui.setWidget("modes-todos", undefined);
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

export default function modesExtension(pi: ExtensionAPI): void {
  const gitRuntime = ManagedRuntime.make(GitClient.layer.pipe(Layer.provide(ProcessRunner.layer)));
  const executor = createInlineExecutionExecutor(pi);

  pi.on("session_shutdown" as any, async () => {
    await gitRuntime.dispose();
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
      case "persistState":
        pi.appendEntry("modes", effect.state);
        break;
      case "updateUI":
        formatUI(machine.getState(), pi, ctx);
        break;
    }
  }

  // ----- Commands -----
  const commands: Command<ModesState, ModesEvent>[] = [
    {
      mode: "query",
      name: "todos",
      description: "Show current executable task list",
      handler: (state, _args, ctx): void => {
        const todoItems =
          state._tag === "Auto" || state._tag === "Spec"
            ? state.pending?.todoItems
            : state._tag === "AwaitingChoice"
              ? state.pending.todoItems
              : state._tag === "Executing"
                ? state.todoItems
                : undefined;
        if (!todoItems || todoItems.length === 0) {
          ctx.ui.notify("No task list. Create one in AUTO mode.", "info");
          return;
        }
        const list = todoItems
          .map((item) => {
            const marker =
              item.status === "completed" ? "✓" : item.status === "in_progress" ? "◼" : "○";
            return `${item.order}. ${marker} ${item.subject}`;
          })
          .join("\n");
        const planFilePath =
          state._tag === "Executing"
            ? state.planFilePath
            : state._tag === "AwaitingChoice"
              ? state.pending.planFilePath
              : (state.pending?.planFilePath ?? null);
        const pathInfo = planFilePath ? `\nTask list file: ${planFilePath}` : "";
        ctx.ui.notify(`Task List:\n${list}${pathInfo}`, "info");
      },
    },
  ];

  // ----- Signal tools -----
  pi.registerTool({
    name: AUTO_SIGNAL_TOOLS[0],
    label: "Enter Spec Mode",
    description:
      "Signal that the current work needs deeper specification before execution and switch into SPEC mode.",
    promptSnippet: "Signal when AUTO mode should switch into SPEC mode for deeper planning.",
    promptGuidelines: [
      "In AUTO mode, call this tool when the request still needs design, scoping, discovery, or a PRD before it can become an executable task list.",
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
    promptSnippet: "Signal when the spec is ready to save.",
    promptGuidelines: [
      "In SPEC mode, call this tool when your spec/PRD is ready instead of generating task lists.",
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
            text: "Spec captured. Return to AUTO mode to generate or refresh the executable task list.",
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
      "Signal that an executable task list is ready and the user must choose what happens next.",
    promptSnippet: "Signal when the executable task list is ready for user review and choice.",
    promptGuidelines: [
      "In AUTO mode, call this tool when you have produced an executable task list.",
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
            { type: "text" as const, text: "AUTO mode is not currently waiting for a task list." },
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
            text: "Task list captured. The system is now waiting for the user's choice. Do not continue until that choice is resolved.",
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
    promptSnippet: "Signal completed plan steps during execution.",
    promptGuidelines: [
      "During execution, call this tool when a plan step is complete instead of writing [DONE:n] tags.",
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

      machine.send({ _tag: "StepDone", step: params.step });
      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded step ${params.step} as ready for validation. Run the gate next.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: EXECUTION_SIGNAL_TOOLS[1],
    label: "Gate Result",
    description: "Signal whether the post-step validation gate passed or failed.",
    promptSnippet: "Signal gate results during plan execution.",
    promptGuidelines: [
      "After running the gate, call this tool with the result instead of emitting GATE_PASS or GATE_FAIL.",
    ],
    parameters: Type.Object({
      status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      summary: Type.Optional(Type.String({ description: "Optional gate summary." })),
    }),
    async execute(_toolCallId, params) {
      const state = machine.getState();
      if (state._tag !== "Executing" || state.phase !== "gating") {
        return {
          content: [{ type: "text" as const, text: "The plan gate is not active right now." }],
          details: {},
          isError: true,
        };
      }

      machine.send({ _tag: "GateResult", status: params.status });
      return {
        content: [
          {
            type: "text" as const,
            text:
              params.status === "pass"
                ? "Gate passed. Run counsel next."
                : "Gate failed. Fix the issues, then re-run the step validation.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: EXECUTION_SIGNAL_TOOLS[2],
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
      if (state._tag !== "Executing" || state.phase !== "counseling") {
        return {
          content: [{ type: "text" as const, text: "Counsel is not active right now." }],
          details: {},
          isError: true,
        };
      }

      machine.send({ _tag: "CounselResult", status: params.status });
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

  // ----- Observer: AwaitingChoice async UI -----
  const awaitingChoiceObserver: StateObserver<ModesState, ModesEvent> = {
    match: (state) => state._tag === "AwaitingChoice",
    handler: async (_state, sendIfCurrent, ctx) => {
      if (!ctx.hasUI) {
        sendIfCurrent({ _tag: "ChooseExecute" });
        return;
      }

      const choice = await ctx.ui.select("AUTO mode — what next?", [
        "Execute the task list",
        "Stay in AUTO mode",
        "Refine the task list",
      ]);

      if (choice?.startsWith("Execute")) {
        sendIfCurrent({ _tag: "ChooseExecute" });
      } else if (choice === "Refine the task list") {
        const refinement = await ctx.ui.editor("Refine the task list:", "");
        if (refinement?.trim()) {
          sendIfCurrent({ _tag: "ChooseRefine", refinement: refinement.trim() });
        } else {
          sendIfCurrent({ _tag: "ChooseStay" });
        }
      } else {
        sendIfCurrent({ _tag: "ChooseStay" });
      }
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
            if (state._tag === "AwaitingChoice") {
              return {
                block: true,
                reason:
                  "AUTO mode is waiting for the user's task-list choice. Do not continue with more tools until the choice is resolved.",
              };
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
              if (message.customType === "modes-context") return false;
              if (message.customType === "modes-auto-context") return false;
              if (message.customType === "modes-execution-context") return false;
              if (
                typeof message.customType === "string" &&
                message.customType.startsWith("modes-gate")
              ) {
                return false;
              }
              if (
                typeof message.customType === "string" &&
                message.customType.startsWith("modes-counsel")
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
              return {
                message: {
                  customType: "modes-auto-context",
                  content: `[AUTO MODE ACTIVE]
You are in auto mode - normal working mode.

If the request is ready for execution, produce an executable task list and call ${TASK_LIST_SIGNAL_TOOLS[0]}.
If the request still needs design, scoping, discovery, or a spec before it can become executable, call ${AUTO_SIGNAL_TOOLS[0]} with:
- prompt: what SPEC mode should clarify or produce

Do not stay in AUTO mode and write a long speculative PRD when the work clearly needs SPEC mode first. Escalate with ${AUTO_SIGNAL_TOOLS[0]}.`,
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
                  customType: "modes-context",
                  content: `[SPEC MODE ACTIVE]
You are in spec mode - a read-only exploration mode for safe analysis, PRDs, and specs.

Restrictions:
- You can only use: ${SPEC_TOOLS.join(", ")}
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands
- Use the interview tool to ask the user clarifying questions about scope

When your spec is ready, call ${SPEC_SIGNAL_TOOLS[0]} with:
- specText: the full spec/PRD markdown/text

Do NOT generate executable task lists in SPEC mode.
Do NOT attempt to make changes - just describe the spec, then call ${SPEC_SIGNAL_TOOLS[0]}.${diffBlock}${principlesBlock}`,
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
                  customType: "modes-execution-context",
                  content: `[EXECUTING TASK LIST - Full tool access enabled]

Remaining steps:
${todoList}${planRef}

Use ${EXECUTION_SIGNAL_TOOLS[0]} when a step is complete.
Use ${EXECUTION_SIGNAL_TOOLS[1]} after the validation gate.
Use ${EXECUTION_SIGNAL_TOOLS[2]} after counsel review.

Execute each step in order. Do not emit [DONE:n], GATE_PASS, GATE_FAIL, COUNSEL_PASS, or COUNSEL_FAIL text markers anymore — use the signal tools instead.${principlesBlock}`,
                  display: false,
                },
              };
            }
          },
        },

        session_switch: {
          mode: "fire",
          toEvent: (): ModesEvent => {
            pi.events.emit("editor:set-mode", { mode: "auto" });
            return { _tag: "Reset" };
          },
        },

        session_start: {
          mode: "fire",
          toEvent: (_state, _event, ctx): ModesEvent => {
            const entries = ctx.sessionManager.getEntries();
            const modesEntry = entries
              .filter((entry: any) => entry.type === "custom" && entry.customType === "modes")
              .pop() as { data?: PersistPayload } | undefined;

            const data = modesEntry?.data;
            const mode = data?.mode;
            const pendingData = data?.pending;
            const todoItems = normalizeHydratedTaskList(
              Array.isArray(pendingData?.todoItems ?? data?.todoItems)
                ? ((pendingData?.todoItems ?? data?.todoItems) as Record<string, unknown>[])
                : [],
            );
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
              data?.phase === "running" || data?.phase === "gating" || data?.phase === "counseling"
                ? data.phase
                : undefined;
            const spec = normalizeHydratedSpec(data?.spec);
            const flagSpec = pi.getFlag("spec") === true;
            const flagPlan = pi.getFlag("plan") === true;

            return {
              _tag: "Hydrate",
              mode,
              todoItems,
              planFilePath,
              savedTools,
              pending,
              spec,
              flagSpec,
              flagPlan,
              currentStep,
              phase,
              currentTools: pi.getActiveTools(),
            };
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

      observers: [awaitingChoiceObserver],

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
        (state._tag === "Spec" || state._tag === "AwaitingChoice" || state._tag === "Executing")
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
}

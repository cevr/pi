import { countTaskStatuses, type TaskListItem } from "@cvr/pi-task-list";

export type TaskWidgetPhase = "running" | "gating" | "counseling";
export type TaskWidgetTone = "accent" | "success" | "muted";

export interface TaskWidgetTheme {
  fg(tone: TaskWidgetTone, text: string): string;
  strikethrough(text: string): string;
}

export interface RenderTaskWidgetOptions {
  readonly phase?: TaskWidgetPhase;
  readonly theme: TaskWidgetTheme;
}

export interface TaskWidgetRender {
  readonly statusText: string;
  readonly lines: string[];
}

function getPhaseSuffix(phase: TaskWidgetPhase): string {
  if (phase === "gating") return " ⚙ gate";
  if (phase === "counseling") return " 🔍 counsel";
  return "";
}

function getActiveTaskLabel(task: TaskListItem, phase: TaskWidgetPhase): string {
  const phaseLabel = phase === "gating" ? " (gate)" : phase === "counseling" ? " (counsel)" : "";
  return `${task.activeForm ?? task.subject}${phaseLabel}`;
}

function getBlockedBySuffix(
  completedTaskIds: ReadonlySet<string>,
  task: TaskListItem,
  theme: TaskWidgetTheme,
): string {
  if (task.status !== "pending" || task.blockedBy.length === 0) return "";

  const openBlockers = task.blockedBy.filter((blockerId) => !completedTaskIds.has(blockerId));
  if (openBlockers.length === 0) return "";

  return theme.fg("muted", ` › blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}`);
}

function renderTaskLine(
  completedTaskIds: ReadonlySet<string>,
  task: TaskListItem,
  phase: TaskWidgetPhase,
  theme: TaskWidgetTheme,
): string {
  if (task.status === "completed") {
    return theme.fg("success", "✔ ") + theme.fg("muted", theme.strikethrough(task.subject));
  }

  if (task.status === "in_progress") {
    return theme.fg("accent", "◼ ") + theme.fg("accent", getActiveTaskLabel(task, phase));
  }

  return `${theme.fg("muted", "◻ ")}${task.subject}${getBlockedBySuffix(completedTaskIds, task, theme)}`;
}

export function renderTaskWidget(
  tasks: readonly TaskListItem[],
  options: RenderTaskWidgetOptions,
): TaskWidgetRender {
  const phase = options.phase ?? "running";
  const counts = countTaskStatuses(tasks);
  const completedTaskIds = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  const summaryParts: string[] = [];
  if (counts.completed > 0) summaryParts.push(`${counts.completed} done`);
  if (counts.in_progress > 0) summaryParts.push(`${counts.in_progress} in progress`);
  if (counts.pending > 0) summaryParts.push(`${counts.pending} open`);

  return {
    statusText: options.theme.fg(
      "accent",
      `📋 ${tasks.length} tasks${summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : ""}${getPhaseSuffix(phase)}`,
    ),
    lines: tasks.map((task) => renderTaskLine(completedTaskIds, task, phase, options.theme)),
  };
}

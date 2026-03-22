import { countTaskStatuses, type TaskListItem, type TaskListStatus } from "@cvr/pi-task-list";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskWidgetPhase = "running" | "counseling";
export type TaskWidgetTone = "accent" | "success" | "muted";

export interface TaskWidgetTheme {
  fg(tone: TaskWidgetTone, text: string): string;
  strikethrough(text: string): string;
}

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Subset of the extension UI context the widget needs.
 * Both overloads of setWidget are supported:
 *   - string[] for simple text
 *   - factory function that returns a Component & { dispose?() }
 */
export interface WidgetUICtx {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content:
      | undefined
      | string[]
      | ((tui: WidgetTUI, theme: TaskWidgetTheme) => WidgetComponent & { dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

/** Minimal TUI surface the widget component needs for rendering. */
export interface WidgetTUI {
  terminal: { columns: number };
  requestRender(): void;
}

/** Component interface matching @mariozechner/pi-tui Component. */
export interface WidgetComponent {
  render(width: number): string[];
  invalidate(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Star spinner frames (matches Claude Code / pi-tasks). */
const SPINNER_FRAMES = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

/** Max tasks shown before overflow truncation. */
const MAX_VISIBLE_TASKS = 10;

/** Spinner animation interval in ms. */
const SPINNER_INTERVAL_MS = 80;

// ---------------------------------------------------------------------------
// Formatting helpers (pure)
// ---------------------------------------------------------------------------

/** Format milliseconds as human-readable duration (e.g., "2m 49s", "1h 3m"). */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function getPhaseSuffix(phase: TaskWidgetPhase): string {
  if (phase === "counseling") return " 🔍 counsel";
  return "";
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

// ---------------------------------------------------------------------------
// TaskWidget class
// ---------------------------------------------------------------------------

export class TaskWidget {
  private uiCtx: WidgetUICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private widgetRegistered = false;
  private tui: WidgetTUI | undefined;
  private phase: TaskWidgetPhase = "running";

  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();

  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();

  /** Clock source — injectable for testing. */
  private now: () => number;

  constructor(
    private getTasks: () => readonly TaskListItem[],
    options?: { now?: () => number },
  ) {
    this.now = options?.now ?? Date.now;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  setUICtx(ctx: WidgetUICtx): void {
    this.uiCtx = ctx;
  }

  setPhase(phase: TaskWidgetPhase): void {
    this.phase = phase;
  }

  /** Mark a task as actively executing (spinner) or not. */
  setActiveTask(taskId: string | undefined, active = true): void {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, {
          startedAt: this.now(),
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for all currently active tasks. */
  addTokenUsage(inputTokens: number, outputTokens: number): void {
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Force an immediate widget update. */
  update(): void {
    if (!this.uiCtx) return;

    const tasks = this.getTasks();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("modes-todos", undefined);
        this.widgetRegistered = false;
      }
      this.stopTimer();
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = tasks.find((task) => task.id === id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Manage animation timer
    const hasActiveSpinner = tasks.some(
      (t) => this.activeTaskIds.has(t.id) && t.status === "in_progress",
    );
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else {
      this.stopTimer();
    }

    this.widgetFrame++;

    // Register or re-render
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        "modes-todos",
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(width, theme),
            invalidate: () => {},
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else if (this.tui) {
      this.tui.requestRender();
    }
  }

  /** Get status text for the status bar. */
  getStatusText(theme: TaskWidgetTheme): string {
    const tasks = this.getTasks();
    const counts = countTaskStatuses(tasks);
    const parts: string[] = [];
    if (counts.completed > 0) parts.push(`${counts.completed} done`);
    if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
    if (counts.pending > 0) parts.push(`${counts.pending} open`);
    const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return theme.fg("accent", `📋 ${tasks.length} tasks${summary}${getPhaseSuffix(this.phase)}`);
  }

  dispose(): void {
    this.stopTimer();
    if (this.uiCtx && this.widgetRegistered) {
      this.uiCtx.setWidget("modes-todos", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.activeTaskIds.clear();
    this.metrics.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private ensureTimer(): void {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), SPINNER_INTERVAL_MS);
    }
  }

  private stopTimer(): void {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
  }

  /** Build widget lines from current state. Called from the Component.render callback. */
  private renderWidget(width: number, theme: TaskWidgetTheme): string[] {
    const tasks = this.getTasks();
    if (tasks.length === 0) return [];

    const counts = countTaskStatuses(tasks);
    const completedTaskIds = new Set(
      tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );

    // Summary header
    const parts: string[] = [];
    if (counts.completed > 0) parts.push(`${counts.completed} done`);
    if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
    if (counts.pending > 0) parts.push(`${counts.pending} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER_FRAMES[this.widgetFrame % SPINNER_FRAMES.length]!;
    const lines: string[] = [theme.fg("accent", "●") + " " + theme.fg("accent", statusText)];

    // Task lines
    const visible = tasks.slice(0, MAX_VISIBLE_TASKS);
    for (const task of visible) {
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";
      lines.push(this.renderTaskLine(task, isActive, spinnerChar, completedTaskIds, theme));
    }

    // Overflow
    if (tasks.length > MAX_VISIBLE_TASKS) {
      lines.push(theme.fg("muted", `    … and ${tasks.length - MAX_VISIBLE_TASKS} more`));
    }

    return lines;
  }

  private renderTaskLine(
    task: TaskListItem,
    isActive: boolean,
    spinnerChar: string,
    completedTaskIds: ReadonlySet<string>,
    theme: TaskWidgetTheme,
  ): string {
    if (isActive) {
      const icon = theme.fg("accent", spinnerChar);
      const form = task.activeForm ?? task.subject;
      const m = this.metrics.get(task.id);
      let stats = "";
      if (m) {
        const elapsed = formatDuration(this.now() - m.startedAt);
        const tokenParts: string[] = [];
        if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
        if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
        stats =
          tokenParts.length > 0
            ? ` ${theme.fg("muted", `(${elapsed} · ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("muted", `(${elapsed})`)}`;
      }
      const phaseSuffix = getPhaseSuffix(this.phase);
      return `  ${icon} ${theme.fg("accent", `${form}…`)}${stats}${phaseSuffix}`;
    }

    if (task.status === "completed") {
      return `  ${theme.fg("success", "✔")} ${theme.fg("muted", theme.strikethrough(task.subject))}`;
    }

    if (task.status === "in_progress") {
      return `  ${theme.fg("accent", "◼")} ${theme.fg("accent", task.activeForm ?? task.subject)}`;
    }

    // pending
    return `  ◻ ${task.subject}${getBlockedBySuffix(completedTaskIds, task, theme)}`;
  }
}

// ---------------------------------------------------------------------------
// Legacy API (deprecated — kept for backward compatibility during migration)
// ---------------------------------------------------------------------------

/** @deprecated Use `TaskWidget` class instead. */
export interface RenderTaskWidgetOptions {
  readonly phase?: TaskWidgetPhase;
  readonly theme: TaskWidgetTheme;
}

/** @deprecated Use `TaskWidget` class instead. */
export interface TaskWidgetRender {
  readonly statusText: string;
  readonly lines: string[];
}

/**
 * @deprecated Use the `TaskWidget` class instead for animated rendering.
 * This function is kept for backward compatibility.
 */
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

  const getActiveLabel = (task: TaskListItem): string => {
    const phaseLabel = phase === "counseling" ? " (counsel)" : "";
    return `${task.activeForm ?? task.subject}${phaseLabel}`;
  };

  const renderLine = (task: TaskListItem): string => {
    if (task.status === "completed") {
      return (
        options.theme.fg("success", "✔ ") +
        options.theme.fg("muted", options.theme.strikethrough(task.subject))
      );
    }
    if (task.status === "in_progress") {
      return options.theme.fg("accent", "◼ ") + options.theme.fg("accent", getActiveLabel(task));
    }
    return `${options.theme.fg("muted", "◻ ")}${task.subject}${getBlockedBySuffix(completedTaskIds, task, options.theme)}`;
  };

  return {
    statusText: options.theme.fg(
      "accent",
      `📋 ${tasks.length} tasks${summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : ""}${getPhaseSuffix(phase)}`,
    ),
    lines: tasks.map(renderLine),
  };
}

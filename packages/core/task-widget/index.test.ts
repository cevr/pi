import { describe, expect, it, beforeEach } from "bun:test";
import { createTaskList, setTaskStatus } from "@cvr/pi-task-list";
import {
  TaskWidget,
  renderTaskWidget,
  formatDuration,
  formatTokens,
  type WidgetUICtx,
  type WidgetTUI,
  type TaskWidgetTheme,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const theme: TaskWidgetTheme = {
  fg: (_tone, text) => text,
  strikethrough: (text) => `~~${text}~~`,
};

function createMockUICtx() {
  let lastWidgetKey: string | undefined;
  let lastWidgetContent: unknown;
  let lastWidgetOptions: unknown;
  let lastStatus: { key: string; text: string | undefined } | undefined;

  const ctx: WidgetUICtx = {
    setStatus(key, text) {
      lastStatus = { key, text };
    },
    setWidget(key, content, options) {
      lastWidgetKey = key;
      lastWidgetContent = content;
      lastWidgetOptions = options;
    },
  };

  return {
    ctx,
    getLastWidget: () => ({
      key: lastWidgetKey,
      content: lastWidgetContent,
      options: lastWidgetOptions,
    }),
    getLastStatus: () => lastStatus,
  };
}

function createMockTUI(columns = 120): WidgetTUI {
  let renderRequests = 0;
  return {
    terminal: { columns },
    requestRender() {
      renderRequests++;
    },
    get _renderRequests() {
      return renderRequests;
    },
  } as WidgetTUI & { _renderRequests: number };
}

/** Invoke the factory function from setWidget and get rendered lines. */
function renderFromFactory(factory: unknown, width = 120): string[] {
  if (typeof factory !== "function") return [];
  const tui = createMockTUI(width);
  const component = factory(tui, theme);
  return component.render(width);
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(169000)).toBe("2m 49s");
    expect(formatDuration(3540000)).toBe("59m");
  });

  it("formats hours", () => {
    expect(formatDuration(3600000)).toBe("1h");
    expect(formatDuration(3780000)).toBe("1h 3m");
    expect(formatDuration(7200000)).toBe("2h");
  });
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(4100)).toBe("4.1k");
    expect(formatTokens(10000)).toBe("10k");
  });
});

// ---------------------------------------------------------------------------
// TaskWidget class
// ---------------------------------------------------------------------------

describe("TaskWidget", () => {
  let tasks = createTaskList(["First", "Second", "Third"]);
  let widget: TaskWidget;
  let mock: ReturnType<typeof createMockUICtx>;

  beforeEach(() => {
    tasks = createTaskList(["First", "Second", "Third"]);
    mock = createMockUICtx();
    widget = new TaskWidget(() => tasks, { now: () => 1000000 });
    widget.setUICtx(mock.ctx);
  });

  describe("update", () => {
    it("registers a factory widget on first call", () => {
      widget.update();
      const { key, content, options } = mock.getLastWidget();
      expect(key).toBe("modes-todos");
      expect(typeof content).toBe("function");
      expect(options).toEqual({ placement: "aboveEditor" });
    });

    it("clears the widget when tasks are empty", () => {
      widget.update(); // register first
      tasks = [];
      widget.update();
      const { content } = mock.getLastWidget();
      expect(content).toBeUndefined();
    });

    it("calls tui.requestRender on subsequent updates", () => {
      widget.update(); // register

      // Invoke the factory to capture the tui reference
      const factory = mock.getLastWidget().content;
      const tui = createMockTUI() as WidgetTUI & { _renderRequests: number };
      (factory as Function)(tui, theme);

      widget.update(); // should call requestRender
      expect(tui._renderRequests).toBeGreaterThan(0);
    });
  });

  describe("rendering", () => {
    it("renders summary header with task counts", () => {
      tasks = setTaskStatus(
        setTaskStatus(createTaskList(["A", "B", "C"]), 1, "completed"),
        2,
        "in_progress",
      );
      widget.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[0]).toBe("● 3 tasks (1 done, 1 in progress, 1 open)");
    });

    it("renders completed tasks with strikethrough", () => {
      tasks = setTaskStatus(createTaskList(["Done task"]), 1, "completed");
      widget.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[1]).toBe("  ✔ ~~Done task~~");
    });

    it("renders in_progress tasks with square icon", () => {
      tasks = setTaskStatus(createTaskList(["Working"]), 1, "in_progress");
      widget.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[1]).toBe("  ◼ Working");
    });

    it("renders pending tasks with open square", () => {
      widget.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[1]).toBe("  ◻ First");
    });

    it("shows blocked-by suffix for pending tasks with open blockers", () => {
      tasks = [
        { id: "1", order: 1, subject: "First", status: "in_progress", blockedBy: [] },
        { id: "2", order: 2, subject: "Second", status: "pending", blockedBy: ["1"] },
      ];
      widget.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[2]).toBe("  ◻ Second › blocked by #1");
    });

    it("hides blocked-by for completed blockers", () => {
      tasks = [
        { id: "1", order: 1, subject: "First", status: "completed", blockedBy: [] },
        { id: "2", order: 2, subject: "Second", status: "pending", blockedBy: ["1"] },
      ];
      widget.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[2]).toBe("  ◻ Second");
    });

    it("shows overflow when more than MAX_VISIBLE_TASKS", () => {
      const subjects = Array.from({ length: 12 }, (_, i) => `Task ${i + 1}`);
      tasks = createTaskList(subjects);
      widget.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      // 1 header + 10 tasks + 1 overflow = 12
      expect(lines).toHaveLength(12);
      expect(lines[11]).toBe("    … and 2 more");
    });
  });

  describe("active tasks (spinner)", () => {
    it("renders spinner icon and activeForm for active tasks", () => {
      tasks = [
        {
          id: "1",
          order: 1,
          subject: "Build service",
          activeForm: "Building service",
          status: "in_progress",
          blockedBy: [],
        },
      ];
      widget.setActiveTask("1");
      const lines = renderFromFactory(mock.getLastWidget().content);
      // Spinner char varies by frame; just check it contains the activeForm text
      expect(lines[1]).toContain("Building service…");
    });

    it("shows elapsed time for active tasks", () => {
      let clock = 1000000;
      const w = new TaskWidget(() => tasks, { now: () => clock });
      w.setUICtx(mock.ctx);

      tasks = setTaskStatus(createTaskList(["Working"]), 1, "in_progress");
      w.setActiveTask("1");

      clock = 1000000 + 169000; // 2m 49s later
      w.update();
      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[1]).toContain("(2m 49s)");
    });

    it("shows token counts for active tasks", () => {
      tasks = setTaskStatus(createTaskList(["Working"]), 1, "in_progress");
      widget.setActiveTask("1");
      widget.addTokenUsage(4100, 1800);
      widget.update();

      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[1]).toContain("↑ 4.1k");
      expect(lines[1]).toContain("↓ 1.8k");
    });

    it("shows phase suffix on active task line", () => {
      tasks = setTaskStatus(createTaskList(["Working"]), 1, "in_progress");
      widget.setActiveTask("1");
      widget.setPhase("counseling");
      widget.update();

      const lines = renderFromFactory(mock.getLastWidget().content);
      expect(lines[1]).toContain("🔍 counsel");
    });

    it("clears active task on setActiveTask(id, false)", () => {
      tasks = setTaskStatus(createTaskList(["Working"]), 1, "in_progress");
      widget.setActiveTask("1");
      widget.setActiveTask("1", false);
      widget.update();

      const lines = renderFromFactory(mock.getLastWidget().content);
      // Should render as normal in_progress, not with spinner
      expect(lines[1]).toBe("  ◼ Working");
    });
  });

  describe("getStatusText", () => {
    it("returns formatted status text", () => {
      tasks = setTaskStatus(createTaskList(["A", "B"]), 1, "completed");
      const text = widget.getStatusText(theme);
      expect(text).toBe("📋 2 tasks (1 done, 1 open)");
    });

    it("includes phase suffix", () => {
      widget.setPhase("counseling");
      const text = widget.getStatusText(theme);
      expect(text).toContain("🔍 counsel");
    });
  });

  describe("dispose", () => {
    it("clears the widget and resets state", () => {
      widget.update();
      widget.dispose();
      const { content } = mock.getLastWidget();
      expect(content).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Legacy renderTaskWidget (backward compatibility)
// ---------------------------------------------------------------------------

describe("renderTaskWidget (deprecated)", () => {
  it("renders status text and task lines for mixed progress", () => {
    const tasks = setTaskStatus(
      setTaskStatus(createTaskList(["First", "Second", "Third"]), 1, "completed"),
      2,
      "in_progress",
    );

    expect(renderTaskWidget(tasks, { phase: "counseling", theme })).toEqual({
      statusText: "📋 3 tasks (1 done, 1 in progress, 1 open) 🔍 counsel",
      lines: ["✔ ~~First~~", "◼ Second (counsel)", "◻ Third"],
    });
  });

  it("uses activeForm for the in-progress task", () => {
    const [task] = setTaskStatus(
      [
        {
          id: "1",
          order: 1,
          subject: "Run the step",
          activeForm: "Running the step",
          status: "in_progress",
          blockedBy: [],
        },
      ],
      1,
      "in_progress",
    );

    expect(renderTaskWidget([task!], { theme })).toEqual({
      statusText: "📋 1 tasks (1 in progress)",
      lines: ["◼ Running the step"],
    });
  });

  it("shows unresolved blockers for pending tasks", () => {
    const tasks = [
      { id: "1", order: 1, subject: "First", status: "completed" as const, blockedBy: [] },
      { id: "2", order: 2, subject: "Second", status: "pending" as const, blockedBy: ["1", "3"] },
      { id: "3", order: 3, subject: "Third", status: "in_progress" as const, blockedBy: [] },
    ];

    expect(renderTaskWidget(tasks, { theme }).lines).toEqual([
      "✔ ~~First~~",
      "◻ Second › blocked by #3",
      "◼ Third",
    ]);
  });
});

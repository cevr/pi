import { describe, expect, it } from "bun:test";
import { createTaskList, setTaskStatus } from "@cvr/pi-task-list";
import { renderTaskWidget } from "./index";

const theme = {
  fg: (_tone: "accent" | "success" | "muted", text: string) => text,
  strikethrough: (text: string) => `~~${text}~~`,
};

describe("renderTaskWidget", () => {
  it("renders status text and task lines for mixed progress", () => {
    const tasks = setTaskStatus(
      setTaskStatus(createTaskList(["First", "Second", "Third"]), 1, "completed"),
      2,
      "in_progress",
    );

    expect(renderTaskWidget(tasks, { phase: "gating", theme })).toEqual({
      statusText: "📋 3 tasks (1 done, 1 in progress, 1 open) ⚙ gate",
      lines: ["✔ ~~First~~", "◼ Second (gate)", "◻ Third"],
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
      {
        id: "1",
        order: 1,
        subject: "First",
        status: "completed" as const,
        blockedBy: [],
      },
      {
        id: "2",
        order: 2,
        subject: "Second",
        status: "pending" as const,
        blockedBy: ["1", "3"],
      },
      {
        id: "3",
        order: 3,
        subject: "Third",
        status: "in_progress" as const,
        blockedBy: [],
      },
    ];

    expect(renderTaskWidget(tasks, { theme }).lines).toEqual([
      "✔ ~~First~~",
      "◻ Second › blocked by #3",
      "◼ Third",
    ]);
  });
});

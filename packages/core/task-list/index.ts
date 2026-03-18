export type TaskListStatus = "pending" | "in_progress" | "completed";

export interface TaskListItem {
  id: string;
  order: number;
  subject: string;
  status: TaskListStatus;
  blockedBy: string[];
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

export function createTaskList(subjects: readonly string[]): TaskListItem[] {
  return subjects.map((subject, index) => ({
    id: String(index + 1),
    order: index + 1,
    subject,
    status: "pending",
    blockedBy: [],
  }));
}

export function findTaskByOrder(
  tasks: readonly TaskListItem[],
  order: number,
): TaskListItem | undefined {
  return tasks.find((task) => task.order === order);
}

export function setTaskStatus(
  tasks: readonly TaskListItem[],
  order: number,
  status: TaskListStatus,
): TaskListItem[] {
  return tasks.map((task) =>
    task.order === order
      ? {
          ...task,
          status,
        }
      : { ...task },
  );
}

export function countTaskStatuses(tasks: readonly TaskListItem[]): Record<TaskListStatus, number> {
  const counts: Record<TaskListStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  return counts;
}

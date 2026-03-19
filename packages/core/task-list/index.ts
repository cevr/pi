import { Schema } from "effect";

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

export interface TaskGraphValidationIssue {
  type: "missing_blocker" | "self_block" | "cycle";
  taskId?: string;
  blockerId?: string;
  taskIds?: string[];
}

export const TaskListStatusSchema = Schema.Literals(["pending", "in_progress", "completed"]);
export const TaskListMetadataSchema = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));

export const TaskListItemSchema = Schema.Struct({
  id: Schema.String,
  order: Schema.Number,
  subject: Schema.String,
  status: TaskListStatusSchema,
  blockedBy: Schema.Array(Schema.String),
  activeForm: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  metadata: TaskListMetadataSchema,
});

export const TaskGraphValidationIssueSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("missing_blocker"),
    taskId: Schema.optional(Schema.String),
    blockerId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("self_block"),
    taskId: Schema.optional(Schema.String),
    blockerId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("cycle"),
    taskIds: Schema.optional(Schema.Array(Schema.String)),
  }),
]); 

export function createTaskList(subjects: readonly string[]): TaskListItem[] {
  return subjects.map((subject, index) => ({
    id: String(index + 1),
    order: index + 1,
    subject,
    status: "pending",
    blockedBy: [],
  }));
}

export function findTaskById(tasks: readonly TaskListItem[], id: string): TaskListItem | undefined {
  return tasks.find((task) => task.id === id);
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

export function setTaskStatuses(
  tasks: readonly TaskListItem[],
  taskIds: readonly string[],
  status: TaskListStatus,
): TaskListItem[] {
  const targetIds = new Set(taskIds);
  return tasks.map((task) =>
    targetIds.has(task.id)
      ? {
          ...task,
          status,
        }
      : { ...task },
  );
}

export function claimTasks(
  tasks: readonly TaskListItem[],
  taskIds: readonly string[],
): TaskListItem[] {
  return setTaskStatuses(tasks, taskIds, "in_progress");
}

export function completeTasks(
  tasks: readonly TaskListItem[],
  taskIds: readonly string[],
): TaskListItem[] {
  return setTaskStatuses(tasks, taskIds, "completed");
}

export function getReadyTaskIds(tasks: readonly TaskListItem[]): string[] {
  const completedTaskIds = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  return tasks
    .filter(
      (task) =>
        task.status === "pending" &&
        task.blockedBy.every((blockerId) => completedTaskIds.has(blockerId)),
    )
    .map((task) => task.id);
}

export function getBlockedTaskIds(tasks: readonly TaskListItem[]): string[] {
  const readyTaskIds = new Set(getReadyTaskIds(tasks));
  return tasks
    .filter((task) => task.status === "pending" && !readyTaskIds.has(task.id))
    .map((task) => task.id);
}

export function validateTaskGraph(tasks: readonly TaskListItem[]): TaskGraphValidationIssue[] {
  const issues: TaskGraphValidationIssue[] = [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  for (const task of tasks) {
    for (const blockerId of task.blockedBy) {
      if (blockerId === task.id) {
        issues.push({ type: "self_block", taskId: task.id, blockerId });
        continue;
      }
      if (!tasksById.has(blockerId)) {
        issues.push({ type: "missing_blocker", taskId: task.id, blockerId });
      }
    }
  }

  const cycle = findTaskGraphCycle(tasksById);
  if (cycle) {
    issues.push({ type: "cycle", taskIds: cycle });
  }

  return issues;
}

function findTaskGraphCycle(tasksById: ReadonlyMap<string, TaskListItem>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (taskId: string): string[] | null => {
    if (visiting.has(taskId)) {
      const start = path.indexOf(taskId);
      return start === -1 ? [taskId] : [...path.slice(start), taskId];
    }
    if (visited.has(taskId)) return null;

    visiting.add(taskId);
    path.push(taskId);

    const task = tasksById.get(taskId);
    for (const blockerId of task?.blockedBy ?? []) {
      if (blockerId === taskId || !tasksById.has(blockerId)) continue;
      const cycle = visit(blockerId);
      if (cycle) return cycle;
    }

    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };

  for (const taskId of tasksById.keys()) {
    const cycle = visit(taskId);
    if (cycle) return cycle;
  }

  return null;
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

import { getReadyTaskIds, type TaskListItem } from "@cvr/pi-task-list";

export type GraphExecutionPhase = "running" | "gating" | "counseling";

export interface GraphExecutionCursor {
  phase: GraphExecutionPhase;
  frontierTaskIds: string[];
  activeTaskIds: string[];
  total: number;
}

export interface GraphExecutionPolicy {
  maxParallel: number;
}

export type GraphExecutionCounselResult =
  | {
      type: "retry";
      phase: GraphExecutionPhase;
      frontierTaskIds: string[];
      activeTaskIds: string[];
      total: number;
    }
  | { type: "complete" }
  | {
      type: "advance";
      phase: GraphExecutionPhase;
      frontierTaskIds: string[];
      activeTaskIds: string[];
      total: number;
    };

function getEffectiveParallelism(policy: GraphExecutionPolicy): number {
  return Number.isInteger(policy.maxParallel) && policy.maxParallel > 0 ? policy.maxParallel : 1;
}

function takeFrontier(tasks: readonly TaskListItem[], policy: GraphExecutionPolicy): string[] {
  return getReadyTaskIds(tasks).slice(0, getEffectiveParallelism(policy));
}

export function startGraphExecution(
  tasks: readonly TaskListItem[],
  policy: GraphExecutionPolicy,
): GraphExecutionCursor | null {
  const frontierTaskIds = takeFrontier(tasks, policy);
  if (frontierTaskIds.length === 0) return null;
  return {
    phase: "running",
    frontierTaskIds,
    activeTaskIds: [...frontierTaskIds],
    total: tasks.length,
  };
}

export function recordGraphTaskCompletion(
  cursor: GraphExecutionCursor,
  taskId: string,
): GraphExecutionCursor | null {
  if (cursor.phase !== "running") return null;
  if (!cursor.activeTaskIds.includes(taskId)) return null;

  const activeTaskIds = cursor.activeTaskIds.filter((id) => id !== taskId);
  return {
    phase: activeTaskIds.length === 0 ? "gating" : "running",
    frontierTaskIds: [...cursor.frontierTaskIds],
    activeTaskIds,
    total: cursor.total,
  };
}

export function resolveGraphExecutionGate(
  cursor: GraphExecutionCursor,
  status: "pass" | "fail",
): GraphExecutionCursor | null {
  if (cursor.phase !== "gating") return null;
  return {
    phase: status === "pass" ? "counseling" : "running",
    frontierTaskIds: [...cursor.frontierTaskIds],
    activeTaskIds: status === "pass" ? [] : [...cursor.frontierTaskIds],
    total: cursor.total,
  };
}

export function resolveGraphExecutionCounsel(
  cursor: GraphExecutionCursor,
  status: "pass" | "fail",
  tasks: readonly TaskListItem[],
  policy: GraphExecutionPolicy,
): GraphExecutionCounselResult | null {
  if (cursor.phase !== "counseling") return null;

  if (status === "fail") {
    return {
      type: "retry",
      phase: "running",
      frontierTaskIds: [...cursor.frontierTaskIds],
      activeTaskIds: [...cursor.frontierTaskIds],
      total: cursor.total,
    };
  }

  const frontierTaskIds = takeFrontier(tasks, policy);
  if (frontierTaskIds.length === 0) {
    return { type: "complete" };
  }

  return {
    type: "advance",
    phase: "running",
    frontierTaskIds,
    activeTaskIds: [...frontierTaskIds],
    total: cursor.total,
  };
}

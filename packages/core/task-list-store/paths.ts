// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as nodePath from "node:path";

export type TaskListScope = "memory" | "session" | "project";

export interface ResolveTaskListStorePathInput {
  cwd: string;
  scope: TaskListScope;
  sessionId?: string;
}

export function resolveTaskListStorePath({
  cwd,
  scope,
  sessionId,
}: ResolveTaskListStorePathInput): string | null {
  if (scope === "memory") return null;
  if (scope === "session") {
    if (!sessionId) return null;
    return nodePath.join(cwd, ".pi", "modes", `tasks-${sessionId}.json`);
  }
  return nodePath.join(cwd, ".pi", "modes", "tasks.json");
}

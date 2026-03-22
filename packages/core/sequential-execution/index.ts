export type SequentialExecutionPhase = "running" | "counseling";

export interface SequentialExecutionCursor {
  phase: SequentialExecutionPhase;
  currentIndex: number | null;
  total: number;
}

export type SequentialExecutionCounselResult =
  | { type: "retry"; phase: SequentialExecutionPhase; currentIndex: number }
  | { type: "complete" }
  | { type: "advance"; phase: SequentialExecutionPhase; currentIndex: number };

export function enterSequentialExecutionCounsel(
  cursor: SequentialExecutionCursor,
  currentIndex: number,
): { phase: "counseling"; currentIndex: number } | null {
  if (cursor.phase !== "running") return null;
  if (currentIndex < 0 || currentIndex >= cursor.total) return null;
  return { phase: "counseling", currentIndex };
}

export function resolveSequentialExecutionCounsel(
  cursor: SequentialExecutionCursor,
  status: "pass" | "fail",
): SequentialExecutionCounselResult | null {
  if (cursor.phase !== "counseling" || cursor.currentIndex === null) return null;

  if (status === "fail") {
    return {
      type: "retry",
      phase: "running",
      currentIndex: cursor.currentIndex,
    };
  }

  const nextIndex = cursor.currentIndex + 1;
  if (nextIndex >= cursor.total) {
    return { type: "complete" };
  }

  return {
    type: "advance",
    phase: "running",
    currentIndex: nextIndex,
  };
}

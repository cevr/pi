import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";

export interface TaskTranscriptEntry {
  isSidechain: true;
  taskId: string;
  description: string;
  sessionId: string;
  type: Message["role"];
  message: Message;
  timestamp: string;
  cwd: string;
}

export function createTaskOutputFilePath(cwd: string, taskId: string, sessionId: string): string {
  const encoded = cwd.replace(/\//g, "-").replace(/^-/, "");
  const root = join(tmpdir(), `pi-task-runner-${process.getuid?.() ?? 0}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dir = join(root, encoded, sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${taskId}.output.jsonl`);
}

export function initializeTaskOutputFile(path: string): void {
  writeFileSync(path, "", "utf-8");
}

export function appendTaskTranscriptEntries(
  path: string,
  messages: readonly Message[],
  state: {
    writtenCount: number;
    taskId: string;
    description: string;
    sessionId: string;
    cwd: string;
  },
): number {
  let writtenCount = state.writtenCount;

  while (writtenCount < messages.length) {
    const message = messages[writtenCount];
    if (!message) break;

    const entry: TaskTranscriptEntry = {
      isSidechain: true,
      taskId: state.taskId,
      description: state.description,
      sessionId: state.sessionId,
      type: message.role,
      message,
      timestamp: new Date().toISOString(),
      cwd: state.cwd,
    };

    try {
      appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      return writtenCount;
    }

    writtenCount += 1;
  }

  return writtenCount;
}

/**
 * file change tracker — persists before/after content to disk for undo_edit.
 *
 * each edit writes a JSON file to a configurable directory (default:
 * ~/.pi/file-changes/{sessionId}/{toolCallId}.{uuid}).
 *
 * `FileTracker` Effect service for effectful callers.
 * Sync functions (`saveChange`, `loadChanges`, etc.) for non-Effect callers.
 * `simpleDiff` is a pure function (no service needed).
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface FileChange {
  id: string;
  uri: string;
  before: string;
  after: string;
  diff: string;
  isNewFile: boolean;
  reverted: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class FileTrackerError extends Schema.TaggedErrorClass<FileTrackerError>()(
  "FileTrackerError",
  { message: Schema.String },
) {}

// ---------------------------------------------------------------------------
// sync internals (shared by service layer and sync API)
// ---------------------------------------------------------------------------

const _state = {
  fileChangesDir: null as string | null,
};

/** override the file changes directory (for testing). */
export function setFileChangesDir(dir: string): void {
  _state.fileChangesDir = dir;
}

const getFileChangesDir = () =>
  _state.fileChangesDir ?? path.join(os.homedir(), ".pi", "file-changes");

function sessionDir(sessionId: string, baseDir?: string): string {
  return path.join(baseDir ?? getFileChangesDir(), sessionId);
}

function changePath(
  sessionId: string,
  toolCallId: string,
  changeId: string,
  baseDir?: string,
): string {
  return path.join(sessionDir(sessionId, baseDir), `${toolCallId}.${changeId}`);
}

function ensureDir(sessionId: string, baseDir?: string): void {
  const dir = sessionDir(sessionId, baseDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// sync API — for non-Effect callers
// ---------------------------------------------------------------------------

export function saveChange(
  sessionId: string,
  toolCallId: string,
  change: Omit<FileChange, "id" | "reverted">,
): string {
  ensureDir(sessionId);
  const id = crypto.randomUUID();
  const record: FileChange = { ...change, id, reverted: false };
  fs.writeFileSync(changePath(sessionId, toolCallId, id), JSON.stringify(record, null, 2), "utf-8");
  return id;
}

export function loadChanges(sessionId: string, toolCallId: string): FileChange[] {
  const dir = sessionDir(sessionId);
  if (!fs.existsSync(dir)) return [];

  const prefix = `${toolCallId}.`;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as FileChange;
        } catch {
          return null;
        }
      })
      .filter((c): c is FileChange => c !== null);
  } catch {
    return [];
  }
}

export function revertChange(
  sessionId: string,
  toolCallId: string,
  changeId: string,
): FileChange | null {
  const p = changePath(sessionId, toolCallId, changeId);
  if (!fs.existsSync(p)) return null;

  let change: FileChange;
  try {
    change = JSON.parse(fs.readFileSync(p, "utf-8")) as FileChange;
  } catch {
    return null;
  }
  if (change.reverted) return null;

  const filePath = change.uri.replace(/^file:\/\//, "");
  fs.writeFileSync(filePath, change.before, "utf-8");

  change.reverted = true;
  fs.writeFileSync(p, JSON.stringify(change, null, 2), "utf-8");

  return change;
}

export function findLatestChange(
  sessionId: string,
  filePath: string,
  activeToolCallIds: string[],
): { toolCallId: string; change: FileChange } | null {
  const uri = `file://${path.resolve(filePath)}`;

  for (let i = activeToolCallIds.length - 1; i >= 0; i--) {
    const toolCallId = activeToolCallIds[i];
    if (!toolCallId) continue;
    const changes = loadChanges(sessionId, toolCallId);
    const match = changes
      .filter((c) => !c.reverted && c.uri === uri)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (match) {
      return { toolCallId, change: match };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class FileTracker extends ServiceMap.Service<
  FileTracker,
  {
    readonly save: (
      sessionId: string,
      toolCallId: string,
      change: Omit<FileChange, "id" | "reverted">,
    ) => Effect.Effect<string, FileTrackerError>;
    readonly load: (sessionId: string, toolCallId: string) => Effect.Effect<FileChange[]>;
    readonly revert: (
      sessionId: string,
      toolCallId: string,
      changeId: string,
    ) => Effect.Effect<Option.Option<FileChange>, FileTrackerError>;
    readonly findLatest: (
      sessionId: string,
      filePath: string,
      activeToolCallIds: string[],
    ) => Effect.Effect<Option.Option<{ toolCallId: string; change: FileChange }>>;
  }
>()("@cvr/pi-file-tracker/index/FileTracker") {
  static layer = Layer.succeed(FileTracker, {
    save: (sessionId: string, toolCallId: string, change: Omit<FileChange, "id" | "reverted">) =>
      Effect.try({
        try: () => saveChange(sessionId, toolCallId, change),
        catch: (err) =>
          new FileTrackerError({
            message: `save failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
      }),

    load: (sessionId: string, toolCallId: string) =>
      Effect.sync(() => loadChanges(sessionId, toolCallId)),

    revert: (sessionId: string, toolCallId: string, changeId: string) =>
      Effect.try({
        try: () => Option.fromNullOr(revertChange(sessionId, toolCallId, changeId)),
        catch: (err) =>
          new FileTrackerError({
            message: `revert failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
      }),

    findLatest: (sessionId: string, filePath: string, activeToolCallIds: string[]) =>
      Effect.sync(() =>
        Option.fromNullOr(findLatestChange(sessionId, filePath, activeToolCallIds)),
      ),
  });

  static layerTest = Layer.effect(
    FileTracker,
    Effect.sync(() => {
      const store = new Map<string, FileChange>();

      return {
        save: (
          sessionId: string,
          toolCallId: string,
          change: Omit<FileChange, "id" | "reverted">,
        ) =>
          Effect.sync(() => {
            const id = crypto.randomUUID();
            const record: FileChange = { ...change, id, reverted: false };
            store.set(`${sessionId}/${toolCallId}.${id}`, record);
            return id;
          }),

        load: (sessionId: string, toolCallId: string) =>
          Effect.sync(() => {
            const prefix = `${sessionId}/${toolCallId}.`;
            const results: FileChange[] = [];
            for (const [key, value] of store) {
              if (key.startsWith(prefix)) results.push(value);
            }
            return results;
          }),

        revert: (sessionId: string, toolCallId: string, changeId: string) =>
          Effect.sync(() => {
            const key = `${sessionId}/${toolCallId}.${changeId}`;
            const change = store.get(key);
            if (!change || change.reverted) return Option.none<FileChange>();
            change.reverted = true;
            return Option.some(change);
          }),

        findLatest: (sessionId: string, filePath: string, activeToolCallIds: string[]) =>
          Effect.sync(() => {
            const uri = `file://${path.resolve(filePath)}`;
            for (let i = activeToolCallIds.length - 1; i >= 0; i--) {
              const toolCallId = activeToolCallIds[i];
              if (!toolCallId) continue;
              const prefix = `${sessionId}/${toolCallId}.`;
              for (const [key, change] of store) {
                if (key.startsWith(prefix) && !change.reverted && change.uri === uri) {
                  return Option.some({ toolCallId, change });
                }
              }
            }
            return Option.none<{
              toolCallId: string;
              change: FileChange;
            }>();
          }),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// simpleDiff — pure function, no service needed
// ---------------------------------------------------------------------------

const _diffLib = (() => {
  try {
    const esmRequire = createRequire(import.meta.url);
    const diffLib = esmRequire("diff");
    return { createPatch: diffLib.createPatch as (
      fileName: string,
      oldStr: string,
      newStr: string,
      oldHeader?: string,
      newHeader?: string,
      options?: { context?: number },
    ) => string };
  } catch {
    return null;
  }
})();

export function simpleDiff(filePath: string, before: string, after: string): string {
  if (_diffLib) {
    const patch = _diffLib.createPatch(path.basename(filePath), before, after, "original", "modified", {
      context: 3,
    });
    const lines = patch.split("\n");
    const startIdx = lines.findIndex((l) => l.startsWith("---"));
    return (startIdx > 0 ? lines.slice(startIdx) : lines).join("\n");
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  const lines: string[] = [
    `--- ${path.basename(filePath)}\toriginal`,
    `+++ ${path.basename(filePath)}\tmodified`,
  ];

  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      lines.push(` ${beforeLines[i]}`);
      i++;
      j++;
    } else if (
      i < beforeLines.length &&
      (j >= afterLines.length || beforeLines[i] !== afterLines[j])
    ) {
      lines.push(`-${beforeLines[i]}`);
      i++;
    } else {
      lines.push(`+${afterLines[j]}`);
      j++;
    }
  }

  return lines.join("\n");
}

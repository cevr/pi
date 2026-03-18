/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  saveChange,
  loadChanges,
  revertChange,
  findLatestChange,
  simpleDiff,
  setFileChangesDir,
} from "./index";

let tmpDir: string;
let sessionId: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `pi-file-tracker-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  sessionId = `test-session-${Date.now()}`;
  setFileChangesDir(tmpDir);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// simpleDiff (pure)
// ---------------------------------------------------------------------------

describe("simpleDiff", () => {
  it("generates unified diff for added lines", () => {
    const diff = simpleDiff("test.txt", "line1\nline2", "line1\nline2\nline3");
    expect(diff).toContain("+line3");
  });

  it("generates unified diff for removed lines", () => {
    const diff = simpleDiff("test.txt", "line1\nline2\nline3", "line1\nline3");
    expect(diff).toContain("-line2");
  });

  it("generates unified diff for changed lines", () => {
    const diff = simpleDiff("file.txt", "old content", "new content");
    expect(diff).toContain("-old content");
    expect(diff).toContain("+new content");
  });

  it("handles identical content", () => {
    const content = "same\nlines\nhere";
    const diff = simpleDiff("same.txt", content, content);
    const lines = diff.split("\n");
    expect(lines.filter((l) => l.startsWith("-") && !l.startsWith("---"))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toHaveLength(0);
  });

  it("handles empty before content", () => {
    expect(simpleDiff("new.txt", "", "new file content")).toContain("+new file content");
  });

  it("handles empty after content", () => {
    expect(simpleDiff("del.txt", "deleted content", "")).toContain("-deleted content");
  });

  it("includes file basename in diff header", () => {
    const diff = simpleDiff("/path/to/some/file.ts", "a", "b");
    expect(diff).toContain("--- file.ts");
    expect(diff).toContain("+++ file.ts");
  });
});

// ---------------------------------------------------------------------------
// sync API
// ---------------------------------------------------------------------------

describe("saveChange and loadChanges", () => {
  it("saves and loads back", () => {
    const filePath = path.join(tmpDir, "test-file.txt");
    const changeId = saveChange(sessionId, "tc-123", {
      uri: `file://${filePath}`,
      before: "",
      after: "content",
      diff: simpleDiff(filePath, "", "content"),
      isNewFile: true,
      timestamp: Date.now(),
    });

    expect(changeId).toMatch(/^[0-9a-f]{8}-/);
    const changes = loadChanges(sessionId, "tc-123");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.after).toBe("content");
  });

  it("supports multiple changes per tool call", () => {
    const id1 = saveChange(sessionId, "tc-multi", {
      uri: `file://${path.join(tmpDir, "f1.txt")}`,
      before: "",
      after: "c1",
      diff: "",
      isNewFile: true,
      timestamp: Date.now(),
    });
    const id2 = saveChange(sessionId, "tc-multi", {
      uri: `file://${path.join(tmpDir, "f2.txt")}`,
      before: "",
      after: "c2",
      diff: "",
      isNewFile: true,
      timestamp: Date.now(),
    });
    expect(id1).not.toBe(id2);
    expect(loadChanges(sessionId, "tc-multi")).toHaveLength(2);
  });

  it("returns empty for missing", () => {
    expect(loadChanges(sessionId, "nonexistent")).toEqual([]);
  });
});

describe("revertChange", () => {
  it("restores file and marks reverted", () => {
    const filePath = path.join(tmpDir, "to-revert.txt");
    fs.writeFileSync(filePath, "original", "utf-8");
    const changeId = saveChange(sessionId, "tc-revert", {
      uri: `file://${filePath}`,
      before: "original",
      after: "modified",
      diff: "",
      isNewFile: false,
      timestamp: Date.now(),
    });
    fs.writeFileSync(filePath, "modified", "utf-8");

    const result = revertChange(sessionId, "tc-revert", changeId);
    expect(result).not.toBeNull();
    expect(result?.reverted).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
  });

  it("returns null for nonexistent", () => {
    expect(revertChange(sessionId, "tc-xxx", "nope")).toBeNull();
  });

  it("returns null for already reverted", () => {
    const filePath = path.join(tmpDir, "revert-twice.txt");
    fs.writeFileSync(filePath, "before", "utf-8");
    const changeId = saveChange(sessionId, "tc-twice", {
      uri: `file://${filePath}`,
      before: "before",
      after: "after",
      diff: "",
      isNewFile: false,
      timestamp: Date.now(),
    });
    expect(revertChange(sessionId, "tc-twice", changeId)).not.toBeNull();
    expect(revertChange(sessionId, "tc-twice", changeId)).toBeNull();
  });
});

describe("findLatestChange", () => {
  it("finds most recent non-reverted change", () => {
    const filePath = path.join(tmpDir, "chain.txt");
    saveChange(sessionId, "tc1", {
      uri: `file://${filePath}`,
      before: "v1",
      after: "v2",
      diff: "",
      isNewFile: false,
      timestamp: Date.now() - 2000,
    });
    saveChange(sessionId, "tc2", {
      uri: `file://${filePath}`,
      before: "v2",
      after: "v3",
      diff: "",
      isNewFile: false,
      timestamp: Date.now(),
    });
    const result = findLatestChange(sessionId, filePath, ["tc1", "tc2"]);
    expect(result?.change.after).toBe("v3");
    expect(result?.toolCallId).toBe("tc2");
  });

  it("returns null for no changes", () => {
    expect(findLatestChange(sessionId, "/nope.txt", ["tc-x"])).toBeNull();
  });
});

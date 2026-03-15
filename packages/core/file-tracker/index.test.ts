// Extracted from index.ts — review imports
import { describe, expect, it, test, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveChange, loadChanges, revertChange, findLatestChange, simpleDiff } from "./index";
import { saveChange, loadChanges, revertChange, findLatestChange, simpleDiff } from "./index";

let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-file-tracker-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    sessionId = `test-session-${Date.now()}`;
    (globalThis as any).__PI_FILE_CHANGES_DIR__ = tmpDir;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("simpleDiff", () => {
    it("generates unified diff for added lines", () => {
      const before = "line1\nline2";
      const after = "line1\nline2\nline3";
      const diff = simpleDiff("test.txt", before, after);

      expect(diff).toContain("--- test.txt");
      expect(diff).toContain("+++ test.txt");
      expect(diff).toContain("+line3");
    });

    it("generates unified diff for removed lines", () => {
      const before = "line1\nline2\nline3";
      const after = "line1\nline3";
      const diff = simpleDiff("test.txt", before, after);

      expect(diff).toContain("-line2");
      expect(diff).not.toContain("+line2");
    });

    it("generates unified diff for changed lines", () => {
      const before = "old content";
      const after = "new content";
      const diff = simpleDiff("file.txt", before, after);

      expect(diff).toContain("-old content");
      expect(diff).toContain("+new content");
    });

    it("handles identical content (no changes)", () => {
      const content = "same\nlines\nhere";
      const diff = simpleDiff("same.txt", content, content);

      expect(diff).toContain("--- same.txt");
      expect(diff).toContain("+++ same.txt");
      const lines = diff.split("\n");
      const changedLines = lines.filter(
        (l) => l.startsWith("-") && !l.startsWith("---"),
      );
      const addedLines = lines.filter(
        (l) => l.startsWith("+") && !l.startsWith("+++"),
      );
      expect(changedLines).toHaveLength(0);
      expect(addedLines).toHaveLength(0);
    });

    it("handles empty before content", () => {
      const after = "new file content";
      const diff = simpleDiff("new.txt", "", after);

      expect(diff).toContain("+new file content");
    });

    it("handles empty after content", () => {
      const before = "deleted content";
      const diff = simpleDiff("del.txt", before, "");

      expect(diff).toContain("-deleted content");
    });

    it("includes file basename in diff header", () => {
      const diff = simpleDiff("/path/to/some/file.ts", "a", "b");
      expect(diff).toContain("--- file.ts");
      expect(diff).toContain("+++ file.ts");
    });
  });

  describe("saveChange and loadChanges", () => {
    it("saves a change record to disk and loads it back", () => {
      const toolCallId = "tc-123";
      const filePath = path.join(tmpDir, "test-file.txt");
      const content = "file content here";

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "",
        after: content,
        diff: simpleDiff(filePath, "", content),
        isNewFile: true,
        timestamp: Date.now(),
      });

      expect(changeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.id).toBe(changeId);
      expect(changes[0]!.uri).toBe(`file://${filePath}`);
      expect(changes[0]!.before).toBe("");
      expect(changes[0]!.after).toBe(content);
      expect(changes[0]!.isNewFile).toBe(true);
      expect(changes[0]!.reverted).toBe(false);
    });

    it("supports multiple changes per tool call", () => {
      const toolCallId = "tc-multi";
      const file1 = path.join(tmpDir, "file1.txt");
      const file2 = path.join(tmpDir, "file2.txt");

      const id1 = saveChange(sessionId, toolCallId, {
        uri: `file://${file1}`,
        before: "",
        after: "content1",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      const id2 = saveChange(sessionId, toolCallId, {
        uri: `file://${file2}`,
        before: "",
        after: "content2",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      expect(id1).not.toBe(id2);

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes).toHaveLength(2);
      const uris = changes.map((c) => c.uri);
      expect(uris).toContain(`file://${file1}`);
      expect(uris).toContain(`file://${file2}`);
    });

    it("returns empty array when no changes exist", () => {
      const changes = loadChanges(sessionId, "nonexistent-toolcall");
      expect(changes).toEqual([]);
    });

    it("persists changes across calls (real disk)", () => {
      const toolCallId = "tc-persist";
      const filePath = path.join(tmpDir, "persist.txt");

      saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "old",
        after: "new",
        diff: simpleDiff(filePath, "old", "new"),
        isNewFile: false,
        timestamp: Date.now(),
      });

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.before).toBe("old");
      expect(changes[0]!.after).toBe("new");
    });
  });

  describe("revertChange", () => {
    it("restores file to before state and marks reverted", () => {
      const toolCallId = "tc-revert";
      const filePath = path.join(tmpDir, "to-revert.txt");

      fs.writeFileSync(filePath, "original content", "utf-8");

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "original content",
        after: "modified content",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      fs.writeFileSync(filePath, "modified content", "utf-8");
      expect(fs.readFileSync(filePath, "utf-8")).toBe("modified content");

      const result = revertChange(sessionId, toolCallId, changeId);

      expect(result).not.toBeNull();
      expect(result?.reverted).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe("original content");

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes[0]!.reverted).toBe(true);
    });

    it("returns null for nonexistent change", () => {
      const result = revertChange(sessionId, "tc-xxx", "nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns null for already reverted change", () => {
      const toolCallId = "tc-revert-twice";
      const filePath = path.join(tmpDir, "revert-once.txt");

      fs.writeFileSync(filePath, "before", "utf-8");

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "before",
        after: "after",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      const first = revertChange(sessionId, toolCallId, changeId);
      expect(first).not.toBeNull();

      const second = revertChange(sessionId, toolCallId, changeId);
      expect(second).toBeNull();
    });

    it("works for newly created files (isNewFile: true)", () => {
      const toolCallId = "tc-newfile";
      const filePath = path.join(tmpDir, "brand-new.txt");

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "",
        after: "new file content",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      fs.writeFileSync(filePath, "new file content", "utf-8");

      const result = revertChange(sessionId, toolCallId, changeId);

      expect(result).not.toBeNull();
      expect(fs.readFileSync(filePath, "utf-8")).toBe("");
    });
  });

  describe("findLatestChange", () => {
    it("finds the most recent change for a file", () => {
      const tc1 = "tc-first";
      const tc2 = "tc-second";
      const filePath = path.join(tmpDir, "chain.txt");

      saveChange(sessionId, tc1, {
        uri: `file://${filePath}`,
        before: "v1",
        after: "v2",
        diff: "",
        isNewFile: false,
        timestamp: Date.now() - 2000,
      });

      saveChange(sessionId, tc2, {
        uri: `file://${filePath}`,
        before: "v2",
        after: "v3",
        diff: "",
        isNewFile: false,
        timestamp: Date.now() - 1000,
      });

      const result = findLatestChange(sessionId, filePath, [tc1, tc2]);

      expect(result).not.toBeNull();
      expect(result?.change.before).toBe("v2");
      expect(result?.change.after).toBe("v3");
      expect(result?.toolCallId).toBe(tc2);
    });

    it("skips reverted changes", () => {
      const tc1 = "tc-revert-skip";
      const filePath = path.join(tmpDir, "skip-reverted.txt");

      const changeId = saveChange(sessionId, tc1, {
        uri: `file://${filePath}`,
        before: "old",
        after: "new",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      // mark as reverted by updating the file
      const changes = loadChanges(sessionId, tc1);
      const change = { ...changes[0], reverted: true };
      const changeFilePath = path.join(tmpDir, sessionId, `${tc1}.${changeId}`);
      fs.writeFileSync(
        changeFilePath,
        JSON.stringify(change, null, 2),
        "utf-8",
      );

      const result = findLatestChange(sessionId, filePath, [tc1]);
      expect(result).toBeNull();
    });

    it("respects branch order (activeToolCallIds order)", () => {
      const tc1 = "tc-branch-1";
      const tc2 = "tc-branch-2";
      const filePath = path.join(tmpDir, "branch-order.txt");

      saveChange(sessionId, tc1, {
        uri: `file://${filePath}`,
        before: "a",
        after: "b",
        diff: "",
        isNewFile: false,
        timestamp: Date.now() - 1000,
      });

      saveChange(sessionId, tc2, {
        uri: `file://${filePath}`,
        before: "c",
        after: "d",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      const result1 = findLatestChange(sessionId, filePath, [tc1, tc2]);
      expect(result1?.change.after).toBe("d");

      const result2 = findLatestChange(sessionId, filePath, [tc1]);
      expect(result2?.change.after).toBe("b");
    });

    it("returns null when file has no changes", () => {
      const result = findLatestChange(sessionId, "/nonexistent/file.txt", [
        "tc-x",
      ]);
      expect(result).toBeNull();
    });

    it("handles multiple changes to different files in same tool call", () => {
      const tc = "tc-multi-file";
      const file1 = path.join(tmpDir, "multi1.txt");
      const file2 = path.join(tmpDir, "multi2.txt");

      saveChange(sessionId, tc, {
        uri: `file://${file1}`,
        before: "",
        after: "f1",
        diff: "",
        isNewFile: true,
        timestamp: Date.now() - 1000,
      });

      saveChange(sessionId, tc, {
        uri: `file://${file2}`,
        before: "",
        after: "f2",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      const result1 = findLatestChange(sessionId, file1, [tc]);
      const result2 = findLatestChange(sessionId, file2, [tc]);

      expect(result1?.change.after).toBe("f1");
      expect(result2?.change.after).toBe("f2");
    });
  });

import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { parseAuditScopeArgs, toAuditDisplayPath } from "./scope";

describe("parseAuditScopeArgs", () => {
  it("keeps plain text as prompt when no paths are present", () => {
    const result = parseAuditScopeArgs("check react and effect", process.cwd());
    expect(result).toEqual({
      targetPaths: [],
      userPrompt: "check react and effect",
      invalidPaths: [],
    });
  });

  it("extracts existing paths and preserves the remaining prompt", () => {
    const cwd = makeFixture();
    const result = parseAuditScopeArgs("src/a.ts check correctness", cwd);

    expect(result.targetPaths).toEqual([path.join(cwd, "src/a.ts")]);
    expect(result.userPrompt).toBe("check correctness");
    expect(result.invalidPaths).toEqual([]);
  });

  it("supports quoted paths with spaces", () => {
    const cwd = makeFixture();
    const result = parseAuditScopeArgs('"docs/notes file.md" tighten wording', cwd);

    expect(result.targetPaths).toEqual([path.join(cwd, "docs/notes file.md")]);
    expect(result.userPrompt).toBe("tighten wording");
  });

  it("collects invalid explicit @path tokens", () => {
    const cwd = makeFixture();
    const result = parseAuditScopeArgs("@missing.ts check types", cwd);

    expect(result.invalidPaths).toEqual(["@missing.ts"]);
    expect(result.targetPaths).toEqual([]);
    expect(result.userPrompt).toBe("check types");
  });
});

describe("toAuditDisplayPath", () => {
  it("renders workspace-relative paths when possible", () => {
    const cwd = "/repo";
    expect(toAuditDisplayPath("/repo/src/a.ts", cwd)).toBe("src/a.ts");
  });

  it("keeps absolute paths outside the workspace", () => {
    const cwd = "/repo";
    expect(toAuditDisplayPath("/elsewhere/a.ts", cwd)).toBe("/elsewhere/a.ts");
  });
});

function makeFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-audit-scope-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "src/a.ts"), "export const a = 1\n");
  writeFileSync(path.join(root, "docs/notes file.md"), "# Notes\n");
  return root;
}

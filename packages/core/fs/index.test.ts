/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
// Extracted from index.ts
import { describe, expect, it, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  expandPath,
  resolveToAbsolute,
  resolveWithVariants,
  resolveWithVariantsUsing,
  parseScopedPathArgs,
  toWorkspaceDisplayPath,
  isSecretFile,
  listDirectory,
  walkDirSync,
} from "./index";

const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = fs;
const { join } = path;
const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("expandPath", () => {
  it("strips @ prefix", () => {
    expect(expandPath("@/foo/bar")).toBe("/foo/bar");
  });

  it("expands ~ to homedir", () => {
    expect(expandPath("~")).toBe(os.homedir());
  });

  it("expands ~/ to homedir + path", () => {
    expect(expandPath("~/foo")).toBe(os.homedir() + "/foo");
  });

  it("returns unchanged path without prefix", () => {
    expect(expandPath("/absolute/path")).toBe("/absolute/path");
    expect(expandPath("relative/path")).toBe("relative/path");
  });
});

describe("resolveToAbsolute", () => {
  it("returns absolute paths unchanged", () => {
    expect(resolveToAbsolute("/foo/bar", "/cwd")).toBe("/foo/bar");
  });

  it("resolves relative paths against cwd", () => {
    expect(resolveToAbsolute("foo/bar", "/cwd")).toBe("/cwd/foo/bar");
  });

  it("expands ~ before resolving", () => {
    expect(resolveToAbsolute("~/foo", "/cwd")).toBe(os.homedir() + "/foo");
  });
});

describe("resolveWithVariants", () => {
  it("returns the existing resolved path unchanged", () => {
    const dir = makeTmpDir();
    const file = join(dir, "plain.txt");
    writeFileSync(file, "x");

    expect(resolveWithVariants(file, "/cwd")).toBe(file);
  });

  it("falls back to narrow no-break space am/pm names", () => {
    const dir = makeTmpDir();
    const variant = join(dir, "meeting\u202FPM.txt");
    writeFileSync(variant, "x");

    expect(resolveWithVariants(join(dir, "meeting PM.txt"), "/cwd")).toBe(variant);
  });

  it("falls back to nfd-normalized names", () => {
    const requested = "/tmp/café.txt";
    const variant = requested.normalize("NFD");

    expect(resolveWithVariantsUsing(requested, "/cwd", (candidate) => candidate === variant)).toBe(
      variant,
    );
  });
});

describe("parseScopedPathArgs", () => {
  it("keeps plain text as prompt when no paths are present", () => {
    const result = parseScopedPathArgs("check react and effect", process.cwd());
    expect(result).toEqual({
      targetPaths: [],
      userPrompt: "check react and effect",
      invalidPaths: [],
    });
  });

  it("extracts existing paths and preserves the remaining prompt", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1\n");

    const result = parseScopedPathArgs("src/a.ts check correctness", dir);
    expect(result.targetPaths).toEqual([join(dir, "src", "a.ts")]);
    expect(result.userPrompt).toBe("check correctness");
    expect(result.invalidPaths).toEqual([]);
  });

  it("supports quoted paths with spaces", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "notes file.md"), "# Notes\n");

    const result = parseScopedPathArgs('"docs/notes file.md" tighten wording', dir);
    expect(result.targetPaths).toEqual([join(dir, "docs", "notes file.md")]);
    expect(result.userPrompt).toBe("tighten wording");
  });

  it("collects invalid explicit @path tokens", () => {
    const dir = makeTmpDir();
    const result = parseScopedPathArgs("@missing.ts check types", dir);

    expect(result.invalidPaths).toEqual(["@missing.ts"]);
    expect(result.targetPaths).toEqual([]);
    expect(result.userPrompt).toBe("check types");
  });
});

describe("toWorkspaceDisplayPath", () => {
  it("renders workspace-relative paths when possible", () => {
    expect(toWorkspaceDisplayPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("keeps absolute paths outside the workspace", () => {
    expect(toWorkspaceDisplayPath("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts");
  });
});

describe("isSecretFile", () => {
  it("blocks .env files", () => {
    expect(isSecretFile("/home/user/.env")).toBe(true);
    expect(isSecretFile("/home/user/.env.local")).toBe(true);
    expect(isSecretFile("/home/user/.env.production")).toBe(true);
  });

  it("allows .env.example and friends", () => {
    expect(isSecretFile("/home/user/.env.example")).toBe(false);
    expect(isSecretFile("/home/user/.env.sample")).toBe(false);
    expect(isSecretFile("/home/user/.env.template")).toBe(false);
  });

  it("allows other files", () => {
    expect(isSecretFile("/home/user/config.json")).toBe(false);
    expect(isSecretFile("/home/user/README.md")).toBe(false);
  });
});

describe("listDirectory", () => {
  it("adds trailing slashes to directories", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "alpha"));
    writeFileSync(join(dir, "beta.txt"), "x");

    expect(listDirectory(dir, 10).split("\n")).toEqual(["alpha/", "beta.txt"]);
  });

  it("truncates with the existing head-tail marker shape", () => {
    const dir = makeTmpDir();
    for (const name of ["a", "b", "c", "d", "e"]) {
      writeFileSync(join(dir, `${name}.txt`), name);
    }

    expect(listDirectory(dir, 4)).toBe(
      ["a.txt", "b.txt", "", "... [1 more entries] ...", "", "d.txt", "e.txt"].join("\n"),
    );
  });
});

describe("walkDirSync", () => {
  it("collects matching files recursively", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "root.jsonl"), "x");
    writeFileSync(join(dir, "a", "b", "leaf.jsonl"), "x");
    writeFileSync(join(dir, "a", "b", "leaf.txt"), "x");

    expect(
      walkDirSync(dir, {
        filter: (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
      })
        .map((file) => path.basename(file))
        .sort(),
    ).toEqual(["leaf.jsonl", "root.jsonl"]);
  });

  it("stops after the first stopWhen match", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "target.jsonl"), "x");
    writeFileSync(join(dir, "a", "b", "later.jsonl"), "x");

    const matches = walkDirSync(dir, {
      stopWhen: (entry) => entry.isFile() && entry.name === "target.jsonl",
    });

    expect(matches).toHaveLength(1);
    expect(path.basename(matches[0]!)).toBe("target.jsonl");
  });
});

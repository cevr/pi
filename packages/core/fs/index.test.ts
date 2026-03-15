// Extracted from index.ts — review imports
import { describe, expect, it, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { expandPath, resolveToAbsolute, resolveWithVariants, isSecretFile, listDirectory, walkDirSync } from "./index";

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

      expect(resolveWithVariants(join(dir, "meeting PM.txt"), "/cwd")).toBe(
        variant,
      );
    });

    it("falls back to nfd-normalized names", () => {
      const requested = "/tmp/café.txt";
      const variant = requested.normalize("NFD");

      expect(
        resolveWithVariantsUsing(
          requested,
          "/cwd",
          (candidate) => candidate === variant,
        ),
      ).toBe(variant);
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

      expect(listDirectory(dir, 10).split("\n")).toEqual([
        "alpha/",
        "beta.txt",
      ]);
    });

    it("truncates with the existing head-tail marker shape", () => {
      const dir = makeTmpDir();
      for (const name of ["a", "b", "c", "d", "e"]) {
        writeFileSync(join(dir, `${name}.txt`), name);
      }

      expect(listDirectory(dir, 4)).toBe(
        [
          "a.txt",
          "b.txt",
          "",
          "... [1 more entries] ...",
          "",
          "d.txt",
          "e.txt",
        ].join("\n"),
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

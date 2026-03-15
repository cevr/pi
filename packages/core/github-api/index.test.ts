// Extracted from index.ts — review imports
import { describe, expect, it } from "bun:test";
import { parseRepoUrl, repoSlug, decodeBase64Content, addLineNumbers, truncate } from "./index";
import { parseRepoUrl, repoSlug, decodeBase64Content, addLineNumbers, truncate } from "./index";

describe("github api helpers", () => {
    describe("parseRepoUrl", () => {
      it("parses full https URL", () => {
        expect(parseRepoUrl("https://github.com/owner/repo")).toEqual({
          owner: "owner",
          repo: "repo",
        });
      });

      it("parses URL without protocol", () => {
        expect(parseRepoUrl("github.com/owner/repo")).toEqual({
          owner: "owner",
          repo: "repo",
        });
      });

      it("parses shorthand owner/repo", () => {
        expect(parseRepoUrl("owner/repo")).toEqual({
          owner: "owner",
          repo: "repo",
        });
      });

      it("strips trailing .git", () => {
        expect(parseRepoUrl("https://github.com/owner/repo.git")).toEqual({
          owner: "owner",
          repo: "repo",
        });
      });

      it("strips trailing slash", () => {
        expect(parseRepoUrl("https://github.com/owner/repo/")).toEqual({
          owner: "owner",
          repo: "repo",
        });
      });

      it("throws on invalid input", () => {
        expect(() => parseRepoUrl("just-a-name")).toThrow(/invalid repository/);
      });
    });

    describe("repoSlug", () => {
      it("returns owner/repo", () => {
        expect(repoSlug({ owner: "a", repo: "b" })).toBe("a/b");
      });
    });

    describe("decodeBase64Content", () => {
      it("decodes base64 with embedded newlines", () => {
        const encoded = Buffer.from("hello world").toString("base64");
        const withNewlines = encoded.slice(0, 4) + "\n" + encoded.slice(4);
        expect(decodeBase64Content(withNewlines)).toBe("hello world");
      });
    });

    describe("addLineNumbers", () => {
      it("numbers from 1 by default", () => {
        expect(addLineNumbers("a\nb\nc")).toBe("1: a\n2: b\n3: c");
      });

      it("numbers from custom start", () => {
        expect(addLineNumbers("x\ny", 10)).toBe("10: x\n11: y");
      });
    });

    describe("truncate", () => {
      it("returns short strings unchanged", () => {
        expect(truncate("hello", 100)).toBe("hello");
      });

      it("truncates with indicator", () => {
        const result = truncate("a".repeat(200), 50);
        expect(result.length).toBeLessThan(200);
        expect(result).toContain("truncated");
        expect(result).toContain("200 total characters");
      });
    });
  });

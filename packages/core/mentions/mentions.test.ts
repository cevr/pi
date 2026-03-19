/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { GitClient } from "@cvr/pi-git-client";
import { detectMentionPrefix, parseMentions } from "./parse";
import { MentionAwareProvider } from "./provider";
import { resolveMentions } from "./resolve";
import { toResolvedSessionMention } from "./types";
import { renderResolvedMentionsBlock, renderResolvedMentionsText } from "./render";
import { CommitIndexService, lookupCommitByPrefix, parseCommitLog } from "./commit-index";
import { clearCommitIndexCache, getCommitIndex } from "./commit-index-sync";
import {
  clearSessionMentionCache,
  resolveMentionableSession,
  type MentionableSession,
} from "./session-index";
import { getMentionSource, registerMentionSource, type MentionSource } from "./sources";

describe("parseMentions", () => {
  it("parses built-in mention tokens", () => {
    expect(parseMentions("use @commit/abc1234")).toEqual([
      {
        kind: "commit",
        raw: "@commit/abc1234",
        value: "abc1234",
        start: 4,
        end: 19,
      },
    ]);
  });

  it("ignores embedded email-ish strings", () => {
    expect(parseMentions("foo@commit/abc1234 bar")).toEqual([]);
  });

  it("only parses extension mention kinds after they register", () => {
    expect(getMentionSource("session")).toBeNull();
    expect(parseMentions("see @session/alpha1234")).toEqual([]);

    const unregisterSession = registerMentionSource(createTestSessionMentionSource("session"));
    const unregisterHandoff = registerMentionSource(createTestSessionMentionSource("handoff"));

    try {
      expect(
        parseMentions("use @commit/abc1234 then check @session/123e4567-e89b and @handoff/run-42"),
      ).toEqual([
        {
          kind: "commit",
          raw: "@commit/abc1234",
          value: "abc1234",
          start: 4,
          end: 19,
        },
        {
          kind: "session",
          raw: "@session/123e4567-e89b",
          value: "123e4567-e89b",
          start: 31,
          end: 53,
        },
        {
          kind: "handoff",
          raw: "@handoff/run-42",
          value: "run-42",
          start: 58,
          end: 73,
        },
      ]);
    } finally {
      unregisterHandoff();
      unregisterSession();
    }
  });
});

describe("detectMentionPrefix", () => {
  it("detects a bare family prefix", () => {
    expect(detectMentionPrefix("check @com")).toEqual({
      raw: "@com",
      start: 6,
      end: 10,
      familyQuery: "com",
      kind: null,
      valueQuery: "",
      hasSlash: false,
    });
  });

  it("detects a value prefix for a known family", () => {
    expect(detectMentionPrefix("check @commit/abc", 17)).toEqual({
      raw: "@commit/abc",
      start: 6,
      end: 17,
      familyQuery: "commit",
      kind: "commit",
      valueQuery: "abc",
      hasSlash: true,
    });
  });

  it("only recognizes extension families after they register", () => {
    expect(getMentionSource("handoff")).toBeNull();
    expect(detectMentionPrefix("check @handoff/run-42", 22)).toEqual({
      raw: "@handoff/run-42",
      start: 6,
      end: 22,
      familyQuery: "handoff",
      kind: null,
      valueQuery: "run-42",
      hasSlash: true,
    });

    const unregisterHandoff = registerMentionSource(createTestSessionMentionSource("handoff"));

    try {
      expect(detectMentionPrefix("check @handoff/run-42", 22)).toEqual({
        raw: "@handoff/run-42",
        start: 6,
        end: 22,
        familyQuery: "handoff",
        kind: "handoff",
        valueQuery: "run-42",
        hasSlash: true,
      });
    } finally {
      unregisterHandoff();
    }
  });

  it("returns null outside mention context", () => {
    expect(detectMentionPrefix("check this", 10)).toBeNull();
  });
});

describe("renderResolvedMentions", () => {
  it("renders commit, session, and handoff summaries", () => {
    expect(
      renderResolvedMentionsText([
        {
          token: {
            kind: "commit",
            raw: "@commit/abc1234",
            value: "abc1234",
            start: 0,
            end: 15,
          },
          status: "resolved",
          kind: "commit",
          commit: {
            sha: "abc1234def5678abc1234def5678abc1234def5",
            shortSha: "abc1234",
            subject: "fix mention parser",
            committedAt: "2026-03-06T16:00:00.000Z",
          },
        },
        {
          token: {
            kind: "session",
            raw: "@session/alpha1234",
            value: "alpha1234",
            start: 16,
            end: 34,
          },
          status: "resolved",
          kind: "session",
          session: {
            sessionId: "alpha1234",
            sessionName: "alpha work",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:10:00.000Z",
            firstUserMessage: "alpha task",
          },
        },
        {
          token: {
            kind: "handoff",
            raw: "@handoff/handoffabcd",
            value: "handoffabcd",
            start: 35,
            end: 55,
          },
          status: "resolved",
          kind: "handoff",
          session: {
            sessionId: "handoffabcd",
            sessionName: "handoff alpha",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:20:00.000Z",
            firstUserMessage: "resume alpha",
            parentSessionPath: "/sessions/parent.jsonl",
          },
        },
      ]),
    ).toBe(
      [
        "resolved mention context:",
        '@commit/abc1234\tcommit\tabc1234def5678abc1234def5678abc1234def5\t2026-03-06T16:00:00.000Z\t"fix mention parser"',
        '@session/alpha1234\tsession\talpha1234\t2026-03-06T17:10:00.000Z\t"alpha work"\t"/repo/app"\t"alpha task"',
        '@handoff/handoffabcd\thandoff\thandoffabcd\t2026-03-06T17:20:00.000Z\t"handoff alpha"\t"/repo/app"\t"resume alpha"\t"/sessions/parent.jsonl"',
      ].join("\n"),
    );
  });

  it("wraps rendered summaries in a hidden block", () => {
    expect(
      renderResolvedMentionsBlock([
        {
          token: {
            kind: "commit",
            raw: "@commit/abc1234",
            value: "abc1234",
            start: 0,
            end: 15,
          },
          status: "resolved",
          kind: "commit",
          commit: {
            sha: "abc1234def5678abc1234def5678abc1234def5",
            shortSha: "abc1234",
            subject: "fix mention parser",
            committedAt: "2026-03-06T16:00:00.000Z",
          },
        },
      ]),
    ).toBe(
      '<!-- pi-mentions\nresolved mention context:\n@commit/abc1234\tcommit\tabc1234def5678abc1234def5678abc1234def5\t2026-03-06T16:00:00.000Z\t"fix mention parser"\n-->',
    );
  });

  it("returns empty string when nothing resolved", () => {
    expect(
      renderResolvedMentionsText([
        {
          token: {
            kind: "session",
            raw: "@session/test",
            value: "test",
            start: 0,
            end: 13,
          },
          status: "unresolved",
          reason: "session_not_found",
        },
      ]),
    ).toBe("");
  });
});

describe("mention autocomplete", () => {
  const baseProvider: AutocompleteProvider = {
    getSuggestions: () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
  };

  it("hides commit namespace outside git repositories", () => {
    const provider = new MentionAwareProvider({
      baseProvider,
      cwd: tmpdir(),
    });

    expect(provider.getSuggestions(["@c"], 0, 2)).toBeNull();

    expect(provider.getSuggestions(["@commit/abc123"], 0, 14)).toEqual({
      items: [],
      prefix: "@commit/abc123",
    });
  });

  it("adds a trailing space after applying a special mention completion", () => {
    const unregisterSession = registerMentionSource(createTestSessionMentionSource("session"));

    try {
      const provider = new MentionAwareProvider({
        baseProvider,
        cwd: tmpdir(),
      });

      const suggestions = provider.getSuggestions(["check @ses"], 0, 10);
      expect(suggestions).not.toBeNull();
      const item = suggestions?.items[0];
      expect(item?.value).toBe("@session/");

      expect(provider.applyCompletion(["check @ses"], 0, 10, item!, "@ses")).toEqual({
        lines: ["check @session/ "],
        cursorLine: 0,
        cursorCol: 16,
      });
    } finally {
      unregisterSession();
    }
  });

  it("does not add a duplicate space when one already follows the prefix", () => {
    const unregisterSession = registerMentionSource(createTestSessionMentionSource("session"));

    try {
      const provider = new MentionAwareProvider({
        baseProvider,
        cwd: tmpdir(),
      });

      const suggestions = provider.getSuggestions(["check @ses next"], 0, 10);
      expect(suggestions).not.toBeNull();
      const item = suggestions?.items[0];
      expect(item?.value).toBe("@session/");

      expect(provider.applyCompletion(["check @ses next"], 0, 10, item!, "@ses")).toEqual({
        lines: ["check @session/ next"],
        cursorLine: 0,
        cursorCol: 15,
      });
    } finally {
      unregisterSession();
    }
  });
});

describe("resolveMentions", () => {
  it("resolves session and handoff mentions from a provided session index", async () => {
    const unregisterSession = registerMentionSource(createTestSessionMentionSource("session"));
    const unregisterHandoff = registerMentionSource(createTestSessionMentionSource("handoff"));

    try {
      await expect(
        resolveMentions("see @session/alpha1234 then @handoff/handoffabcd", {
          cwd: "/repo/app",
          sessions: MENTIONABLE_SESSIONS,
        }),
      ).resolves.toEqual([
        {
          token: {
            kind: "session",
            raw: "@session/alpha1234",
            value: "alpha1234",
            start: 4,
            end: 22,
          },
          status: "resolved",
          kind: "session",
          session: {
            sessionId: "alpha1234",
            sessionName: "alpha work",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:10:00.000Z",
            firstUserMessage: "alpha task",
            parentSessionPath: undefined,
          },
        },
        {
          token: {
            kind: "handoff",
            raw: "@handoff/handoffabcd",
            value: "handoffabcd",
            start: 28,
            end: 48,
          },
          status: "resolved",
          kind: "handoff",
          session: {
            sessionId: "handoffabcd",
            sessionName: "handoff alpha",
            workspace: "/repo/app",
            startedAt: "2026-03-06T17:00:00.000Z",
            updatedAt: "2026-03-06T17:20:00.000Z",
            firstUserMessage: "resume alpha",
            parentSessionPath: "/sessions/parent.jsonl",
          },
        },
      ]);
    } finally {
      unregisterHandoff();
      unregisterSession();
    }
  });

  it("ignores extension mention syntax when the extension source is not registered", async () => {
    await expect(
      resolveMentions("see @session/alpha1234", {
        cwd: "/repo/app",
        sessions: [],
      }),
    ).resolves.toEqual([]);
  });
});

const MENTIONABLE_SESSIONS: MentionableSession[] = [
  {
    sessionId: "alpha1234",
    sessionName: "alpha work",
    workspace: "/repo/app",
    filePath: "/sessions/alpha.jsonl",
    startedAt: "2026-03-06T17:00:00.000Z",
    updatedAt: "2026-03-06T17:10:00.000Z",
    firstUserMessage: "alpha task",
    searchableText: "alpha task",
    branchCount: 1,
    isHandoffCandidate: false,
  },
  {
    sessionId: "handoffabcd",
    sessionName: "handoff alpha",
    workspace: "/repo/app",
    filePath: "/sessions/handoff.jsonl",
    startedAt: "2026-03-06T17:00:00.000Z",
    updatedAt: "2026-03-06T17:20:00.000Z",
    firstUserMessage: "resume alpha",
    searchableText: "resume alpha",
    branchCount: 1,
    parentSessionPath: "/sessions/parent.jsonl",
    isHandoffCandidate: true,
  },
];

function createTestSessionMentionSource(kind: "session" | "handoff"): MentionSource {
  return {
    kind,
    description: kind,
    getSuggestions(query, context) {
      return (context.sessions ?? [])
        .filter((session) => kind !== "handoff" || session.isHandoffCandidate)
        .filter(
          (session) =>
            query.length === 0 || session.sessionId.toLowerCase().startsWith(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((session) => ({
          value: `@${kind}/${session.sessionId}`,
          label: `@${kind}/${session.sessionId}`,
          description: session.sessionName || session.firstUserMessage || session.workspace,
        }));
    },
    resolve(token, context) {
      const result = resolveMentionableSession(context.sessions ?? [], token.value, kind);

      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind,
          session: toResolvedSessionMention(result.session),
        };
      }

      return {
        token,
        status: "unresolved",
        reason: result.status === "ambiguous" ? `${kind}_prefix_ambiguous` : `${kind}_not_found`,
      };
    },
  };
}

const repos: string[] = [];

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mentions-commit-index-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "pi"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "pi@example.com"], { cwd: dir });
  return dir;
}

function commitFile(repo: string, name: string, contents: string, message: string): string {
  writeFileSync(join(repo, name), contents);
  execFileSync("git", ["add", name], { cwd: repo });
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-03-06T16:00:00.000Z",
    GIT_COMMITTER_DATE: "2026-03-06T16:00:00.000Z",
  };
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, env });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

afterEach(() => {
  clearCommitIndexCache();
  clearSessionMentionCache();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("parseCommitLog", () => {
  it("parses git log output deterministically", () => {
    expect(
      parseCommitLog("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t2026-03-06T16:00:00.000Z\tfirst\n"),
    ).toEqual([
      {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortSha: "aaaaaaaaaaaa",
        committedAt: "2026-03-06T16:00:00.000Z",
        subject: "first",
      },
    ]);
  });
});

describe("lookupCommitByPrefix", () => {
  it("resolves a unique commit prefix from a temp repo", () => {
    const repo = createRepo();
    repos.push(repo);
    const sha = commitFile(repo, "a.txt", "one", "first commit");
    commitFile(repo, "b.txt", "two", "second commit");

    const index = getCommitIndex(repo);
    expect(index).not.toBeNull();
    expect(lookupCommitByPrefix(sha.slice(0, 12), index!)).toEqual({
      status: "resolved",
      commit: expect.objectContaining({
        sha: sha.toLowerCase(),
        shortSha: sha.slice(0, 12).toLowerCase(),
        subject: "first commit",
      }),
    });
  });
});

describe("CommitIndexService", () => {
  it("builds an index from GitClient results", async () => {
    const sha = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const runtime = ManagedRuntime.make(
      CommitIndexService.layer.pipe(
        Layer.provide(
          GitClient.layerTest({
            root: "/repo/root",
            log: [
              {
                sha,
                shortSha: sha.slice(0, 12),
                subject: "first commit",
                committedAt: "2026-03-06T16:00:00.000Z",
              },
            ],
          }),
        ),
      ),
    );
    const index = await runtime.runPromise(
      Effect.gen(function* () {
        const commits = yield* CommitIndexService;
        return yield* commits.getIndex("/repo/worktree");
      }),
    );
    await runtime.dispose();

    expect(index).toEqual({
      root: "/repo/root",
      commits: [
        {
          sha: sha.toLowerCase(),
          shortSha: sha.slice(0, 12).toLowerCase(),
          subject: "first commit",
          committedAt: "2026-03-06T16:00:00.000Z",
        },
      ],
    });
  });
});

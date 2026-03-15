// Extracted from session-mention-source.ts — review imports
import { describe, expect, it } from "bun:test";
import { createSessionMentionSource } from "./session-mention-source";

const SESSION_FIXTURE = {
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
};

describe("createSessionMentionSource", () => {
  it("preserves session resolution and graceful degradation", () => {
    const source = createSessionMentionSource();

    expect(
      source.getSuggestions("", {
        cwd: "/repo/app",
        sessionsDir: "/definitely/missing",
      }),
    ).toEqual([]);

    expect(
      source.resolve(
        {
          kind: "session",
          raw: "@session/alpha",
          value: "alpha",
          start: 0,
          end: 14,
        },
        {
          cwd: "/repo/app",
          sessions: [SESSION_FIXTURE],
        },
      ),
    ).toEqual({
      token: {
        kind: "session",
        raw: "@session/alpha",
        value: "alpha",
        start: 0,
        end: 14,
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
    });

    expect(
      source.resolve(
        {
          kind: "session",
          raw: "@session/alpha",
          value: "alpha",
          start: 0,
          end: 14,
        },
        {
          cwd: "/repo/app",
          sessions: [
            SESSION_FIXTURE,
            {
              ...SESSION_FIXTURE,
              sessionId: "alpha5678",
              filePath: "/sessions/alpha-2.jsonl",
              updatedAt: "2026-03-06T17:20:00.000Z",
            },
          ],
        },
      ),
    ).toEqual({
      token: {
        kind: "session",
        raw: "@session/alpha",
        value: "alpha",
        start: 0,
        end: 14,
      },
      status: "unresolved",
      reason: "session_prefix_ambiguous",
    });

    expect(
      source.resolve(
        {
          kind: "session",
          raw: "@session/missing",
          value: "missing",
          start: 0,
          end: 16,
        },
        {
          cwd: "/repo/app",
          sessions: [SESSION_FIXTURE],
        },
      ),
    ).toEqual({
      token: {
        kind: "session",
        raw: "@session/missing",
        value: "missing",
        start: 0,
        end: 16,
      },
      status: "unresolved",
      reason: "session_not_found",
    });
  });
});

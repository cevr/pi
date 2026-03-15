import { describe, expect, it } from "bun:test";
import { Effect, Option } from "effect";
import { MentionRegistry } from "./registry";
import type { MentionSource, MentionSourceContext } from "./sources";
import type { MentionToken, ResolvedMention } from "./types";

const testSource: MentionSource = {
  kind: "session",
  description: "test session source",
  getSuggestions: () => [],
  resolve: (token: MentionToken): ResolvedMention => ({
    token,
    status: "resolved",
    kind: "session",
    session: {
      sessionId: token.value,
      sessionName: "test session",
      workspace: "/test",
      startedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      firstUserMessage: "hello",
    },
  }),
};

const runWithTest = <A, E>(
  effect: Effect.Effect<A, E, MentionRegistry>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect,
      MentionRegistry.layerTest({ sources: [testSource] }),
    ),
  );

describe("MentionRegistry service", () => {
  it("lists registered sources", async () => {
    const result = await runWithTest(
      Effect.gen(function* () {
        const registry = yield* MentionRegistry;
        return yield* registry.listSources();
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("session");
  });

  it("gets source by kind", async () => {
    const result = await runWithTest(
      Effect.gen(function* () {
        const registry = yield* MentionRegistry;
        const session = yield* registry.getSource("session");
        const commit = yield* registry.getSource("commit");
        return { session, commit };
      }),
    );
    expect(Option.isSome(result.session)).toBe(true);
    expect(Option.isNone(result.commit)).toBe(true);
  });

  it("resolves a mention token", async () => {
    const result = await runWithTest(
      Effect.gen(function* () {
        const registry = yield* MentionRegistry;
        return yield* registry.resolve(
          {
            kind: "session",
            raw: "@session/abc",
            value: "abc",
            start: 0,
            end: 12,
          },
          { cwd: "/test" },
        );
      }),
    );
    expect(result.status).toBe("resolved");
  });

  it("returns unresolved for unknown kind", async () => {
    const result = await runWithTest(
      Effect.gen(function* () {
        const registry = yield* MentionRegistry;
        return yield* registry.resolve(
          {
            kind: "commit",
            raw: "@commit/abc",
            value: "abc",
            start: 0,
            end: 11,
          },
          { cwd: "/test" },
        );
      }),
    );
    expect(result.status).toBe("unresolved");
  });

  it("registers and unregisters sources", async () => {
    const result = await runWithTest(
      Effect.gen(function* () {
        const registry = yield* MentionRegistry;
        const before = yield* registry.listSources();
        const unregister = yield* registry.registerSource({
          kind: "handoff",
          description: "handoff",
          getSuggestions: () => [],
          resolve: (token) => ({
            token,
            status: "unresolved",
            reason: "test",
          }),
        });
        const during = yield* registry.listSources();
        unregister();
        const after = yield* registry.listSources();
        return { before: before.length, during: during.length, after: after.length };
      }),
    );
    expect(result.before).toBe(1);
    expect(result.during).toBe(2);
    expect(result.after).toBe(1);
  });
});

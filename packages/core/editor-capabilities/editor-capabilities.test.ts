import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { EditorCapabilities } from "./index";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function createBaseProvider(log: string[]): AutocompleteProvider {
  return {
    getSuggestions: (lines, cursorLine, cursorCol) => {
      log.push(`base:get:${lines[cursorLine] ?? ""}:${cursorCol}`);
      return {
        items: [{ value: "@file/src/index.ts", label: "@file/src/index.ts" }],
        prefix: "@f",
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      log.push(`base:apply:${item.value}:${prefix}`);
      return { lines, cursorLine, cursorCol };
    },
  };
}

function createMentionsContributor(log: string[]) {
  return {
    id: "mentions",
    enhance(provider: AutocompleteProvider, context: { cwd: string }): AutocompleteProvider {
      log.push(`enhance:${context.cwd}`);
      return {
        getSuggestions(lines, cursorLine, cursorCol) {
          const line = lines[cursorLine] ?? "";
          if (line.startsWith("@commit/")) {
            log.push("mentions:get");
            return {
              items: [{ value: "@commit/abc123", label: "@commit/abc123" }],
              prefix: "@commit/",
            };
          }
          return provider.getSuggestions(lines, cursorLine, cursorCol);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          if (item.value.startsWith("@commit/")) {
            log.push(`mentions:apply:${prefix}`);
            return { lines, cursorLine, cursorCol };
          }
          return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Effect EditorCapabilities service tests
// ---------------------------------------------------------------------------

const runWithService = <A, E>(effect: Effect.Effect<A, E, EditorCapabilities>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, EditorCapabilities.layer));

describe("EditorCapabilities service", () => {
  it("registers and lists contributors", async () => {
    const result = await runWithService(
      Effect.gen(function* () {
        const caps = yield* EditorCapabilities;
        const unregister = yield* caps.register({
          id: "test",
          priority: 5,
          enhance: (p) => p,
        });
        const list = yield* caps.list();
        yield* unregister();
        const after = yield* caps.list();
        return { list, after };
      }),
    );

    expect(result.list).toHaveLength(1);
    expect(result.list[0]!.id).toBe("test");
    expect(result.after).toHaveLength(0);
  });

  it("composes providers through contributors", async () => {
    const log: string[] = [];
    const result = await runWithService(
      Effect.gen(function* () {
        const caps = yield* EditorCapabilities;
        yield* caps.register(createMentionsContributor(log));
        const base = createBaseProvider(log);
        const composed = yield* caps.compose(base, { cwd: "/repo" });
        return composed.getSuggestions(["@commit/"], 0, 8);
      }),
    );

    expect(result).toEqual({
      items: [{ value: "@commit/abc123", label: "@commit/abc123" }],
      prefix: "@commit/",
    });
    expect(log).toContain("enhance:/repo");
    expect(log).toContain("mentions:get");
  });

  it("sorts by priority then id", async () => {
    const result = await runWithService(
      Effect.gen(function* () {
        const caps = yield* EditorCapabilities;
        yield* caps.register({ id: "z", priority: 0, enhance: (p) => p });
        yield* caps.register({ id: "a", priority: 10, enhance: (p) => p });
        yield* caps.register({ id: "m", priority: 0, enhance: (p) => p });
        return yield* caps.list();
      }),
    );

    expect(result.map((c) => c.id)).toEqual(["m", "z", "a"]);
  });

  it("layerTest works the same as layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const caps = yield* EditorCapabilities;
        yield* caps.register({ id: "test", enhance: (p) => p });
        return yield* caps.list();
      }).pipe(Effect.provide(EditorCapabilities.layerTest)),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("test");
  });
});

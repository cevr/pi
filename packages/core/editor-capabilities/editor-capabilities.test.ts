import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it } from "bun:test";
import {
  registerEditorAutocompleteContributor,
  listEditorAutocompleteContributors,
  composeEditorAutocompleteProvider,
  subscribeEditorAutocompleteContributors,
} from "./index";

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
// cleanup — unregister all contributors between tests
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups.length = 0;
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("editor-capabilities sync API", () => {
  it("registers and lists contributors", () => {
    const unsub = registerEditorAutocompleteContributor({
      id: "test",
      priority: 5,
      enhance: (p) => p,
    });
    cleanups.push(unsub);

    const list = listEditorAutocompleteContributors();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("test");

    unsub();
    expect(listEditorAutocompleteContributors()).toHaveLength(0);
  });

  it("composes providers through contributors", () => {
    const log: string[] = [];
    cleanups.push(registerEditorAutocompleteContributor(createMentionsContributor(log)));
    const base = createBaseProvider(log);
    const composed = composeEditorAutocompleteProvider(base, { cwd: "/repo" });
    const result = composed.getSuggestions(["@commit/"], 0, 8);

    expect(result).toEqual({
      items: [{ value: "@commit/abc123", label: "@commit/abc123" }],
      prefix: "@commit/",
    });
    expect(log).toContain("enhance:/repo");
    expect(log).toContain("mentions:get");
  });

  it("sorts by priority then id", () => {
    cleanups.push(
      registerEditorAutocompleteContributor({ id: "z", priority: 0, enhance: (p) => p }),
    );
    cleanups.push(
      registerEditorAutocompleteContributor({ id: "a", priority: 10, enhance: (p) => p }),
    );
    cleanups.push(
      registerEditorAutocompleteContributor({ id: "m", priority: 0, enhance: (p) => p }),
    );

    const list = listEditorAutocompleteContributors();
    expect(list.map((c) => c.id)).toEqual(["m", "z", "a"]);
  });

  it("notifies subscribers on change", () => {
    let notified = 0;
    const unsub = subscribeEditorAutocompleteContributors(() => notified++);
    cleanups.push(unsub);

    const unregister = registerEditorAutocompleteContributor({ id: "x", enhance: (p) => p });
    cleanups.push(unregister);
    expect(notified).toBe(1);

    unregister();
    expect(notified).toBe(2);

    unsub();
    const unregY = registerEditorAutocompleteContributor({ id: "y", enhance: (p) => p });
    cleanups.push(unregY);
    expect(notified).toBe(2); // unsubscribed, no more notifications
  });
});

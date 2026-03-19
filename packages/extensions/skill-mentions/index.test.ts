import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createSkillMentionsExtension,
  detectSkillMentionPrefix,
  type SkillMentionsDeps,
} from "./index";

type RegisteredHandler = (...args: any[]) => any;

function createMockExtensionApiHarness() {
  const handlers: Array<{ event: string; handler: unknown }> = [];

  const pi = {
    on(event: string, handler: unknown) {
      handlers.push({ event, handler });
    },
  } as unknown as ExtensionAPI;

  return { pi, handlers };
}

function getHandler(
  handlers: Array<{ event: string; handler: unknown }>,
  event: string,
): RegisteredHandler {
  const entry = handlers.find((handler) => handler.event === event);
  if (!entry) throw new Error(`missing ${event} handler`);
  return entry.handler as RegisteredHandler;
}

function skill(name: string, description = `${name} description`) {
  return {
    name,
    description,
    token: name,
    displayName: name,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    location: "global",
    isLocal: false,
  };
}

function createDeps(skills = [skill("skill-mentions")]): SkillMentionsDeps {
  return {
    getSkillCatalog: () => skills as ReturnType<SkillMentionsDeps["getSkillCatalog"]>,
    loadSkillContent: () => null,
    resolveSkillReference: () => ({ skill: null, matches: [] }),
  };
}

describe("detectSkillMentionPrefix", () => {
  it("detects a trailing skill prefix", () => {
    expect(detectSkillMentionPrefix("use $skil")).toEqual({
      raw: "$skil",
      start: 4,
      end: 9,
      query: "skil",
    });
  });

  it("detects a bare dollar prefix", () => {
    expect(detectSkillMentionPrefix("$")).toEqual({
      raw: "$",
      start: 0,
      end: 1,
      query: "",
    });
  });

  it("ignores embedded dollar strings", () => {
    expect(detectSkillMentionPrefix("foo$skil")).toBeNull();
  });
});

describe("skill mentions extension", () => {
  it("opens immediately when the first real skill character appears after a bare dollar", async () => {
    const extension = createSkillMentionsExtension(createDeps());
    const harness = createMockExtensionApiHarness();
    extension(harness.pi);

    let editorText = "$";
    let terminalInputHandler: ((data: string) => void) | undefined;
    let customCalls = 0;

    const ctx = {
      cwd: "/repo/app",
      hasUI: true,
      ui: {
        onTerminalInput(handler: (data: string) => void) {
          terminalInputHandler = handler;
          return () => {
            terminalInputHandler = undefined;
          };
        },
        getEditorText() {
          return editorText;
        },
        setEditorText(value: string) {
          editorText = value;
        },
        custom: async (factory: any) => {
          customCalls += 1;
          const component = factory(
            { requestRender() {} },
            {
              fg: (_: string, s: string) => s,
              bg: (_: string, s: string) => s,
              bold: (s: string) => s,
            },
            undefined,
            () => {},
          );
          expect(editorText).toBe("$");
          component.handleInput("\r");
        },
      },
    };

    const sessionStartHandler = getHandler(harness.handlers, "session_start");
    await sessionStartHandler({}, ctx);

    terminalInputHandler?.("s");
    await Promise.resolve();

    expect(customCalls).toBe(1);
    expect(editorText).toBe("$skill-mentions ");
  });

  it("syncs in-popup edits back to the editor before selection", async () => {
    const extension = createSkillMentionsExtension(createDeps([skill("skill-map")]));
    const harness = createMockExtensionApiHarness();
    extension(harness.pi);

    let editorText = "$s";
    let terminalInputHandler: ((data: string) => void) | undefined;
    const seenEditorStates: string[] = [];

    const ctx = {
      cwd: "/repo/app",
      hasUI: true,
      ui: {
        onTerminalInput(handler: (data: string) => void) {
          terminalInputHandler = handler;
          return () => {
            terminalInputHandler = undefined;
          };
        },
        getEditorText() {
          return editorText;
        },
        setEditorText(value: string) {
          editorText = value;
          seenEditorStates.push(value);
        },
        custom: async (factory: any) => {
          const component = factory(
            { requestRender() {} },
            {
              fg: (_: string, s: string) => s,
              bg: (_: string, s: string) => s,
              bold: (s: string) => s,
            },
            undefined,
            () => {},
          );
          component.handleInput("i");
          expect(editorText).toBe("$ski");
          component.handleInput("\u007f");
          expect(editorText).toBe("$sk");
          component.handleInput("\r");
        },
      },
    };

    const sessionStartHandler = getHandler(harness.handlers, "session_start");
    await sessionStartHandler({}, ctx);

    terminalInputHandler?.("k");
    await Promise.resolve();

    expect(seenEditorStates).toContain("$ski");
    expect(seenEditorStates).toContain("$sk");
    expect(editorText).toBe("$skill-map ");
  });

  it("does not open for a bare dollar followed by space", async () => {
    const extension = createSkillMentionsExtension(createDeps());
    const harness = createMockExtensionApiHarness();
    extension(harness.pi);

    let editorText = "$ ";
    let terminalInputHandler: ((data: string) => void) | undefined;
    let customCalls = 0;

    const ctx = {
      cwd: "/repo/app",
      hasUI: true,
      ui: {
        onTerminalInput(handler: (data: string) => void) {
          terminalInputHandler = handler;
          return () => {
            terminalInputHandler = undefined;
          };
        },
        getEditorText() {
          return editorText;
        },
        setEditorText(value: string) {
          editorText = value;
        },
        custom: async () => {
          customCalls += 1;
        },
      },
    };

    const sessionStartHandler = getHandler(harness.handlers, "session_start");
    await sessionStartHandler({}, ctx);

    terminalInputHandler?.(" ");
    await Promise.resolve();

    expect(customCalls).toBe(0);
    expect(editorText).toBe("$ ");
  });
});

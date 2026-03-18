import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import reviewLoopExtension from "./index";

function createMockExtensionApiHarness() {
  const tools: Array<{ name: string; tool: any }> = [];
  const commands: Array<{ name: string; command: any }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const sessionEntries: unknown[] = [];

  const pi = {
    registerTool(tool: any) {
      tools.push({ name: tool.name, tool });
    },
    registerCommand(name: string, command: any) {
      commands.push({ name, command });
    },
    on(event: string, handler: Function) {
      listeners.push({ event, handler });
    },
    sendUserMessage() {},
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    events: { emit() {} },
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    commands,
    listeners,
    appendedEntries,
    getListener: (event: string) => listeners.find((listener) => listener.event === event),
    setSessionEntries: (entries: unknown[]) => {
      sessionEntries.splice(0, sessionEntries.length, ...entries);
    },
    createContext: (overrides: Record<string, unknown> = {}) => {
      const ui = {
        notify: mock(() => {}),
        setStatus: mock(() => {}),
      };
      return {
        cwd: "/tmp",
        hasUI: true,
        ui,
        sessionManager: {
          getEntries: () => sessionEntries,
        },
        ...overrides,
      };
    },
  };
}

describe("review-loop extension", () => {
  it("registers /review, /review-exit, /review-max, /review-status commands", () => {
    const h = createMockExtensionApiHarness();
    reviewLoopExtension(h.pi);

    const names = h.commands.map((command) => command.name);
    expect(names).toContain("review");
    expect(names).toContain("review-exit");
    expect(names).toContain("review-max");
    expect(names).toContain("review-status");
  });

  it("registers event handlers for input, before_agent_start, context, agent_end, session_start", () => {
    const h = createMockExtensionApiHarness();
    reviewLoopExtension(h.pi);

    const events = h.listeners.map((listener) => listener.event);
    expect(events).toContain("input");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("context");
    expect(events).toContain("agent_end");
    expect(events).toContain("session_start");
  });

  it("registers the review loop result tool", () => {
    const h = createMockExtensionApiHarness();
    reviewLoopExtension(h.pi);
    expect(h.tools.map((tool) => tool.name)).toEqual(["review_loop_result"]);
  });

  it("restores persisted Reviewing state on session start", () => {
    const h = createMockExtensionApiHarness();
    h.setSessionEntries([
      {
        type: "custom",
        customType: "review-loop",
        data: {
          mode: "Reviewing",
          maxIterations: 6,
          iteration: 2,
          userPrompt: "check correctness",
          scope: "diff",
          diffStat: " 2 files changed",
          targetPaths: ["src/app.ts", "src/lib.ts"],
        },
      },
    ]);
    reviewLoopExtension(h.pi);

    const ctx = h.createContext();
    const sessionStart = h.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("review-loop", "🔄 review 3/6");
  });

  it("restores persisted Inactive maxIterations on session start", () => {
    const h = createMockExtensionApiHarness();
    h.setSessionEntries([
      {
        type: "custom",
        customType: "review-loop",
        data: {
          mode: "Inactive",
          maxIterations: 9,
        },
      },
    ]);
    reviewLoopExtension(h.pi);

    const ctx = h.createContext();
    const sessionStart = h.getListener("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart!.handler({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("review-loop", undefined);
  });
});

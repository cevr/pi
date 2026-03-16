import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import reviewLoopExtension from "./index";

function createMockExtensionApiHarness() {
  const commands: Array<{ name: string; command: unknown }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];

  const pi = {
    registerTool() {},
    registerCommand(name: string, command: unknown) {
      commands.push({ name, command });
    },
    on(event: string, handler: Function) {
      listeners.push({ event, handler });
    },
    sendUserMessage() {},
    events: { emit() {} },
  } as unknown as ExtensionAPI;

  return { pi, commands, listeners };
}

describe("review-loop extension", () => {
  it("registers /review, /review-exit, /review-max, /review-status commands", () => {
    const h = createMockExtensionApiHarness();
    reviewLoopExtension(h.pi);

    const names = h.commands.map((c) => c.name);
    expect(names).toContain("review");
    expect(names).toContain("review-exit");
    expect(names).toContain("review-max");
    expect(names).toContain("review-status");
  });

  it("registers event handlers for input, before_agent_start, context, agent_end, session_start", () => {
    const h = createMockExtensionApiHarness();
    reviewLoopExtension(h.pi);

    const events = h.listeners.map((l) => l.event);
    expect(events).toContain("input");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("context");
    expect(events).toContain("agent_end");
    expect(events).toContain("session_start");
  });

  it("does not register any tools (review loop is commands only)", () => {
    const h = createMockExtensionApiHarness();
    // Track tool registrations
    const tools: unknown[] = [];
    (h.pi as any).registerTool = (t: unknown) => tools.push(t);
    reviewLoopExtension(h.pi);
    expect(tools).toHaveLength(0);
  });
});

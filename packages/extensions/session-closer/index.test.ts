import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import sessionCloserExtension from "./index";

function createHarness() {
  const tools: Array<{ name: string; tool: any }> = [];
  const commands: Array<{ name: string; command: any }> = [];
  const listeners: Array<{ event: string; handler: Function }> = [];
  const sentMessages: Array<{ message: any; options?: unknown }> = [];

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
    sendMessage(message: any, options?: unknown) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const ui = {
    notify: mock(() => {}),
    setStatus: mock(() => {}),
  };

  return {
    pi,
    tools,
    commands,
    listeners,
    sentMessages,
    ui,
    getTool: (name: string) => tools.find((tool) => tool.name === name)?.tool,
    getListener: (event: string) => listeners.find((listener) => listener.event === event)?.handler,
  };
}

describe("session-closer extension", () => {
  it("registers the /done command and completion tool", () => {
    const h = createHarness();
    sessionCloserExtension(h.pi);

    expect(h.commands.map((command) => command.name)).toEqual(["done"]);
    expect(h.tools.map((tool) => tool.name)).toEqual(["session_closer_complete"]);
    expect(h.listeners).toHaveLength(0);
  });

  it("prompts the agent to call the completion tool", async () => {
    const h = createHarness();
    sessionCloserExtension(h.pi);

    await h.commands[0]!.command.handler("", { ui: h.ui });

    expect(h.ui.setStatus).toHaveBeenCalledWith("session-closer", "wrapping up...");
    expect(h.sentMessages[0]!.message.content).toContain("call session_closer_complete");
  });

  it("clears status when the completion tool is called", async () => {
    const h = createHarness();
    sessionCloserExtension(h.pi);

    const result = await h
      .getTool("session_closer_complete")!
      .execute("tc-1", {}, undefined, undefined, { ui: h.ui });

    expect(result.content[0]?.text).toContain("Session wrap-up complete");
    expect(h.ui.setStatus).toHaveBeenCalledWith("session-closer", undefined);
    expect(h.ui.notify).toHaveBeenCalledWith("Session wrap-up complete!", "info");
  });
});

import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { register, type Reducer, type TransitionResult } from "./index";

// ---------------------------------------------------------------------------
// Minimal mock
// ---------------------------------------------------------------------------

function createMockPi() {
  const listeners: Array<{ event: string; handler: Function }> = [];
  const commands: Array<{ name: string; opts: any }> = [];
  const shortcuts: Array<{ key: unknown; opts: any }> = [];
  const flags: Array<{ name: string; opts: any }> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: any[] = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const notified: string[] = [];
  let activeTools: string[] = ["read", "bash"];

  const ctx: ExtensionContext = {
    hasUI: true,
    ui: {
      notify: (msg: string) => notified.push(msg),
      setStatus: mock(() => {}),
      setWidget: mock(() => {}),
      theme: {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
        strikethrough: (t: string) => t,
      },
    },
  } as any;

  const pi = {
    on(event: string, handler: Function) {
      listeners.push({ event, handler });
    },
    registerCommand(name: string, opts: any) {
      commands.push({ name, opts });
    },
    registerShortcut(key: unknown, opts: any) {
      shortcuts.push({ key, opts });
    },
    registerFlag(name: string, opts: any) {
      flags.push({ name, opts });
    },
    sendUserMessage(content: string) {
      sentUserMessages.push(content);
    },
    sendMessage(message: any) {
      sentMessages.push(message);
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    getFlag() {
      return false;
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    ctx,
    listeners,
    commands,
    shortcuts,
    flags,
    sentUserMessages,
    sentMessages,
    appendedEntries,
    notified,
    getActiveTools: () => activeTools,
    getHandler: (event: string) => listeners.find((l) => l.event === event)?.handler,
  };
}

// ---------------------------------------------------------------------------
// Test reducer
// ---------------------------------------------------------------------------

type State = { _tag: "Off" } | { _tag: "On"; count: number };
type Event = { _tag: "TurnOn" } | { _tag: "Increment" } | { _tag: "TurnOff" };

const testReducer: Reducer<State, Event> = (state, event): TransitionResult<State> => {
  switch (event._tag) {
    case "TurnOn":
      return { state: { _tag: "On", count: 0 }, effects: [{ type: "notify", message: "on" }] };
    case "Increment":
      if (state._tag !== "On") return { state };
      return { state: { _tag: "On", count: state.count + 1 } };
    case "TurnOff":
      return { state: { _tag: "Off" }, effects: [{ type: "setStatus", key: "test" }] };
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-state-machine register()", () => {
  it("wires fire mappings → reducer → effects", () => {
    const m = createMockPi();
    const machine = register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      events: {
        session_start: {
          mode: "fire",
          toEvent: (): Event => ({ _tag: "TurnOn" }),
        },
      },
    });

    expect(machine.getState()._tag).toBe("Off");

    // Simulate session_start
    const handler = m.getHandler("session_start")!;
    handler({}, m.ctx);

    expect(machine.getState()._tag).toBe("On");
    expect(m.notified).toContain("on");
  });

  it("wires reply mappings without mutating state", () => {
    const m = createMockPi();
    register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      events: {
        tool_call: {
          mode: "reply",
          handle: (state) => {
            if (state._tag === "Off") return { block: true, reason: "off" };
          },
        },
      },
    });

    const handler = m.getHandler("tool_call")!;
    const result = handler({ toolName: "bash", input: {} }, m.ctx);
    expect(result).toEqual({ block: true, reason: "off" });
  });

  it("wires commands (event mode)", () => {
    const m = createMockPi();
    register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      commands: [{ mode: "event", name: "on", toEvent: (): Event => ({ _tag: "TurnOn" }) }],
    });

    expect(m.commands).toHaveLength(1);
    expect(m.commands[0]!.name).toBe("on");
  });

  it("wires commands (query mode)", () => {
    const m = createMockPi();
    const queryCalled = { value: false };
    register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      commands: [
        {
          mode: "query",
          name: "status",
          handler: (_state) => {
            queryCalled.value = true;
          },
        },
      ],
    });

    // Execute the command handler
    m.commands[0]!.opts.handler("", m.ctx);
    expect(queryCalled.value).toBe(true);
  });

  it("wires shortcuts", () => {
    const m = createMockPi();
    register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      shortcuts: [{ key: "ctrl+t" as any, toEvent: (): Event => ({ _tag: "TurnOn" }) }],
    });

    expect(m.shortcuts).toHaveLength(1);
  });

  it("wires flags", () => {
    const m = createMockPi();
    register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      flags: [{ name: "test-flag", type: "boolean", default: false }],
    });

    expect(m.flags).toHaveLength(1);
    expect(m.flags[0]!.name).toBe("test-flag");
  });

  it("send() dispatches events", () => {
    const m = createMockPi();
    const machine = register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      events: {
        session_start: {
          mode: "fire",
          toEvent: (): Event => ({ _tag: "TurnOn" }),
        },
      },
    });

    // Need to trigger at least one pi event to set lastCtx
    m.getHandler("session_start")!({}, m.ctx);
    expect(machine.getState()).toEqual({ _tag: "On", count: 0 });

    machine.send({ _tag: "Increment" });
    expect(machine.getState()).toEqual({ _tag: "On", count: 1 });
  });

  it("observers fire on state entry, not re-entry", () => {
    const m = createMockPi();
    const observerCalls: string[] = [];

    register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      events: {
        session_start: {
          mode: "fire",
          toEvent: (): Event => ({ _tag: "TurnOn" }),
        },
        agent_end: {
          mode: "fire",
          toEvent: (): Event => ({ _tag: "Increment" }),
        },
      },
      observers: [
        {
          match: (s) => s._tag === "On",
          handler: (_state, _send, _ctx) => {
            observerCalls.push("entered On");
          },
        },
      ],
    });

    m.getHandler("session_start")!({}, m.ctx);
    expect(observerCalls).toEqual(["entered On"]);

    // Increment stays in "On" — observer should NOT re-fire
    m.getHandler("agent_end")!({}, m.ctx);
    expect(observerCalls).toEqual(["entered On"]);
  });

  it("observer sendIfCurrent rejects stale events", () => {
    const m = createMockPi();
    let capturedSend: ((e: Event) => boolean) | undefined;

    const machine = register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      events: {
        session_start: {
          mode: "fire",
          toEvent: (): Event => ({ _tag: "TurnOn" }),
        },
      },
      observers: [
        {
          match: (s) => s._tag === "On",
          handler: (_state, sendIfCurrent) => {
            capturedSend = sendIfCurrent;
          },
        },
      ],
    });

    m.getHandler("session_start")!({}, m.ctx);
    expect(capturedSend).toBeDefined();

    // Mutate state to make the captured send stale
    machine.send({ _tag: "TurnOff" });
    expect(machine.getState()._tag).toBe("Off");

    // Now the captured sendIfCurrent should reject
    const accepted = capturedSend!({ _tag: "Increment" });
    expect(accepted).toBe(false);
    expect(machine.getState()._tag).toBe("Off"); // unchanged
  });

  it("null toEvent skips reducer", () => {
    const m = createMockPi();
    const machine = register(m.pi, {
      id: "test",
      initial: { _tag: "Off" } as State,
      reducer: testReducer,
      events: {
        agent_end: {
          mode: "fire",
          toEvent: (): Event | null => null,
        },
      },
    });

    m.getHandler("agent_end")!({}, m.ctx);
    expect(machine.getState()._tag).toBe("Off"); // unchanged
  });
});

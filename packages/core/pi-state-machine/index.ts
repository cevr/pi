/**
 * pi-state-machine — handrolled reducer framework for pi extensions.
 *
 * Pure `(state, event) => { state, effects }` reducers with a thin bridge
 * that wires them to pi's extension API. Zero external dependencies.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Built-in side effects — common pi API calls. */
export type BuiltinEffect =
  | { type: "setActiveTools"; tools: readonly string[] }
  | { type: "sendUserMessage"; content: string; deliverAs?: "steer" | "followUp" }
  | {
      type: "sendMessage";
      customType: string;
      content: string;
      display: boolean;
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    }
  | { type: "notify"; message: string; level?: "info" | "warning" | "error" }
  | { type: "setStatus"; key: string; text?: string }
  | { type: "setWidget"; key: string; lines?: readonly string[] }
  | { type: "appendEntry"; customType: string; data?: unknown };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Transition result — pure, testable. */
export type TransitionResult<S, Ext = never> = {
  readonly state: S;
  readonly effects?: ReadonlyArray<BuiltinEffect | Ext>;
};

/** Reducer — pure function, no pi dependency. */
export type Reducer<S, E, Ext = never> = (state: S, event: E) => TransitionResult<S, Ext>;

// ---------------------------------------------------------------------------
// Event mappings
// ---------------------------------------------------------------------------

/** All pi event names we support mapping. */
type PiEventName =
  | "session_start"
  | "session_switch"
  | "context"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_end"
  | "tool_call"
  | "input";

/** Read current state, return pi reply. No state mutation. */
type ReplyMapping<S, _K extends PiEventName> = {
  mode: "reply";
  handle: (state: Readonly<S>, piEvent: any, ctx: ExtensionContext) => any;
};

/** Fire event into reducer. No pi reply (for void-return events). */
type FireMapping<S, E, _K extends PiEventName> = {
  mode: "fire";
  toEvent: (state: Readonly<S>, piEvent: any, ctx: ExtensionContext) => E | null;
};

type EventMapping<S, E, K extends PiEventName> = ReplyMapping<S, K> | FireMapping<S, E, K>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Command that fires a machine event. */
export type EventCommand<S, E> = {
  mode: "event";
  name: string;
  description?: string;
  toEvent: (state: Readonly<S>, args: string, ctx: ExtensionContext) => E | null;
};

/** Command that reads state (query-only, no mutation). */
export type QueryCommand<S> = {
  mode: "query";
  name: string;
  description?: string;
  handler: (state: Readonly<S>, args: string, ctx: ExtensionContext) => void;
};

export type Command<S, E> = EventCommand<S, E> | QueryCommand<S>;

// ---------------------------------------------------------------------------
// State observers (async UI)
// ---------------------------------------------------------------------------

/**
 * Observes state changes, runs async UI, feeds result back as event.
 * `sendIfCurrent` checks that state hasn't changed since observer started —
 * prevents stale dialog results from landing on the wrong state.
 */
export type StateObserver<S, E> = {
  match: (state: Readonly<S>) => boolean;
  handler: (
    state: Readonly<S>,
    sendIfCurrent: (event: E) => boolean,
    ctx: ExtensionContext,
  ) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Machine config
// ---------------------------------------------------------------------------

export interface MachineConfig<S, E, Ext = never> {
  id: string;
  initial: S;
  reducer: Reducer<S, E, Ext>;
  events?: { [K in PiEventName]?: EventMapping<S, E, K> };
  commands?: readonly Command<S, E>[];
  shortcuts?: readonly {
    key: KeyId;
    description?: string;
    toEvent: (state: Readonly<S>, ctx: ExtensionContext) => E | null;
  }[];
  observers?: readonly StateObserver<S, E>[];
  /** Flag registration (e.g., --plan). */
  flags?: readonly {
    name: string;
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
  }[];
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

export interface MachineHandle<S, E> {
  getState(): Readonly<S>;
  send(event: E): void;
}

export function register<S, E, Ext = never>(
  pi: ExtensionAPI,
  config: MachineConfig<S, E, Ext>,
  extInterpreter?: (effect: Ext, pi: ExtensionAPI, ctx: ExtensionContext) => void,
): MachineHandle<S, E> {
  let state: S = config.initial;
  let version = 0;
  let lastCtx: ExtensionContext | undefined;

  // Track which observers were matching so we only fire on entry
  const observerActive: boolean[] = (config.observers ?? []).map(() => false);

  function executeEffect(effect: BuiltinEffect | Ext, ctx: ExtensionContext): void {
    const e = effect as any;
    switch (e.type) {
      case "setActiveTools":
        pi.setActiveTools(e.tools as string[]);
        break;
      case "sendUserMessage":
        pi.sendUserMessage(e.content, e.deliverAs ? { deliverAs: e.deliverAs } : undefined);
        break;
      case "sendMessage":
        pi.sendMessage(
          { customType: e.customType, content: e.content, display: e.display },
          { triggerTurn: e.triggerTurn, deliverAs: e.deliverAs },
        );
        break;
      case "notify":
        ctx.ui.notify(e.message, e.level);
        break;
      case "setStatus":
        ctx.ui.setStatus(e.key, e.text);
        break;
      case "setWidget":
        ctx.ui.setWidget(e.key, e.lines as string[] | undefined);
        break;
      case "appendEntry":
        pi.appendEntry(e.customType, e.data);
        break;
      default:
        extInterpreter?.(effect as Ext, pi, ctx);
        break;
    }
  }

  function runObservers(ctx: ExtensionContext): void {
    const observers = config.observers ?? [];
    for (let i = 0; i < observers.length; i++) {
      const obs = observers[i]!;
      const wasActive = observerActive[i]!;
      const isActive = obs.match(state);
      observerActive[i] = isActive;

      if (isActive && !wasActive) {
        const capturedVersion = version;
        const sendIfCurrent = (event: E): boolean => {
          if (version !== capturedVersion) return false;
          send(event);
          return true;
        };
        // Fire-and-forget async — catch rejections to prevent unhandled promise errors
        Promise.resolve(obs.handler(state, sendIfCurrent, ctx)).catch(() => {});
      }
    }
  }

  function reduce(event: E, ctx: ExtensionContext): void {
    const result = config.reducer(state, event);
    state = result.state;
    version++;
    lastCtx = ctx;
    if (result.effects) {
      for (const effect of result.effects) {
        executeEffect(effect, ctx);
      }
    }
    runObservers(ctx);
  }

  function send(event: E): void {
    if (lastCtx) reduce(event, lastCtx);
  }

  // Wire pi events
  if (config.events) {
    for (const [eventName, mapping] of Object.entries(config.events) as [
      PiEventName,
      EventMapping<S, E, PiEventName>,
    ][]) {
      if (mapping.mode === "reply") {
        pi.on(
          eventName as any,
          ((piEvent: any, ctx: ExtensionContext) => {
            lastCtx = ctx;
            return mapping.handle(state, piEvent, ctx);
          }) as ExtensionHandler<any, any>,
        );
      } else {
        pi.on(
          eventName as any,
          ((piEvent: any, ctx: ExtensionContext) => {
            const event = mapping.toEvent(state, piEvent, ctx);
            if (event !== null) reduce(event, ctx);
          }) as ExtensionHandler<any, any>,
        );
      }
    }
  }

  // Wire commands
  for (const cmd of config.commands ?? []) {
    if (cmd.mode === "event") {
      pi.registerCommand(cmd.name, {
        description: cmd.description,
        handler: async (args, ctx) => {
          const event = cmd.toEvent(state, args, ctx);
          if (event !== null) reduce(event, ctx);
        },
      });
    } else {
      pi.registerCommand(cmd.name, {
        description: cmd.description,
        handler: async (args, ctx) => {
          cmd.handler(state, args, ctx);
        },
      });
    }
  }

  // Wire shortcuts
  for (const shortcut of config.shortcuts ?? []) {
    pi.registerShortcut(shortcut.key, {
      description: shortcut.description,
      handler: async (ctx) => {
        const event = shortcut.toEvent(state, ctx);
        if (event !== null) reduce(event, ctx);
      },
    });
  }

  // Wire flags
  for (const flag of config.flags ?? []) {
    pi.registerFlag(flag.name, {
      description: flag.description,
      type: flag.type,
      default: flag.default,
    });
  }

  return { getState: () => state, send };
}

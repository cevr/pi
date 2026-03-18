import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { Reducer, TransitionResult } from "@cvr/pi-state-machine";
import { type UsageStats, zeroUsage } from "@cvr/pi-spawn";
import {
  appendTaskTranscriptEntries,
  createTaskOutputFilePath,
  initializeTaskOutputFile,
} from "./output-file";

export type TaskRunnerStatus = "running" | "completed" | "error" | "aborted";
export type TaskRunnerPhase =
  | "starting"
  | "thinking"
  | "tool"
  | "streaming"
  | "completed"
  | "error"
  | "aborted";

export interface TaskRunnerToolActivity {
  toolCallId: string;
  toolName: string;
  label: string;
}

export interface TaskRunnerProgress {
  phase: TaskRunnerPhase;
  turnCount: number;
  activeTools: TaskRunnerToolActivity[];
  textDelta: string;
}

export interface TaskRecord {
  id: string;
  description: string;
  prompt: string;
  status: TaskRunnerStatus;
  startedAt: number;
  completedAt?: number;
  messages: Message[];
  usage: UsageStats;
  output: string;
  outputFilePath: string | null;
  sessionFilePath: string | null;
  progress: TaskRunnerProgress;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface TaskRunnerHandle {
  id: string;
  result: Promise<TaskRecord>;
  getRecord(): TaskRecord;
  wait(): Promise<TaskRecord>;
  steer(message: string): Promise<boolean>;
  abort(): Promise<void>;
  dispose(): void;
  onToolActivity(listener: (progress: TaskRunnerProgress) => void): () => void;
  onTextDelta(listener: (delta: string, progress: TaskRunnerProgress) => void): () => void;
  onSessionCreated(listener: (record: TaskRecord) => void): () => void;
  onCompletion(listener: (record: TaskRecord) => void): () => void;
}

export type TaskRunnerThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface TaskRunnerConfig {
  cwd: string;
  prompt: string;
  description: string;
  model?: string;
  thinking?: TaskRunnerThinkingLevel;
  builtinTools?: string[];
  extensionTools?: string[];
  systemPrompt?: string;
  outputFilePath?: string;
  sessionDirectory?: string;
  currentModel?: Model<any>;
  modelRegistry: {
    find(provider: string, modelId: string): Model<any> | undefined;
  };
  onUpdate?: (record: TaskRecord) => void;
}

type TaskRunnerSession = Pick<
  AgentSession,
  "abort" | "dispose" | "messages" | "prompt" | "sessionFile" | "sessionId" | "setActiveToolsByName" | "steer" | "subscribe"
>;

export interface TaskRunnerDeps {
  createSession: (config: TaskRunnerConfig) => Promise<TaskRunnerSession>;
  createOutputFilePath: (cwd: string, taskId: string, sessionId: string) => string;
  now: () => number;
  generateId: () => string;
}

const BUILTIN_TOOL_FACTORIES = {
  read: createReadTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
};

function createBuiltinTools(cwd: string, names: readonly string[] | undefined) {
  const toolNames = names ?? ["read", "grep", "find", "ls", "bash", "edit", "write"];
  const tools = [];

  for (const name of toolNames) {
    if (!(name in BUILTIN_TOOL_FACTORIES)) continue;
    const createTool = BUILTIN_TOOL_FACTORIES[name as keyof typeof BUILTIN_TOOL_FACTORIES];
    tools.push(createTool(cwd));
  }

  return tools;
}

function resolveTaskModel(
  modelRegistry: TaskRunnerConfig["modelRegistry"],
  currentModel: Model<any> | undefined,
  configuredModel: string | undefined,
): Model<any> | undefined {
  if (!configuredModel) return currentModel;

  const slashIndex = configuredModel.indexOf("/");
  if (slashIndex === -1) return currentModel;

  const provider = configuredModel.slice(0, slashIndex);
  const modelId = configuredModel.slice(slashIndex + 1);
  return modelRegistry.find(provider, modelId) ?? currentModel;
}

function getCoreMessages(messages: readonly unknown[]): Message[] {
  return messages.filter((message): message is Message => {
    if (typeof message !== "object" || message === null) return false;
    const role = (message as { role?: unknown }).role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });
}

function getMessageText(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      if ((part as { type?: unknown }).type !== "text") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function getFinalAssistantOutput(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = getMessageText(message).trim();
    if (text.length > 0) return text;
  }

  return "";
}

function describeToolActivity(toolName: string, args: unknown): string {
  const argRecord = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const hint =
    argRecord?.path ??
    argRecord?.pattern ??
    argRecord?.query ??
    argRecord?.filePattern ??
    argRecord?.cmd ??
    argRecord?.command;
  if (typeof hint !== "string") return toolName;

  const trimmed = hint.includes("/") ? hint.split("/").at(-1) ?? hint : hint;
  const suffix = trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
  return `${toolName}(${suffix})`;
}

function cloneProgress(progress: TaskRunnerProgress): TaskRunnerProgress {
  return {
    ...progress,
    activeTools: progress.activeTools.map((tool) => ({ ...tool })),
  };
}

function cloneRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    messages: [...record.messages],
    usage: { ...record.usage },
    progress: cloneProgress(record.progress),
  };
}

function updateUsageFromAssistantMessage(usage: UsageStats, message: Message): void {
  if (message.role !== "assistant") return;

  const messageRecord = message as Record<string, unknown>;
  const messageUsage = messageRecord.usage as Record<string, unknown> | undefined;
  if (messageUsage) {
    usage.input += Number(messageUsage.input) || 0;
    usage.output += Number(messageUsage.output) || 0;
    usage.cacheRead += Number(messageUsage.cacheRead) || 0;
    usage.cacheWrite += Number(messageUsage.cacheWrite) || 0;
    usage.cost += Number((messageUsage.cost as Record<string, unknown> | undefined)?.total) || 0;
    usage.contextTokens = Number(messageUsage.totalTokens) || 0;
  }

  usage.turns += 1;
}

function syncRecordFromMessages(record: TaskRecord, messages: readonly Message[]): TaskRecord {
  const next = cloneRecord(record);
  next.messages = [...messages];
  next.output = getFinalAssistantOutput(messages);
  next.usage = zeroUsage();

  for (const message of messages) {
    updateUsageFromAssistantMessage(next.usage, message);

    if (message.role !== "assistant") continue;
    const messageRecord = message as Record<string, unknown>;
    if (!next.model && typeof messageRecord.model === "string") {
      next.model = messageRecord.model;
    }
    if (typeof messageRecord.stopReason === "string") {
      next.stopReason = messageRecord.stopReason;
    }
    if (typeof messageRecord.errorMessage === "string") {
      next.errorMessage = messageRecord.errorMessage;
    }
  }

  return next;
}

function withProgress(record: TaskRecord, progress: Partial<TaskRunnerProgress>): TaskRecord {
  return {
    ...record,
    progress: {
      ...record.progress,
      ...progress,
      activeTools: progress.activeTools?.map((tool) => ({ ...tool })) ?? cloneProgress(record.progress).activeTools,
    },
  };
}

function withSessionRefs(
  record: TaskRecord,
  sessionFilePath: string | null,
  outputFilePath: string | null,
): TaskRecord {
  return {
    ...record,
    sessionFilePath,
    outputFilePath,
  };
}

function withCompletion(record: TaskRecord, status: Exclude<TaskRunnerStatus, "running">, completedAt: number): TaskRecord {
  const phase = status === "completed" ? "completed" : status === "error" ? "error" : "aborted";
  return {
    ...record,
    status,
    completedAt,
    progress: {
      ...record.progress,
      phase,
    },
  };
}

function addActiveTool(
  tools: readonly TaskRunnerToolActivity[],
  nextTool: TaskRunnerToolActivity,
): TaskRunnerToolActivity[] {
  const withoutExisting = tools.filter((tool) => tool.toolCallId !== nextTool.toolCallId);
  return [...withoutExisting, nextTool];
}

function removeActiveTool(
  tools: readonly TaskRunnerToolActivity[],
  toolCallId: string,
): TaskRunnerToolActivity[] {
  return tools.filter((tool) => tool.toolCallId !== toolCallId);
}

function getAllowedToolNames(config: TaskRunnerConfig): string[] {
  return [...new Set([...(config.builtinTools ?? []), ...(config.extensionTools ?? [])])];
}

async function createDefaultSession(config: TaskRunnerConfig): Promise<TaskRunnerSession> {
  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: config.systemPrompt ? () => config.systemPrompt : undefined,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: config.cwd,
    model: resolveTaskModel(config.modelRegistry, config.currentModel, config.model),
    thinkingLevel: config.thinking,
    modelRegistry: config.modelRegistry as any,
    resourceLoader: loader,
    sessionManager: SessionManager.create(config.cwd, config.sessionDirectory),
    settingsManager: SettingsManager.create(config.cwd),
    tools: createBuiltinTools(config.cwd, config.builtinTools),
  });

  session.setActiveToolsByName(getAllowedToolNames(config));
  return session;
}

export const DEFAULT_TASK_RUNNER_DEPS: TaskRunnerDeps = {
  createSession: createDefaultSession,
  createOutputFilePath: createTaskOutputFilePath,
  now: () => Date.now(),
  generateId: () => randomUUID().slice(0, 17),
};

type TaskRunnerMachineState =
  | { _tag: "Starting"; record: TaskRecord; pendingSteers: string[] }
  | { _tag: "Running"; record: TaskRecord; pendingSteers: string[] }
  | { _tag: "Aborting"; record: TaskRecord; pendingSteers: string[] }
  | { _tag: "Completed"; record: TaskRecord }
  | { _tag: "Errored"; record: TaskRecord }
  | { _tag: "Aborted"; record: TaskRecord };

type TaskRunnerMachineEvent =
  | { _tag: "SessionCreated"; sessionFilePath: string | null; outputFilePath: string | null }
  | { _tag: "SessionObserved"; event: AgentSessionEvent; messages: Message[] }
  | { _tag: "QueueSteer"; message: string }
  | { _tag: "PendingSteersFlushed" }
  | { _tag: "AbortRequested" }
  | { _tag: "PromptResolved"; completedAt: number }
  | { _tag: "PromptFailed"; completedAt: number; errorMessage?: string };

type TaskRunnerMachineEffect =
  | { type: "emitUpdate" }
  | { type: "emitSessionCreated" }
  | { type: "emitToolActivity" }
  | { type: "emitTextDelta"; delta: string }
  | { type: "emitCompletion" }
  | { type: "flushTranscript" };

function isActiveState(
  state: TaskRunnerMachineState,
): state is Extract<TaskRunnerMachineState, { _tag: "Starting" | "Running" | "Aborting" }> {
  return state._tag === "Starting" || state._tag === "Running" || state._tag === "Aborting";
}

function isTerminalState(
  state: TaskRunnerMachineState,
): state is Extract<TaskRunnerMachineState, { _tag: "Completed" | "Errored" | "Aborted" }> {
  return state._tag === "Completed" || state._tag === "Errored" || state._tag === "Aborted";
}

function getStateRecord(state: TaskRunnerMachineState): TaskRecord {
  return state.record;
}

function getPendingSteers(state: TaskRunnerMachineState): string[] {
  return isActiveState(state) ? [...state.pendingSteers] : [];
}

function withActiveStateRecord(
  state: Extract<TaskRunnerMachineState, { _tag: "Starting" | "Running" | "Aborting" }>,
  record: TaskRecord,
): Extract<TaskRunnerMachineState, { _tag: "Starting" | "Running" | "Aborting" }> {
  return { ...state, record };
}

function flushesTranscript(event: AgentSessionEvent): boolean {
  return (
    event.type === "message_end" ||
    event.type === "tool_execution_end" ||
    event.type === "turn_end" ||
    event.type === "agent_end"
  );
}

function finalizeRecord(record: TaskRecord, completedAt: number): TaskRecord {
  if (record.status === "aborted" || record.stopReason === "aborted") {
    return withCompletion(record, "aborted", completedAt);
  }
  if (record.stopReason === "error" || record.errorMessage) {
    return withCompletion(record, "error", completedAt);
  }
  return withCompletion(record, "completed", completedAt);
}

function applyObservedEvent(
  record: TaskRecord,
  event: AgentSessionEvent,
): TransitionResult<TaskRecord, TaskRunnerMachineEffect> {
  switch (event.type) {
    case "turn_start": {
      const phase = record.progress.activeTools.length > 0 ? "tool" : "thinking";
      return {
        state: withProgress(record, { turnCount: event.turnIndex + 1, phase }),
      };
    }
    case "tool_execution_start": {
      const activeTools = addActiveTool(record.progress.activeTools, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        label: describeToolActivity(event.toolName, event.args),
      });
      return {
        state: withProgress(record, { phase: "tool", activeTools }),
        effects: [{ type: "emitToolActivity" }],
      };
    }
    case "tool_execution_end": {
      const activeTools = removeActiveTool(record.progress.activeTools, event.toolCallId);
      return {
        state: withProgress(record, {
          phase: activeTools.length > 0 ? "tool" : "thinking",
          activeTools,
        }),
        effects: [{ type: "emitToolActivity" }],
      };
    }
    case "message_start":
      if (event.message.role !== "assistant") return { state: record };
      return {
        state: withProgress(record, {
          phase: record.progress.activeTools.length > 0 ? "tool" : "streaming",
        }),
      };
    case "message_update": {
      if (event.message.role !== "assistant") return { state: record };
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta" || update.delta.length === 0) return { state: record };
      return {
        state: withProgress(record, {
          phase: record.progress.activeTools.length > 0 ? "tool" : "streaming",
          textDelta: update.delta,
        }),
        effects: [{ type: "emitTextDelta", delta: update.delta }],
      };
    }
    case "message_end":
      if (event.message.role !== "assistant" || record.progress.activeTools.length > 0) {
        return { state: record };
      }
      return {
        state: withProgress(record, { phase: "thinking" }),
      };
    default:
      return { state: record };
  }
}

const taskRunnerReducer: Reducer<
  TaskRunnerMachineState,
  TaskRunnerMachineEvent,
  TaskRunnerMachineEffect
> = (state, event): TransitionResult<TaskRunnerMachineState, TaskRunnerMachineEffect> => {
  switch (event._tag) {
    case "SessionCreated": {
      if (!isActiveState(state)) return { state };
      const record = withSessionRefs(state.record, event.sessionFilePath, event.outputFilePath);
      const nextRecord =
        state._tag === "Starting" ? withProgress(record, { phase: "thinking" }) : record;
      const nextState =
        state._tag === "Starting"
          ? ({ _tag: "Running", record: nextRecord, pendingSteers: state.pendingSteers } as const)
          : withActiveStateRecord(state, nextRecord);
      return {
        state: nextState,
        effects: [{ type: "emitSessionCreated" }, { type: "emitUpdate" }],
      };
    }

    case "SessionObserved": {
      if (!isActiveState(state)) return { state };
      const syncedRecord = syncRecordFromMessages(state.record, event.messages);
      const observed = applyObservedEvent(syncedRecord, event.event);
      const effects = [...(observed.effects ?? [])];
      if (flushesTranscript(event.event)) {
        effects.push({ type: "flushTranscript" });
      }
      effects.push({ type: "emitUpdate" });
      return {
        state: withActiveStateRecord(state, observed.state),
        effects,
      };
    }

    case "QueueSteer":
      if (state._tag !== "Starting") return { state };
      return {
        state: { ...state, pendingSteers: [...state.pendingSteers, event.message] },
      };

    case "PendingSteersFlushed":
      if (!isActiveState(state) || state.pendingSteers.length === 0) return { state };
      return {
        state: { ...state, pendingSteers: [] },
      };

    case "AbortRequested":
      if (state._tag !== "Starting" && state._tag !== "Running") return { state };
      return {
        state: {
          _tag: "Aborting",
          record: withProgress({ ...state.record, status: "aborted" }, { phase: "aborted" }),
          pendingSteers: state.pendingSteers,
        },
        effects: [{ type: "emitUpdate" }],
      };

    case "PromptResolved":
      if (!isActiveState(state)) return { state };
      if (state._tag === "Aborting") {
        return {
          state: {
            _tag: "Aborted",
            record: withCompletion(state.record, "aborted", event.completedAt),
          },
          effects: [{ type: "emitUpdate" }, { type: "emitCompletion" }],
        };
      }

      {
        const record = finalizeRecord(state.record, event.completedAt);
        const nextTag =
          record.status === "completed"
            ? "Completed"
            : record.status === "error"
              ? "Errored"
              : "Aborted";
        return {
          state: { _tag: nextTag, record },
          effects: [{ type: "emitUpdate" }, { type: "emitCompletion" }],
        };
      }

    case "PromptFailed":
      if (!isActiveState(state)) return { state };
      if (state._tag === "Aborting") {
        const record = event.errorMessage && !state.record.errorMessage
          ? { ...state.record, errorMessage: event.errorMessage }
          : state.record;
        return {
          state: {
            _tag: "Aborted",
            record: withCompletion(record, "aborted", event.completedAt),
          },
          effects: [{ type: "emitUpdate" }, { type: "emitCompletion" }],
        };
      }

      {
        const record = withCompletion(
          event.errorMessage && !state.record.errorMessage
            ? { ...state.record, errorMessage: event.errorMessage }
            : state.record,
          "error",
          event.completedAt,
        );
        return {
          state: { _tag: "Errored", record },
          effects: [{ type: "emitUpdate" }, { type: "emitCompletion" }],
        };
      }
  }
};

export function createTaskRunner(
  config: TaskRunnerConfig,
  deps: TaskRunnerDeps = DEFAULT_TASK_RUNNER_DEPS,
): TaskRunnerHandle {
  const id = deps.generateId();
  let state: TaskRunnerMachineState = {
    _tag: "Starting",
    record: {
      id,
      description: config.description,
      prompt: config.prompt,
      status: "running",
      startedAt: deps.now(),
      messages: [],
      usage: zeroUsage(),
      output: "",
      outputFilePath: null,
      sessionFilePath: null,
      progress: {
        phase: "starting",
        turnCount: 0,
        activeTools: [],
        textDelta: "",
      },
    },
    pendingSteers: [],
  };

  let session: TaskRunnerSession | undefined;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let writtenCount = 0;
  let dispatchChain = Promise.resolve();
  const toolActivityListeners = new Set<(progress: TaskRunnerProgress) => void>();
  const textDeltaListeners = new Set<(delta: string, progress: TaskRunnerProgress) => void>();
  const sessionCreatedListeners = new Set<(record: TaskRecord) => void>();
  const completionListeners = new Set<(record: TaskRecord) => void>();

  const getRecordSnapshot = () => cloneRecord(getStateRecord(state));

  const emitUpdate = () => {
    try {
      config.onUpdate?.(getRecordSnapshot());
    } catch {
      // ignore user callback failures
    }
  };

  const emitToolActivity = () => {
    const progress = cloneProgress(getStateRecord(state).progress);
    for (const listener of toolActivityListeners) {
      try {
        listener(progress);
      } catch {
        // ignore listener failures
      }
    }
  };

  const emitTextDelta = (delta: string) => {
    const progress = cloneProgress(getStateRecord(state).progress);
    for (const listener of textDeltaListeners) {
      try {
        listener(delta, progress);
      } catch {
        // ignore listener failures
      }
    }
  };

  const emitSessionCreated = () => {
    const snapshot = getRecordSnapshot();
    for (const listener of sessionCreatedListeners) {
      try {
        listener(snapshot);
      } catch {
        // ignore listener failures
      }
    }
  };

  const emitCompletion = () => {
    const snapshot = getRecordSnapshot();
    for (const listener of completionListeners) {
      try {
        listener(snapshot);
      } catch {
        // ignore listener failures
      }
    }
  };

  const flushTranscript = () => {
    if (!session) return;
    const record = getStateRecord(state);
    if (!record.outputFilePath) return;
    writtenCount = appendTaskTranscriptEntries(record.outputFilePath, getCoreMessages(session.messages), {
      writtenCount,
      taskId: record.id,
      description: record.description,
      sessionId: session.sessionId,
      cwd: config.cwd,
    });
  };

  const runEffect = (effect: TaskRunnerMachineEffect) => {
    switch (effect.type) {
      case "emitUpdate":
        emitUpdate();
        break;
      case "emitSessionCreated":
        emitSessionCreated();
        break;
      case "emitToolActivity":
        emitToolActivity();
        break;
      case "emitTextDelta":
        emitTextDelta(effect.delta);
        break;
      case "emitCompletion":
        emitCompletion();
        break;
      case "flushTranscript":
        flushTranscript();
        break;
    }
  };

  const dispatch = (event: TaskRunnerMachineEvent): Promise<void> => {
    const run = async () => {
      const result = taskRunnerReducer(state, event);
      state = result.state;
      for (const effect of result.effects ?? []) {
        runEffect(effect);
      }
    };
    dispatchChain = dispatchChain.then(run, run);
    return dispatchChain;
  };

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    session?.dispose();
    toolActivityListeners.clear();
    textDeltaListeners.clear();
    sessionCreatedListeners.clear();
    completionListeners.clear();
  };

  const flushPendingSteers = async () => {
    if (!session) return;
    const pendingSteers = getPendingSteers(state);
    if (pendingSteers.length === 0) return;
    for (const message of pendingSteers) {
      await session.steer(message);
    }
    await dispatch({ _tag: "PendingSteersFlushed" });
  };

  const result = (async () => {
    try {
      session = await deps.createSession(config);
      const outputFilePath =
        config.outputFilePath ?? deps.createOutputFilePath(config.cwd, id, session.sessionId);
      initializeTaskOutputFile(outputFilePath);

      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        void dispatch({
          _tag: "SessionObserved",
          event,
          messages: getCoreMessages(session?.messages ?? []),
        });
      });

      await dispatch({
        _tag: "SessionCreated",
        sessionFilePath: session.sessionFile ?? null,
        outputFilePath,
      });

      if (state._tag === "Aborting") {
        await dispatch({ _tag: "PromptResolved", completedAt: deps.now() });
        return getRecordSnapshot();
      }

      const promptPromise = session.prompt(config.prompt);
      await flushPendingSteers();
      await promptPromise;
      await dispatchChain;
      await dispatch({ _tag: "PromptResolved", completedAt: deps.now() });
      return getRecordSnapshot();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : undefined;
      await dispatchChain;
      await dispatch({
        _tag: "PromptFailed",
        completedAt: deps.now(),
        errorMessage,
      });
      return getRecordSnapshot();
    } finally {
      cleanup();
    }
  })();

  return {
    id,
    result,
    getRecord: getRecordSnapshot,
    wait: () => result,
    async steer(message: string) {
      if (disposed) return false;
      if (state._tag !== "Starting" && state._tag !== "Running") {
        return false;
      }
      if (!session || state._tag === "Starting") {
        await dispatch({ _tag: "QueueSteer", message });
        return true;
      }
      try {
        await session.steer(message);
        return true;
      } catch {
        return false;
      }
    },
    async abort() {
      if (disposed) return;
      if (state._tag !== "Starting" && state._tag !== "Running") return;
      await dispatch({ _tag: "AbortRequested" });
      if (session) {
        try {
          await session.abort();
        } catch {
          // ignore abort failures
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
    onToolActivity(listener) {
      toolActivityListeners.add(listener);
      return () => {
        toolActivityListeners.delete(listener);
      };
    },
    onTextDelta(listener) {
      textDeltaListeners.add(listener);
      return () => {
        textDeltaListeners.delete(listener);
      };
    },
    onSessionCreated(listener) {
      sessionCreatedListeners.add(listener);
      const record = getStateRecord(state);
      if (record.sessionFilePath || record.outputFilePath) {
        try {
          listener(getRecordSnapshot());
        } catch {
          // ignore listener failures
        }
      }
      return () => {
        sessionCreatedListeners.delete(listener);
      };
    },
    onCompletion(listener) {
      completionListeners.add(listener);
      if (isTerminalState(state)) {
        try {
          listener(getRecordSnapshot());
        } catch {
          // ignore listener failures
        }
      }
      return () => {
        completionListeners.delete(listener);
      };
    },
  };
}

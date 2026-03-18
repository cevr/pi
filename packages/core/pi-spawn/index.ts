/**
 * shared pi process spawning for dedicated sub-agent tools.
 *
 * extracts the spawn-parse-collect loop from the generic subagent
 * extension into a reusable function. each dedicated tool (finder,
 * counsel, Task) calls piSpawn() with its own config.
 *
 * uses shared interpolation from @cvr/pi-interpolate for template variables
 * ({cwd}, {roots}, {date}, etc.) in system prompts.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { resolveGlobalSettingsPath } from "@cvr/pi-config";
import { interpolatePromptVars } from "@cvr/pi-interpolate";
import { killTreeWithEscalation } from "@cvr/pi-process-runner";
import { Effect, Layer, Schema, ServiceMap } from "effect";

// --- types ---

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface PiSpawnResult {
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiSpawnConfig {
  cwd: string;
  task: string;
  model?: string;
  thinking?: string;
  builtinTools?: string[];
  extensionTools?: string[];
  systemPromptBody?: string;
  signal?: AbortSignal;
  onUpdate?: (result: PiSpawnResult) => void;
  sessionId?: string;
  repo?: string;
  /**
   * send the initial prompt through RPC stdin instead of argv.
   *
   * more robust for long prompts (large inlined file context) and avoids
   * edge cases where positional prompt delivery gets dropped.
   */
  promptViaStdin?: boolean;
  /**
   * override the global bds config path for the child process.
   *
   * when omitted, piSpawn propagates the parent's resolved global config path
   * via PI_CVR_CONFIG_PATH so sub-agents inherit extension gating.
   */
  configPath?: string;
  /**
   * inject a follow-up user message after the agent's first turn.
   *
   * uses pi's RPC mode instead of print mode. the follow-up is queued
   * eagerly at startup (not delivered until idle), so the agent loop's
   * getFollowUpMessages() finds it after exploration completes. the
   * process is killed after the second end_turn.
   *
   * primary use case: code_review — agent explores the diff first,
   * then receives the report format instructions.
   */
  followUp?: string;
  /**
   * persist the sub-agent's session to a file.
   *
   * when set, omits `--no-session` and passes `--session <path>`.
   * pi writes the session natively at the given path.
   *
   * when unset (default), `--no-session` is used — in-memory only.
   */
  sessionPath?: string;
}

// --- helpers ---

function writePromptToTempFile(label: string, prompt: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = label.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

export function zeroUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

/**
 * resolve a prompt from either an inline string or a file.
 *
 * precedence: promptString (if non-empty) → readAgentPrompt(promptFile).
 * lets extensions externalize prompt content via config while
 * keeping sops-managed .md files as the default source.
 */
export function resolvePrompt(promptString: string, promptFile: string): string {
  if (promptString) return promptString;
  return readAgentPrompt(promptFile);
}

/**
 * read an agent prompt .md file, strip frontmatter, return body.
 * looks in ~/.pi/agent/agents/{filename}.
 */
export function readAgentPrompt(filename: string): string {
  const promptPath = path.join(os.homedir(), ".pi", "agent", "agents", filename);
  try {
    const content = fs.readFileSync(promptPath, "utf-8");
    if (content.startsWith("---")) {
      const endIdx = content.indexOf("\n---", 3);
      if (endIdx !== -1) return content.slice(endIdx + 4).trim();
    }
    return content;
  } catch {
    return "";
  }
}

// --- NDJSON event processing ---

/** process a single NDJSON line from pi stdout, mutating result in place. */
export function processNdjsonLine(
  line: string,
  result: PiSpawnResult,
  config: Pick<PiSpawnConfig, "followUp" | "onUpdate" | "promptViaStdin">,
  rpcState: { endTurnCount: number },
  killProc: () => void,
): void {
  if (!line.trim()) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // skip RPC protocol responses (acks for prompt/follow_up/abort commands)
  if (event.type === "response") return;

  if (event.type === "message_end" && event.message) {
    const msg = event.message as Message;
    result.messages.push(msg);

    if (msg.role === "assistant") {
      result.usage.turns++;
      const msgRecord = msg as unknown as Record<string, unknown>;
      const usage = msgRecord.usage as Record<string, unknown> | undefined;
      if (usage) {
        result.usage.input += Number(usage.input) || 0;
        result.usage.output += Number(usage.output) || 0;
        result.usage.cacheRead += Number(usage.cacheRead) || 0;
        result.usage.cacheWrite += Number(usage.cacheWrite) || 0;
        result.usage.cost += Number((usage.cost as Record<string, unknown>)?.total) || 0;
        result.usage.contextTokens = Number(usage.totalTokens) || 0;
      }
      if (!result.model && msgRecord.model) {
        result.model = msgRecord.model as string;
      }
      if (msgRecord.stopReason) {
        result.stopReason = msgRecord.stopReason as string;
      }
      if (msgRecord.errorMessage) {
        result.errorMessage = msgRecord.errorMessage as string;
      }

      const stopReason = msgRecord.stopReason as string | undefined;
      const isTurnEnd = stopReason === "end_turn" || stopReason === "stop";
      const useRpc = !!config.followUp || config.promptViaStdin === true;
      const expectedTurns = config.followUp ? 2 : 1;

      if (useRpc && isTurnEnd) {
        rpcState.endTurnCount++;
        if (rpcState.endTurnCount >= expectedTurns) {
          killProc();
        }
      }

      if (useRpc && (stopReason === "error" || stopReason === "aborted")) {
        killProc();
      }
    }

    if (config.onUpdate) config.onUpdate({ ...result });
  }

  if (event.type === "tool_result_end" && event.message) {
    result.messages.push(event.message as Message);
    if (config.onUpdate) config.onUpdate({ ...result });
  }
}

// --- spawn ---

export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
  const useRpc = !!config.followUp || config.promptViaStdin === true;
  const sessionArgs = config.sessionPath ? ["--session", config.sessionPath] : ["--no-session"];
  const args: string[] = useRpc
    ? ["--mode", "rpc", ...sessionArgs]
    : ["--mode", "json", "-p", ...sessionArgs];

  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.builtinTools !== undefined) {
    if (config.builtinTools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", config.builtinTools.join(","));
    }
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const result: PiSpawnResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: zeroUsage(),
  };

  try {
    if (config.systemPromptBody?.trim()) {
      const interpolated = interpolatePromptVars(config.systemPromptBody, config.cwd, {
        sessionId: config.sessionId,
        repo: config.repo,
      });
      const tmp = writePromptToTempFile("subagent", interpolated);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    // in print mode, task is a CLI arg. in RPC mode, sent via stdin prompt command.
    if (!useRpc) {
      args.push(`Task: ${config.task}`);
    }

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      PI_CVR_CONFIG_PATH: config.configPath ?? resolveGlobalSettingsPath(),
    };
    if (config.extensionTools !== undefined) {
      if (config.extensionTools.length === 0) {
        spawnEnv.PI_INCLUDE_TOOLS = "NONE";
      } else {
        spawnEnv.PI_INCLUDE_TOOLS = config.extensionTools.join(",");
      }
    }

    let wasAborted = false;
    const rpcState = { endTurnCount: 0 };

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd: config.cwd,
        shell: false,
        stdio: [useRpc ? "pipe" : "ignore", "pipe", "pipe"],
        env: spawnEnv,
        detached: true, // own process group for tree kill
      });

      let escalationCleanup: (() => void) | undefined;
      let killed = false;

      const killProc = () => {
        if (killed) return;
        killed = true;
        escalationCleanup = killTreeWithEscalation(proc);
      };

      // send initial prompt via RPC stdin, then immediately queue follow_up.
      if (useRpc && proc.stdin) {
        const promptCmd = JSON.stringify({
          type: "prompt",
          message: `Task: ${config.task}`,
        });
        proc.stdin.write(promptCmd + "\n");

        if (config.followUp) {
          const followUpCmd = JSON.stringify({
            type: "follow_up",
            message: config.followUp,
          });
          proc.stdin.write(followUpCmd + "\n");
        }
      }

      let buffer = "";

      proc.stdout!.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          processNdjsonLine(line, result, config, rpcState, killProc);
        }
      });

      proc.stderr!.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) {
          processNdjsonLine(buffer, result, config, rpcState, killProc);
        }
        escalationCleanup?.();
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        escalationCleanup?.();
        resolve(1);
      });

      if (config.signal) {
        const onAbort = () => {
          wasAborted = true;
          killProc();
        };
        if (config.signal.aborted) onAbort();
        else config.signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    result.exitCode = exitCode;
    if (wasAborted) {
      result.exitCode = 1;
      result.stopReason = "aborted";
    }
    // RPC processes are killed intentionally — don't treat SIGTERM exit as error
    if (
      useRpc &&
      result.exitCode !== 0 &&
      (result.stopReason === "end_turn" || result.stopReason === "stop")
    ) {
      result.exitCode = 0;
    }
    return result;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class SpawnError extends Schema.TaggedErrorClass<SpawnError>()("SpawnError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class PiSpawnService extends ServiceMap.Service<
  PiSpawnService,
  {
    readonly spawn: (config: PiSpawnConfig) => Effect.Effect<PiSpawnResult, SpawnError>;
  }
>()("@cvr/pi-spawn/index/PiSpawnService") {
  static layer = Layer.succeed(PiSpawnService, {
    spawn: (config: PiSpawnConfig) =>
      Effect.tryPromise({
        try: () => piSpawn(config),
        catch: (err) =>
          new SpawnError({
            message: err instanceof Error ? err.message : String(err),
          }),
      }),
  });

  static layerTest = (results?: Map<string, PiSpawnResult>) =>
    Layer.succeed(PiSpawnService, {
      spawn: (config: PiSpawnConfig) =>
        Effect.succeed(
          results?.get(config.model ?? "default") ?? {
            exitCode: 0,
            messages: [],
            stderr: "",
            usage: zeroUsage(),
          },
        ),
    });
}

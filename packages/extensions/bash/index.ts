/**
 * bash tool — replaces pi's built-in with enhanced command execution.
 *
 * differences from pi's built-in:
 * - `cmd` + `cwd` params (model-compatible interface, not pi's `command`)
 * - auto-splits `cd dir && cmd` into cwd + command (fallback for models)
 * - trailing `&` starts a tracked background process and returns immediately
 * - git commit trailer injection (session ID)
 * - git lock serialization via withFileLock (prevents concurrent git ops)
 * - SIGTERM → SIGKILL fallback on cancel/timeout (pi goes straight to SIGKILL)
 * - output truncation with head + tail (first/last N lines, not just tail)
 * - constant memory via OutputBuffer (no unbounded string growth)
 * - permission rules from ~/.pi/agent/permissions.json (allow/reject)
 *
 * shadows pi's built-in `bash` tool via same-name registration.
 */

import * as fs from "node:fs";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import {
  boxRendererWindowed,
  type BoxSection,
  type Excerpt,
} from "@cvr/pi-box-format";
import { getText } from "@cvr/pi-tui";
import { Type } from "@sinclair/typebox";
import { withFileLock } from "@cvr/pi-mutex";
import { evaluatePermission, loadPermissions } from "@cvr/pi-permissions";
import { resolveToAbsolute } from "@cvr/pi-fs";
import { OutputBuffer } from "@cvr/pi-output-buffer";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@cvr/pi-config";

type BashExtConfig = {
  headLines: number;
  tailLines: number;
  sigkillDelayMs: number;
};

type BackgroundProcess = {
  pid: number;
  command: string;
  cwd: string;
  logPath: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

type BackgroundState = {
  nextId: number;
  processes: Map<string, BackgroundProcess>;
};

type BashExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: BashExtConfig = {
  headLines: 50,
  tailLines: 50,
  sigkillDelayMs: 3000,
};

const DEFAULT_DEPS: BashExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isBashConfig(value: Record<string, unknown>): value is BashExtConfig {
  return (
    isPositiveInteger(value.headLines) &&
    isPositiveInteger(value.tailLines) &&
    typeof value.sigkillDelayMs === "number" &&
    Number.isInteger(value.sigkillDelayMs) &&
    value.sigkillDelayMs >= 0
  );
}

const BASH_CONFIG_SCHEMA: ExtensionConfigSchema<BashExtConfig> = {
  validate: isBashConfig,
};

// --- shell config ---

/**
 * pi's getShellConfig() lives in utils/shell.js, not re-exported
 * from the main package. reimplemented here — on macOS (our target)
 * this is always /bin/bash.
 */
function getShell(): { shell: string; args: string[] } {
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  return { shell: "sh", args: ["-c"] };
}

// --- command preprocessing ---

/**
 * `cd dir && cmd` is the one chained shape worth accepting.
 *
 * one bash tool call should map to one visible execution step so progress,
 * retries, and blame stay legible. models still emit leading `cd ... &&`
 * out of unix habit, so we normalize that case into `cwd + command` instead
 * of rejecting it.
 */
function splitCdCommand(cmd: string): { cwd: string; command: string } | null {
  const match = cmd.match(
    /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/s,
  );
  if (!match) return null;
  const dir = match[1] ?? match[2] ?? match[3] ?? "";
  const command = match[4];
  if (!command) return null;
  return { cwd: dir, command };
}

function parseBackgroundCommand(cmd: string): {
  command: string;
  background: boolean;
} {
  if (!/\s*&\s*$/.test(cmd)) return { command: cmd, background: false };
  return {
    command: cmd.replace(/\s*&\s*$/, ""),
    background: true,
  };
}

/**
 * reject top-level chaining so one tool call remains one observable step.
 *
 * this is intentionally conservative, not a full shell parser. it ignores
 * operators inside quotes, escapes, and nested grouping. if this scanner ever
 * flags valid single-step shell syntax, that would be a bug in our policy
 * layer, not a reason to silently allow multi-step chains again.
 */
function findTopLevelChainOperator(
  cmd: string,
): { operator: ";" | "&&" | "||"; index: number } | null {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];

    if (!ch) continue;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }

    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === "`") {
      inBacktick = true;
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      continue;
    }

    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (ch === "{") {
      braceDepth++;
      continue;
    }

    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (ch === "[") {
      bracketDepth++;
      continue;
    }

    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (parenDepth > 0 || braceDepth > 0 || bracketDepth > 0) {
      continue;
    }

    if (ch === ";") return { operator: ";", index: i };
    if (ch === "&" && next === "&") return { operator: "&&", index: i };
    if (ch === "|" && next === "|") return { operator: "||", index: i };
  }

  return null;
}

function isGitCommand(cmd: string): boolean {
  return /\bgit\s+/.test(cmd);
}

/**
 * inject session ID trailer into git commit commands so commits
 * are traceable back to the pi session that authored them.
 * skips if trailers are already present (model added them manually).
 */
function injectGitTrailers(cmd: string, sessionId: string): string {
  if (!/\bgit\s+commit\b/.test(cmd)) return cmd;
  if (/--trailer/.test(cmd)) return cmd;
  return cmd.replace(
    /\bgit\s+commit\b/,
    `git commit --trailer "Session-Id: ${sessionId}"`,
  );
}

// --- process management ---

/**
 * SIGTERM the process group first, escalate to SIGKILL after delay.
 * pi's built-in goes straight to SIGKILL via killProcessTree().
 * graceful fallback so processes can clean up.
 */
function killGracefully(pid: number, delayMs: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }

  setTimeout(() => {
    try {
      process.kill(-pid, 0);
      process.kill(-pid, "SIGKILL");
    } catch {
      // already dead
    }
  }, delayMs);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createBackgroundState(): BackgroundState {
  return {
    nextId: 1,
    processes: new Map(),
  };
}

function getBackgroundLogPath(id: string): string {
  return path.join(os.tmpdir(), `pi-bash-${id}.log`);
}

async function terminateBackgroundProcess(
  processInfo: BackgroundProcess,
  delayMs: number,
): Promise<void> {
  if (processInfo.timeoutHandle) clearTimeout(processInfo.timeoutHandle);
  if (!isPidAlive(processInfo.pid)) return;

  killGracefully(processInfo.pid, delayMs);

  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs + 500) {
    if (!isPidAlive(processInfo.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cleanupBackgroundProcesses(
  backgroundState: BackgroundState,
  delayMs: number,
): Promise<void> {
  const entries = [...backgroundState.processes.entries()];
  backgroundState.processes.clear();
  backgroundState.nextId = 1;

  await Promise.all(
    entries.map(async ([, processInfo]) => {
      await terminateBackgroundProcess(processInfo, delayMs);
    }),
  );
}

/** per-block excerpts for collapsed display — head 3 + tail 5 = 8 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

// --- tool factory ---

export function createBashTool(
  backgroundState: BackgroundState = createBackgroundState(),
  config: BashExtConfig = CONFIG_DEFAULTS,
): ToolDefinition {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Executes the given shell command using bash.\n\n" +
      "- Top-level command chains using `;`, `&&`, or `||` are rejected; make separate tool calls instead\n" +
      "- A leading `cd dir && cmd` is normalized into `cwd` + `cmd` for compatibility with model habits\n" +
      "- A trailing `&` runs the command in the background and returns immediately with a PID and log path\n" +
      "- Do NOT use interactive commands (REPLs, editors, password prompts)\n" +
      `- Output shows first ${config.headLines} and last ${config.tailLines} lines; middle is truncated for large outputs\n` +
      "- Environment variables and `cd` do not persist between commands; use the `cwd` parameter instead\n" +
      "- Commands run in the workspace root by default; only use `cwd` when you need a different directory\n" +
      '- ALWAYS quote file paths: `cat "path with spaces/file.txt"`\n' +
      "- Use the Grep tool instead of grep, the Read tool instead of cat\n" +
      "- Only run `git commit` and `git push` if explicitly instructed by the user.",

    parameters: Type.Object({
      cmd: Type.String({
        description: "The shell command to execute.",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the command (absolute path). Defaults to workspace root.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds.",
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const Text = getText();
      const cmd = args.cmd || args.command || "...";
      const timeout = args.timeout;
      const timeoutSuffix = timeout
        ? theme.fg("muted", ` (timeout ${timeout}s)`)
        : "";
      // show first line only for multiline commands
      const lines = cmd.split("\n");
      const firstLine = lines[0];
      const multiSuffix = lines.length > 1 ? theme.fg("muted", " …") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`$ ${firstLine}`)) +
          multiSuffix +
          timeoutSuffix,
        0,
        0,
      );
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const Text = getText();
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return new Text(theme.fg("dim", "(no output)"), 0, 0);

      // extract command from structured details (preferred) or parse from content
      let text: string = content.text;
      let command: string = result.details?.command ?? "";
      if (!command && text.startsWith("$ ")) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline !== -1) {
          command = text.slice(2, firstNewline);
        }
      }
      // strip `$ command\n\n` prefix — renderCall already shows it
      if (text.startsWith("$ ")) {
        const sep = text.indexOf("\n\n");
        if (sep !== -1) {
          text = text.slice(sep + 2);
        }
      }

      if (!text || text === "(no output)")
        return new Text(theme.fg("dim", "(no output)"), 0, 0);

      const lines = text.split("\n");

      const buildSections = (): BoxSection[] => [
        {
          blocks: [
            {
              lines: lines.map((l) => ({
                text: theme.fg("toolOutput", l),
                highlight: true,
              })),
            },
          ],
        },
      ];

      return boxRendererWindowed(
        buildSections,
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { cmd: string; cwd?: string; timeout?: number };
      const parsed = parseBackgroundCommand(p.cmd);
      let command = parsed.command;
      let effectiveCwd = p.cwd ? resolveToAbsolute(p.cwd, ctx.cwd) : ctx.cwd;

      const cdSplit = splitCdCommand(command);
      if (cdSplit) {
        effectiveCwd = resolveToAbsolute(cdSplit.cwd, effectiveCwd);
        command = cdSplit.command;
      }

      const chainOperator = findTopLevelChainOperator(command);
      if (chainOperator) {
        throw new Error(
          `top-level command chaining with ${chainOperator.operator} is not supported. run one command per bash call so progress stays visible.`,
        );
      }

      if (!existsSync(effectiveCwd)) {
        throw new Error(`working directory does not exist: ${effectiveCwd}`);
      }

      const verdict = evaluatePermission(
        "Bash",
        { cmd: command },
        loadPermissions(),
      );
      if (verdict.action === "reject") {
        const msg = verdict.message
          ? `command rejected: ${verdict.message}`
          : `command rejected by permission rule. command: ${command}`;
        throw new Error(msg);
      }

      const sessionId = ctx.sessionManager.getSessionId();
      command = injectGitTrailers(command, sessionId);
      const displayCommand = parsed.background ? `${command} &` : command;

      const run = () =>
        parsed.background
          ? runBackgroundCommand(
              command,
              displayCommand,
              effectiveCwd,
              p.timeout,
              signal,
              backgroundState,
              config,
            )
          : runForegroundCommand(
              command,
              displayCommand,
              effectiveCwd,
              p.timeout,
              signal,
              onUpdate,
              config,
            );

      if (isGitCommand(command)) {
        const gitLockKey = path.join(effectiveCwd, ".git", "__pi_git_lock__");
        return withFileLock(gitLockKey, run);
      }

      return run();
    },
  };
}

// --- execution ---

async function runForegroundCommand(
  command: string,
  displayCommand: string,
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  config: BashExtConfig,
): Promise<any> {
  const { shell, args } = getShell();

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new OutputBuffer(config.headLines, config.tailLines);
    let timedOut = false;
    let aborted = false;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killGracefully(child.pid, config.sigkillDelayMs);
      }, timeout * 1000);
    }

    const onAbort = () => {
      aborted = true;
      if (child.pid) killGracefully(child.pid, config.sigkillDelayMs);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleData = (data: Buffer) => {
      output.add(data.toString("utf-8"));

      if (onUpdate) {
        const { text } = output.format();
        onUpdate({ content: [{ type: "text", text }] });
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`command error: ${err.message}`));
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);

      const { text: outputText } = output.format();

      if (aborted) {
        const text = outputText
          ? `${outputText}\n\ncommand aborted`
          : "command aborted";
        reject(new Error(text));
        return;
      }

      if (timedOut) {
        const text = outputText
          ? `${outputText}\n\ncommand timed out after ${timeout} seconds`
          : `command timed out after ${timeout} seconds`;
        reject(new Error(text));
        return;
      }

      let result = `$ ${displayCommand}\n\n${outputText || "(no output)"}`;

      if (code !== 0 && code !== null) {
        result += `\n\nexit code ${code}`;
        reject(new Error(result));
      } else {
        resolve({
          content: [{ type: "text" as const, text: result }],
          details: { command: displayCommand },
        });
      }
    });
  });
}

async function runBackgroundCommand(
  command: string,
  displayCommand: string,
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  backgroundState: BackgroundState,
  config: BashExtConfig,
): Promise<any> {
  const { shell, args } = getShell();
  const id = `bg-${backgroundState.nextId++}`;
  const logPath = getBackgroundLogPath(id);
  const logFd = fs.openSync(logPath, "a");

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
    });
    fs.closeSync(logFd);

    if (signal?.aborted) {
      if (child.pid) killGracefully(child.pid, config.sigkillDelayMs);
      reject(new Error("command aborted"));
      return;
    }

    child.on("error", (err) => {
      backgroundState.processes.delete(id);
      reject(new Error(`command error: ${err.message}`));
    });

    const pid = child.pid;
    if (!pid) {
      backgroundState.processes.delete(id);
      reject(new Error("command error: failed to determine background pid"));
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        if (isPidAlive(pid)) killGracefully(pid, config.sigkillDelayMs);
      }, timeout * 1000);
    }

    backgroundState.processes.set(id, {
      pid,
      command,
      cwd,
      logPath,
      timeoutHandle,
    });

    child.on("close", () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      backgroundState.processes.delete(id);
    });

    child.unref();

    const timeoutNote =
      timeout && timeout > 0
        ? `\nwill be terminated after ${timeout} seconds if still running.`
        : "";

    resolve({
      content: [
        {
          type: "text" as const,
          text:
            `$ ${displayCommand}\n\nstarted background process ${id} (pid ${pid})` +
            `\nlog: ${logPath}` +
            "\nuse the read tool on the log path to inspect readiness or output." +
            `\nuse bash to stop it, e.g. \`kill ${pid}\`.` +
            timeoutNote,
        },
      ],
      details: { command: displayCommand, background: { id, pid, logPath } },
    });
  });
}

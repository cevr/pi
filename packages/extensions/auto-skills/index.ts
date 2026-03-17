/**
 * Auto-Skills Extension — model-pruned skill hints.
 *
 * On session_start, gathers project signals (package.json deps, file markers)
 * and the full skill catalog. Spawns a cheap model (haiku) in the background
 * to select which skills are relevant. Caches the result by project hash.
 *
 * The pruned hint list is injected via before_agent_start — identical every
 * turn for cache stability. The model decides per-turn which to read.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import { PiSpawnService } from "@cvr/pi-spawn";
import { getFinalOutput } from "@cvr/pi-sub-agent-render";
import { Effect, ManagedRuntime } from "effect";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(os.homedir(), ".pi", "auto-skills");
const PRUNER_MODEL = "anthropic/claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Project signal gathering
// ---------------------------------------------------------------------------

interface ProjectSignals {
  deps: string[];
  files: string[];
}

function gatherSignals(cwd: string): ProjectSignals {
  const deps: string[] = [];
  const files: string[] = [];

  // Read package.json deps
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const section = pkg[key];
      if (section && typeof section === "object") {
        deps.push(...Object.keys(section as Record<string, unknown>));
      }
    }
    const workspaces = pkg.workspaces as Record<string, unknown> | undefined;
    const catalog = workspaces?.catalog as Record<string, string> | undefined;
    if (catalog) deps.push(...Object.keys(catalog));
  } catch {
    /* */
  }

  // Check marker files
  const markers = ["bun.lock", "bun.lockb", "turbo.json", "pnpm-lock.yaml", "yarn.lock"];
  for (const m of markers) {
    try {
      if (fs.existsSync(path.join(cwd, m))) files.push(m);
    } catch {
      /* */
    }
  }

  return { deps: [...new Set(deps)].sort(), files: files.sort() };
}

function hashSignals(signals: ProjectSignals): string {
  const content = JSON.stringify(signals);
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Skill catalog
// ---------------------------------------------------------------------------

interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
}

function getSkillCatalog(cwd: string): SkillEntry[] {
  const { skills } = loadSkills({ cwd, includeDefaults: true });
  return skills
    .filter((s) => s.description.length > 0)
    .map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CachedResult {
  hash: string;
  hints: string;
}

function readCache(hash: string): string | null {
  try {
    const filePath = path.join(CACHE_DIR, `${hash}.json`);
    const raw = fs.readFileSync(filePath, "utf-8");
    const cached = JSON.parse(raw) as CachedResult;
    if (cached.hash === hash) return cached.hints;
  } catch {
    /* */
  }
  return null;
}

function writeCache(hash: string, hints: string): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const filePath = path.join(CACHE_DIR, `${hash}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ hash, hints }), "utf-8");
  } catch {
    /* */
  }
}

// ---------------------------------------------------------------------------
// Pruner prompt
// ---------------------------------------------------------------------------

function buildPrunerPrompt(signals: ProjectSignals, catalog: SkillEntry[]): string {
  const depsBlock =
    signals.deps.length > 0
      ? `Dependencies: ${signals.deps.join(", ")}`
      : "No dependencies detected.";
  const filesBlock = signals.files.length > 0 ? `Marker files: ${signals.files.join(", ")}` : "";

  const skillsList = catalog.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  return `You are selecting which skills are relevant for a software project.

## Project Signals
${depsBlock}
${filesBlock}

## Available Skills
${skillsList}

## Task
Select ONLY the skills relevant to this project. For each selected skill, write a one-line hint describing when the developer should load it.

Output format (one per line, no other text):
SKILL_NAME | when to load hint

Example:
react | working with .tsx files or React components
effect-v4 | working with Effect services, layers, or Effect.gen

Rules:
- Select 3-7 skills maximum
- Always include "code-style"
- Only include skills that match the project's dependencies or file markers
- Be specific in hints — reference file types, import patterns, or task types
- Do NOT include skills for technologies not present in the project`;
}

function parseSkillHints(
  output: string,
  catalog: SkillEntry[],
): Array<{ name: string; when: string; filePath: string }> {
  const pathMap = new Map(catalog.map((s) => [s.name, s.filePath]));
  const hints: Array<{ name: string; when: string; filePath: string }> = [];

  for (const line of output.split("\n")) {
    const match = line.match(/^([a-z0-9-]+)\s*\|\s*(.+)$/);
    if (!match) continue;
    const [, name, when] = match;
    const filePath = pathMap.get(name!);
    if (filePath && when) {
      hints.push({ name: name!, when: when.trim(), filePath });
    }
  }

  return hints;
}

function formatHints(hints: Array<{ when: string; filePath: string }>): string {
  const lines = hints.map((h) => `- When ${h.when} → read ${h.filePath}`);
  return `[AUTO-SKILLS] Load the relevant skill before responding:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoSkillsExtension(pi: ExtensionAPI): void {
  const runtime = ManagedRuntime.make(PiSpawnService.layer);

  pi.on("session_shutdown" as any, async () => {
    await runtime.dispose();
  });

  let cachedMessage: string | null = null;

  pi.on("session_start" as any, (_event: any, ctx: any) => {
    const cwd: string = ctx.cwd;
    const signals = gatherSignals(cwd);

    // No deps at all — skip (not a JS/TS project)
    if (signals.deps.length === 0 && signals.files.length === 0) return;

    const hash = hashSignals(signals);

    // Check cache first
    const cached = readCache(hash);
    if (cached) {
      cachedMessage = cached;
      return;
    }

    // Background: spawn haiku to prune skills
    const catalog = getSkillCatalog(cwd);
    if (catalog.length === 0) return;

    const task = buildPrunerPrompt(signals, catalog);

    runtime
      .runPromise(
        Effect.gen(function* () {
          const svc = yield* PiSpawnService;
          return yield* svc.spawn({
            cwd,
            task,
            model: PRUNER_MODEL,
            builtinTools: [],
            extensionTools: [],
          });
        }),
      )
      .then((result) => {
        if (result.exitCode !== 0) return;
        const output = getFinalOutput(result.messages);
        if (!output) return;

        const hints = parseSkillHints(output, catalog);
        if (hints.length === 0) return;

        const message = formatHints(hints);
        writeCache(hash, message);
        cachedMessage = message;
      })
      .catch(() => {
        /* background — don't crash */
      });
  });

  pi.on("before_agent_start" as any, () => {
    if (!cachedMessage) return;
    return {
      message: {
        customType: "auto-skills",
        content: cachedMessage,
        display: false,
      },
    };
  });

  pi.on("context" as any, (_event: any) => ({
    messages: _event.messages.filter((m: any) => m.customType !== "auto-skills"),
  }));
}

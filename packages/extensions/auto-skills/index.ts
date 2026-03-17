/**
 * Auto-Skills Extension — project-aware skill hints.
 *
 * Scans the workspace once on session_start for dependency signals
 * (package.json deps, lock files) and builds conditional hints that
 * tell the model *when* to load each skill, not to load them all upfront.
 *
 * The injected message is identical every turn → cache-friendly.
 * The model decides per-turn which skills to read based on what it's doing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Skill hint rules
// ---------------------------------------------------------------------------

interface SkillHint {
  /** Skill name (must match a loaded skill) */
  skill: string;
  /** Human-readable condition for when to load this skill */
  when: string;
  /** Check package.json dependencies */
  deps?: string[];
  /** Check if files exist (relative to cwd) */
  files?: string[];
  /** Always include this hint (no signal check needed) */
  always?: boolean;
}

const HINTS: SkillHint[] = [
  { skill: "code-style", when: "writing or reviewing any code", always: true },
  {
    skill: "effect-v4",
    when: "working with effect imports, services, layers, or Effect.gen",
    deps: ["effect"],
  },
  {
    skill: "effect-v3",
    when: "working with effect imports, services, layers, or Effect.gen",
    deps: ["effect"],
  },
  {
    skill: "architecture",
    when: "designing module structure, service wiring, or domain modeling",
    deps: ["effect", "@effect/platform", "@effect/cli"],
  },
  { skill: "react", when: "working with .tsx files or React components", deps: ["react"] },
  {
    skill: "ui",
    when: "implementing UI components, animations, or visual design",
    deps: ["react"],
  },
  {
    skill: "react-native",
    when: "working with React Native components or native APIs",
    deps: ["react-native"],
  },
  {
    skill: "bun",
    when: "running scripts, tests, or using Bun APIs",
    files: ["bun.lock", "bun.lockb"],
  },
  {
    skill: "turborepo",
    when: "configuring tasks, pipelines, or monorepo structure",
    files: ["turbo.json"],
  },
  {
    skill: "cli",
    when: "building CLI commands, flags, or terminal output",
    deps: ["@effect/cli", "commander", "yargs", "meow", "cac"],
  },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function readPackageJsonDeps(cwd: string): Set<string> {
  const deps = new Set<string>();
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const section = pkg[key];
      if (section && typeof section === "object") {
        for (const dep of Object.keys(section as Record<string, unknown>)) {
          deps.add(dep);
        }
      }
    }
    // Also check workspace catalog (monorepos)
    const workspaces = pkg.workspaces as Record<string, unknown> | undefined;
    const catalog = workspaces?.catalog as Record<string, string> | undefined;
    if (catalog) {
      for (const dep of Object.keys(catalog)) deps.add(dep);
    }
  } catch {
    /* no package.json or invalid */
  }
  return deps;
}

function fileExists(cwd: string, relativePath: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, relativePath));
  } catch {
    return false;
  }
}

function detectEffectVersion(cwd: string): "effect-v3" | "effect-v4" | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;

    for (const key of ["dependencies", "devDependencies"]) {
      const section = pkg[key] as Record<string, string> | undefined;
      if (!section?.effect) continue;
      const version = section.effect;
      if (/^[~^]?4\./.test(version) || version.includes("4.0.0-beta")) return "effect-v4";
      if (/^[~^]?3\./.test(version)) return "effect-v3";
    }

    const workspaces = pkg.workspaces as Record<string, unknown> | undefined;
    const catalog = workspaces?.catalog as Record<string, string> | undefined;
    if (catalog?.effect) {
      const version = catalog.effect;
      if (/^[~^]?4\./.test(version) || version.includes("4.0.0-beta")) return "effect-v4";
      if (/^[~^]?3\./.test(version)) return "effect-v3";
    }
  } catch {
    /* */
  }

  try {
    const nmPkg = fs.readFileSync(
      path.join(cwd, "node_modules", "effect", "package.json"),
      "utf-8",
    );
    const parsed = JSON.parse(nmPkg) as { version?: string };
    if (parsed.version?.startsWith("4.")) return "effect-v4";
    if (parsed.version?.startsWith("3.")) return "effect-v3";
  } catch {
    /* */
  }

  return null;
}

interface MatchedHint {
  when: string;
  skillPath: string;
}

function detectHints(cwd: string): MatchedHint[] {
  const deps = readPackageJsonDeps(cwd);
  const effectVersion = deps.has("effect") ? (detectEffectVersion(cwd) ?? "effect-v4") : null;

  // Build path map from loaded skills
  const { skills } = loadSkills({ cwd, includeDefaults: true });
  const pathMap = new Map<string, string>();
  for (const skill of skills) {
    pathMap.set(skill.name, skill.filePath);
  }

  const matched: MatchedHint[] = [];

  for (const hint of HINTS) {
    // Skip wrong effect version
    if (hint.skill === "effect-v3" && effectVersion !== "effect-v3") continue;
    if (hint.skill === "effect-v4" && effectVersion !== "effect-v4") continue;

    const skillPath = pathMap.get(hint.skill);
    if (!skillPath) continue;

    let hit = hint.always ?? false;

    if (hint.deps && hint.deps.some((d) => deps.has(d))) hit = true;
    if (hint.files && hint.files.some((f) => fileExists(cwd, f))) hit = true;

    if (hit) {
      matched.push({ when: hint.when, skillPath });
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoSkillsExtension(pi: ExtensionAPI): void {
  let cachedMessage: string | null = null;

  function buildMessage(cwd: string): string | null {
    const hints = detectHints(cwd);
    if (hints.length === 0) return null;

    const lines = hints.map((h) => `- When ${h.when} → read ${h.skillPath}`);

    return `[AUTO-SKILLS] Load the relevant skill before responding:\n${lines.join("\n")}`;
  }

  pi.on("session_start" as any, (_event: any, ctx: any) => {
    cachedMessage = buildMessage(ctx.cwd);
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

/**
 * Auto-Skills Extension — project-aware skill loading.
 *
 * Scans the workspace once on session_start for dependency signals
 * (package.json deps, lock files, file patterns) and maps them to
 * skills that should be loaded. Injects a stable list of skill paths
 * into before_agent_start so the model loads them proactively.
 *
 * The injected message is identical every turn → cache-friendly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Skill detection rules
// ---------------------------------------------------------------------------

interface SkillRule {
  /** Skills to load when this rule matches */
  skills: string[];
  /** Check package.json dependencies (dependencies + devDependencies) */
  deps?: string[];
  /** Check if files exist (relative to cwd) */
  files?: string[];
  /** Check if any files matching this glob pattern exist (shallow, dir-level) */
  dirEntries?: { dir: string; ext: string };
}

const RULES: SkillRule[] = [
  // Always
  { skills: ["code-style"], files: [] },

  // Effect — check version to pick v3 or v4 (handled specially below)
  { skills: ["architecture"], deps: ["effect", "@effect/platform", "@effect/cli"] },

  // React ecosystem
  { skills: ["react", "ui"], deps: ["react"] },
  { skills: ["react-native"], deps: ["react-native"] },

  // Bun
  { skills: ["bun"], files: ["bun.lock", "bun.lockb"] },

  // Turborepo
  { skills: ["turborepo"], files: ["turbo.json"] },

  // CLI projects
  { skills: ["cli"], deps: ["@effect/cli", "commander", "yargs", "meow", "cac"] },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface DetectedSkills {
  /** Skill names to load */
  names: string[];
  /** Map of skill name → file path (resolved from loadSkills) */
  paths: Map<string, string>;
}

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
  // Check package.json for effect version
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;

    for (const key of ["dependencies", "devDependencies"]) {
      const section = pkg[key] as Record<string, string> | undefined;
      if (!section?.effect) continue;
      const version = section.effect;
      // v4 uses 4.x or beta versions like 4.0.0-beta.*
      if (/^[~^]?4\./.test(version) || version.includes("4.0.0-beta")) return "effect-v4";
      if (/^[~^]?3\./.test(version)) return "effect-v3";
    }

    // Check workspace catalog
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

  // Check for effect in node_modules as fallback
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

function detectSkills(cwd: string): DetectedSkills {
  const matched = new Set<string>();
  const deps = readPackageJsonDeps(cwd);

  // Always include code-style
  matched.add("code-style");

  // Run rules
  for (const rule of RULES) {
    let hit = false;

    if (rule.deps && rule.deps.some((d) => deps.has(d))) {
      hit = true;
    }

    if (rule.files && rule.files.length > 0 && rule.files.some((f) => fileExists(cwd, f))) {
      hit = true;
    }

    // Empty files array means "always match" (used by code-style)
    if (rule.files && rule.files.length === 0) {
      hit = true;
    }

    if (hit) {
      for (const s of rule.skills) matched.add(s);
    }
  }

  // Effect version detection
  if (deps.has("effect") || deps.has("@effect/platform") || deps.has("@effect/cli")) {
    const version = detectEffectVersion(cwd);
    if (version) matched.add(version);
    else matched.add("effect-v4"); // default to v4
  }

  // Build path map from loaded skills
  const { skills } = loadSkills({ cwd, includeDefaults: true });
  const pathMap = new Map<string, string>();
  for (const skill of skills) {
    if (matched.has(skill.name)) {
      pathMap.set(skill.name, skill.filePath);
    }
  }

  return { names: [...matched].filter((n) => pathMap.has(n)), paths: pathMap };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoSkillsExtension(pi: ExtensionAPI): void {
  let cachedMessage: string | null = null;

  function buildMessage(cwd: string): string | null {
    const detected = detectSkills(cwd);
    if (detected.names.length === 0) return null;

    const lines = detected.names.sort().map((name) => `- ${detected.paths.get(name)!}`);

    return `[AUTO-SKILLS] For this workspace, always load these skills before responding:\n${lines.join("\n")}`;
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

/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";
import { expandPath } from "@cvr/pi-fs";

const DEFAULT_AGENT_DIR = path.join(expandPath("~"), ".pi", "agent");
const PROJECT_SKILL_DIR_SUFFIXES = [
  [".pi", "skills"],
  [".claude", "skills"],
  [".agents", "skills"],
] as const;
const SKILL_REFERENCE_RE = /^([a-z][a-z0-9-]*)(?::(global|local|\.pi|\.claude|\.agents))?$/;

export type SkillSelector = "global" | "local" | ".pi" | ".claude" | ".agents";
export type SkillLocation = Exclude<SkillSelector, "local">;

export interface ResolvedSkillFile {
  name: string;
  filePath: string;
  baseDir: string;
}

export interface DiscoveredSkill extends Skill {
  location: SkillLocation;
  isLocal: boolean;
  token: string;
  displayName: string;
}

export interface SkillResolution {
  skill: DiscoveredSkill | null;
  error?: string;
  matches: DiscoveredSkill[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  return envDir ? expandPath(envDir) : DEFAULT_AGENT_DIR;
}

export function getDefaultSkillDir(): string {
  return path.join(getAgentDir(), "skills");
}

export function getSkillPathsFromSettings(): string[] {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  if (!fs.existsSync(settingsPath)) return [];

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const skillPaths = settings.skills;
    return isStringArray(skillPaths) ? skillPaths.map((skillPath) => expandPath(skillPath)) : [];
  } catch {
    return [];
  }
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => path.resolve(entry)))];
}

function getProjectSkillDirs(
  cwd: string,
): Array<{ dir: string; location: Exclude<SkillLocation, "global"> }> {
  return PROJECT_SKILL_DIR_SUFFIXES.map((suffix) => ({
    dir: path.join(cwd, ...suffix),
    location: suffix[0],
  }));
}

export function getSkillSearchDirs(cwd: string): string[] {
  return dedupePaths([
    getDefaultSkillDir(),
    ...getSkillPathsFromSettings(),
    ...getProjectSkillDirs(cwd).map((entry) => entry.dir),
  ]);
}

function getSkillSource(skillDir: string, cwd: string): "user" | "project" | "path" {
  if (path.resolve(skillDir) === path.resolve(getDefaultSkillDir())) return "user";
  if (
    getProjectSkillDirs(cwd).some((entry) => path.resolve(entry.dir) === path.resolve(skillDir))
  ) {
    return "project";
  }
  return "path";
}

function getSkillLocation(skillDir: string, cwd: string): SkillLocation {
  const resolvedSkillDir = path.resolve(skillDir);
  const local = getProjectSkillDirs(cwd).find(
    (entry) => path.resolve(entry.dir) === resolvedSkillDir,
  );
  return local?.location ?? "global";
}

function getRealPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function shouldQualifySkill(
  location: SkillLocation,
  duplicateCount: number,
  hasGlobalVariant: boolean,
): boolean {
  if (duplicateCount <= 1) return false;
  if (hasGlobalVariant) return location !== "global";
  return true;
}

function buildSkillToken(
  name: string,
  location: SkillLocation,
  duplicateCount: number,
  hasGlobalVariant: boolean,
): string {
  return shouldQualifySkill(location, duplicateCount, hasGlobalVariant)
    ? `${name}:${location}`
    : name;
}

function buildSkillDisplayName(
  name: string,
  location: SkillLocation,
  duplicateCount: number,
  hasGlobalVariant: boolean,
): string {
  if (!shouldQualifySkill(location, duplicateCount, hasGlobalVariant)) return name;
  return `${name} (${location})`;
}

function parseSkillReference(reference: string): { name: string; selector?: SkillSelector } | null {
  const trimmed = reference.trim();
  const match = trimmed.match(SKILL_REFERENCE_RE);
  if (!match) return null;
  const [, name, selector] = match;
  return { name: name!, selector: selector as SkillSelector | undefined };
}

export function getDiscoveredSkills(cwd: string): DiscoveredSkill[] {
  const discovered: Array<DiscoveredSkill & { order: number }> = [];
  const seenRealPaths = new Set<string>();
  const searchDirs = getSkillSearchDirs(cwd);

  for (const [order, skillDir] of searchDirs.entries()) {
    if (!fs.existsSync(skillDir)) continue;

    const { skills } = loadSkillsFromDir({
      dir: skillDir,
      source: getSkillSource(skillDir, cwd),
    });
    const location = getSkillLocation(skillDir, cwd);

    for (const skill of skills) {
      const realPath = getRealPath(skill.filePath);
      if (seenRealPaths.has(realPath)) continue;
      seenRealPaths.add(realPath);
      discovered.push({
        ...skill,
        location,
        isLocal: location !== "global",
        token: buildSkillToken(skill.name, location),
        displayName: skill.name,
        order,
      });
    }
  }

  const duplicateCounts = new Map<string, number>();
  const hasGlobalVariant = new Map<string, boolean>();
  for (const skill of discovered) {
    duplicateCounts.set(skill.name, (duplicateCounts.get(skill.name) ?? 0) + 1);
    if (skill.location === "global") hasGlobalVariant.set(skill.name, true);
  }

  return discovered
    .map((skill) => {
      const duplicateCount = duplicateCounts.get(skill.name) ?? 1;
      const hasGlobal = hasGlobalVariant.get(skill.name) ?? false;
      return {
        ...skill,
        token: buildSkillToken(skill.name, skill.location, duplicateCount, hasGlobal),
        displayName: buildSkillDisplayName(skill.name, skill.location, duplicateCount, hasGlobal),
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.order - b.order || a.filePath.localeCompare(b.filePath),
    )
    .map(({ order: _order, ...skill }) => skill);
}

export function resolveSkillReference(reference: string, cwd: string): SkillResolution {
  const parsed = parseSkillReference(reference);
  if (!parsed) {
    return {
      skill: null,
      matches: [],
      error:
        `invalid skill reference "${reference}". ` +
        "Use foo, foo:global, foo:local, foo:.pi, foo:.claude, or foo:.agents.",
    };
  }

  const matches = getDiscoveredSkills(cwd).filter((skill) => skill.name === parsed.name);
  if (matches.length === 0) {
    return { skill: null, matches: [] };
  }

  if (!parsed.selector) {
    const global = matches.find((skill) => skill.location === "global");
    if (global) return { skill: global, matches };
    if (matches.length === 1) return { skill: matches[0]!, matches };
    return {
      skill: null,
      matches,
      error: `skill "${parsed.name}" is ambiguous. Use one of: ${matches.map((skill) => skill.token).join(", ")}`,
    };
  }

  const filtered =
    parsed.selector === "local"
      ? matches.filter((skill) => skill.isLocal)
      : matches.filter((skill) => skill.location === parsed.selector);

  if (filtered.length === 0) {
    return {
      skill: null,
      matches,
      error: `skill "${reference}" not found. Available matches: ${matches.map((skill) => skill.token).join(", ")}`,
    };
  }

  if (filtered.length > 1) {
    return {
      skill: null,
      matches: filtered,
      error: `skill "${reference}" is ambiguous. Use one of: ${filtered.map((skill) => skill.token).join(", ")}`,
    };
  }

  return { skill: filtered[0]!, matches: filtered };
}

export function findSkillFile(reference: string, cwd: string): ResolvedSkillFile | null {
  const { skill } = resolveSkillReference(reference, cwd);
  return skill ? { name: skill.name, filePath: skill.filePath, baseDir: skill.baseDir } : null;
}

export function listAvailableSkillNames(cwd: string): string[] {
  return getDiscoveredSkills(cwd).map((skill) => skill.token);
}

function parseSkillFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 4).trim();
}

function collectSkillFiles(baseDir: string): string[] {
  const files: string[] = [];

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name !== "SKILL.md") files.push(fullPath);
    }
  };

  walk(baseDir);
  return files;
}

export function renderLoadedSkillContent(skill: ResolvedSkillFile): string | null {
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(skill.filePath, "utf-8");
  } catch {
    return null;
  }

  const parts: string[] = [
    `<loaded_skill name="${skill.name}">`,
    parseSkillFrontmatter(rawContent),
    "",
    `Base directory for this skill: file://${skill.baseDir}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
  ];

  const skillFiles = collectSkillFiles(skill.baseDir);
  if (skillFiles.length > 0) {
    parts.push("", "<skill_files>");
    for (const filePath of skillFiles) {
      parts.push(`<file>${filePath}</file>`);
    }
    parts.push("</skill_files>");
  }

  parts.push("</loaded_skill>");
  return parts.join("\n");
}

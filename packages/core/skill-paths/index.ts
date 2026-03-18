/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import * as fs from "node:fs";
import * as path from "node:path";
import { expandPath } from "@cvr/pi-fs";

const DEFAULT_AGENT_DIR = path.join(expandPath("~"), ".pi", "agent");

export interface ResolvedSkillFile {
  name: string;
  filePath: string;
  baseDir: string;
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

export function getSkillSearchDirs(cwd: string): string[] {
  return [
    ...new Set([getDefaultSkillDir(), ...getSkillPathsFromSettings(), path.join(cwd, ".pi", "skills")]),
  ];
}

export function findSkillFile(name: string, cwd: string): ResolvedSkillFile | null {
  for (const skillDir of getSkillSearchDirs(cwd)) {
    const filePath = path.join(skillDir, name, "SKILL.md");
    if (fs.existsSync(filePath)) {
      return { name, filePath, baseDir: path.dirname(filePath) };
    }
  }

  return null;
}

export function listAvailableSkillNames(cwd: string): string[] {
  const names = new Set<string>();

  for (const skillDir of getSkillSearchDirs(cwd)) {
    if (!fs.existsSync(skillDir)) continue;
    try {
      for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(skillDir, entry.name, "SKILL.md"))) {
          names.add(entry.name);
        }
      }
    } catch {
      /* unreadable */
    }
  }

  return [...names].sort();
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

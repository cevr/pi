/**
 * Skill catalog builder for the audit extension.
 *
 * Uses the public `loadSkills` API from pi-coding-agent.
 */

import { loadSkills } from "@mariozechner/pi-coding-agent";
import type { SkillCatalogEntry } from "./machine";

export function buildSkillCatalog(cwd: string): SkillCatalogEntry[] {
  const { skills } = loadSkills({ cwd, includeDefaults: true });
  return skills
    .filter((s) => s.description.length > 0)
    .map((s) => ({ name: s.name, description: s.description }));
}

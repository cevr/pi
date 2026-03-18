/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findSkillFile,
  getAgentDir,
  getDefaultSkillDir,
  getSkillPathsFromSettings,
  getSkillSearchDirs,
  listAvailableSkillNames,
  renderLoadedSkillContent,
} from "./index";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-paths-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("skill-paths", () => {
  it("expands the agent dir from PI_CODING_AGENT_DIR", () => {
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
    expect(getAgentDir()).toBe(path.join(os.homedir(), "custom-agent"));
    expect(getDefaultSkillDir()).toBe(path.join(os.homedir(), "custom-agent", "skills"));
  });

  it("reads and expands configured skill paths from settings.json", () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ skills: ["~/skills-a", "/tmp/skills-b"] }),
    );

    expect(getSkillPathsFromSettings()).toEqual([
      path.join(os.homedir(), "skills-a"),
      "/tmp/skills-b",
    ]);
  });

  it("builds the full search path list for a project", () => {
    const agentDir = makeTempDir();
    const projectDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["/opt/skills"] }));

    expect(getSkillSearchDirs(projectDir)).toEqual([
      path.join(agentDir, "skills"),
      "/opt/skills",
      path.join(projectDir, ".pi", "skills"),
    ]);
  });

  it("finds and lists skills across configured search dirs", () => {
    const agentDir = makeTempDir();
    const extraSkillsDir = makeTempDir();
    const projectDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    fs.mkdirSync(path.join(agentDir, "skills", "agent-skill"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "skills", "agent-skill", "SKILL.md"), "agent");
    fs.mkdirSync(path.join(extraSkillsDir, "extra-skill"), { recursive: true });
    fs.writeFileSync(path.join(extraSkillsDir, "extra-skill", "SKILL.md"), "extra");
    fs.mkdirSync(path.join(projectDir, ".pi", "skills", "project-skill"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".pi", "skills", "project-skill", "SKILL.md"), "project");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ skills: [extraSkillsDir] }));

    expect(listAvailableSkillNames(projectDir)).toEqual([
      "agent-skill",
      "extra-skill",
      "project-skill",
    ]);
    expect(findSkillFile("project-skill", projectDir)?.filePath).toBe(
      path.join(projectDir, ".pi", "skills", "project-skill", "SKILL.md"),
    );
  });

  it("renders the loaded skill contract with file urls and relative path guidance", () => {
    const projectDir = makeTempDir();
    const baseDir = path.join(projectDir, ".pi", "skills", "demo-skill");
    fs.mkdirSync(path.join(baseDir, "reference"), { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, "SKILL.md"),
      ["---", "name: demo-skill", "description: demo", "---", "", "body text"].join("\n"),
    );
    fs.writeFileSync(path.join(baseDir, "reference", "notes.md"), "notes");

    expect(
      renderLoadedSkillContent({
        name: "demo-skill",
        filePath: path.join(baseDir, "SKILL.md"),
        baseDir,
      }),
    ).toBe([
      '<loaded_skill name="demo-skill">',
      "body text",
      "",
      `Base directory for this skill: file://${baseDir}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "",
      "<skill_files>",
      `<file>${path.join(baseDir, "reference", "notes.md")}</file>`,
      "</skill_files>",
      "</loaded_skill>",
    ].join("\n"));
  });
});

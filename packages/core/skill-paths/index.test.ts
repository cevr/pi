/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findSkillFile,
  getAgentDir,
  getDefaultSkillDir,
  getDiscoveredSkills,
  getSkillPathsFromSettings,
  getSkillSearchDirs,
  listAvailableSkillNames,
  renderLoadedSkillContent,
  resolveSkillReference,
} from "./index";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-paths-"));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(skillDir: string, description: string): string {
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(
    filePath,
    [
      "---",
      `name: ${path.basename(skillDir)}`,
      `description: ${description}`,
      "---",
      "",
      description,
    ].join("\n"),
  );
  return filePath;
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
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ skills: ["/opt/skills"] }),
    );

    expect(getSkillSearchDirs(projectDir)).toEqual([
      path.join(agentDir, "skills"),
      "/opt/skills",
      path.join(projectDir, ".pi", "skills"),
      path.join(projectDir, ".claude", "skills"),
      path.join(projectDir, ".agents", "skills"),
    ]);
  });

  it("discovers all skills across global and local dirs without deduping names", () => {
    const agentDir = makeTempDir();
    const extraSkillsDir = makeTempDir();
    const projectDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeSkill(path.join(agentDir, "skills", "agent-skill"), "agent");
    writeSkill(path.join(extraSkillsDir, "extra-skill"), "extra");
    const globalFooPath = writeSkill(path.join(agentDir, "skills", "foo"), "global foo");
    const piFooPath = writeSkill(path.join(projectDir, ".pi", "skills", "foo"), "pi foo");
    const claudeFooPath = writeSkill(
      path.join(projectDir, ".claude", "skills", "foo"),
      "claude foo",
    );
    const agentsFooPath = writeSkill(
      path.join(projectDir, ".agents", "skills", "foo"),
      "agents foo",
    );
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ skills: [extraSkillsDir] }),
    );

    expect(listAvailableSkillNames(projectDir)).toEqual([
      "agent-skill",
      "extra-skill",
      "foo",
      "foo:.pi",
      "foo:.claude",
      "foo:.agents",
    ]);

    const discovered = getDiscoveredSkills(projectDir).filter((skill) => skill.name === "foo");
    expect(
      discovered.map((skill) => ({ token: skill.token, displayName: skill.displayName })),
    ).toEqual([
      { token: "foo", displayName: "foo" },
      { token: "foo:.pi", displayName: "foo (.pi)" },
      { token: "foo:.claude", displayName: "foo (.claude)" },
      { token: "foo:.agents", displayName: "foo (.agents)" },
    ]);

    expect(resolveSkillReference("foo", projectDir).skill?.filePath).toBe(globalFooPath);
    expect(resolveSkillReference("foo:.pi", projectDir).skill?.filePath).toBe(piFooPath);
    expect(resolveSkillReference("foo:.claude", projectDir).skill?.filePath).toBe(claudeFooPath);
    expect(resolveSkillReference("foo:.agents", projectDir).skill?.filePath).toBe(agentsFooPath);
    expect(findSkillFile("foo", projectDir)?.filePath).toBe(globalFooPath);
  });

  it("treats :local as ambiguous when multiple local variants exist", () => {
    const agentDir = makeTempDir();
    const projectDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    writeSkill(path.join(projectDir, ".claude", "skills", "foo"), "claude foo");
    writeSkill(path.join(projectDir, ".agents", "skills", "foo"), "agents foo");

    const result = resolveSkillReference("foo:local", projectDir);
    expect(result.skill).toBeNull();
    expect(result.error).toContain("ambiguous");
    expect(result.error).toContain("foo:.claude");
    expect(result.error).toContain("foo:.agents");
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
    ).toBe(
      [
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
      ].join("\n"),
    );
  });
});

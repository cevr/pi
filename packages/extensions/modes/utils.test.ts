import { describe, expect, it } from "bun:test";
import { cleanStepText, isSafeCommand } from "./utils";

describe("isSafeCommand", () => {
  it("allows read-only commands", () => {
    expect(isSafeCommand("cat foo.txt")).toBe(true);
    expect(isSafeCommand("ls -la")).toBe(true);
    expect(isSafeCommand("grep -r 'pattern' src/")).toBe(true);
    expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
    expect(isSafeCommand("git status")).toBe(true);
    expect(isSafeCommand("git log --oneline")).toBe(true);
    expect(isSafeCommand("git diff HEAD~1")).toBe(true);
    expect(isSafeCommand("rg 'foo' src/")).toBe(true);
    expect(isSafeCommand("fd -e ts")).toBe(true);
    expect(isSafeCommand("tree src/")).toBe(true);
    expect(isSafeCommand("eza --tree")).toBe(true);
    expect(isSafeCommand("wc -l file.txt")).toBe(true);
    expect(isSafeCommand("head -20 file.txt")).toBe(true);
    expect(isSafeCommand("tail -f log.txt")).toBe(true);
    expect(isSafeCommand("jq '.key' data.json")).toBe(true);
  });

  it("allows repo commands", () => {
    expect(isSafeCommand("repo fetch owner/repo")).toBe(true);
    expect(isSafeCommand("repo path owner/repo")).toBe(true);
    expect(isSafeCommand("repo list")).toBe(true);
  });

  it("allows ast-grep", () => {
    expect(isSafeCommand("ast-grep --pattern 'foo' --lang ts src/")).toBe(true);
  });

  it("allows bun read-only commands", () => {
    expect(isSafeCommand("bun pm ls")).toBe(true);
    expect(isSafeCommand("bun --version")).toBe(true);
  });

  it("blocks destructive commands", () => {
    expect(isSafeCommand("rm -rf /")).toBe(false);
    expect(isSafeCommand("mv foo bar")).toBe(false);
    expect(isSafeCommand("cp src dest")).toBe(false);
    expect(isSafeCommand("mkdir new-dir")).toBe(false);
    expect(isSafeCommand("touch new-file")).toBe(false);
    expect(isSafeCommand("chmod 777 file")).toBe(false);
  });

  it("blocks git write commands", () => {
    expect(isSafeCommand("git commit -m 'msg'")).toBe(false);
    expect(isSafeCommand("git push origin main")).toBe(false);
    expect(isSafeCommand("git pull")).toBe(false);
    expect(isSafeCommand("git merge feature")).toBe(false);
    expect(isSafeCommand("git rebase main")).toBe(false);
    expect(isSafeCommand("git reset --hard")).toBe(false);
    expect(isSafeCommand("git add .")).toBe(false);
    expect(isSafeCommand("git stash")).toBe(false);
  });

  it("blocks package manager installs", () => {
    expect(isSafeCommand("npm install express")).toBe(false);
    expect(isSafeCommand("yarn add react")).toBe(false);
    expect(isSafeCommand("pnpm add lodash")).toBe(false);
    expect(isSafeCommand("bun add express")).toBe(false);
    expect(isSafeCommand("pip install requests")).toBe(false);
  });

  it("blocks redirect operators", () => {
    expect(isSafeCommand("echo foo > file.txt")).toBe(false);
    expect(isSafeCommand("echo foo >> file.txt")).toBe(false);
  });

  it("blocks sudo and kill", () => {
    expect(isSafeCommand("sudo rm -rf /")).toBe(false);
    expect(isSafeCommand("kill -9 1234")).toBe(false);
    expect(isSafeCommand("pkill node")).toBe(false);
  });

  it("blocks interactive editors", () => {
    expect(isSafeCommand("vim file.txt")).toBe(false);
    expect(isSafeCommand("nano file.txt")).toBe(false);
    expect(isSafeCommand("code .")).toBe(false);
  });

  it("blocks unknown commands", () => {
    expect(isSafeCommand("some-random-command")).toBe(false);
    expect(isSafeCommand("./run-script.sh")).toBe(false);
  });
});

describe("cleanStepText", () => {
  it("strips markdown formatting", () => {
    expect(cleanStepText("**Bold text**")).toBe("Bold text");
    expect(cleanStepText("*italic*")).toBe("Italic");
    expect(cleanStepText("`code`")).toBe("Code");
  });

  it("strips action verb prefixes", () => {
    expect(cleanStepText("Create the new file")).toBe("New file");
    expect(cleanStepText("Run the test suite")).toBe("Test suite");
    expect(cleanStepText("Update the configuration")).toBe("Configuration");
  });

  it("truncates long text to 50 chars", () => {
    const long = "A".repeat(60);
    const result = cleanStepText(long);
    expect(result.length).toBe(50);
    expect(result.endsWith("...")).toBe(true);
  });

  it("capitalizes first letter", () => {
    expect(cleanStepText("lower case")).toBe("Lower case");
  });

  it("collapses whitespace", () => {
    expect(cleanStepText("too   many   spaces")).toBe("Too many spaces");
  });
});

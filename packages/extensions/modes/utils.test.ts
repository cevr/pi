import { describe, expect, it } from "bun:test";
import {
  isSafeCommand,
  cleanStepText,
  extractTodoItems,
  extractDoneSteps,
  markCompletedSteps,
  type PlanTask,
} from "./utils";

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

describe("extractTodoItems", () => {
  it("extracts numbered items after Plan: header", () => {
    const message = `Here's what I'd do:

Plan:
1. Set up the project structure
2. Define the core types and interfaces
3. Implement the main service
4. Write comprehensive tests
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(4);
    expect(items[0]!.order).toBe(1);
    expect(items[0]!.subject).toBe("Set up the project structure");
    expect(items[0]!.status).toBe("pending");
    expect(items[3]!.order).toBe(4);
  });

  it("handles **Plan:** bold header", () => {
    const message = `**Plan:**
1. First step here
2. Second step here
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(2);
  });

  it("extracts bullet items after a Plan header", () => {
    const message = `Plan:
- Audit the current flow
- Improve test coverage
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(2);
    expect(items[0]!.order).toBe(1);
    expect(items[0]!.subject).toBe("Audit the current flow");
    expect(items[1]!.order).toBe(2);
    expect(items[1]!.subject).toBe("Improve test coverage");
  });

  it("handles checklist bullets and ignores nested bullet details", () => {
    const message = `Plan:
- [ ] Audit the current flow
  - inspect session hydration
- [x] Improve test coverage
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(2);
    expect(items[0]!.subject).toBe("Audit the current flow");
    expect(items[1]!.subject).toBe("Improve test coverage");
  });

  it("handles markdown headings like ## Implementation Plan", () => {
    const message = `## Implementation Plan
1. **Audit** the current flow
2. Add a resume-safe choice state
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(2);
    expect(items[0]!.subject).toBe("Audit the current flow");
    expect(items[1]!.subject).toBe("A resume-safe choice state");
  });

  it("handles bold item text", () => {
    const message = `Plan
1. **First step here**
2. **Second** step here
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(2);
    expect(items[0]!.subject).toBe("First step here");
    expect(items[1]!.subject).toBe("Second step here");
  });

  it("returns empty for no Plan: header", () => {
    const message = "Here are some steps:\n1. Do this\n2. Do that";
    expect(extractTodoItems(message)).toHaveLength(0);
  });

  it("skips items shorter than 5 chars", () => {
    const message = `Plan:
1. OK
2. This is a real step
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(1);
    expect(items[0]!.subject).toContain("real step");
  });

  it("skips items starting with backtick, slash, or dash", () => {
    const message = `Plan:
1. \`some code block\`
2. /some/path/here
3. - a dash item
4. A normal valid step here
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(1);
  });

  it("handles ) delimiter", () => {
    const message = `Plan:
1) First step description here
2) Second step description here
`;
    const items = extractTodoItems(message);
    expect(items).toHaveLength(2);
  });
});

describe("extractDoneSteps", () => {
  it("extracts [DONE:n] markers", () => {
    expect(extractDoneSteps("[DONE:1] First step done")).toEqual([1]);
    expect(extractDoneSteps("[DONE:1] [DONE:3]")).toEqual([1, 3]);
  });

  it("is case insensitive", () => {
    expect(extractDoneSteps("[done:2]")).toEqual([2]);
    expect(extractDoneSteps("[Done:5]")).toEqual([5]);
  });

  it("returns empty for no markers", () => {
    expect(extractDoneSteps("No markers here")).toEqual([]);
  });
});

describe("markCompletedSteps", () => {
  it("marks matching items as completed", () => {
    const items: PlanTask[] = [
      { id: "1", order: 1, subject: "First", status: "pending", blockedBy: [] },
      { id: "2", order: 2, subject: "Second", status: "pending", blockedBy: [] },
      { id: "3", order: 3, subject: "Third", status: "pending", blockedBy: [] },
    ];
    const count = markCompletedSteps("[DONE:1] [DONE:3]", items);
    expect(count).toBe(2);
    expect(items[0]!.status).toBe("completed");
    expect(items[1]!.status).toBe("pending");
    expect(items[2]!.status).toBe("completed");
  });

  it("ignores non-existent step numbers", () => {
    const items: PlanTask[] = [{ id: "1", order: 1, subject: "First", status: "pending", blockedBy: [] }];
    const count = markCompletedSteps("[DONE:99]", items);
    expect(count).toBe(1); // 1 marker found, even though no item matched
    expect(items[0]!.status).toBe("pending");
  });

  it("returns 0 for no markers", () => {
    const items: PlanTask[] = [{ id: "1", order: 1, subject: "First", status: "pending", blockedBy: [] }];
    expect(markCompletedSteps("no markers", items)).toBe(0);
  });
});

// Extracted from index.ts — review imports
import { clearConfigCache, setGlobalSettingsPath } from "@cvr/pi-config";
import { describe, expect, test, afterEach } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { findGitRoot, interpolatePromptVars } from "./index";

const cwd = "/home/user/project";

afterEach(() => {
  clearConfigCache();
});

describe("interpolatePromptVars", () => {
  test("resolves all basic vars", () => {
    const prompt =
      "cwd={cwd} roots={roots} wsroot={wsroot} workingDir={workingDir} date={date} os={os}";
    const result = interpolatePromptVars(prompt, cwd, {
      repo: "gh:test",
      sessionId: "s-123",
    });

    expect(result).toContain(`cwd=${cwd}`);
    expect(result).toContain("roots=");
    expect(result).toContain("wsroot=");
    expect(result).toContain(`workingDir=${cwd}`);
    expect(result).toContain("os=");
    expect(result).not.toContain("{cwd}");
    expect(result).not.toContain("{roots}");
    expect(result).not.toContain("{date}");
    expect(result).not.toContain("{os}");
  });

  test("resolves repo and sessionId from extra context", () => {
    const prompt = "Repository: {repo}\nSession: {sessionId}";
    const result = interpolatePromptVars(prompt, cwd, {
      repo: "https://github.com/test/repo",
      sessionId: "abc-123",
    });

    expect(result).toContain("Repository: https://github.com/test/repo");
    expect(result).toContain("Session: abc-123");
  });

  test("drops entire line when value is empty", () => {
    const prompt = "Working directory: {cwd}\nRepository: {repo}\nSession ID: {sessionId}\nDone.";
    const result = interpolatePromptVars(prompt, cwd, {
      repo: "",
      sessionId: "",
    });

    expect(result).toContain(`Working directory: ${cwd}`);
    expect(result).not.toContain("Repository");
    expect(result).not.toContain("Session ID");
    expect(result).toContain("Done.");
  });

  test("drops line when extra context is omitted entirely", () => {
    const prompt = "Dir: {cwd}\nRepo: {repo}\nEnd.";
    const result = interpolatePromptVars(prompt, cwd);

    expect(result).toContain(`Dir: ${cwd}`);
    expect(result).not.toContain("Repo");
    expect(result).toContain("End.");
  });

  test("no double-interpolation when a value contains another var pattern", () => {
    const prompt = "Repo: {repo}\nDate: {date}";
    const result = interpolatePromptVars(prompt, cwd, {
      repo: "my-{date}-repo",
      sessionId: "",
    });

    expect(result).toContain("Repo: my-{date}-repo");
    expect(result).toMatch(/Date: \w+/);
  });

  test("replaces multiple occurrences of same var", () => {
    const prompt = "{cwd} and also {cwd}";
    const result = interpolatePromptVars(prompt, cwd, {
      repo: "x",
      sessionId: "y",
    });

    expect(result).toBe(`${cwd} and also ${cwd}`);
  });

  test("multiline ls expansion preserves surrounding content", () => {
    const prompt = "Files:\n{ls}\nEnd.";
    const result = interpolatePromptVars(prompt, cwd, {
      repo: "x",
      sessionId: "y",
    });

    // ls resolves to something (git root listing) or empty — either way, End. must survive
    expect(result).toContain("End.");
  });

  test("empty ls drops the line", () => {
    // /tmp has no .git, so findGitRoot falls back to cwd, and listing /nonexistent fails
    const prompt = "Before\n{ls}\nAfter";
    const result = interpolatePromptVars(prompt, "/nonexistent/path/unlikely", {
      repo: "x",
      sessionId: "y",
    });

    expect(result).toContain("Before");
    expect(result).toContain("After");
  });
});

describe("findGitRoot", () => {
  test("finds git root from cwd", () => {
    // this test file lives inside a git repo
    const root = findGitRoot(process.cwd());
    const { existsSync } = require("node:fs");
    const { join } = require("node:path");

    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  test("falls back to dir when no git root exists", () => {
    const result = findGitRoot("/tmp/nonexistent-no-git-here");
    expect(result).toBe("/tmp/nonexistent-no-git-here");
  });
});

// ── new resolver tests ─────────────────────────────────────────────

describe("literal resolver", () => {
  test("returns static string", () => {
    const result = interpolatePromptVars(
      "val={myVar}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        myVar: { literal: "hello world" },
      },
    );
    expect(result).toContain("val=hello world");
  });
});

describe("alias resolver", () => {
  test("resolves to another variable's value", () => {
    const result = interpolatePromptVars(
      "a={a} b={b}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        a: { literal: "alpha" },
        b: { alias: "a" },
      },
    );
    expect(result).toContain("a=alpha");
    expect(result).toContain("b=alpha");
  });
});

describe("file resolver", () => {
  test("reads file contents relative to config dir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interp-test-"));
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "file content here");
    setGlobalSettingsPath(path.join(tmpDir, "cvr-pi.json"));

    const result = interpolatePromptVars(
      "content={f}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        f: { file: "test.txt" },
      },
    );
    expect(result).toContain("content=file content here");
  });
});

describe("env resolver", () => {
  test("reads environment variable", () => {
    const key = `PI_TEST_ENV_${Date.now()}`;
    process.env[key] = "env_value";
    try {
      const result = interpolatePromptVars(
        "e={e}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          e: { env: key },
        },
      );
      expect(result).toContain("e=env_value");
    } finally {
      delete process.env[key];
    }
  });
});

describe("dangerously_evaluate_js resolver", () => {
  test("evaluates JS expression", () => {
    const result = interpolatePromptVars(
      "n={n}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        n: { dangerously_evaluate_js: "2 + 2" },
      },
    );
    expect(result).toContain("n=4");
  });

  test("returns empty on error", () => {
    const result = interpolatePromptVars(
      "n={n}\nend",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        n: { dangerously_evaluate_js: "throw new Error('boom')" },
      },
    );
    expect(result).not.toContain("n=");
    expect(result).toContain("end");
  });
});

describe("dangerously_evaluate_sh resolver", () => {
  test("captures stdout from shell command", () => {
    const result = interpolatePromptVars(
      "v={v}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        v: { dangerously_evaluate_sh: "echo hello_from_sh" },
      },
    );
    expect(result).toContain("v=hello_from_sh");
  });

  test("cwd supports {var} refs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interp-sh-"));
    const result = interpolatePromptVars(
      "v={v}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        dir: { literal: tmpDir },
        v: { dangerously_evaluate_sh: "pwd", cwd: "{dir}" },
      },
    );
    // pwd output should contain the temp dir path
    expect(result).toContain(tmpDir);
  });
});

describe("default value", () => {
  test("falls back to default when resolver returns empty", () => {
    const key = `PI_TEST_MISSING_${Date.now()}`;
    delete process.env[key]; // ensure not set
    const result = interpolatePromptVars(
      "v={v}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        v: { env: key, default: "fallback" },
      },
    );
    expect(result).toContain("v=fallback");
  });

  test("default supports {var} refs", () => {
    const key = `PI_TEST_MISSING2_${Date.now()}`;
    delete process.env[key];
    const result = interpolatePromptVars(
      "v={v}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        base: { literal: "hello" },
        v: { env: key, default: "{base}-world" },
      },
    );
    expect(result).toContain("v=hello-world");
  });
});

describe("topo sort", () => {
  test("resolves dependencies in correct order", () => {
    const result = interpolatePromptVars(
      "a={a} b={b} c={c}",
      cwd,
      { repo: "x", sessionId: "y" },
      {
        c: { alias: "b" },
        b: { alias: "a" },
        a: { literal: "root" },
      },
    );
    expect(result).toContain("a=root");
    expect(result).toContain("b=root");
    expect(result).toContain("c=root");
  });

  test("throws on cycle", () => {
    expect(() =>
      interpolatePromptVars(
        "x={x}",
        cwd,
        { repo: "x", sessionId: "y" },
        {
          x: { alias: "y" },
          y: { alias: "x" },
        },
      ),
    ).toThrow(/cycle/i);
  });
});

describe("dropLineIfEmpty", () => {
  test("preserves line when dropLineIfEmpty is false", () => {
    const key = `PI_TEST_DROP_${Date.now()}`;
    delete process.env[key];
    const result = interpolatePromptVars(
      "Before\nLabel: {v}\nAfter",
      cwd,
      { repo: "x", sessionId: "y" },
      { v: { env: key, dropLineIfEmpty: false } },
    );
    expect(result).toContain("Label: ");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });
});

describe("config-driven variables", () => {
  test("reads promptVariables from global config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interp-cfg-"));
    const settingsPath = path.join(tmpDir, "cvr-pi.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        promptVariables: { custom: { literal: "from config" } },
      }),
    );
    setGlobalSettingsPath(settingsPath);

    const result = interpolatePromptVars("v={custom}", cwd, {
      repo: "x",
      sessionId: "y",
    });
    expect(result).toContain("v=from config");
  });
});

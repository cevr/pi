/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  evaluatePermission,
  decodePermissionsFile,
  type PermissionRule,
  Permissions,
} from "./index";

// ---------------------------------------------------------------------------
// shared test rules
// ---------------------------------------------------------------------------

const RULES: PermissionRule[] = [
  {
    tool: "Bash",
    matches: { cmd: ["*git add -A*", "*git add .*"] },
    action: "reject",
    message: "stage files explicitly with 'git add <file>' — unstaged changes may not be yours",
  },
  {
    tool: "Bash",
    matches: {
      cmd: ["*git push --force*", "*git push -f*", "*--force-with-lease*"],
    },
    action: "reject",
    message:
      "never force push. if diverged: 'git fetch origin && git rebase origin/main && git push'",
  },
  {
    tool: "Bash",
    matches: { cmd: ["rm *", "* && rm *", "* || rm *", "* ; rm *"] },
    action: "reject",
    message: "use 'trash <file>' instead of rm — recoverable deletion",
  },
  { tool: "*", action: "allow" },
];

// ---------------------------------------------------------------------------
// pure evaluatePermission tests
// ---------------------------------------------------------------------------

describe("evaluatePermission", () => {
  it("allows normal commands", () => {
    expect(evaluatePermission("Bash", { cmd: "git status" }, RULES)).toEqual({
      action: "allow",
    });
    expect(evaluatePermission("Bash", { cmd: "ls -la" }, RULES)).toEqual({
      action: "allow",
    });
    expect(evaluatePermission("Bash", { cmd: "nix build .#foo" }, RULES)).toEqual({
      action: "allow",
    });
  });

  it("rejects git add -A", () => {
    const v = evaluatePermission("Bash", { cmd: "git add -A" }, RULES);
    expect(v.action).toBe("reject");
    expect(v.message).toContain("stage files explicitly");
  });

  it("rejects git add .", () => {
    const v = evaluatePermission("Bash", { cmd: "git add ." }, RULES);
    expect(v.action).toBe("reject");
  });

  it("allows explicit git add", () => {
    const v = evaluatePermission("Bash", { cmd: "git add src/foo.ts" }, RULES);
    expect(v.action).toBe("allow");
  });

  it("rejects force push variants", () => {
    expect(evaluatePermission("Bash", { cmd: "git push --force" }, RULES).action).toBe("reject");
    expect(evaluatePermission("Bash", { cmd: "git push -f origin main" }, RULES).action).toBe(
      "reject",
    );
    expect(evaluatePermission("Bash", { cmd: "git push --force-with-lease" }, RULES).action).toBe(
      "reject",
    );
  });

  it("allows normal git push", () => {
    expect(evaluatePermission("Bash", { cmd: "git push" }, RULES).action).toBe("allow");
    expect(evaluatePermission("Bash", { cmd: "git push origin main" }, RULES).action).toBe("allow");
  });

  it("rejects rm commands", () => {
    expect(evaluatePermission("Bash", { cmd: "rm foo.txt" }, RULES).action).toBe("reject");
    expect(evaluatePermission("Bash", { cmd: "rm -rf /tmp/junk" }, RULES).action).toBe("reject");
    expect(evaluatePermission("Bash", { cmd: "ls && rm foo" }, RULES).action).toBe("reject");
    expect(evaluatePermission("Bash", { cmd: "false || rm foo" }, RULES).action).toBe("reject");
    expect(evaluatePermission("Bash", { cmd: "echo hi ; rm foo" }, RULES).action).toBe("reject");
  });

  it("allows non-Bash tools via wildcard catch-all", () => {
    expect(evaluatePermission("Read", { cmd: "/etc/passwd" }, RULES)).toEqual({
      action: "allow",
    });
  });

  it("allows everything when no rules", () => {
    expect(evaluatePermission("Bash", { cmd: "rm -rf /" }, [])).toEqual({
      action: "allow",
    });
  });

  it("matches tool name with glob", () => {
    const rules: PermissionRule[] = [
      { tool: "mcp__*", action: "reject", message: "no mcp" },
      { tool: "*", action: "allow" },
    ];
    expect(evaluatePermission("mcp__playwright_click", {}, rules).action).toBe("reject");
    expect(evaluatePermission("Bash", { cmd: "ls" }, rules).action).toBe("allow");
  });
});

async function runWithPermissionsLayer<A, E>(
  layer: Layer.Layer<Permissions, never, never>,
  effect: Effect.Effect<A, E, Permissions>,
): Promise<A> {
  const runtime = ManagedRuntime.make(layer);
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

// ---------------------------------------------------------------------------
// Effect Permissions service tests
// ---------------------------------------------------------------------------

describe("Permissions service", () => {
  it("evaluates rules via layerTest", async () => {
    const result = await runWithPermissionsLayer(
      Permissions.layerTest(RULES),
      Effect.gen(function* () {
        const perms = yield* Permissions;
        return yield* perms.evaluate("Bash", { cmd: "git add -A" });
      }),
    );

    expect(result.action).toBe("reject");
    expect(result.message).toContain("stage files explicitly");
  });

  it("loads rules via layerTest", async () => {
    const result = await runWithPermissionsLayer(
      Permissions.layerTest(RULES),
      Effect.gen(function* () {
        const perms = yield* Permissions;
        return yield* perms.loadRules();
      }),
    );

    expect(result).toHaveLength(4);
    expect(result[0]!.tool).toBe("Bash");
  });

  it("allows everything with empty rules", async () => {
    const result = await runWithPermissionsLayer(
      Permissions.layerTest([]),
      Effect.gen(function* () {
        const perms = yield* Permissions;
        return yield* perms.evaluate("Bash", { cmd: "rm -rf /" });
      }),
    );

    expect(result.action).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// boundary tests — production layer + sync API
// ---------------------------------------------------------------------------

describe("permissions boundary", () => {
  function tmpFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perms-test-"));
    const p = path.join(dir, "permissions.json");
    fs.writeFileSync(p, content);
    return p;
  }

  it("loads valid JSON from disk via production layer", async () => {
    const p = tmpFile(JSON.stringify([{ tool: "Bash", action: "reject" }]));
    const result = await runWithPermissionsLayer(
      Permissions.layer(p),
      Effect.gen(function* () {
        const perms = yield* Permissions;
        return yield* perms.loadRules();
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.action).toBe("reject");
  });

  it("returns [] when file is missing (allow all)", async () => {
    const result = await runWithPermissionsLayer(
      Permissions.layer("/nonexistent/permissions.json"),
      Effect.gen(function* () {
        const perms = yield* Permissions;
        return yield* perms.loadRules();
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("fails closed on malformed JSON (reject all)", async () => {
    const p = tmpFile("NOT VALID JSON {{{");
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runWithPermissionsLayer(
      Permissions.layer(p),
      Effect.gen(function* () {
        const perms = yield* Permissions;
        return yield* perms.evaluate("Bash", { cmd: "ls" });
      }),
    );
    expect(result.action).toBe("reject");
    expect(result.message).toContain("malformed");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("fails closed on invalid schema shape (reject all)", async () => {
    const p = tmpFile(JSON.stringify([{ tool: 123, action: "maybe" }]));
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runWithPermissionsLayer(
      Permissions.layer(p),
      Effect.gen(function* () {
        const perms = yield* Permissions;
        return yield* perms.evaluate("Read", { cmd: "/etc/passwd" });
      }),
    );
    expect(result.action).toBe("reject");
    errSpy.mockRestore();
  });

  it("sync decodePermissionsFile returns [] for missing file", () => {
    const rules = decodePermissionsFile("/nonexistent/permissions.json");
    expect(rules).toHaveLength(0);
  });

  it("sync decodePermissionsFile fails closed on malformed JSON", () => {
    const p = tmpFile("NOT VALID JSON {{{");
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const rules = decodePermissionsFile(p);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.action).toBe("reject");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("sync decodePermissionsFile fails closed on invalid schema", () => {
    const p = tmpFile(JSON.stringify([{ tool: 123, action: "maybe" }]));
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const rules = decodePermissionsFile(p);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.action).toBe("reject");
    errSpy.mockRestore();
  });
});

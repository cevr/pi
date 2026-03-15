import { afterEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import {
  clearConfigCache,
  getExtensionConfig,
  getExtensionConfigWithSchema,
  getEnabledExtensionConfig,
  getGlobalConfig,
  resolveConfigDir,
  setGlobalSettingsPath,
  ConfigService,
} from "./index";

const tmpdir = os.tmpdir();

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

const originalPiCvrConfigPath = process.env.PI_CVR_CONFIG_PATH;

afterEach(() => {
  clearConfigCache();
  setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  if (originalPiCvrConfigPath === undefined) {
    delete process.env.PI_CVR_CONFIG_PATH;
  } else {
    process.env.PI_CVR_CONFIG_PATH = originalPiCvrConfigPath;
  }
});

describe("getExtensionConfig", () => {
  test("returns defaults when no settings file exists", () => {
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
    const result = getExtensionConfig("@cvr/pi-test", { foo: "bar", n: 1 });
    expect(result).toEqual({ foo: "bar", n: 1 });
  });

  test("reads namespaced config from global settings", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { foo: "overridden" },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getExtensionConfig("@cvr/pi-test", {
      foo: "default",
      extra: true,
    });
    expect(result).toEqual({ foo: "overridden", extra: true });
  });

  test("prefers the in-process override over PI_CVR_CONFIG_PATH", () => {
    const envDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-env-"));
    const envSettingsPath = writeTmpJson(envDir, "env-settings.json", {
      "@cvr/pi-test": { foo: "from-env" },
    });
    const manualDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-manual-"));
    const manualSettingsPath = writeTmpJson(manualDir, "manual-settings.json", {
      "@cvr/pi-test": { foo: "from-setter" },
    });
    process.env.PI_CVR_CONFIG_PATH = envSettingsPath;
    setGlobalSettingsPath(manualSettingsPath);

    const result = getExtensionConfig("@cvr/pi-test", { foo: "default" });
    expect(result).toEqual({ foo: "from-setter" });
  });

  test("deep merges nested objects", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { nested: { b: 2, c: 3 } },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getExtensionConfig("@cvr/pi-test", {
      nested: { a: 1, b: 0 },
    });
    expect(result).toEqual({ nested: { a: 1, b: 2, c: 3 } });
  });

  test("arrays replace rather than merge", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { items: [3, 4] },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getExtensionConfig("@cvr/pi-test", { items: [1, 2] });
    expect(result).toEqual({ items: [3, 4] });
  });

  test("caches reads — second call does not re-read file", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { v: 1 },
    });
    setGlobalSettingsPath(settingsPath);

    getExtensionConfig("@cvr/pi-test", { v: 0 });
    fs.writeFileSync(settingsPath, JSON.stringify({ "@cvr/pi-test": { v: 999 } }));
    const result = getExtensionConfig("@cvr/pi-test", { v: 0 });
    expect(result).toEqual({ v: 1 });
  });

  test("clearConfigCache resets cached reads", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { v: 1 },
    });
    setGlobalSettingsPath(settingsPath);

    getExtensionConfig("@cvr/pi-test", { v: 0 });
    fs.writeFileSync(settingsPath, JSON.stringify({ "@cvr/pi-test": { v: 999 } }));
    clearConfigCache();
    const result = getExtensionConfig("@cvr/pi-test", { v: 0 });
    expect(result).toEqual({ v: 999 });
  });

  test("handles malformed JSON gracefully", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, "NOT VALID JSON {{{");
    setGlobalSettingsPath(settingsPath);

    const result = getExtensionConfig("@cvr/pi-test", { ok: true });
    expect(result).toEqual({ ok: true });
  });

  test("returns defaults when namespace key is missing", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-other": { x: 1 },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getExtensionConfig("@cvr/pi-test", { y: 2 });
    expect(result).toEqual({ y: 2 });
  });

  test("project-local config merges on top of global", () => {
    const globalDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-global-"));
    const globalPath = writeTmpJson(globalDir, "settings.json", {
      "@cvr/pi-test": { a: "global", b: "global" },
    });
    setGlobalSettingsPath(globalPath);

    const projectDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-project-"));
    writeTmpJson(projectDir, ".pi/settings.json", {
      "@cvr/pi-test": { b: "project", c: "project" },
    });

    const result = getExtensionConfig(
      "@cvr/pi-test",
      { a: "default", b: "default", c: "default" },
      { cwd: projectDir, allowProjectConfig: true },
    );
    expect(result).toEqual({ a: "global", b: "project", c: "project" });
  });

  test("project-local config is ignored when allowProjectConfig is false", () => {
    const globalDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-global-"));
    const globalPath = writeTmpJson(globalDir, "settings.json", {
      "@cvr/pi-test": { a: "global" },
    });
    setGlobalSettingsPath(globalPath);

    const projectDir = fs.mkdtempSync(path.join(tmpdir, "pi-config-project-"));
    writeTmpJson(projectDir, ".pi/settings.json", {
      "@cvr/pi-test": { a: "project" },
    });

    const result = getExtensionConfig("@cvr/pi-test", { a: "default" }, { cwd: projectDir });
    expect(result).toEqual({ a: "global" });
  });
});

describe("getExtensionConfigWithSchema", () => {
  test("applies validation and normalization to merged config", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { foo: "overridden", count: 2 },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getExtensionConfigWithSchema(
      "@cvr/pi-test",
      { foo: "default", count: 0 },
      {
        schema: {
          validate: (
            value,
          ): value is {
            foo: string;
            count: number;
          } => typeof value.foo === "string" && typeof value.count === "number",
          normalize: (value) => ({
            ...value,
            foo: value.foo.trim().toUpperCase(),
          }),
        },
      },
    );

    expect(result).toEqual({ foo: "OVERRIDDEN", count: 2 });
  });

  test("falls back to defaults when validation fails", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { foo: 123 },
    });
    setGlobalSettingsPath(settingsPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);

    const result = getExtensionConfigWithSchema(
      "@cvr/pi-test",
      { foo: "default" },
      {
        schema: {
          validate: (value): value is { foo: string } => typeof value.foo === "string",
        },
      },
    );

    expect(result).toEqual({ foo: "default" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[@cvr/pi-config] invalid config for @cvr/pi-test; falling back to defaults.",
    );
  });
});

describe("getEnabledExtensionConfig", () => {
  test("defaults enabled to true and strips the reserved flag from config", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { foo: "overridden" },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getEnabledExtensionConfig("@cvr/pi-test", {
      foo: "default",
    });

    expect(result).toEqual({ enabled: true, config: { foo: "overridden" } });
  });

  test("returns explicit enabled flag and validates remaining config", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { enabled: false, foo: " override ", count: 2 },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getEnabledExtensionConfig(
      "@cvr/pi-test",
      { foo: "default", count: 0 },
      {
        schema: {
          validate: (
            value,
          ): value is {
            foo: string;
            count: number;
          } => typeof value.foo === "string" && typeof value.count === "number",
          normalize: (value) => ({ ...value, foo: value.foo.trim() }),
        },
      },
    );

    expect(result).toEqual({
      enabled: false,
      config: { foo: "override", count: 2 },
    });
  });

  test("ignores non-boolean enabled values", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      "@cvr/pi-test": { enabled: "nope", foo: "overridden" },
    });
    setGlobalSettingsPath(settingsPath);

    const result = getEnabledExtensionConfig("@cvr/pi-test", {
      foo: "default",
    });

    expect(result).toEqual({ enabled: true, config: { foo: "overridden" } });
  });
});

describe("getGlobalConfig", () => {
  test("returns undefined when no settings file exists", () => {
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
    expect(getGlobalConfig("missing")).toBeUndefined();
  });

  test("reads top-level key from global settings", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", {
      promptVariables: { foo: { literal: "bar" } },
    });
    setGlobalSettingsPath(settingsPath);
    expect(getGlobalConfig("promptVariables")).toEqual({
      foo: { literal: "bar" },
    });
  });

  test("returns undefined for missing key", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir, "pi-config-test-"));
    const settingsPath = writeTmpJson(dir, "settings.json", { other: 1 });
    setGlobalSettingsPath(settingsPath);
    expect(getGlobalConfig("promptVariables")).toBeUndefined();
  });
});

describe("resolveConfigDir", () => {
  test("returns dirname of global settings path", () => {
    setGlobalSettingsPath("/fake/dir/settings.json");
    expect(resolveConfigDir()).toBe("/fake/dir");
  });
});

// ---------------------------------------------------------------------------
// Effect ConfigService tests
// ---------------------------------------------------------------------------

describe("ConfigService", () => {
  const testData = {
    "@cvr/pi-test": { foo: "overridden", count: 2 },
    "@cvr/pi-gated": { enabled: false, bar: "value" },
    promptVariables: { foo: { literal: "bar" } },
  };

  const runWithConfig = <A, E>(effect: Effect.Effect<A, E, ConfigService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, ConfigService.layerTest(testData)));

  test("getExtension merges with defaults", async () => {
    const result = await runWithConfig(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        return yield* config.getExtension("@cvr/pi-test", {
          foo: "default",
          extra: true,
        });
      }),
    );
    expect(result).toEqual({ foo: "overridden", extra: true, count: 2 });
  });

  test("getExtension returns defaults for missing namespace", async () => {
    const result = await runWithConfig(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        return yield* config.getExtension("@cvr/pi-missing", { x: 1 });
      }),
    );
    expect(result).toEqual({ x: 1 });
  });

  test("getEnabled returns enabled flag", async () => {
    const result = await runWithConfig(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        return yield* config.getEnabled("@cvr/pi-gated", { bar: "default" });
      }),
    );
    expect(result.enabled).toBe(false);
    expect(result.config.bar).toBe("value");
  });

  test("getEnabled defaults to true when no enabled flag", async () => {
    const result = await runWithConfig(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        return yield* config.getEnabled("@cvr/pi-test", {
          foo: "default",
          count: 0,
        });
      }),
    );
    expect(result.enabled).toBe(true);
  });

  test("getGlobal reads top-level key", async () => {
    const result = await runWithConfig(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        return yield* config.getGlobal("promptVariables");
      }),
    );
    expect(result).toEqual({ foo: { literal: "bar" } });
  });

  test("getGlobal returns undefined for missing key", async () => {
    const result = await runWithConfig(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        return yield* config.getGlobal("missing");
      }),
    );
    expect(result).toBeUndefined();
  });

  test("configDir returns test path", async () => {
    const result = await runWithConfig(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        return yield* config.configDir();
      }),
    );
    expect(result).toBe("/test/config");
  });
});

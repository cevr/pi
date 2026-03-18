/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Config, Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { findRepoRoot, layerRepoEnv } from "./index";

const touchedKeys = new Set<string>();

function setEnv(key: string, value: string | undefined) {
  touchedKeys.add(key);
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makePackageRoot(): { root: string; nested: string; filePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-env-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@cvr/pi", private: true }, null, 2) + "\n",
  );
  const nested = path.join(root, "dist", "nested");
  fs.mkdirSync(nested, { recursive: true });
  const filePath = path.join(nested, "index.ts");
  fs.writeFileSync(filePath, "export {};\n");
  return { root, nested, filePath };
}

function repoEnvLayer(start: string | URL) {
  return layerRepoEnv(start).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );
}

function repoPathLayer() {
  return Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
}

async function readConfigValue<A>(start: string | URL, config: Config.Config<A>) {
  const runtime = ManagedRuntime.make(repoEnvLayer(start));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        return yield* config;
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

async function readRepoRoot(start: string | URL) {
  const runtime = ManagedRuntime.make(repoPathLayer());
  try {
    return await runtime.runPromise(findRepoRoot(start));
  } finally {
    await runtime.dispose();
  }
}

afterEach(() => {
  for (const key of touchedKeys) {
    delete process.env[key];
  }
  touchedKeys.clear();
});

describe("repo-env", () => {
  it("finds the package root from a nested directory", async () => {
    const { root, nested } = makePackageRoot();
    expect(await readRepoRoot(nested)).toEqual(Option.some(root));
  });

  it("finds the package root from a nested file path", async () => {
    const { root, filePath } = makePackageRoot();
    expect(await readRepoRoot(filePath)).toEqual(Option.some(root));
  });

  it("finds the package root from a nested file URL", async () => {
    const { root, filePath } = makePackageRoot();
    expect(await readRepoRoot(pathToFileURL(filePath))).toEqual(Option.some(root));
  });

  it("finds the package root from a nested file URL string", async () => {
    const { root, filePath } = makePackageRoot();
    expect(await readRepoRoot(pathToFileURL(filePath).toString())).toEqual(Option.some(root));
  });

  it("returns none when no repo root exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-env-missing-root-"));
    expect(await readRepoRoot(dir)).toEqual(Option.none());
  });

  it("loads repo .env values through the config provider", async () => {
    const { root, nested } = makePackageRoot();
    fs.writeFileSync(path.join(root, ".env"), "PARALLEL_API_KEY=from-dotenv\n");
    setEnv("PARALLEL_API_KEY", undefined);

    const apiKey = await readConfigValue(nested, Config.redacted("PARALLEL_API_KEY"));

    expect(Redacted.value(apiKey)).toBe("from-dotenv");
  });

  it("leaves config missing when repo .env is absent", async () => {
    const { nested } = makePackageRoot();
    setEnv("PARALLEL_API_KEY", undefined);

    const apiKey = await readConfigValue(
      nested,
      Config.option(Config.redacted("PARALLEL_API_KEY")),
    );

    expect(apiKey).toEqual(Option.none());
  });

  it("lets shell env override repo .env", async () => {
    const { root, nested } = makePackageRoot();
    fs.writeFileSync(path.join(root, ".env"), "PARALLEL_API_KEY=from-dotenv\n");
    setEnv("PARALLEL_API_KEY", "from-shell");

    const apiKey = await readConfigValue(nested, Config.redacted("PARALLEL_API_KEY"));

    expect(Redacted.value(apiKey)).toBe("from-shell");
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPackageRoot, loadRootEnv } from "./load-root-env";

const touchedKeys = new Set<string>();

function setEnv(key: string, value: string | undefined) {
  touchedKeys.add(key);
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makePackageRoot(): { root: string; nested: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-load-root-env-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@cvr/pi", private: true }, null, 2) + "\n",
  );
  const nested = path.join(root, "dist", "nested");
  fs.mkdirSync(nested, { recursive: true });
  return { root, nested };
}

afterEach(() => {
  for (const key of touchedKeys) {
    delete process.env[key];
  }
  touchedKeys.clear();
});

describe("load-root-env", () => {
  it("finds the package root from a nested directory", () => {
    const { root, nested } = makePackageRoot();
    expect(findPackageRoot(nested)).toBe(root);
  });

  it("loads .env values from the package root", () => {
    const { root, nested } = makePackageRoot();
    fs.writeFileSync(path.join(root, ".env"), "PARALLEL_API_KEY=from-dotenv\nSEARCH_MODE=enabled\n");
    setEnv("PARALLEL_API_KEY", undefined);
    setEnv("SEARCH_MODE", undefined);

    const loadedPath = loadRootEnv(nested);

    expect(loadedPath).toBe(path.join(root, ".env"));
    expect(process.env.PARALLEL_API_KEY).toBe("from-dotenv");
    expect(process.env.SEARCH_MODE).toBe("enabled");
  });

  it("does not override existing env vars", () => {
    const { root, nested } = makePackageRoot();
    fs.writeFileSync(path.join(root, ".env"), "PARALLEL_API_KEY=from-dotenv\n");
    setEnv("PARALLEL_API_KEY", "already-set");

    loadRootEnv(nested);

    expect(process.env.PARALLEL_API_KEY).toBe("already-set");
  });

  it("returns null when .env is missing", () => {
    const { nested } = makePackageRoot();
    expect(loadRootEnv(nested)).toBeNull();
  });
});

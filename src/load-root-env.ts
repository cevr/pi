import * as fs from "node:fs";
import * as path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@cvr/pi";
const ENV_FILENAME = ".env";

function isPackageRoot(dir: string): boolean {
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return packageJson.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function findPackageRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (isPackageRoot(current)) return current;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadRootEnv(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  const root = findPackageRoot(startDir);
  if (!root) return null;

  const envPath = path.join(root, ENV_FILENAME);
  if (!fs.existsSync(envPath)) return null;

  try {
    const parsed = parseEnv(fs.readFileSync(envPath, "utf-8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return envPath;
  } catch (error) {
    console.warn(
      `[@cvr/pi] failed to load ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

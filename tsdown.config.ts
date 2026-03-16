import { defineConfig } from "tsdown";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const excludedEntryDirs = new Set(["test-utils"]);

/** collect all index.ts entry points from a packages subdirectory. */
function collectEntries(base: string, prefix: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(resolve(base))) {
    if (excludedEntryDirs.has(name)) continue;

    const dir = resolve(base, name);
    const entry = resolve(dir, "index.ts");

    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(entry)) continue;

    entries[`${prefix}/${name}`] = entry;
  }
  return entries;
}

const coreEntries = collectEntries("packages/core", "core");
const extensionEntries = collectEntries("packages/extensions", "extensions");

/** all @cvr/pi-* workspace packages resolved to their source. */
const cvrPiAlias: Record<string, string> = {};
for (const [key, value] of Object.entries({
  ...coreEntries,
  ...extensionEntries,
})) {
  const pkgName = `@cvr/pi-${key.split("/")[1]}`;
  cvrPiAlias[pkgName] = value;
}

export default defineConfig({
  entry: {
    extensions: "src/extensions.ts",
    ...extensionEntries,
    ...coreEntries,
  },
  format: "esm",
  dts: false,
  tsconfig: "tsconfig.build.json",
  deps: {
    neverBundle: [/^@mariozechner\//, /^@sinclair\//, "beautiful-mermaid"],
  },
  alias: cvrPiAlias,
  define: { "import.meta.vitest": "undefined" },
  outDir: "dist",
  clean: true,
  fixedExtension: false,
});

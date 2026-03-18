/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * Comprehensive test file fixer:
 * 1. Move all imports to the top of the file (after the header comment)
 * 2. Add missing imports from sibling source files
 * 3. Add missing node: imports
 * 4. Fix vi.* → bun:test equivalents
 */
import * as fs from "node:fs";
import * as path from "node:path";

const PI_ROOT = path.resolve(import.meta.dirname, "..");

function findTestFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      results.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

function getExports(sourceFile: string): string[] {
  if (!fs.existsSync(sourceFile)) return [];
  const content = fs.readFileSync(sourceFile, "utf-8");
  const exports: string[] = [];
  for (const match of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g))
    exports.push(match[1]!);
  for (const match of content.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g))
    exports.push(match[1]!);
  for (const match of content.matchAll(/export\s+class\s+(\w+)/g)) exports.push(match[1]!);
  for (const match of content.matchAll(/export\s+(?:interface|type)\s+(\w+)/g))
    exports.push(match[1]!);
  for (const match of content.matchAll(/export\s+default\s+(?:function|class)\s+(\w+)/g))
    exports.push(match[1]!);
  for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const names = match[1]!.split(",").map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim(),
    );
    exports.push(...names.filter(Boolean));
  }
  return [...new Set(exports)];
}

function fixTestFile(testFile: string): boolean {
  let content = fs.readFileSync(testFile, "utf-8");
  const dir = path.dirname(testFile);
  const basename = path.basename(testFile, ".test.ts");
  const sourceFile = path.join(dir, `${basename}.ts`);

  // 1. Collect all import lines and non-import lines
  const lines = content.split("\n");
  const importLines: string[] = [];
  const bodyLines: string[] = [];
  const headerLines: string[] = []; // comment at top

  let inHeader = true;
  for (const line of lines) {
    if (inHeader && (line.startsWith("//") || line.trim() === "")) {
      headerLines.push(line);
      continue;
    }
    inHeader = false;

    if (/^\s*import\s/.test(line)) {
      importLines.push(line);
    } else {
      bodyLines.push(line);
    }
  }

  // 2. Get available exports from source
  const availableExports = getExports(sourceFile);

  // 3. Find what's already imported
  const alreadyImported = new Set<string>();
  const alreadyImportedModules = new Set<string>();
  for (const imp of importLines) {
    for (const match of imp.matchAll(/\{([^}]+)\}/g)) {
      for (const name of match[1]!.split(",")) {
        alreadyImported.add(
          name
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        );
      }
    }
    const starMatch = imp.match(/import\s+\*\s+as\s+(\w+)/);
    if (starMatch) alreadyImported.add(starMatch[1]!);
    const modMatch = imp.match(/from\s+["']([^"']+)["']/);
    if (modMatch) alreadyImportedModules.add(modMatch[1]!);
  }

  // 4. Find needed source imports
  const body = bodyLines.join("\n");
  const neededFromSource = availableExports.filter(
    (e) => !alreadyImported.has(e) && new RegExp(`\\b${e}\\b`).test(body),
  );

  // 5. Find needed node: imports
  const nodeModules: [string, string][] = [
    ["os", "node:os"],
    ["fs", "node:fs"],
    ["path", "node:path"],
  ];
  const neededNodeImports: string[] = [];
  for (const [name, mod] of nodeModules) {
    if (!alreadyImported.has(name) && new RegExp(`\\b${name}\\.`).test(body)) {
      neededNodeImports.push(`import * as ${name} from "${mod}";`);
    }
  }

  // 6. Find needed bun:test imports
  const bunTestNeeded: string[] = [];
  const bunTestAll = [
    "describe",
    "expect",
    "it",
    "test",
    "beforeEach",
    "beforeAll",
    "afterEach",
    "afterAll",
    "mock",
    "spyOn",
  ];
  for (const fn of bunTestAll) {
    if (!alreadyImported.has(fn) && new RegExp(`\\b${fn}\\b`).test(body)) {
      bunTestNeeded.push(fn);
    }
  }

  // Check if there's already a bun:test import and merge
  let hasBunTestImport = false;
  const updatedImportLines = importLines.map((line) => {
    if (line.includes('"bun:test"')) {
      hasBunTestImport = true;
      // Merge any missing bun:test imports
      const existing = new Set<string>();
      const match = line.match(/\{([^}]+)\}/);
      if (match) {
        for (const name of match[1]!.split(",")) {
          existing.add(name.trim());
        }
      }
      for (const fn of bunTestNeeded) {
        existing.add(fn);
      }
      return `import { ${[...existing].join(", ")} } from "bun:test";`;
    }
    return line;
  });

  if (!hasBunTestImport && bunTestNeeded.length > 0) {
    updatedImportLines.unshift(`import { ${bunTestNeeded.join(", ")} } from "bun:test";`);
  }

  // 7. Add source import
  if (neededFromSource.length > 0) {
    const relPath = `./${basename}`;
    // Check if there's already an import from this source
    const existingSourceImportIdx = updatedImportLines.findIndex((l) =>
      l.includes(`from "${relPath}"`),
    );
    if (existingSourceImportIdx >= 0) {
      const existing = updatedImportLines[existingSourceImportIdx]!;
      const match = existing.match(/\{([^}]+)\}/);
      if (match) {
        const names = new Set(match[1]!.split(",").map((n) => n.trim()));
        for (const n of neededFromSource) names.add(n);
        updatedImportLines[existingSourceImportIdx] =
          `import { ${[...names].join(", ")} } from "${relPath}";`;
      }
    } else {
      updatedImportLines.push(`import { ${neededFromSource.join(", ")} } from "${relPath}";`);
    }
  }

  // 8. Add node imports
  for (const imp of neededNodeImports) {
    updatedImportLines.push(imp);
  }

  // 9. Reassemble
  const newContent = [
    ...headerLines,
    ...updatedImportLines,
    "",
    ...bodyLines.filter((l, i) => !(i === 0 && l.trim() === "")), // remove leading blank
  ].join("\n");

  if (newContent !== content) {
    fs.writeFileSync(testFile, newContent);
    return true;
  }
  return false;
}

// Main
const testFiles = findTestFiles(path.join(PI_ROOT, "packages"));
let fixCount = 0;
for (const file of testFiles) {
  const rel = path.relative(PI_ROOT, file);
  if (fixTestFile(file)) {
    console.log(`FIXED ${rel}`);
    fixCount++;
  }
}
console.log(`\nFixed ${fixCount} / ${testFiles.length} files`);

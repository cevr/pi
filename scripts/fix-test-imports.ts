/**
 * Fix extracted test files by adding missing imports from sibling source files.
 *
 * For each .test.ts file:
 * 1. Find the corresponding source file (index.ts or same-name.ts)
 * 2. Parse exports from source
 * 3. Find references in test file that aren't imported
 * 4. Add import statement
 * 5. Add missing node: imports (os, fs, path, etc.)
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

  // export function foo
  for (const match of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
    exports.push(match[1]!);
  }
  // export const/let/var foo
  for (const match of content.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) {
    exports.push(match[1]!);
  }
  // export class foo
  for (const match of content.matchAll(/export\s+class\s+(\w+)/g)) {
    exports.push(match[1]!);
  }
  // export interface/type foo
  for (const match of content.matchAll(/export\s+(?:interface|type)\s+(\w+)/g)) {
    exports.push(match[1]!);
  }
  // export default function foo / export default class foo
  for (const match of content.matchAll(/export\s+default\s+(?:function|class)\s+(\w+)/g)) {
    exports.push(match[1]!);
  }
  // export { foo, bar } — named re-exports
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

function findReferencedExports(testContent: string, availableExports: string[]): string[] {
  const referenced: string[] = [];
  for (const exp of availableExports) {
    // Check if the export name appears in the test content as a word boundary
    const regex = new RegExp(`\\b${exp}\\b`);
    if (regex.test(testContent)) {
      referenced.push(exp);
    }
  }
  return referenced;
}

function getExistingImports(testContent: string): Set<string> {
  const imported = new Set<string>();
  for (const match of testContent.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    const names = match[1]!.split(",").map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim(),
    );
    for (const name of names) {
      if (name) imported.add(name);
    }
  }
  for (const match of testContent.matchAll(/import\s+(\w+)\s+from/g)) {
    imported.add(match[1]!);
  }
  for (const match of testContent.matchAll(/import\s+\*\s+as\s+(\w+)\s+from/g)) {
    imported.add(match[1]!);
  }
  return imported;
}

// Node built-in modules that tests commonly use
const NODE_MODULES: Record<string, string> = {
  os: "node:os",
  fs: "node:fs",
  path: "node:path",
  child_process: "node:child_process",
};

function findMissingNodeImports(testContent: string, existingImports: Set<string>): string[] {
  const missing: string[] = [];
  for (const [name, _mod] of Object.entries(NODE_MODULES)) {
    if (!existingImports.has(name) && new RegExp(`\\b${name}\\.`).test(testContent)) {
      missing.push(name);
    }
  }
  return missing;
}

function fixTestFile(testFile: string): { fixed: boolean; added: string[] } {
  let content = fs.readFileSync(testFile, "utf-8");
  const dir = path.dirname(testFile);
  const basename = path.basename(testFile, ".test.ts");

  // Find corresponding source file
  const sourceFile = path.join(dir, `${basename}.ts`);
  const availableExports = getExports(sourceFile);

  // Also check for re-exports from the source's imports
  // (e.g., source imports and re-exports from workspace packages)

  const existingImports = getExistingImports(content);
  const neededExports = findReferencedExports(content, availableExports).filter(
    (e) => !existingImports.has(e),
  );

  const neededNodeModules = findMissingNodeImports(content, existingImports);

  if (neededExports.length === 0 && neededNodeModules.length === 0) {
    return { fixed: false, added: [] };
  }

  const added: string[] = [];
  const newImports: string[] = [];

  // Add node module imports
  for (const mod of neededNodeModules) {
    newImports.push(`import * as ${mod} from "${NODE_MODULES[mod]!}";`);
    added.push(mod);
  }

  // Add source imports
  if (neededExports.length > 0) {
    const relPath = `./${basename}`;
    newImports.push(`import { ${neededExports.join(", ")} } from "${relPath}";`);
    added.push(...neededExports);
  }

  // Insert after the first comment line or at the top
  const existingImportEnd = content.lastIndexOf("import ");
  if (existingImportEnd > 0) {
    // Find end of last import line
    const lineEnd = content.indexOf("\n", existingImportEnd);
    content =
      content.slice(0, lineEnd + 1) + newImports.join("\n") + "\n" + content.slice(lineEnd + 1);
  } else {
    content = newImports.join("\n") + "\n" + content;
  }

  fs.writeFileSync(testFile, content);
  return { fixed: true, added };
}

// Main
const testFiles = findTestFiles(path.join(PI_ROOT, "packages"));
let fixCount = 0;

for (const file of testFiles) {
  const rel = path.relative(PI_ROOT, file);
  const result = fixTestFile(file);
  if (result.fixed) {
    console.log(`FIXED ${rel} — added: ${result.added.join(", ")}`);
    fixCount++;
  }
}

console.log(`\nFixed ${fixCount} / ${testFiles.length} test files`);

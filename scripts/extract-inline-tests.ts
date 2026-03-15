/**
 * Extract `if (import.meta.vitest) { ... }` blocks from source files
 * into dedicated .test.ts files, then strip the block from source.
 *
 * Usage: bun run scripts/extract-inline-tests.ts [--dry-run]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const dryRun = process.argv.includes("--dry-run");

function findInlineTestFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
			results.push(...findInlineTestFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			const content = fs.readFileSync(full, "utf-8");
			if (content.includes("import.meta.vitest")) {
				results.push(full);
			}
		}
	}
	return results;
}

function extractTestBlock(content: string): { source: string; testBlock: string } | null {
	// Find `if (import.meta.vitest) {` and extract everything to matching `}`
	const marker = "if (import.meta.vitest)";
	const idx = content.indexOf(marker);
	if (idx === -1) return null;

	// Find the opening brace
	const braceStart = content.indexOf("{", idx + marker.length);
	if (braceStart === -1) return null;

	// Match braces to find the end
	let depth = 1;
	let i = braceStart + 1;
	while (i < content.length && depth > 0) {
		if (content[i] === "{") depth++;
		else if (content[i] === "}") depth--;
		i++;
	}

	if (depth !== 0) return null;

	const testBlock = content.slice(braceStart + 1, i - 1).trim();
	// Remove the entire if block + any preceding newlines
	let start = idx;
	while (start > 0 && content[start - 1] === "\n") start--;
	if (start > 0) start++; // keep one newline

	const source = content.slice(0, start).trimEnd() + "\n";

	return { source, testBlock };
}

function convertTestBlock(testBlock: string, sourceFile: string): string {
	// Remove vitest destructuring like `const { describe, expect, it, vi, ... } = import.meta.vitest;`
	let converted = testBlock.replace(
		/const\s*\{[^}]*\}\s*=\s*import\.meta\.vitest\s*;?\s*\n?/g,
		"",
	);

	// Detect what test utilities are used
	const usesDescribe = /\bdescribe\b/.test(converted);
	const usesExpect = /\bexpect\b/.test(converted);
	const usesIt = /\bit\b/.test(converted);
	const usesTest = /\btest\b/.test(converted);
	const usesVi = /\bvi\b/.test(converted);
	const usesBefore = /\b(beforeEach|beforeAll|afterEach|afterAll)\b/.test(converted);

	const bunTestImports: string[] = [];
	if (usesDescribe) bunTestImports.push("describe");
	if (usesExpect) bunTestImports.push("expect");
	if (usesIt) bunTestImports.push("it");
	if (usesTest) bunTestImports.push("test");
	if (usesVi) bunTestImports.push("vi" as never); // bun:test has mock/spyOn
	const beforeAfter = converted.match(/\b(beforeEach|beforeAll|afterEach|afterAll)\b/g);
	if (beforeAfter) {
		for (const fn of new Set(beforeAfter)) {
			bunTestImports.push(fn);
		}
	}

	// Build import for bun:test
	let imports = "";
	if (bunTestImports.length > 0) {
		// Replace vi with mock/spyOn
		const finalImports = bunTestImports.filter((i) => i !== "vi");
		if (usesVi) {
			finalImports.push("mock", "spyOn");
		}
		imports = `import { ${finalImports.join(", ")} } from "bun:test";\n`;
	}

	// Replace vi.fn() with mock()
	converted = converted.replace(/\bvi\.fn\b/g, "mock");
	// Replace vi.spyOn with spyOn
	converted = converted.replace(/\bvi\.spyOn\b/g, "spyOn");
	// Replace vi.restoreAllMocks with mock.restore (approximate)
	converted = converted.replace(/\bvi\.restoreAllMocks\(\)/g, "// mock.restore() — manual cleanup");
	// Replace vi.mock with mock.module
	converted = converted.replace(/\bvi\.mock\b/g, "mock.module");

	// Figure out relative import for the source module
	const dir = path.dirname(sourceFile);
	const basename = path.basename(sourceFile, ".ts");
	const relImport = `./${basename}`;

	// Add a TODO for manual review
	const header = `// Extracted from ${path.basename(sourceFile)} — review imports\n`;

	return `${header}${imports}\n${converted.trim()}\n`;
}

// Main
const files = findInlineTestFiles(path.resolve("packages"));
console.log(`Found ${files.length} files with inline tests\n`);

let extracted = 0;
for (const file of files) {
	const content = fs.readFileSync(file, "utf-8");
	const result = extractTestBlock(content);
	if (!result) {
		console.log(`  SKIP ${file} — could not parse test block`);
		continue;
	}

	const dir = path.dirname(file);
	const basename = path.basename(file, ".ts");
	const testFile = path.join(dir, `${basename}.test.ts`);

	if (fs.existsSync(testFile)) {
		console.log(`  SKIP ${file} — ${basename}.test.ts already exists`);
		continue;
	}

	const testContent = convertTestBlock(result.testBlock, file);

	if (dryRun) {
		console.log(`  WOULD extract ${file} → ${testFile}`);
	} else {
		fs.writeFileSync(testFile, testContent);
		fs.writeFileSync(file, result.source);
		console.log(`  DONE ${file} → ${testFile}`);
		extracted++;
	}
}

console.log(`\n${dryRun ? "Would extract" : "Extracted"} ${extracted} test files`);

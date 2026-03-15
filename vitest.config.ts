import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { defineConfig } from "vitest/config";

function buildAliases(): Record<string, string> {
	const aliases: Record<string, string> = {};
	const root = import.meta.dirname;

	for (const group of ["core", "extensions"]) {
		const groupDir = join(root, "packages", group);
		if (!existsSync(groupDir)) continue;

		for (const name of readdirSync(groupDir)) {
			const pkgJsonPath = join(groupDir, name, "package.json");
			const indexPath = join(groupDir, name, "index.ts");
			if (!existsSync(pkgJsonPath) || !existsSync(indexPath)) continue;

			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
			if (pkg.name) {
				aliases[pkg.name] = resolve(indexPath);
			}
		}
	}

	return aliases;
}

export default defineConfig({
	resolve: {
		alias: buildAliases(),
	},
	test: {
		includeSource: ["packages/**/*.ts"],
	},
	define: {
		"import.meta.vitest": "undefined",
	},
});

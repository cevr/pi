/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * brain principles reader — loads engineering principles from ~/.brain/principles/.
 *
 * pure sync utility. reads all .md files from the principles directory,
 * concatenates them with headers. used by counsel, plan-mode, and review-loop.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PRINCIPLES_DIR = path.join(os.homedir(), ".brain", "principles");

/** Read all .md files from a directory, return concatenated content with filenames as headers. */
export function readPrinciples(principlesDir: string = DEFAULT_PRINCIPLES_DIR): string {
  try {
    const files = fs
      .readdirSync(principlesDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    if (files.length === 0) return "";

    const sections: string[] = [];
    for (const file of files) {
      const filePath = path.join(principlesDir, file);
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        const name = file.replace(/\.md$/, "").replace(/-/g, " ");
        sections.push(`### ${name}\n\n${content}`);
      }
    }
    return sections.length > 0 ? `## Engineering Principles\n\n${sections.join("\n\n")}` : "";
  } catch {
    return "";
  }
}

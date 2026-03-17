/**
 * cheerio-based HTML→markdown. returns null when cheerio isn't
 * resolvable (caller falls back to raw output). optimizes for
 * LLM-readable output over pixel-perfect fidelity.
 */

import { createRequire } from "node:module";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";

let cheerioLoad: ((html: string) => any) | null = null;

try {
  const esmRequire = createRequire(import.meta.url);
  const cheerio = esmRequire("cheerio");
  cheerioLoad = cheerio.load;
} catch {}

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "nav",
  "footer",
  "header",
  "aside",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  ".cookie-banner",
  ".cookie-consent",
  "#cookie-banner",
  "#cookie-consent",
].join(", ");

const MAIN_SELECTORS = [
  "main",
  "article",
  '[role="main"]',
  "#content",
  "#main",
  ".content",
  ".main",
  ".post-content",
  ".article-content",
  ".entry-content",
];

function loadContentRoot(html: string): { $: any; root: any } | null {
  if (!cheerioLoad) return null;
  if (!isHtml(html)) return null;

  const $ = cheerioLoad(html);
  $(REMOVE_SELECTORS).remove();

  let root = null;
  for (const sel of MAIN_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) {
      root = found.first();
      break;
    }
  }
  if (!root) root = $("body");

  return { $, root };
}

export function isHtml(text: string): boolean {
  const trimmed = text.trimStart().slice(0, 200).toLowerCase();
  return (
    trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<?xml")
  );
}

function nodeToMd($: any, node: any): string {
  if (node.type === "text") {
    return (node.data || "").replace(/[ \t]+/g, " ");
  }
  if (node.type !== "tag") return "";

  const tag = node.name?.toLowerCase();
  if (!tag) return "";

  const el = $(node);
  const children = el.contents().toArray();
  const inner = () => children.map((c: any) => nodeToMd($, c)).join("");

  if (/^h[1-6]$/.test(tag)) {
    const level = parseInt(tag[1]);
    const text = inner().trim();
    if (!text) return "";
    return `\n\n${"#".repeat(level)} ${text}\n\n`;
  }

  if (tag === "p") {
    const text = inner().trim();
    return text ? `\n\n${text}\n\n` : "";
  }
  if (tag === "br") return "\n";

  if (tag === "a") {
    const href = el.attr("href");
    const text = inner().trim();
    if (!text) return "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
    return `[${text}](${href})`;
  }

  if (tag === "strong" || tag === "b") {
    const text = inner().trim();
    return text ? `**${text}**` : "";
  }
  if (tag === "em" || tag === "i") {
    const text = inner().trim();
    return text ? `*${text}*` : "";
  }

  if (tag === "code") {
    if (el.parent().is("pre")) return el.text();
    const text = el.text().trim();
    return text ? `\`${text}\`` : "";
  }
  if (tag === "pre") {
    const code = el.find("code");
    const lang = code.attr("class")?.match(/language-(\w+)/)?.[1] || "";
    const text = code.length > 0 ? code.text() : el.text();
    return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
  }

  if (tag === "ul" || tag === "ol") {
    const items = el.children("li").toArray();
    const lines = items.map((li: any, i: number) => {
      const text = nodeToMd($, li).trim();
      const prefix = tag === "ol" ? `${i + 1}. ` : "- ";
      return `${prefix}${text}`;
    });
    return `\n\n${lines.join("\n")}\n\n`;
  }
  if (tag === "li") return inner();

  if (tag === "blockquote") {
    const text = inner().trim();
    return text
      ? `\n\n${text
          .split("\n")
          .map((l: string) => `> ${l}`)
          .join("\n")}\n\n`
      : "";
  }

  if (tag === "img") {
    const alt = el.attr("alt") || "";
    const src = el.attr("src") || "";
    if (!src) return "";
    return `![${alt}](${src})`;
  }

  if (tag === "table") {
    const rows = el.find("tr").toArray();
    if (rows.length === 0) return "";
    const result: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = $(rows[i])
        .find("th, td")
        .toArray()
        .map((c: any) => $(c).text().trim());
      if (cells.length === 0) continue;
      result.push(`| ${cells.join(" | ")} |`);
      if (i === 0) {
        result.push(`| ${cells.map(() => "---").join(" | ")} |`);
      }
    }
    return result.length > 0 ? `\n\n${result.join("\n")}\n\n` : "";
  }

  if (
    [
      "div",
      "section",
      "article",
      "main",
      "figure",
      "figcaption",
      "details",
      "summary",
      "dl",
      "dt",
      "dd",
    ].includes(tag)
  ) {
    return inner();
  }

  if (tag === "hr") return "\n\n---\n\n";

  return inner();
}

function nodeToText($: any, node: any): string {
  if (node.type === "text") {
    return (node.data || "").replace(/[ \t]+/g, " ");
  }
  if (node.type !== "tag") return "";

  const tag = node.name?.toLowerCase();
  if (!tag) return "";

  const el = $(node);
  const children = el.contents().toArray();
  const inner = () => children.map((c: any) => nodeToText($, c)).join("");

  if (/^h[1-6]$/.test(tag) || ["p", "pre", "blockquote"].includes(tag)) {
    const text = inner().trim();
    return text ? `\n\n${text}\n\n` : "";
  }

  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n";

  if (tag === "li") {
    const text = inner().trim();
    return text ? `\n- ${text}` : "";
  }

  if (tag === "ul" || tag === "ol") {
    const text = inner().trim();
    return text ? `\n\n${text}\n\n` : "";
  }

  if (tag === "tr") {
    const cells = el
      .children("th, td")
      .toArray()
      .map((c: any) => $(c).text().trim())
      .filter(Boolean);
    return cells.length > 0 ? `\n${cells.join(" | ")}` : "";
  }

  if (tag === "table") {
    const text = inner().trim();
    return text ? `\n\n${text}\n\n` : "";
  }

  if (tag === "img") {
    return (el.attr("alt") || "").trim();
  }

  if (["div", "section", "article", "main", "figure", "figcaption", "details", "summary"].includes(tag)) {
    const text = inner().trim();
    return text ? `\n\n${text}\n\n` : "";
  }

  return inner();
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function htmlToMarkdown(html: string): string | null {
  const content = loadContentRoot(html);
  if (!content) return null;

  const { $, root } = content;
  const md = root
    .contents()
    .toArray()
    .map((n: any) => nodeToMd($, n))
    .join("");
  return collapseWhitespace(md);
}

export function htmlToText(html: string): string | null {
  const content = loadContentRoot(html);
  if (!content) return null;

  const { $, root } = content;
  const text = root
    .contents()
    .toArray()
    .map((n: any) => nodeToText($, n))
    .join("");
  return collapseWhitespace(text);
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class HtmlToMdError extends Schema.TaggedErrorClass<HtmlToMdError>()("HtmlToMdError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class HtmlToMdService extends ServiceMap.Service<
  HtmlToMdService,
  {
    /** convert HTML to markdown. returns Option.none() when conversion isn't possible. */
    readonly convert: (html: string) => Effect.Effect<Option.Option<string>, HtmlToMdError>;
  }
>()("@cvr/pi-html-to-md/index/HtmlToMdService") {
  static layer = Layer.succeed(HtmlToMdService, {
    convert: (html) =>
      Effect.try({
        try: () => Option.fromNullishOr(htmlToMarkdown(html)),
        catch: (cause) =>
          new HtmlToMdError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
  });

  static layerTest = (result: Option.Option<string>) =>
    Layer.succeed(HtmlToMdService, {
      convert: () => Effect.succeed(result),
    });
}

// inline tests

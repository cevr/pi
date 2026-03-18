/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * skill mentions — `$skill-name` token expansion with picker overlay.
 *
 * type `$` in the editor to open a fuzzy-searchable skill picker.
 * on selection, the skill token is pasted after the `$` already in the editor.
 * on submit, `$skill-name` tokens matching known skills are expanded:
 * SKILL.md content is loaded and injected as hidden context.
 *
 * duplicate names can be qualified with suffixes like `$foo:.claude`.
 * plain `$foo` prefers the global skill when both global and local variants exist.
 *
 * replaces the auto-skills extension (model-pruned hints). the `skill` tool
 * remains registered separately for backward compat / model-initiated loading.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  getDiscoveredSkills,
  renderLoadedSkillContent,
  resolveSkillReference,
  type DiscoveredSkill,
} from "@cvr/pi-skill-paths";
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  fuzzyFilter,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { boxBottom, boxRow, boxTop } from "@cvr/pi-box-chrome";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CUSTOM_TYPE = "skill-mentions:context";
const SKILL_TOKEN_RE =
  /(?<![\\$\w])\$([a-z][a-z0-9-]*)(?::(global|local|\.pi|\.claude|\.agents))?/g;
const SKILL_PREFIX_RE = /(?:^|[\s([{"'])\$([a-z][a-z0-9-]*)?$/;
const MAX_VISIBLE = 12;

export interface SkillMentionPrefix {
  raw: string;
  start: number;
  end: number;
  query: string;
}

export function detectSkillMentionPrefix(
  text: string,
  cursor: number = text.length,
): SkillMentionPrefix | null {
  const head = text.slice(0, cursor);
  const match = head.match(SKILL_PREFIX_RE);
  if (!match) return null;

  const start = head.lastIndexOf("$");
  if (start < 0) return null;

  return {
    raw: head.slice(start, cursor),
    start,
    end: cursor,
    query: match[1] ?? "",
  };
}

function replaceTextRange(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function syncPrefixText(
  text: string,
  prefix: SkillMentionPrefix,
  replacement: string,
): { text: string; prefix: SkillMentionPrefix } {
  const nextText = replaceTextRange(text, prefix.start, prefix.end, replacement);
  return {
    text: nextText,
    prefix: {
      raw: replacement,
      start: prefix.start,
      end: prefix.start + replacement.length,
      query: replacement.startsWith("$") ? replacement.slice(1) : replacement,
    },
  };
}

function shouldTrackEditorInput(data: string): boolean {
  return matchesKey(data, Key.backspace) || (data.length >= 1 && !data.startsWith("\x1b"));
}

function shouldOpenPickerForInput(data: string, prefix: SkillMentionPrefix): boolean {
  if (matchesKey(data, Key.backspace)) return prefix.raw.length > 1;
  if (/^\s+$/.test(data)) return false;
  return prefix.query.length > 0;
}

// ---------------------------------------------------------------------------
// Skill catalog
// ---------------------------------------------------------------------------

function getSkillCatalog(cwd: string): DiscoveredSkill[] {
  return getDiscoveredSkills(cwd).filter((skill) => skill.description.length > 0);
}

// ---------------------------------------------------------------------------
// SKILL.md loading
// ---------------------------------------------------------------------------

function loadSkillContent(skill: DiscoveredSkill): string | null {
  return renderLoadedSkillContent({
    name: skill.name,
    filePath: skill.filePath,
    baseDir: path.dirname(skill.filePath),
  });
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

function parseSkillTokens(text: string): Array<{ reference: string; start: number; end: number }> {
  const tokens: Array<{ reference: string; start: number; end: number }> = [];
  for (const match of text.matchAll(SKILL_TOKEN_RE)) {
    const name = match[1]!;
    const selector = match[2];
    const start = match.index!;
    tokens.push({
      reference: selector ? `${name}:${selector}` : name,
      start,
      end: start + match[0].length,
    });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Skill picker overlay
// ---------------------------------------------------------------------------

interface PickerItem {
  name: string;
  description: string;
  insertText: string;
}

class SkillPicker implements Component, Focusable {
  private searchText = "";
  private filtered: PickerItem[];
  private highlightedIndex = 0;
  private scrollOffset = 0;
  private cachedLines?: string[];
  private cachedWidth?: number;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private items: PickerItem[],
    private theme: import("@mariozechner/pi-coding-agent").Theme,
    private onSelect: (item: PickerItem) => void,
    private onCancel: (deletePrefix?: boolean) => void,
    private onSearchChange: (searchText: string) => void,
    initialSearchText = "",
  ) {
    this.searchText = initialSearchText;
    this.filtered = [...items];
    this.applyFilter();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const item = this.filtered[this.highlightedIndex];
      if (item) this.onSelect(item);
      else this.onCancel();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.highlightedIndex = Math.max(0, this.highlightedIndex - 1);
      this.ensureVisible();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.highlightedIndex = Math.min(this.filtered.length - 1, this.highlightedIndex + 1);
      this.ensureVisible();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.searchText.length > 0) {
        this.searchText = this.searchText.slice(0, -1);
        this.onSearchChange(this.searchText);
        this.applyFilter();
        this.invalidate();
      } else {
        this.onCancel(true);
      }
      return;
    }

    if (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) {
      this.searchText += data;
      this.onSearchChange(this.searchText);
      this.applyFilter();
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const maxW = Math.min(width, 72);
    const innerW = maxW - 2;
    const lines: string[] = [];
    const dim = (s: string) => th.fg("muted", s);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const chrome = { dim };
    const row = (content: string) =>
      boxRow({ variant: "closed", style: chrome, inner: pad(content, innerW) });

    lines.push(
      boxTop({
        variant: "closed",
        style: chrome,
        innerWidth: innerW,
        header: { text: dim("[skills]"), width: visibleWidth("[skills]") },
      }),
    );

    const prompt = dim(" $ ");
    const searchDisplay = th.fg("text", this.searchText);
    const cursor = this._focused ? CURSOR_MARKER + th.fg("accent", "▏") : dim("▏");
    const placeholder = this.searchText.length === 0 ? dim("type to search…") : "";
    lines.push(row(prompt + searchDisplay + cursor + placeholder));
    lines.push(row(""));

    if (this.filtered.length === 0) {
      lines.push(row(dim("  no matches")));
    } else {
      const visibleEnd = Math.min(this.scrollOffset + MAX_VISIBLE, this.filtered.length);

      if (this.scrollOffset > 0) {
        lines.push(row(dim(`  ↑ ${this.scrollOffset} more`)));
      }

      for (let i = this.scrollOffset; i < visibleEnd; i++) {
        const item = this.filtered[i];
        if (!item) continue;
        const isHl = i === this.highlightedIndex;

        const label = isHl ? th.bold(item.name) : th.fg("text", item.name);
        const desc = item.description ? "  " + dim(item.description) : "";
        let line = ` ${label}${desc}`;
        line = truncateToWidth(line, innerW);
        if (isHl) line = th.bg("selectedBg", pad(line, innerW));
        lines.push(
          boxRow({ variant: "closed", style: chrome, inner: isHl ? line : pad(line, innerW) }),
        );
      }

      const remaining = this.filtered.length - visibleEnd;
      if (remaining > 0) lines.push(row(dim(`  ↓ ${remaining} more`)));
    }

    const footerStr = dim("↑↓ navigate • enter select • esc close");
    lines.push(
      boxBottom({
        variant: "closed",
        style: chrome,
        innerWidth: innerW,
        footer: { text: footerStr, width: visibleWidth(footerStr) },
      }),
    );

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  private applyFilter(): void {
    if (this.searchText === "") {
      this.filtered = [...this.items];
    } else {
      this.filtered = fuzzyFilter(
        this.items,
        this.searchText,
        (item) => `${item.name} ${item.description}`,
      );
    }
    this.highlightedIndex = 0;
    this.scrollOffset = 0;
  }

  private ensureVisible(): void {
    if (this.highlightedIndex < this.scrollOffset) {
      this.scrollOffset = this.highlightedIndex;
    } else if (this.highlightedIndex >= this.scrollOffset + MAX_VISIBLE) {
      this.scrollOffset = this.highlightedIndex - MAX_VISIBLE + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export interface SkillMentionsDeps {
  getSkillCatalog: (cwd: string) => DiscoveredSkill[];
  loadSkillContent: (skill: DiscoveredSkill) => string | null;
  resolveSkillReference: typeof resolveSkillReference;
}

export const DEFAULT_DEPS: SkillMentionsDeps = {
  getSkillCatalog,
  loadSkillContent,
  resolveSkillReference,
};

export function createSkillMentionsExtension(deps: SkillMentionsDeps = DEFAULT_DEPS) {
  return function skillMentionsExtension(pi: ExtensionAPI): void {
    let catalog: DiscoveredSkill[] = [];
    let activeSkillContext = "";
    let inputUnsub: (() => void) | null = null;
    let pickerOpen = false;
    let currentCwd = process.cwd();

    function rebuildCatalog(cwd: string) {
      currentCwd = cwd;
      catalog = deps.getSkillCatalog(cwd);
    }

    function clearActive() {
      activeSkillContext = "";
    }

    async function openPicker(
      ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
      initialPrefix: SkillMentionPrefix,
    ) {
      if (!ctx.hasUI || pickerOpen || catalog.length === 0) return;
      pickerOpen = true;

      const items: PickerItem[] = catalog.map((skill) => ({
        name: skill.displayName,
        description: skill.description,
        insertText: skill.token,
      }));
      let livePrefix = initialPrefix;

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const picker = new SkillPicker(
            items,
            theme,
            (item) => {
              const text = ctx.ui.getEditorText();
              const synced = syncPrefixText(text, livePrefix, `$${item.insertText} `);
              livePrefix = synced.prefix;
              ctx.ui.setEditorText(synced.text);
              done();
            },
            (deletePrefix) => {
              if (deletePrefix) {
                const text = ctx.ui.getEditorText();
                const synced = syncPrefixText(text, livePrefix, "");
                livePrefix = synced.prefix;
                ctx.ui.setEditorText(synced.text);
              }
              done();
            },
            (searchText) => {
              const text = ctx.ui.getEditorText();
              const synced = syncPrefixText(text, livePrefix, `$${searchText}`);
              livePrefix = synced.prefix;
              ctx.ui.setEditorText(synced.text);
            },
            initialPrefix.query,
          );
          return {
            render: (w: number) => picker.render(w),
            handleInput: (data: string) => {
              picker.handleInput(data);
              tui.requestRender();
            },
            invalidate: () => picker.invalidate(),
            get focused() {
              return picker.focused;
            },
            set focused(v: boolean) {
              picker.focused = v;
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-center",
            width: 72,
            minWidth: 40,
            maxHeight: "60%",
            offsetY: 2,
          },
        },
      );

      pickerOpen = false;
    }

    pi.on("session_start", async (_event, ctx) => {
      rebuildCatalog(ctx.cwd);
      clearActive();

      if (!ctx.hasUI) return;

      inputUnsub?.();
      inputUnsub = ctx.ui.onTerminalInput((data) => {
        if (!shouldTrackEditorInput(data)) return undefined;

        const prefix = detectSkillMentionPrefix(ctx.ui.getEditorText());
        if (!prefix || !shouldOpenPickerForInput(data, prefix)) return undefined;

        void openPicker(ctx, prefix);
        return undefined;
      });
    });

    pi.on("session_switch", async (_event, ctx) => {
      rebuildCatalog(ctx.cwd);
      clearActive();
    });

    pi.on("input", async (event) => {
      if (event.source === "extension") return { action: "continue" as const };

      const tokens = parseSkillTokens(event.text);
      if (tokens.length === 0) {
        clearActive();
        return { action: "continue" as const };
      }

      const seen = new Set<string>();
      const loaded: string[] = [];
      for (const token of tokens) {
        const { skill } = deps.resolveSkillReference(token.reference, currentCwd);
        if (!skill) continue;
        if (seen.has(skill.filePath)) continue;
        seen.add(skill.filePath);
        const content = deps.loadSkillContent(skill);
        if (content) loaded.push(content);
      }

      activeSkillContext = loaded.join("\n\n");
      return { action: "continue" as const };
    });

    pi.on("context", async (event) => {
      const messages = event.messages.filter((m: any) => m.customType !== CUSTOM_TYPE);

      if (!activeSkillContext) return { messages };

      return {
        messages: [
          ...messages,
          {
            role: "custom",
            customType: CUSTOM_TYPE,
            content: activeSkillContext,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });

    pi.on("agent_end", async () => {
      clearActive();
    });

    pi.on("session_shutdown", async () => {
      inputUnsub?.();
      inputUnsub = null;
    });
  };
}

export default createSkillMentionsExtension();

/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * skill mentions — `$skill-name` token expansion with picker overlay.
 *
 * type `$` in the editor to open a fuzzy-searchable skill picker.
 * on selection, the skill name is pasted after the `$` already in the editor.
 * on submit, `$skill-name` tokens matching known skills are expanded:
 * SKILL.md content is loaded and injected as hidden context.
 *
 * replaces the auto-skills extension (haiku-pruned hints). the `skill` tool
 * remains registered separately for backward compat / model-initiated loading.
 */

import * as path from "node:path";
import type { ExtensionAPI, Skill } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import { getSkillPathsFromSettings, renderLoadedSkillContent } from "@cvr/pi-skill-paths";
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
const SKILL_TOKEN_RE = /(?<![\\$\w])\$([a-z][a-z0-9-]*)/g;
const MAX_VISIBLE = 12;

// ---------------------------------------------------------------------------
// Skill catalog
// ---------------------------------------------------------------------------

function getSkillCatalog(cwd: string): Skill[] {
  const skillPaths = getSkillPathsFromSettings();
  const { skills } = loadSkills({ cwd, skillPaths, includeDefaults: true });
  return skills.filter((s) => s.description.length > 0);
}

// ---------------------------------------------------------------------------
// SKILL.md loading
// ---------------------------------------------------------------------------

function loadSkillContent(skill: Skill): string | null {
  return renderLoadedSkillContent({
    name: skill.name,
    filePath: skill.filePath,
    baseDir: path.dirname(skill.filePath),
  });
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

function parseSkillTokens(
  text: string,
  catalogNames: Set<string>,
): Array<{ name: string; start: number; end: number }> {
  const tokens: Array<{ name: string; start: number; end: number }> = [];
  for (const match of text.matchAll(SKILL_TOKEN_RE)) {
    const name = match[1]!;
    if (!catalogNames.has(name)) continue;
    const start = match.index!;
    tokens.push({ name, start, end: start + match[0].length });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Skill picker overlay
// ---------------------------------------------------------------------------

interface PickerItem {
  name: string;
  description: string;
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
  ) {
    this.filtered = [...items];
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
        this.applyFilter();
        this.invalidate();
      } else {
        // empty search + backspace → close picker and delete the $ in editor
        this.onCancel(true);
      }
      return;
    }

    if (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) {
      this.searchText += data;
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
    const dim = (s: string) => th.fg("dim", s);
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

    // search input
    const prompt = dim(" $ ");
    const searchDisplay = th.fg("text", this.searchText);
    const cursor = this._focused ? CURSOR_MARKER + th.fg("accent", "▏") : dim("▏");
    const placeholder = this.searchText.length === 0 ? dim("type to search…") : "";
    lines.push(row(prompt + searchDisplay + cursor + placeholder));
    lines.push(row(""));

    // items
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

export default function skillMentionsExtension(pi: ExtensionAPI): void {
  let catalog: Skill[] = [];
  let catalogNames = new Set<string>();
  let activeSkillContext = "";
  let inputUnsub: (() => void) | null = null;
  let pickerOpen = false;

  function rebuildCatalog(cwd: string) {
    catalog = getSkillCatalog(cwd);
    catalogNames = new Set(catalog.map((s) => s.name));
  }

  function clearActive() {
    activeSkillContext = "";
  }

  async function openPicker(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext) {
    if (!ctx.hasUI || pickerOpen || catalog.length === 0) return;
    pickerOpen = true;

    const items: PickerItem[] = catalog.map((s) => ({
      name: s.name,
      description: s.description,
    }));

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const picker = new SkillPicker(
          items,
          theme,
          (item) => {
            ctx.ui.pasteToEditor(item.name + " ");
            done();
          },
          (deletePrefix) => {
            if (deletePrefix) {
              // remove the $ that was typed into the editor
              const text = ctx.ui.getEditorText();
              if (text.endsWith("$")) {
                ctx.ui.setEditorText(text.slice(0, -1));
              }
            }
            done();
          },
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
      if (data !== "$") return undefined;

      // let $ land in editor (do NOT consume), open picker opportunistically
      const text = ctx.ui.getEditorText();
      if (text.length === 0 || /\s$/.test(text)) {
        void openPicker(ctx);
      }
      return undefined;
    });
  });

  pi.on("session_switch", async (_event, ctx) => {
    rebuildCatalog(ctx.cwd);
    clearActive();
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };

    const tokens = parseSkillTokens(event.text, catalogNames);
    if (tokens.length === 0) {
      clearActive();
      return { action: "continue" as const };
    }

    // dedupe by name
    const seen = new Set<string>();
    const loaded: string[] = [];
    for (const token of tokens) {
      if (seen.has(token.name)) continue;
      seen.add(token.name);
      const skill = catalog.find((s) => s.name === token.name);
      if (!skill) continue;
      const content = loadSkillContent(skill);
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
}

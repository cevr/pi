/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

/** Destructive commands blocked in plan mode. */
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bbun\s+(add|remove|install|link|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

/** Safe read-only commands allowed in plan mode. */
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*eza\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*bun\s+(pm\s+ls|run\s+--list)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*bun\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*exa\b/,
  /^\s*repo\s+(path|list|fetch)\b/i,
  /^\s*ast-grep\b/i,
];

/**
 * Check whether a bash command is safe for plan mode.
 * Must not match any destructive pattern AND must match at least one safe pattern.
 */
export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

/** Clean a plan step's text for display in the todo widget. */
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/^\[(?: |x|X)\]\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }
  return cleaned;
}

function appendTodoItem(items: TodoItem[], rawText: string): void {
  const text = rawText.trim();
  if (text.length <= 5 || text.startsWith("`") || text.startsWith("/") || text.startsWith("-")) {
    return;
  }

  const cleaned = cleanStepText(text);
  if (cleaned.length > 3) {
    items.push({ step: items.length + 1, text: cleaned, completed: false });
  }
}

/**
 * Extract plan steps from an assistant message.
 * Looks for a plan heading and parses numbered lists, bullets, or checklists below it.
 */
function isPlanHeader(line: string): boolean {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*{1,2}/, "")
    .replace(/\*{1,2}$/, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();

  return (
    normalized === "plan" || normalized === "implementation plan" || normalized === "proposed plan"
  );
}

function parsePlanListLine(line: string): { indent: number; text: string } | null {
  const match = line.match(/^([ \t]*)(?:(?:\d+[.)])|[-*+])\s+(?:\[(?: |x|X)\]\s+)?(.+?)\s*$/);
  if (!match?.[2]) return null;
  return {
    indent: match[1]?.length ?? 0,
    text: match[2].trim(),
  };
}

export function extractTodoItems(message: string): TodoItem[] {
  const lines = message.split(/\r?\n/);
  const headerIndex = lines.findIndex(isPlanHeader);
  if (headerIndex === -1) return [];

  const items: TodoItem[] = [];
  let currentLines: string[] = [];
  let listIndent: number | null = null;

  const flushCurrentItem = () => {
    if (currentLines.length === 0) return;
    appendTodoItem(items, currentLines.join(" "));
    currentLines = [];
  };

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if ((items.length > 0 || currentLines.length > 0) && /^\s*#{1,6}\s+/.test(line)) {
      flushCurrentItem();
      break;
    }

    const parsed = parsePlanListLine(line);
    if (parsed) {
      if (listIndent === null) listIndent = parsed.indent;

      if (parsed.indent === listIndent) {
        flushCurrentItem();
        currentLines = [parsed.text];
        continue;
      }

      if (currentLines.length > 0 && listIndent !== null && parsed.indent > listIndent) {
        continue;
      }
    }

    if (currentLines.length > 0 && listIndent !== null) {
      const indent = line.length - line.trimStart().length;
      if (indent > listIndent) {
        currentLines.push(trimmed);
        continue;
      }

      flushCurrentItem();
      break;
    }
  }

  flushCurrentItem();
  return items;
}

/** Extract [DONE:n] step numbers from text. */
export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/** Mark todo items as completed based on [DONE:n] markers in text. Returns count marked. */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}

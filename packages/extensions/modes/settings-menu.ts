/**
 * settings-menu.ts — Settings panel for /todos → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions.
 */

// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as fs from "node:fs";
// @effect-diagnostics-next-line effect/nodeBuiltinImport:off
import * as path from "node:path";
import { SettingsList, Container, Text, Spacer, type SettingItem } from "@mariozechner/pi-tui";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import type { TaskListScope } from "@cvr/pi-task-list-store";

// ---------------------------------------------------------------------------
// Config persistence — <cwd>/.pi/modes-config.json
// ---------------------------------------------------------------------------

export interface ModesConfig {
  taskListScope?: TaskListScope;
}

function getConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "modes-config.json");
}

export function loadModesConfig(cwd: string): ModesConfig {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(cwd), "utf-8"));
  } catch {
    return {};
  }
}

export function saveModesConfig(cwd: string, config: ModesConfig): void {
  const configPath = getConfigPath(cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

export async function openSettingsMenu(
  ui: SettingsUI,
  cwd: string,
  currentScope: TaskListScope,
  onScopeChange: (scope: TaskListScope) => void,
  onBack: () => Promise<void>,
): Promise<void> {
  const config = loadModesConfig(cwd);

  await ui.custom((_tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      {
        id: "taskListScope",
        label: "Task storage",
        description:
          "memory: tasks live only in memory, lost when session ends. " +
          "session: persisted per session, survives resume. " +
          "project: shared across all sessions in the project. " +
          "Takes effect on next session start.",
        currentValue: currentScope,
        values: ["memory", "session", "project"],
      },
    ];

    const list = new SettingsList(
      items,
      /* maxVisible */ 10,
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "taskListScope") {
          const scope = newValue as TaskListScope;
          config.taskListScope = scope;
          saveModesConfig(cwd, config);
          onScopeChange(scope);
        }
      },
      /* onCancel */ () => done(undefined),
    );

    // Container doesn't forward handleInput to children — subclass to fix.
    class SettingsPanel extends Container {
      handleInput(data: string) {
        list.handleInput(data);
      }
    }

    const root = new SettingsPanel();
    root.addChild(new Text(theme.bold(theme.fg("accent", "⚙  Task Settings")), 0, 0));
    root.addChild(new Spacer(1));
    root.addChild(list);

    return root;
  });

  return onBack();
}

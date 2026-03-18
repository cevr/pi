/** @effect-diagnostics effect/nodeBuiltinImport:skip-file */
/**
 * skill tool — load a skill by name, returning its content for
 * injection into the conversation context.
 *
 * replaces pi's default approach (model uses `read` on the SKILL.md
 * path) with a dedicated tool. the model calls `skill(name: "git")`
 * instead of `read(path: "/.../SKILL.md")`.
 *
 * discovery searches skill directories configured in pi's settings,
 * the default agentDir/skills/, and project-local .pi/.claude/.agents
 * skill directories. duplicate local skills can be selected with
 * qualified names like `foo:.claude`; plain `foo` prefers global.
 */

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { boxRendererWindowed, textSection, type Excerpt } from "@cvr/pi-box-format";
import {
  listAvailableSkillNames,
  renderLoadedSkillContent,
  resolveSkillReference,
} from "@cvr/pi-skill-paths";

const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

interface SkillParams {
  name: string;
  arguments?: string;
}

export function createSkillTool(): ToolDefinition {
  return {
    name: "skill",
    label: "Load Skill",
    description:
      "Load a specialized skill that provides domain-specific instructions and workflows.\n\n" +
      "When you recognize that a task matches one of the available skills, use this tool " +
      "to load the full skill instructions.\n\n" +
      "Duplicate local variants can be selected with qualified names like " +
      "`foo:.pi`, `foo:.claude`, or `foo:.agents`. Plain `foo` prefers global.\n\n" +
      "The skill will inject detailed instructions, workflows, and access to bundled " +
      "resources (scripts, references, templates) into the conversation context.",

    parameters: Type.Object({
      name: Type.String({
        description:
          "The skill reference to load. Use plain names like 'react' or qualified names like " +
          "'foo:.claude', 'foo:.agents', 'foo:.pi', 'foo:local', or 'foo:global'.",
      }),
      arguments: Type.Optional(
        Type.String({
          description: "Optional arguments to pass to the skill.",
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const name = args.name || "...";
      return new Text(
        theme.fg("muted", "using ") +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("muted", " skill"),
        0,
        0,
      );
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as SkillParams;
      const resolved = resolveSkillReference(p.name, ctx.cwd);
      const skill = resolved.skill;

      if (!skill) {
        const available = listAvailableSkillNames(ctx.cwd);
        const list = available.length > 0 ? `\n\navailable skills: ${available.join(", ")}` : "";
        const message = resolved.error ?? `skill "${p.name}" not found.`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${message}${list}`,
            },
          ],
          isError: true,
        } as any;
      }

      const rendered = renderLoadedSkillContent(skill);
      if (!rendered) {
        return {
          content: [
            {
              type: "text" as const,
              text: `failed to read skill file: ${skill.filePath}`,
            },
          ],
          isError: true,
        } as any;
      }

      return {
        content: [{ type: "text" as const, text: rendered }],
        details: { header: skill.token },
      } as any;
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any) {
      const content = result.content?.[0];
      if (!content || content.type !== "text") return new Text("(no output)", 0, 0);
      if (content.text.startsWith("<loaded_skill")) {
        return boxRendererWindowed(
          () => [textSection(undefined, "skill loaded", true)],
          { collapsed: {}, expanded: {} },
          undefined,
          expanded,
        );
      }
      return boxRendererWindowed(
        () => [textSection(undefined, content.text)],
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool(withPromptPatch(createSkillTool()));
}

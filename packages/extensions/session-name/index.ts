/**
 * auto session naming — generates a short title from conversation context.
 *
 * fires on the `input` event so the name appears while the agent is still
 * thinking. names the session on the first message, then re-evaluates
 * every `renameInterval` messages (default 10) as the conversation topic
 * may drift. uses gemini flash for speed/cost.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piAi from "@mariozechner/pi-ai";
import type { Api, Model, Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@cvr/pi-config";

type SessionNameExtConfig = {
  model: { provider: string; id: string };
  renameInterval: number;
};

export const CONFIG_DEFAULTS: SessionNameExtConfig = {
  model: {
    provider: "openrouter",
    id: "google/gemini-3-flash-preview",
  },
  renameInterval: 10,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionNameConfig(
  value: Record<string, unknown>,
): value is SessionNameExtConfig {
  const renameInterval = value.renameInterval;
  if (
    typeof renameInterval !== "number" ||
    !Number.isInteger(renameInterval) ||
    renameInterval < 1
  ) {
    return false;
  }

  if (!isPlainObject(value.model)) {
    return false;
  }

  return (
    typeof value.model.provider === "string" &&
    value.model.provider.trim().length > 0 &&
    typeof value.model.id === "string" &&
    value.model.id.trim().length > 0
  );
}

export const SESSION_NAME_CONFIG_SCHEMA: ExtensionConfigSchema<SessionNameExtConfig> =
  {
    validate: isSessionNameConfig,
  };

export function sessionNameExtension(pi: ExtensionAPI): void {
  const { enabled, config: cfg } = getEnabledExtensionConfig(
    "@cvr/pi-session-name",
    CONFIG_DEFAULTS,
    { schema: SESSION_NAME_CONFIG_SCHEMA },
  );
  if (!enabled) return;

  let messageCount = 0;
  let pending = false;

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    if (text.startsWith("/") || text.length < 10) return;

    messageCount++;

    const isFirst = messageCount === 1;
    const isInterval =
      messageCount > 1 && (messageCount - 1) % cfg.renameInterval === 0;
    if (!isFirst && !isInterval) return;
    if (pending) return;

    const model =
      ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) ?? ctx.model;
    if (!model) return;

    pending = true;

    const currentName = pi.getSessionName() || undefined;

    generateName(model, ctx.modelRegistry, text, currentName, isFirst)
      .then((name) => {
        if (name) pi.setSessionName(name);
      })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  });

  pi.on("session_switch", async () => {
    messageCount = 0;
    pending = false;
  });
}

export default sessionNameExtension;

async function generateName(
  model: Model<Api>,
  registry: { getApiKey(model: Model<Api>): Promise<string | undefined> },
  userMessage: string,
  currentName: string | undefined,
  isFirst: boolean,
): Promise<string | null> {
  const apiKey = await registry.getApiKey(model);
  if (!apiKey) return null;

  const prompt = isFirst
    ? `Generate a 3-5 word title for a coding session that starts with this message. Return ONLY the title, no quotes, no punctuation, no explanation. Lowercase.\n\n${userMessage.slice(0, 500)}`
    : `The current session title is "${currentName}". Based on this latest message, decide if the title still fits. If the topic has shifted, generate a new 3-5 word title. If it still fits, return the EXACT current title. Return ONLY the title, no quotes, no punctuation, no explanation. Lowercase.\n\n${userMessage.slice(0, 500)}`;

  const message: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const response = await piAi.complete(
    model,
    { messages: [message] },
    { apiKey, maxTokens: 20 },
  );
  if (response.stopReason === "aborted") return null;

  const title = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  return title || null;
}

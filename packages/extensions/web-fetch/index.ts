import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { boxRendererWindowed, osc8Link, type BoxSection, type Excerpt } from "@cvr/pi-box-format";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import {
  CONFIG_DEFAULTS,
  type FetchFormat,
  type WebFetchCoreConfig,
  type WebFetchRequest,
  WebFetchService,
} from "@cvr/pi-web-fetch-core";
import { Type } from "@sinclair/typebox";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

export { CONFIG_DEFAULTS };

export type WebFetchExtConfig = WebFetchCoreConfig;

type WebFetchExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

interface WebFetchParams {
  url: string;
  format?: FetchFormat;
  timeout_secs?: number;
}

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 12 }];

export const DEFAULT_DEPS: WebFetchExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isWebFetchConfig(value: Record<string, unknown>): value is WebFetchExtConfig {
  return (
    isPositiveInteger(value.defaultTimeoutSecs) &&
    isPositiveInteger(value.maxTimeoutSecs) &&
    isPositiveInteger(value.maxResponseBytes) &&
    value.maxTimeoutSecs >= value.defaultTimeoutSecs
  );
}

function clampTimeoutSecs(timeoutSecs: number | undefined, config: WebFetchExtConfig): number {
  const requested =
    typeof timeoutSecs === "number" && Number.isFinite(timeoutSecs)
      ? timeoutSecs
      : config.defaultTimeoutSecs;
  return Math.max(1, Math.min(requested, config.maxTimeoutSecs));
}

function textToSection(title: string, text: string): BoxSection {
  return {
    header: title,
    blocks: [{ lines: text.split("\n").map((line) => ({ text: line, highlight: false })) }],
  };
}

export const WEB_FETCH_CONFIG_SCHEMA: ExtensionConfigSchema<WebFetchExtConfig> = {
  validate: isWebFetchConfig,
};

export function createWebFetchTool(
  config: WebFetchExtConfig = CONFIG_DEFAULTS,
  runtime?: ManagedRuntime.ManagedRuntime<WebFetchService | HttpClient.HttpClient, never>,
): ToolDefinition {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page or text resource from a URL. Use it when you already know the page you want and need the full content, not just search results.\n\n" +
      "- Supports `markdown`, `text`, and `html` output formats.\n" +
      `- Optional \`timeout_secs\` is capped at ${config.maxTimeoutSecs} seconds.\n` +
      `- Refuses responses larger than ${Math.floor(config.maxResponseBytes / (1024 * 1024))}MB.\n` +
      "- Returns images directly when the URL points to an image.\n" +
      "- Use `web_search` first when you need discovery; use `web_fetch` when you already have the URL.\n\n" +
      "# Examples\n\n" +
      '```json\n{"url":"https://bun.sh/docs/runtime/http","format":"markdown"}\n```\n\n' +
      '```json\n{"url":"https://example.com/robots.txt","format":"text","timeout_secs":10}\n```',

    parameters: Type.Object({
      url: Type.String({
        description: "The fully-qualified http:// or https:// URL to fetch.",
      }),
      format: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
          description: "The response format to return. Defaults to markdown.",
        }),
      ),
      timeout_secs: Type.Optional(
        Type.Number({
          description: `Optional timeout in seconds. Values above ${config.maxTimeoutSecs} are clamped.`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      if (!runtime) {
        return {
          content: [{ type: "text" as const, text: "web fetch runtime not available" }],
          isError: true,
        } as any;
      }

      const request: WebFetchRequest = {
        url: (params as WebFetchParams).url,
        format: (params as WebFetchParams).format ?? "markdown",
        timeoutSecs: clampTimeoutSecs((params as WebFetchParams).timeout_secs, config),
      };

      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* WebFetchService;
          return yield* service.fetch(request).pipe(Effect.result);
        }),
        { signal },
      );

      if (result._tag === "Failure") {
        return {
          content: [{ type: "text" as const, text: result.failure.message }],
          isError: true,
        } as any;
      }

      if (result.success._tag === "Image") {
        return {
          content: [
            {
              type: "image" as const,
              data: result.success.data,
              mimeType: result.success.mimeType,
            },
          ],
          details: {
            title: result.success.title,
            url: result.success.url,
            mimeType: result.success.mimeType,
          },
        } as any;
      }

      return {
        content: [{ type: "text" as const, text: result.success.text }],
        details: {
          title: result.success.title,
          url: result.success.url,
          mimeType: result.success.mimeType,
          format: result.success.format,
        },
      } as any;
    },

    renderCall(args: any, theme: any) {
      const url = args.url || "...";
      const short = url.length > 80 ? `${url.slice(0, 80)}...` : url;
      const linked = /^https?:\/\//.test(url) ? osc8Link(url, short) : short;
      const format = args.format ? theme.fg("muted", ` [${args.format}]`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("muted", linked) + format,
        0,
        0,
      );
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any) {
      const first = result.content?.[0];
      const title = result.details?.title ?? "web fetch";

      if (first?.type === "image") {
        const mimeType = result.details?.mimeType ?? "image";
        return new Text(`[image] ${mimeType}`, 0, 0);
      }

      const text = first?.type === "text" ? first.text : "(no output)";
      return boxRendererWindowed(
        () => [textToSection(title, text)],
        {
          collapsed: { maxSections: 1, excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },
  };
}

export function createWebFetchExtension(
  deps: WebFetchExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function webFetchExtension(pi: ExtensionAPI): void {
    const { enabled, config } = deps.getEnabledExtensionConfig(
      "@cvr/pi-web-fetch",
      CONFIG_DEFAULTS,
      { schema: WEB_FETCH_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const runtime = ManagedRuntime.make(
      Layer.mergeAll(WebFetchService.layer(config), FetchHttpClient.layer),
    );
    pi.registerTool(deps.withPromptPatch(createWebFetchTool(config, runtime)));
    pi.on("session_shutdown", async () => {
      await runtime.dispose();
    });
  };
}

const webFetchExtension: (pi: ExtensionAPI) => void = createWebFetchExtension();

export default webFetchExtension;

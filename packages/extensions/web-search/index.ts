/**
 * web_search tool — direct HTTP call to Parallel AI's Search API.
 *
 * uses curl (not fetch/SDK) because the extension already shells out,
 * curl is available, and the single-endpoint usage doesn't justify a
 * heavier client dependency.
 *
 * cost is derived from the response's usage array, not hardcoded —
 * the API returns UsageItem[] with SKU counts, we multiply by known
 * unit prices. if the API omits usage, we fall back to base search cost.
 *
 * refs:
 *   schema: https://docs.parallel.ai/public-openapi.json (UsageItem)
 *   pricing: https://docs.parallel.ai/pricing (Search API section)
 */

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { boxRendererWindowed, osc8Link, type BoxSection, type Excerpt } from "@cvr/pi-box-format";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "@cvr/pi-config";
import { ProcessRunner } from "@cvr/pi-process-runner";
import { withPromptPatch } from "@cvr/pi-prompt-patch";
import { layerRepoEnv } from "@cvr/pi-repo-env";
import { Type } from "@sinclair/typebox";
import type { ToolCostDetails } from "@cvr/pi-tool-cost";
import { Config, Effect, Layer, ManagedRuntime, Redacted, ServiceMap } from "effect";
import type { BadArgument, PlatformError } from "effect/PlatformError";

type WebSearchRuntimeError = Config.ConfigError | BadArgument | PlatformError;
type WebSearchRuntime = ManagedRuntime.ManagedRuntime<ProcessRunner | WebSearchSecrets, WebSearchRuntimeError>;
type SearchParallelRuntime =
  | ManagedRuntime.ManagedRuntime<ProcessRunner, never>
  | WebSearchRuntime;

type WebSearchExtConfig = {
  defaultMaxResults: number;
  endpoint: string;
  curlTimeoutSecs: number;
};

type WebSearchExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

export const CONFIG_DEFAULTS: WebSearchExtConfig = {
  defaultMaxResults: 10,
  endpoint: "https://api.parallel.ai/v1beta/search",
  curlTimeoutSecs: 30,
};

export const DEFAULT_DEPS: WebSearchExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

const MISSING_API_KEY_MESSAGE = "PARALLEL_API_KEY not set. add it to your environment or the repo .env file.";

export class WebSearchSecrets extends ServiceMap.Service<
  WebSearchSecrets,
  {
    readonly parallelApiKey: Redacted.Redacted<string>;
  }
>()("@cvr/pi-web-search/index/WebSearchSecrets") {
  static layer = Layer.effect(
    WebSearchSecrets,
    Effect.gen(function* () {
      return {
        parallelApiKey: yield* Config.redacted("PARALLEL_API_KEY"),
      };
    }),
  );

  static layerTest = (parallelApiKey: string) =>
    Layer.succeed(WebSearchSecrets, {
      parallelApiKey: Redacted.make(parallelApiKey),
    });
}

function configErrorToMessage(error: Config.ConfigError): string {
  return error.message.includes('["PARALLEL_API_KEY"]')
    ? MISSING_API_KEY_MESSAGE
    : `failed to load PARALLEL_API_KEY: ${error.message}`;
}

type ResolveParallelApiKeyResult =
  | { readonly _tag: "Success"; readonly apiKey: string }
  | { readonly _tag: "Failure"; readonly message: string };

async function resolveParallelApiKey(
  runtime: WebSearchRuntime,
  signal?: AbortSignal,
): Promise<ResolveParallelApiKeyResult> {
  try {
    const apiKey = await runtime.runPromise(
      Effect.gen(function* () {
        const { parallelApiKey } = yield* WebSearchSecrets;
        return Redacted.value(parallelApiKey);
      }),
      { signal },
    );

    return {
      _tag: "Success",
      apiKey,
    };
  } catch (error) {
    return {
      _tag: "Failure",
      message:
        error instanceof Config.ConfigError
          ? configErrorToMessage(error)
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

function isWebSearchConfig(value: Record<string, unknown>): value is WebSearchExtConfig {
  return (
    typeof value.defaultMaxResults === "number" &&
    Number.isInteger(value.defaultMaxResults) &&
    value.defaultMaxResults >= 1 &&
    typeof value.endpoint === "string" &&
    value.endpoint.trim().length > 0 &&
    typeof value.curlTimeoutSecs === "number" &&
    Number.isInteger(value.curlTimeoutSecs) &&
    value.curlTimeoutSecs >= 1
  );
}

export const WEB_SEARCH_CONFIG_SCHEMA: ExtensionConfigSchema<WebSearchExtConfig> = {
  validate: isWebSearchConfig,
};

/** per-result excerpts for collapsed display — first 5 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

interface SearchResult {
  url: string;
  title: string;
  publish_date?: string;
  excerpts: string[];
}

/**
 * usage line item from the API response.
 * schema: https://docs.parallel.ai/public-openapi.json → UsageItem
 */
interface UsageItem {
  name: string;
  count: number;
}

/** per-unit pricing by SKU name ($/unit). ref: https://docs.parallel.ai/pricing */
const SKU_UNIT_COST: Record<string, number> = {
  sku_search: 0.005,
  sku_search_additional_results: 0.001,
};

/** falls back to base search cost when API omits usage (e.g., older API versions). */
function costFromUsage(usage: UsageItem[] | undefined): number {
  if (!usage?.length) return SKU_UNIT_COST.sku_search ?? 0;
  let total = 0;
  for (const item of usage) {
    total += (SKU_UNIT_COST[item.name] ?? 0) * item.count;
  }
  return total;
}

interface SearchResponse {
  search_id?: string;
  results: SearchResult[];
  warnings?: string[];
  usage?: UsageItem[];
}

export async function searchParallel(
  apiKey: string,
  body: Record<string, unknown>,
  endpoint: string,
  curlTimeoutSecs: number,
  signal?: AbortSignal,
  runtime?: SearchParallelRuntime,
): Promise<{ data?: SearchResponse; error?: string }> {
  const payload = JSON.stringify(body);

  const args = [
    "-sL",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "-H",
    `x-api-key: ${apiKey}`,
    "-H",
    "parallel-beta: search-extract-2025-10-10",
    "-m",
    String(curlTimeoutSecs),
    "-d",
    payload,
    endpoint,
  ];

  if (!runtime) {
    return { error: "ProcessRunner runtime not available" };
  }

  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run("curl", { args, signal });
      }),
    );

    if (result.exitCode !== 0) {
      return {
        error: `search failed: ${result.stderr.trim() || `curl exited with code ${result.exitCode}`}`,
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as SearchResponse;
      return { data: parsed };
    } catch {
      return {
        error: `invalid response from Parallel API: ${result.stdout.slice(0, 200)}`,
      };
    }
  } catch (err) {
    if (err && typeof err === "object" && "_tag" in err && (err as any)._tag === "CommandAborted") {
      return { error: "search aborted" };
    }
    return { error: `curl error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function formatResults(results: SearchResult[]): {
  text: string;
  headerLineIndices: number[];
} {
  if (results.length === 0) return { text: "(no results found)", headerLineIndices: [] };

  const lines: string[] = [];
  const headerLineIndices: number[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    headerLineIndices.push(lines.length);
    lines.push(`### ${r.title || "(untitled)"}`);
    lines.push(r.url!);
    if (r.publish_date) lines.push(`*${r.publish_date}*`);
    if (r.excerpts?.length) {
      lines.push("");
      for (let j = 0; j < r.excerpts.length; j++) {
        const excerptLines = r.excerpts[j]!.split("\n");
        lines.push(...excerptLines);
        if (j < r.excerpts.length - 1) lines.push("");
      }
    }

    if (i < results.length - 1) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return { text: lines.join("\n"), headerLineIndices };
}

/** convert raw SearchResult[] into BoxSection[] for box-format rendering. */
function resultsToSections(results: SearchResult[]): BoxSection[] {
  return results.map((r) => {
    const lines = [];
    lines.push({ text: osc8Link(r.url, r.url), highlight: true });
    if (r.publish_date) lines.push({ text: r.publish_date, highlight: true });
    if (r.excerpts?.length) {
      lines.push({ text: "", highlight: false });
      for (let j = 0; j < r.excerpts.length; j++) {
        for (const l of r.excerpts[j]!.split("\n")) {
          lines.push({ text: l, highlight: false });
        }
        if (j < r.excerpts.length - 1) lines.push({ text: "", highlight: false });
      }
    }
    return {
      header: r.title || "(untitled)",
      blocks: [{ lines }],
    };
  });
}

interface WebSearchParams {
  objective: string;
  search_queries?: string[];
  max_results?: number;
}

export function createWebSearchTool(
  config: WebSearchExtConfig = CONFIG_DEFAULTS,
  runtime?: WebSearchRuntime,
): ToolDefinition {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for information relevant to a research objective.\n\n" +
      "Use when you need up-to-date or precise documentation. " +
      "Use `web_fetch` to fetch full content from a specific URL.\n\n" +
      "# Examples\n\n" +
      "Get API documentation for a specific provider\n" +
      '```json\n{"objective":"I want to know the request fields for the Stripe billing create customer API. Prefer Stripe\'s docs site."}\n```\n\n' +
      "See usage documentation for newly released library features\n" +
      '```json\n{"objective":"I want to know how to use SvelteKit remote functions, which is a new feature shipped in the last month.","search_queries":["sveltekit","remote function"]}\n```',

    parameters: Type.Object({
      objective: Type.String({
        description:
          "A natural-language description of the broader task or research goal, " +
          "including any source or freshness guidance.",
      }),
      search_queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional keyword queries to ensure matches for specific terms are " +
            "prioritized (recommended for best results).",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: `The maximum number of results to return (default: ${config.defaultMaxResults}).`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const p = params as WebSearchParams;
      if (!runtime) {
        return {
          content: [{ type: "text" as const, text: "web search runtime not available" }],
          isError: true,
        } as any;
      }

      const apiKeyResult = await resolveParallelApiKey(runtime, signal);
      if (apiKeyResult._tag === "Failure") {
        return {
          content: [{ type: "text" as const, text: apiKeyResult.message }],
          isError: true,
        } as any;
      }

      const body: Record<string, unknown> = {
        objective: p.objective,
        max_results: p.max_results ?? config.defaultMaxResults,
        excerpts: { max_chars_per_result: 2000 },
      };
      if (p.search_queries?.length) {
        body.search_queries = p.search_queries;
      }

      const { data, error } = await searchParallel(
        apiKeyResult.apiKey,
        body,
        config.endpoint,
        config.curlTimeoutSecs,
        signal,
        runtime,
      );

      if (error) {
        return {
          content: [{ type: "text" as const, text: error }],
          isError: true,
        } as any;
      }

      if (!data?.results) {
        return {
          content: [{ type: "text" as const, text: "(no results)" }],
        } as any;
      }

      const { text, headerLineIndices } = formatResults(data.results);
      let output = text;

      if (data.warnings?.length) {
        output += `\n\n**Warnings:** ${data.warnings.join("; ")}`;
      }

      const resultSections = resultsToSections(data.results);
      const details: ToolCostDetails & {
        matchLineIndices?: number[];
        resultSections?: BoxSection[];
      } = {
        cost: costFromUsage(data.usage),
        matchLineIndices: headerLineIndices,
        resultSections,
      };
      return { content: [{ type: "text" as const, text: output }], details };
    },

    renderCall(args: any, theme: any) {
      const objective = args.objective || "...";
      const short = objective.length > 70 ? `${objective.slice(0, 70)}...` : objective;
      let text = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("dim", short);
      if (args.search_queries?.length) {
        text += theme.fg("muted", ` [${args.search_queries.join(", ")}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any) {
      const sections: BoxSection[] | undefined = result.details?.resultSections;
      if (!sections?.length) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      return boxRendererWindowed(
        () => sections,
        {
          collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },
  };
}

export function createWebSearchRuntime(
  start: string | URL = new URL(".", import.meta.url),
  processRunnerLayer: Layer.Layer<ProcessRunner, never, never> = ProcessRunner.layer,
): WebSearchRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      processRunnerLayer,
      WebSearchSecrets.layer.pipe(
        Layer.provide(
          layerRepoEnv(start).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
        ),
      ),
    ),
  );
}

export function createWebSearchExtension(
  deps: WebSearchExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function webSearchExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@cvr/pi-web-search",
      CONFIG_DEFAULTS,
      { schema: WEB_SEARCH_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const runtime = createWebSearchRuntime();
    pi.registerTool(deps.withPromptPatch(createWebSearchTool(cfg, runtime)));
    pi.on("session_shutdown", async () => {
      await runtime.dispose();
    });
  };
}

const webSearchExtension: (pi: ExtensionAPI) => void = createWebSearchExtension();

export default webSearchExtension;

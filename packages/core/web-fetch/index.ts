import { Buffer } from "node:buffer";
import { Duration, Effect, Layer, Option, Schema, ServiceMap, Stream } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { htmlToMarkdown, htmlToText, isHtml } from "@cvr/pi-html-to-md";

export type FetchFormat = "markdown" | "text" | "html";

export interface WebFetchCoreConfig extends Record<string, unknown> {
  readonly defaultTimeoutSecs: number;
  readonly maxTimeoutSecs: number;
  readonly maxResponseBytes: number;
}

export interface WebFetchRequest {
  readonly url: string;
  readonly format: FetchFormat;
  readonly timeoutSecs: number;
}

export interface WebFetchTextResult {
  readonly _tag: "Text";
  readonly text: string;
  readonly url: string;
  readonly title: string;
  readonly mimeType: string;
  readonly format: FetchFormat;
}

export interface WebFetchImageResult {
  readonly _tag: "Image";
  readonly data: string;
  readonly url: string;
  readonly title: string;
  readonly mimeType: string;
}

export type WebFetchResult = WebFetchTextResult | WebFetchImageResult;

export type WebFetchLayerTestResponse = WebFetchResult | WebFetchError;

export const CONFIG_DEFAULTS: WebFetchCoreConfig = {
  defaultTimeoutSecs: 30,
  maxTimeoutSecs: 120,
  maxResponseBytes: 5 * 1024 * 1024,
};

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const CLOUDFLARE_RETRY_USER_AGENT = "pi";
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const HTML_MIME_RE = /^(text\/html|application\/xhtml\+xml)$/i;
const TEXT_LIKE_MIME_RE =
  /^(text\/|application\/(json|xml|javascript|x-javascript|rss\+xml|atom\+xml))/i;
const WEB_FETCH_ERROR_TAGS = new Set<string>([
  "WebFetchInvalidUrlError",
  "WebFetchTimeoutError",
  "WebFetchRequestError",
  "WebFetchStatusError",
  "WebFetchResponseTooLargeError",
  "WebFetchUnsupportedContentTypeError",
]);

export class WebFetchInvalidUrlError extends Schema.TaggedErrorClass<WebFetchInvalidUrlError>()(
  "WebFetchInvalidUrlError",
  {
    url: Schema.String,
    message: Schema.String,
  },
) {}

export class WebFetchTimeoutError extends Schema.TaggedErrorClass<WebFetchTimeoutError>()(
  "WebFetchTimeoutError",
  {
    url: Schema.String,
    timeoutSecs: Schema.Number,
    message: Schema.String,
  },
) {}

export class WebFetchRequestError extends Schema.TaggedErrorClass<WebFetchRequestError>()(
  "WebFetchRequestError",
  {
    url: Schema.String,
    message: Schema.String,
  },
) {}

export class WebFetchStatusError extends Schema.TaggedErrorClass<WebFetchStatusError>()(
  "WebFetchStatusError",
  {
    url: Schema.String,
    status: Schema.Number,
    message: Schema.String,
  },
) {}

export class WebFetchResponseTooLargeError extends Schema.TaggedErrorClass<WebFetchResponseTooLargeError>()(
  "WebFetchResponseTooLargeError",
  {
    url: Schema.String,
    limitBytes: Schema.Number,
    message: Schema.String,
  },
) {}

export class WebFetchUnsupportedContentTypeError extends Schema.TaggedErrorClass<WebFetchUnsupportedContentTypeError>()(
  "WebFetchUnsupportedContentTypeError",
  {
    url: Schema.String,
    mimeType: Schema.String,
    message: Schema.String,
  },
) {}

export type WebFetchError =
  | WebFetchInvalidUrlError
  | WebFetchTimeoutError
  | WebFetchRequestError
  | WebFetchStatusError
  | WebFetchResponseTooLargeError
  | WebFetchUnsupportedContentTypeError;

function getAcceptHeader(format: FetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

function isHtmlMime(mimeType: string): boolean {
  return HTML_MIME_RE.test(mimeType);
}

function isTextLikeMime(mimeType: string): boolean {
  return mimeType.length === 0 || TEXT_LIKE_MIME_RE.test(mimeType) || isHtmlMime(mimeType);
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function normalizeMimeType(headers: Headers.Headers): string {
  const contentType = Headers.get(headers, "content-type");
  if (Option.isNone(contentType)) return "";
  const [mimeType] = contentType.value.split(";");
  return (mimeType ?? "").trim().toLowerCase();
}

function parseContentLength(headers: Headers.Headers): Option.Option<number> {
  const contentLength = Headers.get(headers, "content-length");
  if (Option.isNone(contentLength)) return Option.none();

  const parsed = Number.parseInt(contentLength.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Option.some(parsed) : Option.none();
}

function normalizeHtmlForConversion(body: string, mimeType: string): string {
  if (!isHtmlMime(mimeType) || isHtml(body)) return body;
  return `<!DOCTYPE html><html><body>${body}</body></html>`;
}

function formatTextBody(body: string, format: FetchFormat, mimeType: string): string {
  if (format === "html") return body;
  if (!isHtml(body) && !isHtmlMime(mimeType)) return body;

  const htmlInput = normalizeHtmlForConversion(body, mimeType);

  if (format === "markdown") {
    return htmlToMarkdown(htmlInput) ?? body;
  }

  return htmlToText(htmlInput) ?? htmlToMarkdown(htmlInput) ?? body;
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>, totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function makeTitle(url: string, mimeType: string): string {
  return mimeType ? `${url} (${mimeType})` : url;
}

function isWebFetchError(value: WebFetchLayerTestResponse | undefined): value is WebFetchError {
  if (value == null || typeof value !== "object" || !("_tag" in value)) return false;
  const tag = value._tag;
  return typeof tag === "string" && WEB_FETCH_ERROR_TAGS.has(tag);
}

function isResponseTooLargeError(error: unknown): error is WebFetchResponseTooLargeError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WebFetchResponseTooLargeError"
  );
}

const validateUrl = Effect.fn("@cvr/pi-web-fetch-core/index/WebFetchService.validateUrl")(
  function* (rawUrl: string) {
    const parsed = yield* Effect.try({
      try: () => new URL(rawUrl),
      catch: () =>
        new WebFetchInvalidUrlError({
          url: rawUrl,
          message: "invalid url",
        }),
    });

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* new WebFetchInvalidUrlError({
        url: rawUrl,
        message: "url must use http:// or https://",
      });
    }

    return parsed.toString();
  },
);

const requestWithUserAgent = Effect.fn(
  "@cvr/pi-web-fetch-core/index/WebFetchService.requestWithUserAgent",
)(function* (url: string, format: FetchFormat, timeoutSecs: number, userAgent: string) {
  const request = HttpClientRequest.get(url, {
    headers: {
      Accept: getAcceptHeader(format),
      "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
      "User-Agent": userAgent,
    },
  });

  return yield* HttpClient.execute(request).pipe(
    Effect.mapError(
      (error) =>
        new WebFetchRequestError({
          url,
          message: error.message,
        }),
    ),
    Effect.timeoutOption(Duration.seconds(timeoutSecs)),
    Effect.flatMap((response) =>
      Option.match(response, {
        onNone: () =>
          Effect.fail(
            new WebFetchTimeoutError({
              url,
              timeoutSecs,
              message: `request timed out after ${timeoutSecs} seconds`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

const ensureSuccessStatus = Effect.fn(
  "@cvr/pi-web-fetch-core/index/WebFetchService.ensureSuccessStatus",
)(function* (url: string, response: HttpClientResponse.HttpClientResponse) {
  if (response.status >= 200 && response.status < 300) return response;
  return yield* new WebFetchStatusError({
    url,
    status: response.status,
    message: `request failed with status code ${response.status}`,
  });
});

const ensureContentLengthWithinLimit = Effect.fn(
  "@cvr/pi-web-fetch-core/index/WebFetchService.ensureContentLengthWithinLimit",
)(function* (url: string, headers: Headers.Headers, maxResponseBytes: number) {
  const contentLength = parseContentLength(headers);
  if (Option.isSome(contentLength) && contentLength.value > maxResponseBytes) {
    return yield* new WebFetchResponseTooLargeError({
      url,
      limitBytes: maxResponseBytes,
      message: `response exceeds byte limit of ${maxResponseBytes} bytes`,
    });
  }
});

const readResponseBytes = Effect.fn(
  "@cvr/pi-web-fetch-core/index/WebFetchService.readResponseBytes",
)(function* (
  url: string,
  response: HttpClientResponse.HttpClientResponse,
  maxResponseBytes: number,
) {
  const contentLength = parseContentLength(response.headers);
  if (Option.isSome(contentLength) && contentLength.value === 0) {
    return new Uint8Array(0);
  }

  const body = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, totalBytes: 0 }),
      (state, chunk) => {
        const totalBytes = state.totalBytes + chunk.byteLength;
        if (totalBytes > maxResponseBytes) {
          return Effect.fail(
            new WebFetchResponseTooLargeError({
              url,
              limitBytes: maxResponseBytes,
              message: `response exceeds byte limit of ${maxResponseBytes} bytes`,
            }),
          );
        }

        return Effect.succeed({
          chunks: [...state.chunks, chunk],
          totalBytes,
        });
      },
    ),
    Effect.map((state) => concatChunks(state.chunks, state.totalBytes)),
    Effect.mapError((error: WebFetchResponseTooLargeError | HttpClientError.HttpClientError) => {
      if (isResponseTooLargeError(error)) return error;
      return new WebFetchRequestError({
        url,
        message: error.message,
      });
    }),
  );

  return body;
});

const fetchResource = (config: WebFetchCoreConfig) =>
  Effect.fn("@cvr/pi-web-fetch-core/index/WebFetchService.fetch")(function* (
    request: WebFetchRequest,
  ) {
    const url = yield* validateUrl(request.url);
    const initialResponse = yield* requestWithUserAgent(
      url,
      request.format,
      request.timeoutSecs,
      DEFAULT_USER_AGENT,
    );

    const mitigated = Headers.get(initialResponse.headers, "cf-mitigated");
    const response =
      initialResponse.status === 403 && Option.isSome(mitigated) && mitigated.value === "challenge"
        ? yield* requestWithUserAgent(
            url,
            request.format,
            request.timeoutSecs,
            CLOUDFLARE_RETRY_USER_AGENT,
          )
        : initialResponse;

    const okResponse = yield* ensureSuccessStatus(url, response);
    yield* ensureContentLengthWithinLimit(url, okResponse.headers, config.maxResponseBytes);

    const mimeType = normalizeMimeType(okResponse.headers);
    const title = makeTitle(url, mimeType);
    const bytes = yield* readResponseBytes(url, okResponse, config.maxResponseBytes);

    if (isImageMime(mimeType)) {
      return {
        _tag: "Image",
        data: Buffer.from(bytes).toString("base64"),
        url,
        title,
        mimeType,
      } satisfies WebFetchImageResult;
    }

    if (!isTextLikeMime(mimeType)) {
      return yield* new WebFetchUnsupportedContentTypeError({
        url,
        mimeType: mimeType || "unknown",
        message: `unsupported content-type: ${mimeType || "unknown"}`,
      });
    }

    const body = new TextDecoder().decode(bytes);
    return {
      _tag: "Text",
      text: formatTextBody(body, request.format, mimeType),
      url,
      title,
      mimeType,
      format: request.format,
    } satisfies WebFetchTextResult;
  });

export class WebFetchService extends ServiceMap.Service<
  WebFetchService,
  {
    readonly fetch: (
      request: WebFetchRequest,
    ) => Effect.Effect<WebFetchResult, WebFetchError, HttpClient.HttpClient>;
  }
>()("@cvr/pi-web-fetch-core/index/WebFetchService") {
  static layer = (config: WebFetchCoreConfig) =>
    Layer.succeed(WebFetchService, {
      fetch: fetchResource(config),
    });

  static layerTest = (responses: Map<string, WebFetchLayerTestResponse> = new Map()) =>
    Layer.mergeAll(
      Layer.succeed(WebFetchService, {
        fetch: (request) => {
          const response = responses.get(request.url);
          if (response === undefined) {
            return Effect.fail(
              new WebFetchRequestError({
                url: request.url,
                message: `no mock for ${request.url}`,
              }),
            );
          }

          if (isWebFetchError(response)) {
            return Effect.fail(response);
          }

          return Effect.succeed(response);
        },
      }),
      FetchHttpClient.layer,
    );
}

import { describe, expect, it } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import {
  CONFIG_DEFAULTS,
  WebFetchInvalidUrlError,
  WebFetchRequestError,
  WebFetchResponseTooLargeError,
  WebFetchService,
  WebFetchTimeoutError,
  WebFetchUnsupportedContentTypeError,
  type WebFetchCoreConfig,
  type WebFetchRequest,
} from "./index";

const DEFAULT_REQUEST: WebFetchRequest = {
  url: "https://example.com/docs",
  format: "markdown",
  timeoutSecs: CONFIG_DEFAULTS.defaultTimeoutSecs,
};

function withFetchShape(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(fetchImpl, {
    preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
  });
}

function createSequentialFetch(responses: Array<Response>) {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

  const fetchImpl = withFetchShape(async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected fetch call");
    }
    return response;
  });

  return { fetchImpl, calls };
}

function createLayer(
  fetchImpl: typeof globalThis.fetch,
  config: WebFetchCoreConfig = CONFIG_DEFAULTS,
) {
  return Layer.mergeAll(
    WebFetchService.layer(config),
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, fetchImpl),
  );
}

async function withRuntime<A, E>(
  layer: ReturnType<typeof createLayer> | ReturnType<typeof WebFetchService.layerTest>,
  effect: Effect.Effect<A, E, WebFetchService | HttpClient.HttpClient>,
) {
  const runtime = ManagedRuntime.make(layer);
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

function runFetch(
  layer: ReturnType<typeof createLayer> | ReturnType<typeof WebFetchService.layerTest>,
  request: WebFetchRequest = DEFAULT_REQUEST,
) {
  return withRuntime(
    layer,
    Effect.gen(function* () {
      const service = yield* WebFetchService;
      return yield* service.fetch(request);
    }),
  );
}

function runFetchResult(
  layer: ReturnType<typeof createLayer> | ReturnType<typeof WebFetchService.layerTest>,
  request: WebFetchRequest = DEFAULT_REQUEST,
) {
  return withRuntime(
    layer,
    Effect.gen(function* () {
      const service = yield* WebFetchService;
      return yield* service.fetch(request).pipe(Effect.result);
    }),
  );
}

describe("WebFetchService", () => {
  it("converts html to markdown by default", async () => {
    const { fetchImpl } = createSequentialFetch([
      new Response("<!DOCTYPE html><html><body><main><h1>Docs</h1><p>Hello world.</p></main></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ]);

    const result = await runFetch(createLayer(fetchImpl));

    expect(result._tag).toBe("Text");
    if (result._tag !== "Text") throw new Error("expected text result");
    expect(result.text).toContain("# Docs");
    expect(result.text).toContain("Hello world.");
  });

  it("converts html to text when requested", async () => {
    const { fetchImpl } = createSequentialFetch([
      new Response("<!DOCTYPE html><html><body><main><h1>Docs</h1><p>Hello world.</p></main></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    ]);

    const result = await runFetch(createLayer(fetchImpl), {
      ...DEFAULT_REQUEST,
      format: "text",
    });

    expect(result._tag).toBe("Text");
    if (result._tag !== "Text") throw new Error("expected text result");
    expect(result.text).toBe("Docs\n\nHello world.");
  });

  it("converts html fragments when the mime type is html", async () => {
    const { fetchImpl } = createSequentialFetch([
      new Response("<main><h1>Docs</h1><p>Hello fragment.</p></main>", {
        headers: { "content-type": "text/html" },
      }),
    ]);

    const result = await runFetch(createLayer(fetchImpl));

    expect(result._tag).toBe("Text");
    if (result._tag !== "Text") throw new Error("expected text result");
    expect(result.text).toContain("# Docs");
    expect(result.text).toContain("Hello fragment.");
  });

  it("returns images as base64 image results", async () => {
    const { fetchImpl } = createSequentialFetch([
      new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    ]);

    const result = await runFetch(createLayer(fetchImpl));

    expect(result._tag).toBe("Image");
    if (result._tag !== "Image") throw new Error("expected image result");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe("iVBORw==");
  });

  it("rejects invalid urls before sending a request", async () => {
    const { fetchImpl, calls } = createSequentialFetch([]);
    const result = await runFetchResult(createLayer(fetchImpl), {
      ...DEFAULT_REQUEST,
      url: "notaurl",
    });

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected failure result");
    expect(result.failure).toBeInstanceOf(WebFetchInvalidUrlError);
    expect(result.failure.message).toBe("invalid url");
    expect(calls).toHaveLength(0);
  });

  it("retries Cloudflare challenge with the pi user agent", async () => {
    const { fetchImpl, calls } = createSequentialFetch([
      new Response("blocked", {
        status: 403,
        headers: {
          "cf-mitigated": "challenge",
          "content-type": "text/html",
        },
      }),
      new Response("<!DOCTYPE html><html><body><main><p>Recovered</p></main></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    ]);

    const result = await runFetch(createLayer(fetchImpl));

    expect(result._tag).toBe("Text");
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toContain("Mozilla/5.0");
    expect(new Headers(calls[1]?.init?.headers).get("user-agent")).toBe("pi");
  });

  it("fails fast when content-length exceeds the byte cap", async () => {
    const { fetchImpl } = createSequentialFetch([
      new Response("hello", {
        headers: {
          "content-type": "text/plain",
          "content-length": String(CONFIG_DEFAULTS.maxResponseBytes + 1),
        },
      }),
    ]);

    const result = await runFetchResult(createLayer(fetchImpl));

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected failure result");
    expect(result.failure).toBeInstanceOf(WebFetchResponseTooLargeError);
  });

  it("fails when streamed bytes exceed the cap without content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("def"));
        controller.close();
      },
    });
    const { fetchImpl } = createSequentialFetch([
      new Response(stream, {
        headers: { "content-type": "text/plain" },
      }),
    ]);

    const result = await runFetchResult(
      createLayer(fetchImpl, {
        ...CONFIG_DEFAULTS,
        maxResponseBytes: 5,
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected failure result");
    expect(result.failure).toBeInstanceOf(WebFetchResponseTooLargeError);
  });

  it("rejects unsupported binary content", async () => {
    const { fetchImpl } = createSequentialFetch([
      new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "application/pdf" },
      }),
    ]);

    const result = await runFetchResult(createLayer(fetchImpl));

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected failure result");
    expect(result.failure).toBeInstanceOf(WebFetchUnsupportedContentTypeError);
  });

  it("times out slow requests", async () => {
    const fetchImpl = withFetchShape(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason ?? new DOMException("Aborted", "AbortError"));
            return;
          }

          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );

    const result = await runFetchResult(
      createLayer(fetchImpl),
      {
        ...DEFAULT_REQUEST,
        timeoutSecs: 1,
      },
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected failure result");
    expect(result.failure).toBeInstanceOf(WebFetchTimeoutError);
  });

  it("layerTest returns canned responses", async () => {
    const result = await runFetch(
      WebFetchService.layerTest(
        new Map([
          [
            DEFAULT_REQUEST.url,
            {
              _tag: "Text",
              text: "mock body",
              url: DEFAULT_REQUEST.url,
              title: DEFAULT_REQUEST.url,
              mimeType: "text/plain",
              format: "markdown",
            },
          ],
        ]),
      ),
    );

    expect(result._tag).toBe("Text");
    if (result._tag !== "Text") throw new Error("expected text result");
    expect(result.text).toBe("mock body");
  });

  it("layerTest returns canned errors", async () => {
    const result = await runFetchResult(
      WebFetchService.layerTest(
        new Map([
          [
            DEFAULT_REQUEST.url,
            new WebFetchRequestError({
              url: DEFAULT_REQUEST.url,
              message: "mock failure",
            }),
          ],
        ]),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected failure result");
    expect(result.failure).toBeInstanceOf(WebFetchRequestError);
  });
});

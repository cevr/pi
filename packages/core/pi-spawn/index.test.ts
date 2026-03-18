import { describe, expect, it } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import {
  processNdjsonLine,
  zeroUsage,
  resolvePrompt,
  readAgentPrompt,
  PiSpawnService,
  type PiSpawnResult,
} from "./index";

// ---------------------------------------------------------------------------
// processNdjsonLine (pure, no spawn needed)
// ---------------------------------------------------------------------------

function makeResult(): PiSpawnResult {
  return { exitCode: 0, messages: [], stderr: "", usage: zeroUsage() };
}

async function runWithPiSpawnLayer<A, E>(
  effect: Effect.Effect<A, E, PiSpawnService>,
  results?: Map<string, PiSpawnResult>,
): Promise<A> {
  const runtime = ManagedRuntime.make(PiSpawnService.layerTest(results));
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}

describe("processNdjsonLine", () => {
  it("ignores empty lines", () => {
    const result = makeResult();
    const rpc = { endTurnCount: 0 };
    processNdjsonLine("", result, {}, rpc, () => {});
    processNdjsonLine("   ", result, {}, rpc, () => {});
    expect(result.messages).toHaveLength(0);
  });

  it("ignores invalid JSON", () => {
    const result = makeResult();
    processNdjsonLine("not json", result, {}, { endTurnCount: 0 }, () => {});
    expect(result.messages).toHaveLength(0);
  });

  it("ignores RPC response events", () => {
    const result = makeResult();
    processNdjsonLine(
      JSON.stringify({ type: "response", id: 1 }),
      result,
      {},
      { endTurnCount: 0 },
      () => {},
    );
    expect(result.messages).toHaveLength(0);
  });

  it("collects message_end events", () => {
    const result = makeResult();
    const msg = { role: "user", content: "hello" };
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      {},
      { endTurnCount: 0 },
      () => {},
    );
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as any)?.role).toBe(msg.role);
    expect((result.messages[0] as any)?.content).toBe(msg.content);
  });

  it("accumulates usage from assistant messages", () => {
    const result = makeResult();
    const msg = {
      role: "assistant",
      content: "hi",
      usage: { input: 100, output: 50, cacheRead: 10, totalTokens: 200 },
      model: "test-model",
      stopReason: "end_turn",
    };
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      {},
      { endTurnCount: 0 },
      () => {},
    );
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(result.usage.cacheRead).toBe(10);
    expect(result.usage.contextTokens).toBe(200);
    expect(result.usage.turns).toBe(1);
    expect(result.model).toBe("test-model");
    expect(result.stopReason).toBe("end_turn");
  });

  it("accumulates usage across multiple turns", () => {
    const result = makeResult();
    const msg1 = { role: "assistant", content: "a", usage: { input: 100, output: 50 } };
    const msg2 = { role: "assistant", content: "b", usage: { input: 200, output: 75 } };
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg1 }),
      result,
      {},
      { endTurnCount: 0 },
      () => {},
    );
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg2 }),
      result,
      {},
      { endTurnCount: 0 },
      () => {},
    );
    expect(result.usage.input).toBe(300);
    expect(result.usage.output).toBe(125);
    expect(result.usage.turns).toBe(2);
  });

  it("coerces string usage values to numbers", () => {
    const result = makeResult();
    const msg = {
      role: "assistant",
      content: "hi",
      usage: { input: "100", output: "50" },
    };
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      {},
      { endTurnCount: 0 },
      () => {},
    );
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(typeof result.usage.input).toBe("number");
  });

  it("collects tool_result_end events", () => {
    const result = makeResult();
    const msg = { role: "tool_result", content: "done" };
    processNdjsonLine(
      JSON.stringify({ type: "tool_result_end", message: msg }),
      result,
      {},
      { endTurnCount: 0 },
      () => {},
    );
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as any)?.role).toBe(msg.role);
    expect((result.messages[0] as any)?.content).toBe(msg.content);
  });

  it("calls onUpdate after message_end", () => {
    const updates: PiSpawnResult[] = [];
    const result = makeResult();
    const msg = { role: "assistant", content: "hi", stopReason: "end_turn" };
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      { onUpdate: (r) => updates.push(r) },
      { endTurnCount: 0 },
      () => {},
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.messages).toHaveLength(1);
  });

  it("kills proc after expected turns in RPC mode", () => {
    let killed = false;
    const result = makeResult();
    const rpc = { endTurnCount: 0 };
    const msg = { role: "assistant", content: "done", stopReason: "end_turn" };

    // single-turn (no followUp)
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      { followUp: "review this" },
      rpc,
      () => {
        killed = true;
      },
    );
    expect(killed).toBe(false); // need 2 turns for followUp
    expect(rpc.endTurnCount).toBe(1);

    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      { followUp: "review this" },
      rpc,
      () => {
        killed = true;
      },
    );
    expect(killed).toBe(true); // 2nd turn → kill
    expect(rpc.endTurnCount).toBe(2);
  });

  it("kills proc after first turn by default", () => {
    let killed = false;
    const result = makeResult();
    const msg = { role: "assistant", content: "done", stopReason: "end_turn" };

    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      {},
      { endTurnCount: 0 },
      () => {
        killed = true;
      },
    );

    expect(killed).toBe(true);
  });

  it("does not auto-kill when promptViaStdin is disabled", () => {
    let killed = false;
    const result = makeResult();
    const msg = { role: "assistant", content: "done", stopReason: "end_turn" };

    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      { promptViaStdin: false },
      { endTurnCount: 0 },
      () => {
        killed = true;
      },
    );

    expect(killed).toBe(false);
  });

  it("kills proc on error stopReason in RPC mode", () => {
    let killed = false;
    const result = makeResult();
    const msg = { role: "assistant", content: "err", stopReason: "error" };
    processNdjsonLine(
      JSON.stringify({ type: "message_end", message: msg }),
      result,
      { followUp: "review" },
      { endTurnCount: 0 },
      () => {
        killed = true;
      },
    );
    expect(killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("zeroUsage", () => {
  it("returns zeroed stats", () => {
    const u = zeroUsage();
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(u.turns).toBe(0);
  });
});

describe("resolvePrompt", () => {
  it("returns promptString when non-empty", () => {
    expect(resolvePrompt("inline prompt", "file.md")).toBe("inline prompt");
  });

  it("falls back to readAgentPrompt when promptString is empty", () => {
    // readAgentPrompt returns "" for missing files
    expect(resolvePrompt("", "nonexistent-file.md")).toBe("");
  });
});

describe("readAgentPrompt", () => {
  it("returns empty string for missing file", () => {
    expect(readAgentPrompt("does-not-exist-12345.md")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PiSpawnService layerTest
// ---------------------------------------------------------------------------

describe("PiSpawnService (layerTest)", () => {
  it("returns default result when no map provided", async () => {
    const result = await runWithPiSpawnLayer(
      Effect.gen(function* () {
        const svc = yield* PiSpawnService;
        return yield* svc.spawn({ cwd: "/tmp", task: "test" });
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("returns canned result from map", async () => {
    const canned: PiSpawnResult = {
      exitCode: 0,
      messages: [{ role: "assistant", content: "done" } as any],
      stderr: "",
      usage: zeroUsage(),
      model: "test",
    };
    const results = new Map([["test-model", canned]]);

    const result = await runWithPiSpawnLayer(
      Effect.gen(function* () {
        const svc = yield* PiSpawnService;
        return yield* svc.spawn({ cwd: "/tmp", task: "test", model: "test-model" });
      }),
      results,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.model).toBe("test");
  });
});

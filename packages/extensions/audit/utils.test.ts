import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";
import {
  AUDIT_SIGNAL_TOOLS,
  hasToolCall,
  parseConcernCompletion,
  parseCounselResult,
  parseFindingResult,
  parseGateResult,
  parseSynthesisComplete,
} from "./utils";

function assistantMessage(...content: AssistantMessage["content"]): Message {
  return { role: "assistant", content } as AssistantMessage;
}

function toolResult(toolCallId: string, isError = false): Message {
  return {
    role: "toolResult",
    toolCallId,
    isError,
    content: [{ type: "text", text: isError ? "error" : "ok" }],
  } as ToolResultMessage;
}

describe("audit transcript signal parsing", () => {
  it("detects concern completion tool calls", () => {
    const messages: Message[] = [
      assistantMessage({ type: "text", text: "Concern notes" }, {
        type: "toolCall",
        id: "tc-1",
        name: AUDIT_SIGNAL_TOOLS.concernComplete,
        arguments: {},
      } as any),
      toolResult("tc-1"),
    ];

    expect(hasToolCall(messages, AUDIT_SIGNAL_TOOLS.concernComplete)).toBe(true);
    expect(parseConcernCompletion(messages)).toBe(true);
  });

  it("parses synthesis findings from the typed tool call", () => {
    const messages: Message[] = [
      assistantMessage({ type: "text", text: "Audit report" }, {
        type: "toolCall",
        id: "tc-2",
        name: AUDIT_SIGNAL_TOOLS.synthesisComplete,
        arguments: {
          findings: [
            { file: "src/app.tsx", description: "Missing null check", severity: "critical" },
          ],
        },
      } as any),
      toolResult("tc-2"),
    ];

    expect(parseSynthesisComplete(messages)).toEqual([
      { file: "src/app.tsx", description: "Missing null check", severity: "critical" },
    ]);
  });

  it("defaults invalid synthesis severities to warning", () => {
    const messages: Message[] = [
      assistantMessage({
        type: "toolCall",
        id: "tc-3",
        name: AUDIT_SIGNAL_TOOLS.synthesisComplete,
        arguments: { findings: [{ file: "a.ts", description: "x", severity: "invalid" }] },
      } as any),
      toolResult("tc-3"),
    ];

    expect(parseSynthesisComplete(messages)?.[0]?.severity).toBe("warning");
  });

  it("returns null for malformed synthesis payloads", () => {
    const messages: Message[] = [
      assistantMessage({
        type: "toolCall",
        id: "tc-4",
        name: AUDIT_SIGNAL_TOOLS.synthesisComplete,
        arguments: { findings: [{ file: "a.ts" }] },
      } as any),
      toolResult("tc-4"),
    ];

    expect(parseSynthesisComplete(messages)).toBeNull();
  });

  it("parses finding, gate, and counsel outcomes", () => {
    const messages: Message[] = [
      assistantMessage(
        {
          type: "toolCall",
          id: "tc-5",
          name: AUDIT_SIGNAL_TOOLS.findingResult,
          arguments: { outcome: "skip" },
        } as any,
        {
          type: "toolCall",
          id: "tc-6",
          name: AUDIT_SIGNAL_TOOLS.fixGateResult,
          arguments: { status: "pass" },
        } as any,
        {
          type: "toolCall",
          id: "tc-7",
          name: AUDIT_SIGNAL_TOOLS.fixCounselResult,
          arguments: { status: "fail" },
        } as any,
      ),
      toolResult("tc-5"),
      toolResult("tc-6"),
      toolResult("tc-7"),
    ];

    expect(parseFindingResult(messages)).toBe("skip");
    expect(parseGateResult(messages)).toBe("pass");
    expect(parseCounselResult(messages)).toBe("fail");
  });

  it("ignores tool calls whose result errored", () => {
    const messages: Message[] = [
      assistantMessage({
        type: "toolCall",
        id: "tc-8",
        name: AUDIT_SIGNAL_TOOLS.findingResult,
        arguments: { outcome: "fixed" },
      } as any),
      toolResult("tc-8", true),
    ];

    expect(hasToolCall(messages, AUDIT_SIGNAL_TOOLS.findingResult)).toBe(false);
    expect(parseFindingResult(messages)).toBeNull();
  });
});

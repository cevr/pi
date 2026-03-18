import { describe, expect, it, mock } from "bun:test";
import { createInlineExecutionExecutor, executeTurn, isExecutionEffect } from "./index";

describe("executeTurn", () => {
  it("wraps a request as an execution effect", () => {
    expect(
      executeTurn({
        customType: "modes-execute",
        content: "Run the next step.",
        display: true,
        triggerTurn: true,
      }),
    ).toEqual({
      type: "executeTurn",
      request: {
        customType: "modes-execute",
        content: "Run the next step.",
        display: true,
        triggerTurn: true,
      },
    });
  });
});

describe("isExecutionEffect", () => {
  it("detects execution effects", () => {
    expect(isExecutionEffect(executeTurn({ customType: "x", content: "y", display: false }))).toBe(
      true,
    );
    expect(isExecutionEffect({ type: "notify", message: "nope" })).toBe(false);
  });
});

describe("createInlineExecutionExecutor", () => {
  it("dispatches requests through pi.sendMessage", () => {
    const sendMessage = mock(() => {});
    const executor = createInlineExecutionExecutor({ sendMessage });

    executor.execute(
      {
        customType: "audit-fix",
        content: "Fix finding 1/2",
        display: false,
        triggerTurn: true,
        deliverAs: "followUp",
      },
      {} as never,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "audit-fix",
        content: "Fix finding 1/2",
        display: false,
      },
      {
        triggerTurn: true,
        deliverAs: "followUp",
      },
    );
  });
});

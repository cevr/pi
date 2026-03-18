import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ExecutionDelivery = "steer" | "followUp" | "nextTurn";

export interface ExecutionRequest {
  customType: string;
  content: string;
  display: boolean;
  triggerTurn?: boolean;
  deliverAs?: ExecutionDelivery;
}

export interface ExecutionEffect {
  type: "executeTurn";
  request: ExecutionRequest;
}

export interface ExecutionExecutor {
  execute(request: ExecutionRequest, ctx: ExtensionContext): void;
}

export function executeTurn(request: ExecutionRequest): ExecutionEffect {
  return { type: "executeTurn", request };
}

export function isExecutionEffect(effect: unknown): effect is ExecutionEffect {
  return (
    typeof effect === "object" &&
    effect !== null &&
    (effect as { type?: string }).type === "executeTurn"
  );
}

export function createInlineExecutionExecutor(
  pi: Pick<ExtensionAPI, "sendMessage">,
): ExecutionExecutor {
  return {
    execute(request) {
      pi.sendMessage(
        {
          customType: request.customType,
          content: request.content,
          display: request.display,
        },
        {
          triggerTurn: request.triggerTurn,
          deliverAs: request.deliverAs,
        },
      );
    },
  };
}

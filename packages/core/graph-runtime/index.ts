import { Effect, Layer, ServiceMap } from "effect";
import type { GraphExecutionPolicy } from "@cvr/pi-graph-execution";

export interface GraphRuntimeTaskResult<A> {
  readonly taskId: string;
  readonly value: A;
}

function getEffectiveParallelism(policy: GraphExecutionPolicy): number {
  return Number.isInteger(policy.maxParallel) && policy.maxParallel > 0 ? policy.maxParallel : 1;
}

export class GraphRuntime extends ServiceMap.Service<
  GraphRuntime,
  {
    readonly runFrontier: <A, E, R>(
      frontierTaskIds: readonly string[],
      runTask: (taskId: string) => Effect.Effect<A, E, R>,
      policy: GraphExecutionPolicy,
    ) => Effect.Effect<ReadonlyArray<GraphRuntimeTaskResult<A>>, E, R>;
  }
>()("@cvr/pi-graph-runtime/index/GraphRuntime") {
  static layer = Layer.succeed(GraphRuntime, {
    runFrontier: <A, E, R>(
      frontierTaskIds: readonly string[],
      runTask: (taskId: string) => Effect.Effect<A, E, R>,
      policy: GraphExecutionPolicy,
    ) =>
      Effect.forEach(
        frontierTaskIds,
        (taskId) => runTask(taskId).pipe(Effect.map((value) => ({ taskId, value }))),
        { concurrency: getEffectiveParallelism(policy) },
      ),
  });
}

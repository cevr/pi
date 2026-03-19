import { Schema } from "effect";
import { TaskListItemSchema } from "@cvr/pi-task-list";

export const PersistedTaskListSchema = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.Number,
  tasks: Schema.Array(TaskListItemSchema),
});

export type PersistedTaskList = typeof PersistedTaskListSchema.Type;

export const PersistedTaskListFromJson = Schema.fromJsonString(PersistedTaskListSchema);

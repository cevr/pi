import { Schema } from "effect";

export class TaskListStoreIoError extends Schema.TaggedErrorClass<TaskListStoreIoError>()(
  "TaskListStoreIoError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
  },
) {}

export class TaskListStoreDecodeError extends Schema.TaggedErrorClass<TaskListStoreDecodeError>()(
  "TaskListStoreDecodeError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
  },
) {}

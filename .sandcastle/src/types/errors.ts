import { Schema } from "effect";

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()("WorkflowError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class VerificationCheckError extends Schema.TaggedErrorClass<VerificationCheckError>()(
  "VerificationCheckError",
  {
    command: Schema.String,
    message: Schema.String,
    output: Schema.String,
  },
) {}

export class ExternalServiceError extends Schema.TaggedErrorClass<ExternalServiceError>()(
  "ExternalServiceError",
  {
    service: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  command: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  message: Schema.String,
}) {}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("DecodeError", {
  source: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

import { Effect, Schema } from "effect";
import type { WorkflowDefinition } from "./index";

/**
 * Executes a complete definition in memory for an Effect-aware unit test.
 * It deliberately makes no process-restart or durable-engine guarantee.
 */
export const executeWorkflow = <
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
>(
  definition: WorkflowDefinition<Input, Success, Failure>,
  input: unknown,
): Effect.Effect<
  Success["Type"],
  Failure["Type"] | Schema.SchemaError,
  Input["DecodingServices"]
> =>
  Schema.decodeUnknownEffect(definition.inputSchema)(input).pipe(
    Effect.flatMap((decoded) => definition.handler(decoded)),
  );

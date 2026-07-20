import { Effect } from "effect";
import { decodeJson } from "../../../shared/decoding";
import { ReviewDecision } from "../../../types/delivery";
import { WorkflowError } from "../../../types/errors";

const extractTaggedJson = Effect.fn("extractTaggedJson")(function* (output: string, tag: string) {
  const expression = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const json = [...output.matchAll(expression)].at(-1)?.[1];
  if (!json) {
    return yield* new WorkflowError({
      message: `Agent output is missing <${tag}> JSON`,
      operation: "delivery.extractAgentOutput",
    });
  }
  return json;
});

export const parseReviewDecision = Effect.fn("parseReviewDecision")(function* (output: string) {
  const json = yield* extractTaggedJson(output, "review");
  return yield* decodeJson(ReviewDecision, "review agent", json);
});

import type {
  InvocationDocument,
  InvocationTotals,
} from "@carere/kojo-client-contracts/contexts/client/contracts/invocation";

/** Keep missing measurements distinct from measured zero across implementation and repair calls. */
export const invocationTotals = (
  invocations: ReadonlyArray<InvocationDocument>,
): InvocationTotals => {
  const calls = [...new Map(invocations.map((call) => [call.invocationId, call])).values()];
  const sum = (
    field:
      | "inputTokens"
      | "cacheReadTokens"
      | "cacheWriteTokens"
      | "outputTokens"
      | "reportedCostUsd"
      | "estimatedCostUsd",
  ) => {
    const values = calls.flatMap((call) =>
      call.usage?.[field] === undefined ? [] : [call.usage[field]],
    );
    return values.length === 0
      ? {}
      : { [field]: values.reduce((total, value) => total + value, 0) };
  };
  return {
    count: calls.length,
    ...sum("inputTokens"),
    ...sum("cacheReadTokens"),
    ...sum("cacheWriteTokens"),
    ...sum("outputTokens"),
    usagePartial: calls.some((call) =>
      ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"].some(
        (field) =>
          call.usage?.[field as keyof NonNullable<InvocationDocument["usage"]>] === undefined,
      ),
    ),
    ...sum("reportedCostUsd"),
    reportedCostPartial: calls.some((call) => call.usage?.reportedCostUsd === undefined),
    ...sum("estimatedCostUsd"),
    estimatedCostPartial: calls.some((call) => call.usage?.estimatedCostUsd === undefined),
    estimateBases: [
      ...new Set(
        calls.flatMap((call) =>
          call.usage?.estimateBasis === undefined ? [] : [call.usage.estimateBasis],
        ),
      ),
    ],
  };
};

import { readFileSync } from "node:fs";
import { isTerminalRunUncertaintyResolved } from "@carere/kojo-client-contracts/contexts/client/contracts/run";

export interface ShippedRunEvidence {
  readonly valid: boolean;
  readonly diagnostic: string;
  readonly uncertainty: "absent" | "result-confirmed" | "invalid";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (diagnostic: string): ShippedRunEvidence => ({
  valid: false,
  diagnostic,
  uncertainty: "invalid",
});

export const shippedRunEvidence = (output: string): ShippedRunEvidence => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch (cause) {
    return invalid(
      `Run evidence is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isRecord(decoded) || !isRecord(decoded.run)) {
    return invalid("Run evidence has no Run document");
  }
  const run = decoded.run;
  if (run.state !== "succeeded") return invalid(`Run state is ${String(run.state)}`);
  for (const field of ["queueReason", "executionFault", "cancellation", "recovery", "cleanup"]) {
    if (Object.hasOwn(run, field)) return invalid(`terminal Run retains optional field ${field}`);
  }
  if (!Array.isArray(run.phases) || run.phases.length < 2) {
    return invalid("terminal Run has fewer than two Phases");
  }
  if (run.phases.some((phase) => isRecord(phase) && Object.hasOwn(phase, "errorTag"))) {
    return invalid("terminal Run retains a Phase error tag");
  }
  if (!Array.isArray(run.gates) || run.gates.length < 1) {
    return invalid("terminal Run has no Gate evidence");
  }
  if (!Array.isArray(run.sandboxes) || run.sandboxes.length < 2) {
    return invalid("terminal Run has fewer than two Sandbox records");
  }
  if (!Array.isArray(run.artifacts) || run.artifacts.length < 1) {
    return invalid("terminal Run has no Artifact evidence");
  }
  if (!Object.hasOwn(run, "uncertainty")) {
    return { valid: true, diagnostic: "terminal Run has no uncertainty", uncertainty: "absent" };
  }
  const uncertainty = run.uncertainty;
  if (!isTerminalRunUncertaintyResolved(uncertainty)) {
    if (!isRecord(uncertainty)) return invalid("terminal Run uncertainty is not a record");
    if (uncertainty.state === "result-confirmed") {
      return invalid("terminal result-confirmed uncertainty is malformed");
    }
    return invalid(`terminal Run uncertainty is ${String(uncertainty.state)}`);
  }
  return {
    valid: true,
    diagnostic: "terminal Run uncertainty is result-confirmed with original-result evidence",
    uncertainty: "result-confirmed",
  };
};

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined) throw new Error("usage: ShippedRunEvidence.ts RUN_STATUS_JSON");
  process.stdout.write(`${JSON.stringify(shippedRunEvidence(readFileSync(path, "utf8")))}\n`);
}

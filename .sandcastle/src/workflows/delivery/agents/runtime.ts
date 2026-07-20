import * as sandcastle from "@ai-hero/sandcastle";
import { Effect } from "effect";
import { tryExternalPromise } from "../../../shared/external-failure";
import { outputTail } from "../../../shared/process";
import type { PreparedTarget } from "../../../types/delivery";
import { VerificationCheckError, WorkflowError } from "../../../types/errors";
import { createSandboxProvider, hooks } from "./config";

export const runTargetAgent = (
  target: PreparedTarget,
  name: string,
  maxIterations: number,
  agent: sandcastle.AgentProvider,
  promptFile: string,
  promptArgs: sandcastle.PromptArgs,
) =>
  tryExternalPromise("sandcastle", `run ${name}`, (signal) =>
    sandcastle.run({
      agent,
      branchStrategy: { type: "head" },
      cwd: target.path,
      hooks,
      maxIterations,
      name,
      promptArgs,
      promptFile,
      sandbox: createSandboxProvider(),
      signal,
    }),
  );

export const sandboxRequired = Effect.fn("sandboxRequired")(function* (
  sandbox: sandcastle.Sandbox,
  command: string,
  label: string,
) {
  // Sandcastle 0.12 cannot cancel exec, so wait before a scope closes its active sandbox.
  const result = yield* tryExternalPromise("sandcastle", label, () =>
    sandbox.exec(command, { onLine: (line) => globalThis.console.log(`    ${line}`) }),
  ).pipe(Effect.uninterruptible);
  if (result.exitCode !== 0) {
    const detail = outputTail(
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
    );
    return yield* new WorkflowError({
      message: `${label} failed: ${detail}`,
      operation: "delivery.runSandboxCommand",
    });
  }
  return result.stdout.trim();
});

const verificationCheckRequired = Effect.fn("verificationCheckRequired")(function* (
  sandbox: sandcastle.Sandbox,
  command: string,
  label: string,
) {
  const result = yield* tryExternalPromise("sandcastle", label, () =>
    sandbox.exec(command, { onLine: (line) => globalThis.console.log(`    ${line}`) }),
  ).pipe(Effect.uninterruptible);
  if (result.exitCode !== 0) {
    const output = outputTail(
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
    );
    return yield* new VerificationCheckError({
      command,
      message: `${label} failed: ${output}`,
      output,
    });
  }
});

export const runSandboxChecks = Effect.fn("runSandboxChecks")(function* (
  sandbox: sandcastle.Sandbox,
) {
  yield* sandboxRequired(sandbox, "moon run :test", "tests");
  yield* sandboxRequired(sandbox, "moon run :check", "checks");
  yield* sandboxRequired(sandbox, "moon run :tsc", "typecheck");
});

export const runVerificationChecks = Effect.fn("runVerificationChecks")(function* (
  sandbox: sandcastle.Sandbox,
) {
  yield* verificationCheckRequired(sandbox, "moon run :test", "tests");
  yield* verificationCheckRequired(sandbox, "moon run :check", "checks");
  yield* verificationCheckRequired(sandbox, "moon run :tsc", "typecheck");
});

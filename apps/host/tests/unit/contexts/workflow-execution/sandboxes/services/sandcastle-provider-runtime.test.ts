import { expect, it } from "@effect/vitest";
import { ProjectIdentity } from "@kojo/control";
import { Effect, Exit, Schema } from "effect";
import { ProviderRuntime } from "../../../../../../src/contexts/workflow-execution/sandboxes/services/provider-runtime";
import { SandcastleProviderRuntimeLive } from "../../../../../../src/contexts/workflow-execution/sandboxes/services/sandcastle-provider-runtime";

it.effect("fails supported cleanup when a fresh layer has no recovered Provider session", () =>
  Effect.gen(function* () {
    const runtime = yield* ProviderRuntime;
    const result = yield* Effect.exit(
      runtime.cleanupRun?.(
        {
          identity: Schema.decodeUnknownSync(ProjectIdentity)(
            "00000000-0000-7000-8000-000000000001",
          ),
          path: "/project",
        },
        "run-with-persisted-provider",
        { capability: "supported" },
      ) ?? Effect.die("cleanupRun is not available"),
    );
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.provide(SandcastleProviderRuntimeLive)),
);

it.effect("does not invent a Provider warning for a run without Provider evidence", () =>
  Effect.gen(function* () {
    const runtime = yield* ProviderRuntime;
    const result = yield* Effect.exit(
      runtime.cleanupRun?.(
        {
          identity: Schema.decodeUnknownSync(ProjectIdentity)(
            "00000000-0000-7000-8000-000000000001",
          ),
          path: "/project",
        },
        "run-without-provider",
      ) ?? Effect.die("cleanupRun is not available"),
    );
    expect(Exit.isSuccess(result)).toBe(true);
  }).pipe(Effect.provide(SandcastleProviderRuntimeLive)),
);

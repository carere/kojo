import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InMemoryConfigurationRepository } from "../../../../../src/contexts/daemon/adapters/InMemoryConfigurationRepository.ts";
import { InMemoryRetentionRepository } from "../../../../../src/contexts/daemon/adapters/InMemoryRetentionRepository.ts";
import { ConfigurationApi } from "../../../../../src/contexts/daemon/services/ConfigurationApi.ts";

const retained = (stateFingerprint = "retained-1") =>
  new InMemoryRetentionRepository({
    runIds: ["run-eligible"],
    traceRunIds: ["run-eligible"],
    artifactIds: ["artifact-eligible"],
    protectedRunIds: ["run-protected"],
    stateFingerprint,
  });

const field = (
  status: { readonly fields: ReadonlyArray<{ readonly path: string }> },
  path: string,
) => status.fields.find((candidate) => candidate.path === path);

describe("operator configuration", () => {
  it.effect("rejects an unknown or conflicting patch without a partial change", () =>
    Effect.gen(function* () {
      const configuration = new InMemoryConfigurationRepository();
      const api = new ConfigurationApi({
        dataIdentity: "data-1",
        now: () => Date.parse("2026-09-01T10:00:00.000Z"),
        configuration,
        retention: retained(),
      });
      const applied = yield* api.apply(
        { scope: "daemon" },
        { set: { limits: { executingRuns: 2 } } },
      );
      expect(field(applied.status, "limits.executingRuns")).toMatchObject({
        effective: 2,
        default: 4,
        scope: "daemon",
        activation: "immediate",
      });
      const version = applied.status.stateVersion;
      const unknown = yield* Effect.flip(
        api.apply(
          { scope: "daemon" },
          { set: { limits: { newStartQueue: 5 }, secrets: { token: "no" } } },
        ),
      );
      expect(unknown.code).toBe("INVALID_CONFIGURATION_PATCH");
      const conflict = yield* Effect.flip(
        api.apply(
          { scope: "daemon" },
          { set: { limits: { executingRuns: 3 } }, reset: ["limits.executingRuns"] },
        ),
      );
      expect(conflict.code).toBe("INVALID_CONFIGURATION_PATCH");
      const emptyUnknown = yield* Effect.flip(
        api.apply({ scope: "daemon" }, { set: { secrets: {} } }),
      );
      expect(emptyUnknown.code).toBe("INVALID_CONFIGURATION_PATCH");
      const objectLeaf = yield* Effect.flip(
        api.apply({ scope: "daemon" }, { set: { limits: { executingRuns: {} } } }),
      );
      expect(objectLeaf.code).toBe("INVALID_CONFIGURATION_PATCH");
      const after = yield* api.status({ scope: "daemon" });
      expect(after.stateVersion).toBe(version);
      expect(field(after, "limits.executingRuns")).toMatchObject({ effective: 2 });
      expect(field(after, "limits.newStartQueue")).toMatchObject({ effective: 1_000 });
    }),
  );

  it.effect("expires a data-bound retention plan after ten minutes", () => {
    let now = Date.parse("2026-09-01T10:00:00.000Z");
    const configuration = new InMemoryConfigurationRepository();
    const api = new ConfigurationApi({
      dataIdentity: "data-1",
      now: () => now,
      configuration,
      retention: retained(),
    });
    return Effect.gen(function* () {
      const checked = yield* api.check(
        { scope: "daemon" },
        { set: { retention: { runHistoryMs: 1 } } },
      );
      expect(checked.plan?.impact).toMatchObject({
        runIds: ["run-eligible"],
        protectedRunIds: ["run-protected"],
      });
      now += 10 * 60_000;
      const failure = yield* Effect.flip(api.confirm(checked.plan?.planId ?? "missing"));
      expect(failure.code).toBe("CONFIGURATION_PLAN_EXPIRED");
      const status = yield* api.status({ scope: "daemon" });
      expect(field(status, "retention.runHistoryMs")).toMatchObject({
        effective: "indefinite",
      });
    });
  });

  it.effect("invalidates a plan after configuration or retained state changes", () =>
    Effect.gen(function* () {
      const configuration = new InMemoryConfigurationRepository();
      const retention = retained();
      const api = new ConfigurationApi({
        dataIdentity: "data-1",
        now: () => Date.parse("2026-09-01T10:00:00.000Z"),
        configuration,
        retention,
      });
      const configPlan = yield* api.check(
        { scope: "daemon" },
        { set: { retention: { traceMs: 1 } } },
      );
      yield* api.apply({ scope: "daemon" }, { set: { limits: { executingRuns: 3 } } });
      const configFailure = yield* Effect.flip(api.confirm(configPlan.plan?.planId ?? "missing"));
      expect(configFailure.code).toBe("CONFIGURATION_PLAN_STALE");

      const dataPlan = yield* api.check(
        { scope: "daemon" },
        { set: { retention: { artifactMs: 1 } } },
      );
      retention.replace({
        runIds: ["run-eligible", "run-new"],
        traceRunIds: ["run-eligible"],
        artifactIds: ["artifact-eligible"],
        protectedRunIds: ["run-protected"],
        stateFingerprint: "retained-2",
      });
      const dataFailure = yield* Effect.flip(api.confirm(dataPlan.plan?.planId ?? "missing"));
      expect(dataFailure.code).toBe("CONFIGURATION_PLAN_STALE");
    }),
  );

  it.effect("reports lifecycle settings as pending and Runner settings for future attempts", () =>
    Effect.gen(function* () {
      const api = new ConfigurationApi({
        dataIdentity: "data-1",
        now: () => Date.parse("2026-09-01T10:00:00.000Z"),
        configuration: new InMemoryConfigurationRepository(),
        retention: retained(),
      });
      const applied = yield* api.apply(
        { scope: "daemon" },
        {
          set: {
            daemon: { readinessMs: 1_000 },
            runner: { handshakeMs: 2_000 },
          },
        },
      );
      expect(applied.status.restartRequired).toBe(true);
      expect(field(applied.status, "daemon.readinessMs")).toMatchObject({
        effective: 60_000,
        pending: 1_000,
        activation: "lifecycle-restart",
      });
      expect(field(applied.status, "runner.handshakeMs")).toMatchObject({
        effective: 2_000,
        activation: "future-attempt",
      });
      const reset = yield* api.apply({ scope: "daemon" }, { reset: ["daemon.readinessMs"] });
      expect(reset.status.restartRequired).toBe(false);
      expect(field(reset.status, "daemon.readinessMs")).toMatchObject({
        effective: 60_000,
        activation: "lifecycle-restart",
      });
    }),
  );
});

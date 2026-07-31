import { expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot, RequestKey } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  emptyProjectIndexState,
  ProjectIndexRepository,
  type ProjectIndexRepositoryShape,
  type ProjectIndexState,
} from "../../../../../../src/contexts/workflow-authoring/projects/repositories/project-index-repository";
import { ProjectLayout } from "../../../../../../src/contexts/workflow-authoring/projects/services/project-layout";
import { ProjectRepository } from "../../../../../../src/contexts/workflow-execution/projects/repositories/project-repository";
import { ProjectRuntime } from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { WorkflowBackend } from "../../../../../../src/contexts/workflow-execution/projects/services/workflow-backend";
import {
  assessProjectReadiness,
  repairProjectReadiness,
} from "../../../../../../src/contexts/workflow-execution/readiness/use-cases/project-readiness";
import { WorkflowRunRepository } from "../../../../../../src/contexts/workflow-execution/runs/repositories/workflow-run-repository";
import { WorkflowScheduleRepository } from "../../../../../../src/contexts/workflow-execution/schedules/repositories/workflow-schedule-repository";

const identity = Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000036");
const project: ProjectSnapshot = { identity, path: "/projects/readiness" };
const requestKey = Schema.decodeUnknownSync(RequestKey)("readiness-repair-request");

const validDefinitions = {
  ok: true as const,
  snapshot: {
    snapshotId: "current",
    workflows: [
      {
        workflowKey: "available",
        revision: "current",
        inputSchemaFingerprint: "input",
        successSchemaFingerprint: "success",
        failureSchemaFingerprint: "failure",
        sourceIdentity: "source",
        sensitivity: { input: [], success: [], failure: [] },
        childWorkflowKeys: [],
        schedules: [],
      },
    ],
  },
};

const indexLayer = (projects: ReadonlyArray<ProjectSnapshot> = [project]) => {
  let state: ProjectIndexState = { ...emptyProjectIndexState(), projects: [...projects] };
  const service: ProjectIndexRepositoryShape = {
    read: Effect.sync(() => state),
    update: (change) =>
      Effect.flatMap(change(state), (result) =>
        Effect.sync(() => {
          state = result.state;
          return result.result;
        }),
      ),
  };
  return Layer.succeed(ProjectIndexRepository, service);
};

const runtimeLayer = (
  condition: "ready" | "limited" | "needs-attention" = "ready",
  definitions = validDefinitions.snapshot,
) =>
  Layer.succeed(ProjectRuntime, {
    readiness: () => Effect.succeed(condition),
    definitions: () => Effect.succeed(definitions),
  } as never);

const projectRepositoryLayer = (condition: "ready" | "limited" | "needs-attention" = "ready") =>
  Layer.succeed(ProjectRepository, {
    readiness: () => Effect.succeed(condition),
  } as never);

const backendLayer = (condition: "ready" | "uninitialized" | "needs-attention" = "ready") =>
  Layer.succeed(WorkflowBackend, { readiness: () => Effect.succeed(condition) } as never);

const repositoryLayers = (options?: {
  readonly runs?: ReadonlyArray<{
    readonly parentRunId: string | null;
    readonly runId: string;
    readonly workflowKey: string;
    readonly workflowRevision: string;
  }>;
  readonly schedules?: ReadonlyArray<{
    readonly condition: "available" | "unavailable" | "needs-attention";
    readonly enabledIntent: boolean;
    readonly scheduleKey: string;
  }>;
}) =>
  Layer.mergeAll(
    Layer.succeed(WorkflowRunRepository, {
      activeRuns: () => Effect.succeed(options?.runs ?? []),
    } as never),
    Layer.succeed(WorkflowScheduleRepository, {
      list: () => Effect.succeed(options?.schedules ?? []),
    } as never),
  );

it.effect(
  "reports safe guidance and preserves inspection when Project layout blocks execution",
  () => {
    const layer = Layer.mergeAll(
      indexLayer(),
      Layer.succeed(ProjectLayout, {
        inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
        validate: () =>
          Effect.succeed({
            ok: false as const,
            message: "The Project-local /.kojo/ ignore rule is missing.",
            findingKey: "layout.ignore-rule-missing" as const,
          }),
      }),
      runtimeLayer(),
      projectRepositoryLayer(),
      backendLayer(),
      repositoryLayers(),
    );

    return Effect.gen(function* () {
      const result = yield* assessProjectReadiness(identity);
      expect(result).toMatchObject({ ok: true, assessment: { condition: "needs-attention" } });
      if (!result.ok) return;
      expect(result.assessment).toMatchObject({
        project,
        condition: "needs-attention",
        capabilities: expect.any(Array),
        repairs: [],
      });
      expect(result.assessment.revision).toMatch(/^[0-9a-f]{24}$/u);
      expect(result.assessment.assessedAtMs).toBeGreaterThan(0);
      expect(result.assessment.findings).toMatchObject([
        {
          key: expect.any(String),
          code: "layout.ignore-rule-missing",
          affectedResource: { kind: "layout", path: project.path },
          blockedCapabilities: ["runs:recover", "runs:start", "schedules:process"],
          dependents: [],
          summary: "The Project-local /.kojo/ ignore rule is missing.",
          relevant: [],
          repairClass: "explicit",
          actions: [{ key: "layout.add-ignore-rule" }],
        },
      ]);
      expect(result.assessment.capabilities).toContainEqual({
        capability: "project:inspect",
        available: true,
        findingKeys: [],
      });
      expect(result.assessment.capabilities).toContainEqual({
        capability: "runs:start",
        available: false,
        findingKeys: ["layout.ignore-rule-missing"],
      });
      expect(result.assessment.findings[0]?.firstObservedAtMs).toBeGreaterThan(0);
      expect(result.assessment.findings[0]?.lastObservedAtMs).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("limits only unavailable Run recovery and enabled Schedule processing", () => {
  const layer = Layer.mergeAll(
    indexLayer(),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () => Effect.succeed({ ok: true as const, project, definitions: validDefinitions }),
    }),
    runtimeLayer(),
    projectRepositoryLayer(),
    backendLayer(),
    repositoryLayers({
      runs: [
        {
          runId: "parent",
          parentRunId: null,
          workflowKey: "available",
          workflowRevision: "current",
        },
        {
          runId: "child",
          parentRunId: "parent",
          workflowKey: "removed",
          workflowRevision: "old",
        },
      ],
      schedules: [
        { scheduleKey: "removed-schedule", enabledIntent: true, condition: "unavailable" },
      ],
    }),
  );

  return Effect.gen(function* () {
    const result = yield* assessProjectReadiness(identity);
    expect(result).toMatchObject({ ok: true, assessment: { condition: "limited" } });
    if (!result.ok) return;
    expect(result.assessment.findings).toMatchObject([
      {
        code: "workflow.revision-unavailable",
        affectedResource: { kind: "run", runId: "child" },
        dependents: [{ kind: "run", runId: "parent" }],
      },
      {
        code: "schedule.definition-unavailable",
        affectedResource: { kind: "schedule", scheduleKey: "removed-schedule" },
      },
    ]);
    expect(result.assessment.capabilities).toContainEqual({
      capability: "runs:recover",
      available: false,
      findingKeys: ["workflow.revision-unavailable"],
    });
    expect(result.assessment.capabilities).toContainEqual({
      capability: "runs:control",
      available: true,
      findingKeys: [],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("rejects stale repair requests before running a filesystem action", () => {
  const layer = Layer.mergeAll(
    indexLayer(),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () =>
        Effect.succeed({
          ok: false as const,
          message: "The Project-local /.kojo/ ignore rule is missing.",
          findingKey: "layout.ignore-rule-missing" as const,
        }),
      addIgnoreRule: () => Effect.die("A stale request must not repair the layout"),
    }),
    runtimeLayer(),
    projectRepositoryLayer(),
    backendLayer(),
    repositoryLayers(),
  );

  return Effect.gen(function* () {
    const result = yield* repairProjectReadiness({
      identity,
      assessmentRevision: "obsolete",
      action: "layout.add-ignore-rule",
      requestKey,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "stale-assessment" } });
  }).pipe(Effect.provide(layer));
});

it.effect("uses settled project-wide scopes for layout, identity, store, and engine damage", () => {
  const cases = [
    ["layout.path-conflict", "layout"],
    ["layout.symbolic-link", "layout"],
    ["layout.owner-invalid", "layout"],
    ["layout.permissions-invalid", "layout"],
    ["layout.version-unsupported", "layout"],
    ["layout.metadata-invalid", "layout"],
    ["project.identity-missing", "project"],
    ["project.identity-duplicate", "project"],
    ["store.missing", "store"],
    ["store.open-failed", "store"],
    ["store.integrity-failed", "store"],
    ["store.version-unsupported", "store"],
    ["store.migration-failed", "store"],
    ["engine.ownership-unavailable", "engine"],
    ["engine.global-state-invalid", "engine"],
    ["engine.execution-unowned", "engine"],
  ] as const;

  return Effect.forEach(cases, ([code, resourceKind]) => {
    const layer = Layer.mergeAll(
      indexLayer(),
      Layer.succeed(ProjectLayout, {
        inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
        validate: () =>
          Effect.succeed({
            ok: false as const,
            project,
            message: `Safe readiness finding: ${code}`,
            findingKey: code,
          }),
      }),
      runtimeLayer(),
      projectRepositoryLayer(),
      backendLayer(),
      repositoryLayers(),
    );
    return Effect.gen(function* () {
      const result = yield* assessProjectReadiness(identity);
      expect(result).toMatchObject({ ok: true, assessment: { condition: "needs-attention" } });
      if (!result.ok) return;
      expect(result.assessment.findings).toContainEqual(
        expect.objectContaining({
          code,
          affectedResource: expect.objectContaining({ kind: resourceKind }),
        }),
      );
      expect(result.assessment.capabilities).toContainEqual({
        capability: "runs:recover",
        available: false,
        findingKeys: [code],
      });
      expect(result.assessment.capabilities).toContainEqual({
        capability: "runs:control",
        available: true,
        findingKeys: [],
      });
    }).pipe(Effect.provide(layer));
  });
});

it.effect(
  "keeps compatible existing work available for a live invalid replacement and blocks cold recovery",
  () => {
    const invalidDefinitions = {
      ok: false as const,
      findingKey: "workflow.schema-invalid" as const,
      message: "Workflow Definition available has an invalid schema.",
      findings: [
        {
          findingKey: "workflow.schema-invalid" as const,
          workflowKey: "available",
          message: "Workflow Definition available has an invalid schema.",
        },
      ],
    };
    const existingRun = {
      runId: "existing",
      parentRunId: null,
      workflowKey: "available",
      workflowRevision: "current",
    };
    const layout = Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () =>
        Effect.succeed({ ok: true as const, project, definitions: invalidDefinitions }),
    });

    return Effect.gen(function* () {
      const live = yield* assessProjectReadiness(identity).pipe(
        Effect.provide(
          Layer.mergeAll(
            indexLayer(),
            layout,
            runtimeLayer("limited", validDefinitions.snapshot),
            projectRepositoryLayer(),
            backendLayer(),
            repositoryLayers({ runs: [existingRun] }),
          ),
        ),
      );
      expect(live).toMatchObject({ ok: true, assessment: { condition: "limited" } });
      if (live.ok) {
        expect(live.assessment.capabilities).toContainEqual({
          capability: "runs:recover",
          available: true,
          findingKeys: [],
        });
        expect(live.assessment.capabilities).toContainEqual({
          capability: "runs:start",
          available: false,
          findingKeys: ["workflow.schema-invalid"],
        });
        expect(live.assessment.capabilities).toContainEqual({
          capability: "schedules:process",
          available: false,
          findingKeys: ["workflow.schema-invalid"],
        });
        expect(live.assessment.findings).not.toContainEqual(
          expect.objectContaining({ code: "workflow.revision-unavailable" }),
        );
      }

      const cold = yield* assessProjectReadiness(identity).pipe(
        Effect.provide(
          Layer.mergeAll(
            indexLayer(),
            layout,
            Layer.succeed(ProjectRuntime, {
              readiness: () => Effect.succeed("needs-attention" as const),
              definitions: () => Effect.succeed(undefined),
            } as never),
            projectRepositoryLayer(),
            backendLayer(),
            repositoryLayers({ runs: [existingRun] }),
          ),
        ),
      );
      expect(cold).toMatchObject({ ok: true, assessment: { condition: "needs-attention" } });
      if (cold.ok) {
        expect(cold.assessment.capabilities).toContainEqual({
          capability: "runs:recover",
          available: false,
          findingKeys: expect.arrayContaining([
            "workflow.schema-invalid",
            "workflow.revision-unavailable",
          ]),
        });
      }
    });
  },
);

it.effect(
  "scopes every live configuration finding to current source and blocks only new work",
  () => {
    const cases = [
      ["dependency.workflow-package-missing", "configuration", undefined],
      ["dependency.workflow-package-incompatible", "configuration", undefined],
      ["configuration.missing", "configuration", undefined],
      ["configuration.load-failed", "configuration", undefined],
      ["configuration.invalid", "configuration", undefined],
      ["workflow.key-duplicate", "workflow", "available"],
      ["workflow.schema-invalid", "workflow", "available"],
      ["workflow.revision-conflict", "workflow", "available"],
      ["workflow.child-definition-missing", "workflow", "available"],
      ["schedule.key-duplicate", "workflow", "available"],
      ["schedule.definition-invalid", "workflow", "available"],
    ] as const;

    return Effect.forEach(cases, ([findingKey, resourceKind, workflowKey]) => {
      const definitions = {
        ok: false as const,
        findingKey,
        message: `Current source has ${findingKey}.`,
        findings: [
          {
            findingKey,
            message: `Current source has ${findingKey}.`,
            ...(workflowKey === undefined ? {} : { workflowKey }),
          },
        ],
      };
      const layer = Layer.mergeAll(
        indexLayer(),
        Layer.succeed(ProjectLayout, {
          inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
          validate: () => Effect.succeed({ ok: true as const, project, definitions }),
        }),
        runtimeLayer("limited", validDefinitions.snapshot),
        projectRepositoryLayer(),
        backendLayer(),
        repositoryLayers(),
      );
      return Effect.gen(function* () {
        const result = yield* assessProjectReadiness(identity);
        expect(result).toMatchObject({ ok: true, assessment: { condition: "limited" } });
        if (!result.ok) return;
        expect(result.assessment.findings).toContainEqual(
          expect.objectContaining({
            code: findingKey,
            affectedResource: expect.objectContaining({ kind: resourceKind }),
          }),
        );
        expect(result.assessment.capabilities).toContainEqual({
          capability: "runs:start",
          available: false,
          findingKeys: [findingKey],
        });
        expect(result.assessment.capabilities).toContainEqual({
          capability: "schedules:process",
          available: false,
          findingKeys: [findingKey],
        });
        expect(result.assessment.capabilities).toContainEqual({
          capability: "runs:recover",
          available: findingKey !== "workflow.revision-conflict",
          findingKeys: findingKey === "workflow.revision-conflict" ? [findingKey] : [],
        });
      }).pipe(Effect.provide(layer));
    });
  },
);

it.effect("keeps engine and Sandbox loss scoped to the affected Run and waiting parents", () => {
  const runs = [
    {
      runId: "parent",
      parentRunId: null,
      workflowKey: "available",
      workflowRevision: "current",
    },
    {
      runId: "child",
      parentRunId: "parent",
      workflowKey: "available",
      workflowRevision: "current",
    },
  ];
  const layer = Layer.mergeAll(
    indexLayer(),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () => Effect.succeed({ ok: true as const, project, definitions: validDefinitions }),
    }),
    runtimeLayer(),
    projectRepositoryLayer(),
    Layer.succeed(WorkflowBackend, {
      readiness: () => Effect.succeed("ready" as const),
      observe: (_project: ProjectSnapshot, reference: { readonly runId: string }) =>
        reference.runId === "child"
          ? Effect.die("The child engine execution disappeared")
          : Effect.succeed({ _tag: "Pending" as const }),
      inspectSandboxState: (_project: ProjectSnapshot, runId: string) =>
        Effect.succeed(runId === "child" ? [{ sandboxKey: "build", available: false }] : []),
    } as never),
    repositoryLayers({ runs }),
  );

  return Effect.gen(function* () {
    const result = yield* assessProjectReadiness(identity);
    expect(result).toMatchObject({ ok: true, assessment: { condition: "limited" } });
    if (!result.ok) return;
    expect(result.assessment.findings).toContainEqual(
      expect.objectContaining({
        code: "run.engine-state-missing",
        affectedResource: { kind: "run", identity, runId: "child" },
        dependents: [{ kind: "run", identity, runId: "parent" }],
      }),
    );
    expect(result.assessment.findings).toContainEqual(
      expect.objectContaining({
        code: "sandbox.state-missing",
        affectedResource: { kind: "sandbox", identity, runId: "child", sandboxKey: "build" },
        dependents: [{ kind: "run", identity, runId: "parent" }],
      }),
    );
    expect(result.assessment.capabilities).toContainEqual({
      capability: "runs:start",
      available: true,
      findingKeys: [],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reports successful proven automatic repairs instead of retaining their findings", () => {
  let artifactsMissing = true;
  let sandboxesMissing = true;
  const layer = Layer.mergeAll(
    indexLayer(),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () =>
        artifactsMissing || sandboxesMissing
          ? Effect.succeed({
              ok: false as const,
              project,
              message: "A generated Kojo directory is missing.",
              findingKey: "layout.path-conflict" as const,
            })
          : Effect.succeed({ ok: true as const, project, definitions: validDefinitions }),
      recreateArtifacts: () =>
        Effect.sync(() => {
          artifactsMissing = false;
          return true;
        }),
      recreateEmptySandboxes: () =>
        Effect.sync(() => {
          sandboxesMissing = false;
          return true;
        }),
    }),
    runtimeLayer(),
    projectRepositoryLayer(),
    backendLayer(),
    repositoryLayers(),
  );

  return Effect.gen(function* () {
    const result = yield* assessProjectReadiness(identity);
    expect(result).toMatchObject({ ok: true, assessment: { condition: "ready", findings: [] } });
    if (!result.ok) return;
    expect(result.assessment.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "layout.artifacts-recreated" }),
        expect.objectContaining({ code: "layout.empty-sandboxes-recreated" }),
      ]),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a failed automatic repair as an active finding", () => {
  const layer = Layer.mergeAll(
    indexLayer(),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () =>
        Effect.succeed({
          ok: false as const,
          project,
          message: "The artifacts path is not a safe directory.",
          findingKey: "layout.path-conflict" as const,
        }),
      recreateArtifacts: () => Effect.succeed(false),
      recreateEmptySandboxes: () => Effect.succeed(false),
    }),
    runtimeLayer(),
    projectRepositoryLayer(),
    backendLayer(),
    repositoryLayers(),
  );

  return Effect.gen(function* () {
    const result = yield* assessProjectReadiness(identity);
    expect(result).toMatchObject({ ok: true, assessment: { condition: "needs-attention" } });
    if (!result.ok) return;
    expect(result.assessment.findings).toContainEqual(
      expect.objectContaining({ code: "layout.path-conflict" }),
    );
    expect(result.assessment.repairs).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "rechecks and applies the ignore-rule repair only while its finding remains current",
  () => {
    let ignoreRuleMissing = true;
    let repairs = 0;
    const layer = Layer.mergeAll(
      indexLayer(),
      Layer.succeed(ProjectLayout, {
        inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
        validate: () =>
          ignoreRuleMissing
            ? Effect.succeed({
                ok: false as const,
                project,
                message: "The Project-local /.kojo/ ignore rule is missing.",
                findingKey: "layout.ignore-rule-missing" as const,
              })
            : Effect.succeed({ ok: true as const, project, definitions: validDefinitions }),
        addIgnoreRule: () =>
          Effect.sync(() => {
            repairs += 1;
            ignoreRuleMissing = false;
            return true;
          }),
      }),
      runtimeLayer(),
      projectRepositoryLayer(),
      backendLayer(),
      repositoryLayers(),
    );

    return Effect.gen(function* () {
      const assessment = yield* assessProjectReadiness(identity);
      if (!assessment.ok) return;
      const result = yield* repairProjectReadiness({
        identity,
        assessmentRevision: assessment.assessment.revision,
        action: "layout.add-ignore-rule",
        requestKey,
      });
      expect(repairs).toBe(1);
      expect(result).toMatchObject({ ok: true, assessment: { condition: "ready", findings: [] } });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("replaces missing Project data only through the explicit repair action", () => {
  let missingData = true;
  const layer = Layer.mergeAll(
    indexLayer(),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () =>
        missingData
          ? Effect.succeed({
              ok: false as const,
              project,
              message: "The Project database is missing.",
              findingKey: "store.missing" as const,
            })
          : Effect.succeed({ ok: true as const, project, definitions: validDefinitions }),
      replaceMissingData: () =>
        Effect.sync(() => {
          missingData = false;
          return true;
        }),
    }),
    runtimeLayer(),
    projectRepositoryLayer(),
    backendLayer(),
    repositoryLayers(),
  );

  return Effect.gen(function* () {
    const assessment = yield* assessProjectReadiness(identity);
    if (!assessment.ok) return;
    const result = yield* repairProjectReadiness({
      identity,
      assessmentRevision: assessment.assessment.revision,
      action: "project.replace-missing-data",
      requestKey,
    });
    expect(result).toMatchObject({ ok: true, assessment: { condition: "ready", findings: [] } });
  }).pipe(Effect.provide(layer));
});

it.effect("assigns a new identity only to the repaired duplicate Project path", () => {
  const duplicatePathProject = { ...project, path: "/projects/readiness-copy" };
  const replacement = {
    identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000037"),
    path: project.path,
  };
  let currentProject = project;
  const layer = Layer.mergeAll(
    indexLayer([project, duplicatePathProject]),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: (path) =>
        Effect.succeed({
          ok: true as const,
          project: path === duplicatePathProject.path ? duplicatePathProject : currentProject,
          definitions: validDefinitions,
        }),
      assignNewIdentity: () =>
        Effect.sync(() => {
          currentProject = replacement;
          return replacement;
        }),
    }),
    runtimeLayer(),
    projectRepositoryLayer(),
    backendLayer(),
    repositoryLayers(),
  );

  return Effect.gen(function* () {
    const assessment = yield* assessProjectReadiness(identity);
    if (!assessment.ok) return;
    const result = yield* repairProjectReadiness({
      identity,
      assessmentRevision: assessment.assessment.revision,
      action: "project.assign-new-identity",
      requestKey,
    });
    expect(result).toMatchObject({
      ok: true,
      assessment: { project: replacement, condition: "ready", findings: [] },
    });
    const duplicate = yield* assessProjectReadiness(identity);
    expect(duplicate).toMatchObject({ ok: true, assessment: { project: duplicatePathProject } });
  }).pipe(Effect.provide(layer));
});

it.effect("retries a failed migration only after reassessing its repair preconditions", () => {
  let migrationFailed = true;
  let retried = 0;
  const layer = Layer.mergeAll(
    indexLayer(),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () => Effect.succeed({ ok: true as const, project, definitions: validDefinitions }),
    }),
    Layer.succeed(ProjectRuntime, {
      readiness: () => Effect.succeed(migrationFailed ? ("limited" as const) : ("ready" as const)),
      definitions: () => Effect.succeed(validDefinitions.snapshot),
    } as never),
    Layer.succeed(ProjectRepository, {
      readiness: () => Effect.succeed(migrationFailed ? ("limited" as const) : ("ready" as const)),
      retryMigration: () =>
        Effect.sync(() => {
          retried += 1;
          migrationFailed = false;
        }),
    } as never),
    backendLayer(),
    repositoryLayers(),
  );

  return Effect.gen(function* () {
    const assessment = yield* assessProjectReadiness(identity);
    if (!assessment.ok) return;
    expect(assessment.assessment.findings).toContainEqual(
      expect.objectContaining({ code: "store.migration-failed" }),
    );
    const result = yield* repairProjectReadiness({
      identity,
      assessmentRevision: assessment.assessment.revision,
      action: "store.retry-migration",
      requestKey,
    });
    expect(retried).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      assessment: {
        condition: "ready",
        repairs: [expect.objectContaining({ code: "store.migrated" })],
      },
    });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "refreshes a current assessment and rejects actions that no current finding permits",
  () => {
    const layer = Layer.mergeAll(
      indexLayer(),
      Layer.succeed(ProjectLayout, {
        inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
        validate: () =>
          Effect.succeed({ ok: true as const, project, definitions: validDefinitions }),
      }),
      runtimeLayer(),
      projectRepositoryLayer(),
      backendLayer(),
      repositoryLayers(),
    );

    return Effect.gen(function* () {
      const assessment = yield* assessProjectReadiness(identity);
      if (!assessment.ok) return;
      const refreshed = yield* repairProjectReadiness({
        identity,
        assessmentRevision: assessment.assessment.revision,
        action: "readiness.refresh",
        requestKey,
      });
      expect(refreshed).toMatchObject({ ok: true, assessment: { condition: "ready" } });
      const rejected = yield* repairProjectReadiness({
        identity,
        assessmentRevision: assessment.assessment.revision,
        action: "store.retry-migration",
        requestKey,
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: "repair-not-available" } });
    }).pipe(Effect.provide(layer));
  },
);

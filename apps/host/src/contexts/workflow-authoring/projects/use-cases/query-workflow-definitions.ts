import type {
  ProjectIdentity,
  ProjectWorkflowQueryResult,
  WorkflowDefinitionQueryResult,
} from "@kojo/control";
import { Effect } from "effect";
import { ProjectRuntime } from "../../../workflow-execution/projects/services/project-runtime";
import { ProjectIndexRepository } from "../repositories/project-index-repository";
import { ProjectLayout } from "../services/project-layout";
import { operationError } from "./project-operation-results";

const missingProject = (identity: ProjectIdentity) => ({
  ok: false as const,
  error: operationError(
    "project-not-found",
    "Kojo Project was not found in the Project Index.",
    "Register the Project or choose a listed Project Identity.",
    { kind: "project", identity },
    [],
  ),
});

export const listWorkflowDefinitions = (
  identity: ProjectIdentity,
): Effect.Effect<
  ProjectWorkflowQueryResult,
  never,
  ProjectIndexRepository | ProjectLayout | ProjectRuntime
> =>
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const indexed = (yield* index.read).projects.find((project) => project.identity === identity);
    if (indexed === undefined) return missingProject(identity);
    const validation = yield* layout.validate(indexed.path);
    if (!validation.ok) {
      return {
        ok: false as const,
        error: operationError(
          "project-layout-invalid",
          validation.message,
          "Correct the Project layout and retry.",
          { kind: "project", identity },
          [validation.findingKey],
        ),
      };
    }
    const definitions = yield* runtime.acceptDefinitions(
      validation.project,
      validation.definitions,
    );
    if (definitions === undefined) {
      const current = validation.definitions;
      return {
        ok: false as const,
        error: operationError(
          "project-layout-invalid",
          current.ok ? "Kojo Configuration has not been accepted." : current.message,
          "Correct the Kojo Configuration and retry.",
          { kind: "project", identity },
          current.ok ? [] : current.findings.map((finding) => finding.findingKey),
        ),
      };
    }
    return { ok: true as const, snapshot: { project: validation.project, definitions } };
  });

export const showWorkflowDefinition = (
  identity: ProjectIdentity,
  workflowKey: string,
): Effect.Effect<
  WorkflowDefinitionQueryResult,
  never,
  ProjectIndexRepository | ProjectLayout | ProjectRuntime
> =>
  Effect.gen(function* () {
    const result = yield* listWorkflowDefinitions(identity);
    if (!result.ok) return { ok: false as const, error: result.error };
    const workflow = result.snapshot.definitions.workflows.find(
      (candidate) => candidate.workflowKey === workflowKey,
    );
    return workflow === undefined
      ? {
          ok: false as const,
          error: operationError(
            "project-not-found",
            `Workflow Definition ${workflowKey} was not found in the accepted Project snapshot.`,
            "List accepted Workflow Definitions and choose a Workflow Key from that snapshot.",
            { kind: "project", identity },
            [],
          ),
        }
      : {
          ok: true as const,
          project: result.snapshot.project,
          snapshotId: result.snapshot.definitions.snapshotId,
          workflow,
        };
  });

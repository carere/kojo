import type {
  ProjectIdentity,
  ProjectReadinessRepairNotice,
  ProjectSnapshot,
  ReadinessFindingKey,
} from "@kojo/control";
import type { ProjectDefinitionValidation } from "@kojo/control/project-definition-validation";
import { Context, type Effect } from "effect";

export type ProjectLayoutValidation =
  | {
      readonly ok: true;
      readonly project: ProjectSnapshot;
      readonly definitions: ProjectDefinitionValidation;
      readonly repairs?: ReadonlyArray<ProjectLayoutRepair>;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly findingKey: ReadinessFindingKey;
      /** Every independent layout check that could run from the canonical root. */
      readonly findings?: ReadonlyArray<{
        readonly findingKey: ReadinessFindingKey;
        readonly message: string;
      }>;
      /** Configuration findings remain available even when layout is also damaged. */
      readonly definitions?: ProjectDefinitionValidation;
      readonly project?: ProjectSnapshot;
      readonly repairs?: ReadonlyArray<ProjectLayoutRepair>;
    };

/** A repair that validation proved lossless while checking the owned layout. */
export interface ProjectLayoutRepair {
  readonly code: Extract<ProjectReadinessRepairNotice["code"], "layout.permissions-tightened">;
  readonly path: string;
  readonly summary: string;
}

export type IndexedProjectPath =
  | { readonly status: "missing" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly identity: ProjectIdentity };

export interface ProjectLayoutShape {
  readonly inspectIndexedPath: (path: string) => Effect.Effect<IndexedProjectPath>;
  readonly validate: (path: string) => Effect.Effect<ProjectLayoutValidation>;
  /** Lossless mutations exposed only through the readiness repair protocol. */
  readonly addIgnoreRule?: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly assignNewIdentity?: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ProjectSnapshot | undefined>;
  readonly replaceMissingData?: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  /** Recreates only a missing owned artifacts directory; never replaces data. */
  readonly recreateArtifacts?: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  /** Recreates Sandboxes only after readiness proves no non-final Run needs them. */
  readonly recreateEmptySandboxes?: (project: ProjectSnapshot) => Effect.Effect<boolean>;
}

export class ProjectLayout extends Context.Service<ProjectLayout, ProjectLayoutShape>()(
  "kojo/host/ProjectLayout",
) {}

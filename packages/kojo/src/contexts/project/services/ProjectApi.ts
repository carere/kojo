import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  decodeMutationEnvelope,
  type MutationEnvelope,
} from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type {
  OperationReceipt,
  OperationRefusal,
} from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type {
  ClientRequestDocument,
  ProjectCounts,
  ProjectLocationAction,
  ProjectSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type {
  WorkflowCounts,
  WorkflowSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { Effect } from "effect";
import type { ClientRequestRepository } from "../../daemon/ports/ClientRequestRepository.ts";
import type { FactoryRefreshObservation } from "../../workflow/models/FactoryRefresh.ts";
import { RevisionCaptureError } from "../../workflow/models/RevisionCaptureError.ts";
import type { ProjectRunControl } from "../../workflow/ports/RunControl.ts";
import { refreshFactory } from "../../workflow/services/refreshFactory.ts";
import { ProjectStoreError } from "../models/ProjectStoreError.ts";
import type { DaemonProjectRepository } from "../ports/DaemonProjectRepository.ts";
import { exactGitWorkingTree } from "./gitWorkingTree.ts";

const response = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refusal = (error: ProjectStoreError, requestId: string, dataIdentity: string): Response => {
  const body: OperationRefusal = {
    refusalVersion: 1,
    requestId,
    dataIdentity,
    problem: {
      problemVersion: 1,
      code: error.code,
      scope: { identityVersion: 1, kind: "clientRequest", parts: [requestId] },
      retry: error.retry,
      remedy: error.remedy,
      diagnostic: error.message,
    },
  };
  return response(body, error.status);
};

const invalid = (message: string): ProjectStoreError =>
  new ProjectStoreError({
    code: "INVALID_PROJECT_REQUEST",
    message,
    status: 422,
    retry: "never",
    remedy: "Prepare a registerProject request with one canonical location.",
  });

const registrationLocation = (request: MutationEnvelope, dataIdentity: string): string => {
  if (
    request.dataIdentity !== dataIdentity ||
    request.operation !== "registerProject" ||
    request.target.kind !== "daemonData" ||
    request.target.parts.length !== 1 ||
    request.target.parts[0] !== dataIdentity ||
    Object.keys(request.preconditions).length !== 0 ||
    Object.keys(request.arguments).length !== 1 ||
    typeof request.arguments.location !== "string"
  ) {
    throw invalid("The request does not match the Daemon Project registration contract.");
  }
  return request.arguments.location;
};

const countsOf = (projects: ProjectSnapshot["projects"]): ProjectCounts => ({
  total: projects.length,
  available: projects.filter((project) => project.projectState === "available").length,
  unavailable: projects.filter((project) => project.projectState === "unavailable").length,
  archived: projects.filter((project) => project.projectState === "archived").length,
  missingFactories: projects.filter((project) => project.factoryState === "missing").length,
  invalidFactories: projects.filter((project) => project.factoryState === "invalid").length,
});

const workflowCountsOf = (workflows: WorkflowSnapshot["workflows"]): WorkflowCounts => ({
  total: workflows.length,
  available: workflows.filter((workflow) => workflow.availability === "available").length,
  invalid: workflows.filter((workflow) => workflow.availability === "invalid").length,
  removed: workflows.filter((workflow) => workflow.availability === "removed").length,
  active: workflows.filter((workflow) => workflow.activity === "active").length,
});

export class ProjectApi {
  readonly #dataIdentity: string;
  readonly #dataRoot: string;
  readonly #instanceId: string;
  readonly #journal: ClientRequestRepository;
  readonly #now: () => number;
  readonly #repository: DaemonProjectRepository;
  readonly #runs: ProjectRunControl;
  readonly #worktrees: string;

  constructor(options: {
    readonly dataIdentity: string;
    readonly instanceId: string;
    readonly journal: ClientRequestRepository;
    readonly now: () => number;
    readonly repository: DaemonProjectRepository;
    readonly dataRoot: string;
    readonly runs: ProjectRunControl;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#dataRoot = options.dataRoot;
    this.#instanceId = options.instanceId;
    this.#journal = options.journal;
    this.#now = options.now;
    this.#repository = options.repository;
    this.#runs = options.runs;
    this.#worktrees = join(options.dataRoot, "worktrees");
  }

  snapshot(): Effect.Effect<Response> {
    return Effect.promise(async () => {
      try {
        let projects = await Effect.runPromise(this.#repository.projects);
        const missing = projects
          .filter(
            (project) =>
              project.locationActive &&
              project.projectState === "available" &&
              !existsSync(project.location),
          )
          .map((project) => project.location);
        if (missing.length > 0) {
          await Effect.runPromise(
            this.#repository.markMissingLocations(missing, new Date(this.#now()).toISOString()),
          );
          await Promise.all(
            projects
              .filter((project) => missing.includes(project.location))
              .map((project) =>
                Effect.runPromise(
                  this.#runs.holdProjectDispatch(project.projectId, "Project location unavailable"),
                ),
              ),
          );
          projects = await Effect.runPromise(this.#repository.projects);
        }
        const snapshotVersion = await Effect.runPromise(this.#repository.snapshotVersion);
        const body: ProjectSnapshot = {
          observationVersion: 1,
          instanceId: this.#instanceId,
          dataIdentity: this.#dataIdentity,
          snapshotVersion,
          observedAt: new Date(this.#now()).toISOString(),
          refreshAfterMillis: 1_000,
          counts: countsOf(projects),
          projects,
        };
        return response(body);
      } catch (cause) {
        return refusal(
          cause instanceof ProjectStoreError ? cause : invalid(String(cause)),
          "snapshot",
          this.#dataIdentity,
        );
      }
    });
  }

  locationChange(
    projectId: string,
    action: ProjectLocationAction,
    input: unknown,
  ): Effect.Effect<Response> {
    return Effect.promise(async () => {
      let requestId = "invalid";
      try {
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
          throw invalid("The Project location request must be one JSON object.");
        }
        const body = input as Record<string, unknown>;
        requestId = typeof body.requestId === "string" ? body.requestId : "invalid";
        if (
          Object.keys(body).some(
            (key) => !["requestId", "dataIdentity", "location", "confirm"].includes(key),
          ) ||
          typeof body.requestId !== "string" ||
          body.dataIdentity !== this.#dataIdentity
        ) {
          throw invalid("The Project location request does not match this Daemon data lifetime.");
        }
        let requestedLocation: string | undefined;
        if (action !== "archive") {
          if (typeof body.location !== "string") {
            throw invalid("Relocate and restore need one exact Git working-tree root.");
          }
          requestedLocation = exactGitWorkingTree(body.location, this.#worktrees);
          if (requestedLocation !== body.location) {
            throw invalid("The Daemon resolved a different Project location.");
          }
          if (body.confirm !== true) {
            throw new ProjectStoreError({
              code: "PROJECT_LOCATION_CONFIRMATION_REQUIRED",
              message: "A Project location change needs explicit confirmation.",
              status: 409,
              retry: "never",
              remedy:
                "Confirm that Workflows become inactive while retained Runs keep their pinned revisions.",
            });
          }
        } else if (body.location !== undefined || body.confirm !== true) {
          throw new ProjectStoreError({
            code: "PROJECT_ARCHIVE_CONFIRMATION_REQUIRED",
            message: "Archiving needs explicit confirmation and does not accept a location.",
            status: 409,
            retry: "never",
            remedy:
              "Confirm that the Project becomes Archived and its active location is released.",
          });
        }
        const changedAt = new Date(this.#now()).toISOString();
        const retainedRequest: MutationEnvelope = {
          mutationVersion: 1,
          requestId,
          dataIdentity: this.#dataIdentity,
          operation: `${action}Project`,
          target: { identityVersion: 1, kind: "project", parts: [projectId] },
          arguments: {
            confirm: true,
            ...(requestedLocation === undefined ? {} : { location: requestedLocation }),
          },
          preconditions: {},
        };
        this.#journal.prepare(retainedRequest);
        const requestBody = JSON.stringify(retainedRequest);
        const accepted = await Effect.runPromise(
          this.#repository.beginLocationChange({
            requestId,
            requestBody,
            dataIdentity: this.#dataIdentity,
            projectId,
            action,
            ...(requestedLocation === undefined ? {} : { requestedLocation }),
            changedAt,
          }),
        );
        if (accepted.status === "committed") return response(accepted);
        await Effect.runPromise(this.#runs.drainProject(projectId));
        await Effect.runPromise(
          this.#repository.commitLocationChange({
            requestId,
            dataIdentity: this.#dataIdentity,
            projectId,
            action,
            changedAt: new Date(this.#now()).toISOString(),
          }),
        );
        if (action !== "archive") this.#runs.releaseProjectDispatch(projectId);
        const receipt = await Effect.runPromise(
          this.#repository.receipt(this.#dataIdentity, requestId),
        );
        if (receipt === undefined)
          throw new Error("the committed Project receipt was not retained");
        return response(receipt);
      } catch (cause) {
        return refusal(
          cause instanceof ProjectStoreError
            ? cause
            : new ProjectStoreError({
                code: "PROJECT_LOCATION_CHANGE_REFUSED",
                message: cause instanceof Error ? cause.message : String(cause),
                status: 409,
                retry: "safe",
                remedy:
                  "Inspect the Project drain, Project recovery, and Resource leases before retrying this request.",
              }),
          requestId,
          this.#dataIdentity,
        );
      }
    });
  }

  workflowSnapshot(projectId?: string): Effect.Effect<Response> {
    return Effect.promise(async () => {
      try {
        const [all, snapshotVersion] = await Promise.all([
          Effect.runPromise(this.#repository.workflows),
          Effect.runPromise(this.#repository.snapshotVersion),
        ]);
        const workflows =
          projectId === undefined
            ? all
            : all.filter((workflow) => workflow.projectId === projectId);
        const body: WorkflowSnapshot = {
          observationVersion: 1,
          instanceId: this.#instanceId,
          dataIdentity: this.#dataIdentity,
          snapshotVersion,
          observedAt: new Date(this.#now()).toISOString(),
          refreshAfterMillis: 1_000,
          counts: workflowCountsOf(workflows),
          workflows,
        };
        return response(body);
      } catch (cause) {
        return refusal(
          cause instanceof ProjectStoreError ? cause : invalid(String(cause)),
          "workflow-snapshot",
          this.#dataIdentity,
        );
      }
    });
  }

  prepare(requestId: string, input: unknown): Effect.Effect<Response> {
    return Effect.sync(() => {
      const decoded = decodeMutationEnvelope(input);
      if (!decoded.ok || decoded.value.requestId !== requestId) {
        return refusal(
          invalid("The prepared request body is invalid."),
          requestId,
          this.#dataIdentity,
        );
      }
      try {
        registrationLocation(decoded.value, this.#dataIdentity);
        this.#journal.prepare(decoded.value);
        return response({ request: decoded.value } satisfies ClientRequestDocument, 201);
      } catch (cause) {
        return refusal(
          cause instanceof ProjectStoreError ? cause : invalid(String(cause)),
          requestId,
          this.#dataIdentity,
        );
      }
    });
  }

  lookup(requestId: string): Effect.Effect<Response> {
    return Effect.promise(async () => {
      try {
        const retained = this.#journal.lookup(requestId);
        if (retained === undefined) {
          return refusal(
            new ProjectStoreError({
              code: "CLIENT_REQUEST_NOT_FOUND",
              message: "The client request does not exist.",
              status: 404,
              retry: "never",
              remedy: "Use a request ID from this Daemon data lifetime.",
            }),
            requestId,
            this.#dataIdentity,
          );
        }
        const receipt = await Effect.runPromise(
          this.#repository.receipt(this.#dataIdentity, requestId),
        );
        const document: ClientRequestDocument = {
          request: retained.request,
          ...(receipt === undefined ? {} : { receipt }),
        };
        return response(document);
      } catch (cause) {
        return refusal(
          cause instanceof ProjectStoreError ? cause : invalid(String(cause)),
          requestId,
          this.#dataIdentity,
        );
      }
    });
  }

  retry(requestId: string): Effect.Effect<Response> {
    return Effect.promise(async () => {
      try {
        const retained = this.#journal.lookup(requestId);
        if (retained === undefined) {
          return refusal(
            new ProjectStoreError({
              code: "CLIENT_REQUEST_NOT_FOUND",
              message: "The client request does not exist.",
              status: 404,
              retry: "never",
              remedy: "Prepare the exact request before it is sent.",
            }),
            requestId,
            this.#dataIdentity,
          );
        }
        const locationOperation = retained.request.operation.match(
          /^(relocate|archive|restore)Project$/,
        );
        if (
          locationOperation !== null &&
          retained.request.target.kind === "project" &&
          typeof retained.request.target.parts[0] === "string"
        ) {
          return await Effect.runPromise(
            this.locationChange(
              retained.request.target.parts[0],
              locationOperation[1] as ProjectLocationAction,
              {
                requestId,
                dataIdentity: this.#dataIdentity,
                confirm: true,
                ...(typeof retained.request.arguments.location === "string"
                  ? { location: retained.request.arguments.location }
                  : {}),
              },
            ),
          );
        }
        const sentLocation = registrationLocation(retained.request, this.#dataIdentity);
        const location = exactGitWorkingTree(sentLocation, this.#worktrees);
        if (location !== sentLocation)
          throw invalid("The Daemon resolved a different Project location.");
        let factory: {
          readonly state: "missing" | "invalid" | "available";
          readonly refreshState: "current" | "failed" | "pending";
          readonly workflows: FactoryRefreshObservation["workflows"];
          readonly fault?: string;
          readonly remedy?: string;
        };
        try {
          const refreshed = await Effect.runPromise(
            refreshFactory({ project: location, dataRoot: this.#dataRoot }),
          );
          factory = {
            state: refreshed.factoryState,
            refreshState: "current",
            workflows: refreshed.workflows,
            ...(refreshed.fault === undefined ? {} : { fault: refreshed.fault }),
            ...(refreshed.remedy === undefined ? {} : { remedy: refreshed.remedy }),
          };
        } catch (cause) {
          const error =
            cause instanceof RevisionCaptureError
              ? cause
              : new RevisionCaptureError({
                  code: "CAPTURE_FAILED",
                  message: cause instanceof Error ? cause.message : String(cause),
                  remedy: "Retry Factory Refresh after the operational fault is repaired.",
                  cause,
                });
          factory = {
            state: existsSync(join(location, ".kojo")) ? "available" : "missing",
            refreshState: error.code === "REFRESH_UNSTABLE" ? "pending" : "failed",
            workflows: [],
            fault: error.message,
            remedy: error.remedy,
          };
        }
        await Effect.runPromise(
          this.#repository.register({
            requestId,
            requestBody: retained.body,
            dataIdentity: this.#dataIdentity,
            location,
            observedAt: new Date(this.#now()).toISOString(),
            factory,
          }),
        );
        const receipt = await Effect.runPromise(
          this.#repository.receipt(this.#dataIdentity, requestId),
        );
        if (receipt === undefined) throw new Error("the committed receipt could not be read");
        return response(receipt satisfies OperationReceipt);
      } catch (cause) {
        return refusal(
          cause instanceof ProjectStoreError ? cause : invalid(String(cause)),
          requestId,
          this.#dataIdentity,
        );
      }
    });
  }
}

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
  ProjectSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Effect } from "effect";
import type { HostClientRequestJournal } from "../../daemon/adapters/HostClientRequestJournal.ts";
import type { SqliteProjectRepository } from "../adapters/SqliteProjectRepository.ts";
import { ProjectStoreError } from "../models/ProjectStoreError.ts";
import { exactGitWorkingTree } from "./gitWorkingTree.ts";
import { inspectFactory } from "./inspectFactory.ts";

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

export class ProjectApi {
  readonly #dataIdentity: string;
  readonly #instanceId: string;
  readonly #journal: HostClientRequestJournal;
  readonly #now: () => number;
  readonly #repository: SqliteProjectRepository;
  readonly #worktrees: string;

  constructor(options: {
    readonly dataIdentity: string;
    readonly instanceId: string;
    readonly journal: HostClientRequestJournal;
    readonly now: () => number;
    readonly repository: SqliteProjectRepository;
    readonly dataRoot: string;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#instanceId = options.instanceId;
    this.#journal = options.journal;
    this.#now = options.now;
    this.#repository = options.repository;
    this.#worktrees = join(options.dataRoot, "worktrees");
  }

  snapshot(): Effect.Effect<Response> {
    return Effect.promise(async () => {
      try {
        const [projects, snapshotVersion] = await Promise.all([
          Effect.runPromise(this.#repository.projects),
          Effect.runPromise(this.#repository.snapshotVersion),
        ]);
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
        const sentLocation = registrationLocation(retained.request, this.#dataIdentity);
        const location = exactGitWorkingTree(sentLocation, this.#worktrees);
        if (location !== sentLocation)
          throw invalid("The Daemon resolved a different Project location.");
        const factory = await Effect.runPromise(inspectFactory(location));
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

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { BootstrapResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/bootstrap";
import type {
  BrowserSessionRequest,
  BrowserSessionResponse,
  DaemonDocument,
} from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import type { RecordVerdictRequest } from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import {
  decodeJsonValue,
  type JsonValue,
} from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Cause, Effect, Option } from "effect";
import type { GateApi } from "../../gate/services/GateApi.ts";
import type { SqliteProjectRepository } from "../../project/adapters/SqliteProjectRepository.ts";
import type { ProjectApi } from "../../project/services/ProjectApi.ts";
import type { AtomicArtifactRepository } from "../../trace/adapters/AtomicArtifactRepository.ts";
import type { SqliteRevisionRepository } from "../../workflow/adapters/SqliteRevisionRepository.ts";
import type { RunCoordinator } from "../../workflow/services/RunCoordinator.ts";
import { readCheckedManagedRelease } from "../adapters/ManagedInstallation.ts";
import type { ConsoleRelease } from "../models/ConsoleRelease.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import { activeConsoleRelease } from "../services/activeConsoleRelease.ts";
import type { BrowserAuthority } from "../services/browserAuthority.ts";
import type { ClientMutationBoundary } from "../services/ClientMutationBoundary.ts";
import type { ConfigurationApi } from "../services/ConfigurationApi.ts";
import {
  consoleAsset,
  isJson,
  noStoreJson,
  problem,
  requestJson,
  withOrdinaryMutation,
} from "../services/DaemonHttp.ts";
import type { DaemonMutationGate } from "../services/DaemonMutationGate.ts";
import type { DaemonNotifications } from "../services/DaemonNotifications.ts";
import type { ManagedUpgradePreflight } from "../services/ManagedUpgradePreflight.ts";

export interface DaemonHttpApplication {
  readonly consoleServer: Bun.Server<unknown>;
  readonly endpoint: DaemonEndpoint;
  readonly socketServer: Bun.Server<unknown>;
}

export const startDaemonHttpApplication = (options: {
  readonly artifactRepository: AtomicArtifactRepository;
  readonly authority: BrowserAuthority;
  readonly clientRequests: ClientMutationBoundary;
  readonly configurationApi: ConfigurationApi;
  readonly consolePort?: number;
  readonly dataIdentity: string;
  readonly database: Database;
  readonly gateApi: GateApi;
  readonly instanceId: string;
  readonly mutationGate: DaemonMutationGate;
  readonly notifications: DaemonNotifications;
  readonly now: () => number;
  readonly paths: DaemonPaths;
  readonly projectApi: ProjectApi;
  readonly projectRepository: SqliteProjectRepository;
  readonly recordOperationSuccess?: () => void;
  readonly release: ConsoleRelease;
  readonly revisionRepository: SqliteRevisionRepository;
  readonly runApi: RunCoordinator;
  readonly socketPath: string;
  readonly sourceManifest: string;
  readonly sourceManifestPath: string;
  readonly startedAt: string;
  readonly upgradePreflight: ManagedUpgradePreflight;
}): DaemonHttpApplication => {
  const {
    artifactRepository,
    authority,
    clientRequests,
    configurationApi,
    dataIdentity,
    database,
    gateApi,
    instanceId,
    mutationGate,
    notifications,
    now,
    paths,
    projectApi,
    projectRepository,
    release,
    revisionRepository,
    runApi,
    socketPath,
    sourceManifest,
    sourceManifestPath,
    startedAt,
    upgradePreflight,
  } = options;
  let consoleServer: Bun.Server<unknown> | undefined;
  const ownerDatabase = database;
  const mutationOf = async (
    request: Request,
    operation: string,
    targetKind: string,
  ): Promise<MutationEnvelope> =>
    clientRequests.requireKind(await requestJson(request), operation, targetKind);

  const outcomeResponse = (prepared: MutationEnvelope, status = 200): Response => {
    const receipt = clientRequests.resolved(prepared);
    if (receipt === undefined) {
      return problem(
        500,
        "operation-outcome-missing",
        "the domain transition did not commit its operation outcome",
      );
    }
    return noStoreJson(receipt.result ?? receipt, status);
  };
  const recordedResponse = (prepared: MutationEnvelope, status = 200): Response | undefined => {
    const receipt = clientRequests.resolved(prepared);
    return receipt?.status === "committed"
      ? noStoreJson(receipt.result ?? receipt, status)
      : undefined;
  };
  const publicOperation = (requestId: string): Response => {
    const receipt = clientRequests.outcome(requestId);
    if (receipt === undefined)
      return problem(404, "operation-not-found", "the recorded operation was not found");
    return noStoreJson({
      receiptVersion: receipt.receiptVersion,
      requestId: receipt.requestId,
      dataIdentity: receipt.dataIdentity,
      operation: receipt.operation,
      status: receipt.status,
      resultReference: {
        identityVersion: 1,
        kind: "operationOutcome",
        parts: [receipt.requestId],
      },
    });
  };
  const configurationResponse = async (
    request: Request,
    url: URL,
    allowMaintenance: boolean,
  ): Promise<Response | undefined> => {
    const daemonStatus = url.pathname === "/api/v1/daemon/configuration";
    const daemonAction = url.pathname === "/api/v1/daemon/actions/configure";
    const projectStatus = url.pathname.match(
      /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/configuration$/,
    );
    const projectAction = url.pathname.match(
      /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/configure$/,
    );
    if (!daemonStatus && !daemonAction && projectStatus === null && projectAction === null) {
      return undefined;
    }
    if (!allowMaintenance) {
      return problem(
        405,
        "cli-maintenance-required",
        "configuration and retention status and changes are available only through the private CLI",
      );
    }
    const projectId = projectStatus?.[1] ?? projectAction?.[1];
    if (
      projectId !== undefined &&
      ownerDatabase
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM projects WHERE project_id = ?",
        )
        .get(projectId) === null
    ) {
      return problem(404, "project-not-found", "the selected Project was not found");
    }
    const target =
      projectId === undefined
        ? ({ scope: "daemon" } as const)
        : ({ scope: "project", projectId } as const);
    const isAction = daemonAction || projectAction !== null;
    if (request.method === "GET" && !isAction) {
      return noStoreJson(await Effect.runPromise(configurationApi.status(target)));
    }
    if (request.method !== "POST" || !isAction) {
      return problem(405, "method-not-allowed", "the configuration action requires POST");
    }
    if (!isJson(request)) {
      return problem(415, "json-required", "the configuration action requires JSON");
    }
    try {
      const value = await requestJson(request);
      const decoded = clientRequests.decode(value);
      const operation =
        typeof decoded.arguments.confirm === "string"
          ? "confirmDaemonConfiguration"
          : target.scope === "daemon"
            ? "configureDaemon"
            : "configureProject";
      const prepared = clientRequests.require(
        value,
        operation,
        target.scope === "daemon"
          ? { identityVersion: 1, kind: "daemonData", parts: [dataIdentity] }
          : { identityVersion: 1, kind: "project", parts: [target.projectId] },
      );
      const record = prepared.arguments;
      const prior = recordedResponse(prepared, 202);
      if (prior !== undefined) return prior;
      if (typeof record.confirm === "string") {
        if (
          target.scope !== "daemon" ||
          Object.keys(record).length !== 1 ||
          record.confirm.length === 0
        ) {
          return problem(
            400,
            "invalid-configuration-confirmation",
            "confirmation must name one exact Daemon retention plan",
          );
        }
        await Effect.runPromise(configurationApi.confirm(record.confirm, prepared));
        return outcomeResponse(prepared, 202);
      }
      if (
        Object.keys(record).some((key) => key !== "patch" && key !== "check") ||
        !("patch" in record) ||
        (record.check !== undefined && typeof record.check !== "boolean")
      ) {
        return problem(
          400,
          "invalid-configuration",
          "configure accepts only patch and optional check",
        );
      }
      const result =
        record.check === true
          ? await Effect.runPromise(configurationApi.check(target, record.patch, prepared))
          : await Effect.runPromise(configurationApi.apply(target, record.patch, prepared));
      void result;
      return outcomeResponse(prepared, record.check === true ? 200 : 202);
    } catch (cause) {
      const configuration = cause as { readonly code?: string; readonly message?: string };
      const invalid = configuration.code === "INVALID_CONFIGURATION_PATCH";
      return problem(
        invalid ? 400 : 409,
        configuration.code ?? "configuration-refused",
        configuration.message ?? "the configuration change was refused",
      );
    }
  };
  const upgradeResponse = async (request: Request, url: URL): Promise<Response | undefined> => {
    if (url.pathname !== "/api/v1/daemon/upgrade-check") return undefined;
    try {
      if (request.method === "GET") {
        const latest = await Effect.runPromise(upgradePreflight.latest);
        return latest === undefined
          ? problem(404, "upgrade-check-not-found", "no managed upgrade check is recorded")
          : noStoreJson(latest);
      }
      if (request.method !== "POST") {
        return problem(405, "method-not-allowed", "managed upgrade check supports GET and POST");
      }
      if (!isJson(request)) {
        return problem(415, "json-required", "managed upgrade check requires JSON");
      }
      const prepared = await mutationOf(request, "checkDaemonUpgrade", "daemonData");
      const body = prepared.arguments;
      if (
        Object.keys(body).some((key) => key !== "candidateReleaseId" && key !== "approvalToken") ||
        typeof body.candidateReleaseId !== "string" ||
        !/^[A-Za-z0-9._-]+$/.test(body.candidateReleaseId) ||
        (body.approvalToken !== undefined &&
          (typeof body.approvalToken !== "string" || body.approvalToken.length === 0))
      ) {
        return problem(400, "invalid-upgrade-check", "the managed upgrade check body is invalid");
      }
      const selectedSource = activeConsoleRelease(paths);
      if (
        selectedSource.releaseId !== release.releaseId ||
        readFileSync(sourceManifestPath, "utf8") !== sourceManifest
      ) {
        throw new LifecycleError(
          "ACTIVE_RELEASE_CHANGED",
          "the active managed release changed after this Daemon became its owner",
        );
      }
      const sourceFormat = (JSON.parse(sourceManifest) as { readonly formatVersion?: unknown })
        .formatVersion;
      if (sourceFormat === 2) readCheckedManagedRelease(paths, release.releaseId);
      const candidate = readCheckedManagedRelease(paths, body.candidateReleaseId);
      const prior = recordedResponse(prepared);
      if (prior !== undefined) return prior;
      const result = await Effect.runPromise(
        upgradePreflight.check({
          candidate,
          sourceReleaseId: release.releaseId,
          mutation: prepared,
          ...(body.approvalToken === undefined
            ? {}
            : { approvalToken: body.approvalToken as string }),
        }),
      );
      return noStoreJson(result);
    } catch (cause) {
      const fault =
        cause instanceof LifecycleError
          ? cause
          : new LifecycleError(
              "UPGRADE_PREFLIGHT_FAILED",
              cause instanceof Error ? cause.message : String(cause),
              cause,
            );
      return problem(409, fault.code, fault.message);
    }
  };
  const revisionResponse = async (
    request: Request,
    url: URL,
    allowMaintenance: boolean,
  ): Promise<Response | undefined> => {
    const matched = url.pathname.match(
      /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/revisions\/([a-f0-9]{64})(\/actions\/(repair|collect))?$/,
    );
    if (matched === null) return undefined;
    const projectId = matched[1] ?? "invalid";
    const revisionId = matched[2] ?? "invalid";
    const registered = ownerDatabase
      .query<{ readonly found: number }, [string, string]>(
        `SELECT 1 AS found FROM workflow_revision_registrations
            WHERE project_id = ? AND revision_id = ? LIMIT 1`,
      )
      .get(projectId, revisionId);
    if (registered === null) {
      return problem(404, "revision-not-found", "the selected Workflow Revision was not found");
    }
    try {
      if (request.method === "GET" && matched[3] === undefined) {
        return noStoreJson(
          await Effect.runPromise(
            revisionRepository.details(revisionId, new Date(now()).toISOString()),
          ),
        );
      }
      if (!allowMaintenance) {
        return problem(
          405,
          "cli-maintenance-required",
          "exact-content repair and collection are available only through the private CLI",
        );
      }
      if (request.method === "POST" && matched[4] === "repair") {
        const prepared = await mutationOf(request, "repairRevision", "workflowRevision");
        if (
          prepared.target.parts[0] !== projectId ||
          prepared.target.parts[1] !== revisionId ||
          typeof prepared.arguments.from !== "string"
        ) {
          return problem(400, "invalid-repair", "exact revision repair requires one source path");
        }
        const prior = recordedResponse(prepared);
        if (prior !== undefined) return prior;
        await Effect.runPromise(
          revisionRepository.repairExact(
            revisionId,
            prepared.arguments.from,
            new Date(now()).toISOString(),
            prepared,
          ),
        );
        return outcomeResponse(prepared);
      }
      if (request.method === "POST" && matched[4] === "collect") {
        const prepared = await mutationOf(request, "collectRevision", "workflowRevision");
        if (prepared.target.parts[0] !== projectId || prepared.target.parts[1] !== revisionId)
          return problem(409, "target-mismatch", "the revision target does not match its route");
        const prior = recordedResponse(prepared);
        if (prior !== undefined) return prior;
        await Effect.runPromise(
          revisionRepository.collect(revisionId, new Date(now()).toISOString(), prepared),
        );
        return outcomeResponse(prepared);
      }
      return problem(405, "method-not-allowed", "the revision action does not allow this method");
    } catch (cause) {
      return problem(
        409,
        "revision-maintenance-refused",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  };
  const gateSnapshot = async (projectId?: string): Promise<Response> =>
    noStoreJson(await Effect.runPromise(gateApi.snapshot(projectId)));
  const recordGateAnswer = async (
    request: Request,
    clientSuppliesAnswerer: boolean,
  ): Promise<Response> => {
    let input: RecordVerdictRequest;
    let prepared: MutationEnvelope;
    try {
      prepared = await mutationOf(request, "recordGateVerdict", "gate");
      const record = prepared.arguments;
      if (
        typeof record.token !== "string" ||
        typeof record.choice !== "string" ||
        typeof record.reason !== "string" ||
        (record.answerer !== undefined && typeof record.answerer !== "string")
      ) {
        return problem(400, "invalid-verdict", "the Verdict request has invalid fields");
      }
      input = {
        requestId: prepared.requestId,
        dataIdentity: prepared.dataIdentity,
        token: record.token,
        choice: record.choice,
        reason: record.reason,
        ...(clientSuppliesAnswerer && typeof record.answerer === "string"
          ? { answerer: record.answerer }
          : {}),
      };
    } catch {
      return problem(400, "invalid-json", "the Verdict request body is invalid");
    }
    const prior = recordedResponse(prepared);
    if (prior !== undefined) return prior;
    const result = await Effect.runPromiseExit(gateApi.record({ ...input, mutation: prepared }));
    if (result._tag === "Success") return outcomeResponse(prepared);
    const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause)) as
      | { readonly code?: string; readonly message?: string }
      | undefined;
    if (failure?.code === "DEADLINE_PASSED")
      return problem(409, "deadline-passed", "the Verdict was not recorded before the Deadline");
    if (failure?.code === "ASKING_NOT_FOUND")
      return problem(404, "asking-not-found", "the Gate token was not found");
    return problem(409, "verdict-refused", failure?.message ?? Cause.pretty(result.cause));
  };
  const startRun = async (
    request: Request,
    projectId: string,
    workflowName: string,
  ): Promise<Response> => {
    try {
      const prepared = await mutationOf(request, "startWorkflow", "workflow");
      if (prepared.target.parts[0] !== projectId || prepared.target.parts[1] !== workflowName)
        return problem(409, "target-mismatch", "the Start target does not match its route");
      const reviewedMode = prepared.preconditions.mode;
      const reviewedRevisionId = prepared.preconditions.revisionId;
      if (
        (reviewedMode !== "trigger" && reviewedMode !== "no-trigger") ||
        typeof reviewedRevisionId !== "string"
      )
        return problem(
          400,
          "workflow-review-required",
          "Start requires the reviewed Workflow mode and revision",
        );
      let payloadValue: JsonValue | undefined;
      if ("payload" in prepared.arguments) {
        const payload = decodeJsonValue(prepared.arguments.payload);
        if (!payload.ok) return problem(400, "invalid-payload", "the payload is not JSON");
        payloadValue = payload.value;
      }
      const prior = recordedResponse(prepared, 202);
      if (prior !== undefined) return prior;
      await Effect.runPromise(
        runApi.startWorkflow({
          projectId,
          workflowName,
          requestId: prepared.requestId,
          dataIdentity: prepared.dataIdentity,
          mutation: prepared,
          reviewedMode,
          reviewedRevisionId,
          ...(payloadValue === undefined ? {} : { payload: payloadValue }),
        }),
      );
      return outcomeResponse(prepared, 202);
    } catch (cause) {
      return problem(
        409,
        "start-refused",
        cause instanceof Error ? cause.message : "the Run was not admitted",
      );
    }
  };
  const stopWorkflow = async (
    request: Request,
    projectId: string,
    workflowName: string,
  ): Promise<Response> => {
    try {
      const prepared = await mutationOf(request, "stopWorkflow", "workflow");
      if (prepared.target.parts[0] !== projectId || prepared.target.parts[1] !== workflowName)
        return problem(409, "target-mismatch", "the Stop target does not match its route");
      if (prepared.arguments.force !== undefined && typeof prepared.arguments.force !== "boolean")
        return problem(400, "invalid-stop", "the Stop request has invalid fields");
      const prior = recordedResponse(prepared, 202);
      if (prior !== undefined) return prior;
      await Effect.runPromise(
        runApi.stopWorkflow({
          projectId,
          workflowName,
          requestId: prepared.requestId,
          dataIdentity: prepared.dataIdentity,
          mutation: prepared,
          ...(prepared.arguments.force === true ? { force: true } : {}),
        }),
      );
      return outcomeResponse(prepared, 202);
    } catch (cause) {
      return problem(
        409,
        "stop-refused",
        cause instanceof Error ? cause.message : "the Workflow was not stopped",
      );
    }
  };
  const cancelRun = async (request: Request, runId: string): Promise<Response> => {
    try {
      const prepared = await mutationOf(request, "cancelRun", "run");
      if (prepared.target.parts[0] !== runId)
        return problem(409, "target-mismatch", "the Run target does not match its route");
      const prior = recordedResponse(prepared, 202);
      if (prior !== undefined) return prior;
      await Effect.runPromise(
        runApi.cancelRun({
          runId,
          requestId: prepared.requestId,
          dataIdentity: prepared.dataIdentity,
          mutation: prepared,
        }),
      );
      return outcomeResponse(prepared, 202);
    } catch (cause) {
      return problem(
        409,
        "cancel-refused",
        cause instanceof Error ? cause.message : "the Run cancellation was refused",
      );
    }
  };
  const retryUncertainAction = async (request: Request, runId: string): Promise<Response> => {
    try {
      const prepared = await mutationOf(request, "retryUncertainAction", "runAction");
      const record = prepared.arguments;
      if (
        prepared.target.parts[0] !== runId ||
        typeof prepared.target.parts[1] !== "string" ||
        typeof record.reason !== "string" ||
        record.reason.trim() === "" ||
        prepared.preconditions.possibleDuplicationAcknowledged !== true
      ) {
        return problem(
          400,
          "invalid-uncertain-retry",
          "retry requires the exact action ID, a reason, and possible-duplication acknowledgement",
        );
      }
      const prior = recordedResponse(prepared, 202);
      if (prior !== undefined) return prior;
      await Effect.runPromise(
        runApi.retryUncertainAction({
          runId,
          requestId: prepared.requestId,
          dataIdentity: prepared.dataIdentity,
          actionId: prepared.target.parts[1],
          reason: record.reason,
          possibleDuplicationAcknowledged: true,
          mutation: prepared,
        }),
      );
      return outcomeResponse(prepared, 202);
    } catch (cause) {
      return problem(
        409,
        "uncertain-retry-refused",
        cause instanceof Error ? cause.message : "the uncertain retry was refused",
      );
    }
  };
  const repairProjectRunner = async (request: Request, projectId: string): Promise<Response> => {
    const project = (await Effect.runPromise(projectRepository.projects)).find(
      (candidate) => candidate.projectId === projectId,
    );
    if (project === undefined) {
      return problem(404, "project-not-found", "the selected Project was not found");
    }
    try {
      const prepared = await mutationOf(request, "repairProject", "project");
      if (prepared.target.parts[0] !== projectId)
        return problem(
          409,
          "target-mismatch",
          "the Project repair target does not match its route",
        );
      const prior = recordedResponse(prepared, 202);
      if (prior !== undefined) return prior;
      await Effect.runPromise(runApi.repairProject(projectId, prepared));
      return outcomeResponse(prepared, 202);
    } catch (cause) {
      return problem(
        409,
        "project-repair-refused",
        cause instanceof Error ? cause.message : "Project repair was refused",
      );
    }
  };

  const replayPrepared = async (requestId: string): Promise<Response> => {
    const retained = clientRequests.lookup(requestId);
    const recorded = clientRequests.outcome(requestId);
    if (retained?.request !== undefined && recorded !== undefined)
      clientRequests.resolved(retained.request);
    if (recorded?.status === "committed") return noStoreJson(recorded);
    if (retained === undefined || retained.request === undefined) {
      return Effect.runPromise(projectApi.retry(requestId));
    }
    const mutation = retained.request;
    const requestFor = (path: string): Request =>
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation),
      });
    const replay = requestFor("/replay");
    const first = mutation.target.parts[0];
    const second = mutation.target.parts[1];
    if (
      mutation.operation === "startWorkflow" &&
      typeof first === "string" &&
      typeof second === "string"
    )
      return startRun(replay, first, second);
    if (
      mutation.operation === "stopWorkflow" &&
      typeof first === "string" &&
      typeof second === "string"
    )
      return stopWorkflow(replay, first, second);
    if (mutation.operation === "cancelRun" && typeof first === "string")
      return cancelRun(replay, first);
    if (mutation.operation === "retryUncertainAction" && typeof first === "string")
      return retryUncertainAction(replay, first);
    if (mutation.operation === "recordGateVerdict") return recordGateAnswer(replay, true);
    if (mutation.operation === "repairProject" && typeof first === "string")
      return repairProjectRunner(replay, first);
    if (
      mutation.operation === "configureDaemon" ||
      mutation.operation === "confirmDaemonConfiguration"
    )
      return (
        (await configurationResponse(
          requestFor("/api/v1/daemon/actions/configure"),
          new URL("http://localhost/api/v1/daemon/actions/configure"),
          true,
        )) ?? problem(409, "replay-refused", "the Daemon configuration replay was refused")
      );
    if (mutation.operation === "configureProject" && typeof first === "string") {
      const path = `/api/v1/projects/${encodeURIComponent(first)}/actions/configure`;
      return (
        (await configurationResponse(requestFor(path), new URL(`http://localhost${path}`), true)) ??
        problem(409, "replay-refused", "the Project configuration replay was refused")
      );
    }
    if (
      (mutation.operation === "repairRevision" || mutation.operation === "collectRevision") &&
      typeof first === "string" &&
      typeof second === "string"
    ) {
      const action = mutation.operation === "repairRevision" ? "repair" : "collect";
      const path = `/api/v1/projects/${encodeURIComponent(first)}/revisions/${encodeURIComponent(second)}/actions/${action}`;
      return (
        (await revisionResponse(requestFor(path), new URL(`http://localhost${path}`), true)) ??
        problem(409, "replay-refused", "the Workflow Revision replay was refused")
      );
    }
    if (mutation.operation === "checkDaemonUpgrade")
      return (
        (await upgradeResponse(
          requestFor("/api/v1/daemon/upgrade-check"),
          new URL("http://localhost/api/v1/daemon/upgrade-check"),
        )) ?? problem(409, "replay-refused", "the upgrade check replay was refused")
      );
    return Effect.runPromise(projectApi.retry(requestId));
  };

  consoleServer = Bun.serve({
    hostname: "127.0.0.1",
    port: options.consolePort ?? 0,
    async fetch(request) {
      return withOrdinaryMutation(mutationGate, request, async () => {
        const expectedHost = `127.0.0.1:${consoleServer?.port ?? 0}`;
        const origin = `http://${expectedHost}`;
        if (request.headers.get("host") !== expectedHost) {
          return problem(421, "wrong-host", "the request Host does not match this Console");
        }

        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/_kojo/compat") {
          const body: BootstrapResponse = {
            bootstrapVersion: 1,
            instanceId,
            dataIdentity,
            clientApiVersions: [1],
            features: [
              "browser-session",
              "project-catalogue",
              "workflow-revisions",
              "no-trigger-runs",
              "trigger-scheduling",
              "gate-verdicts",
              "client-request-journal",
            ],
            packageVersion: release.packageVersion,
          };
          return noStoreJson(body);
        }

        if (url.pathname === "/_kojo/session") {
          if (request.method !== "POST") {
            return problem(405, "method-not-allowed", "the session exchange requires POST");
          }
          if (request.headers.get("origin") !== origin) {
            return problem(403, "wrong-origin", "the request Origin does not match this Console");
          }
          if (!isJson(request)) {
            return problem(415, "json-required", "the session exchange requires JSON");
          }
          let body: BrowserSessionRequest;
          try {
            const bytes = new Uint8Array(await request.arrayBuffer());
            if (bytes.byteLength > 4_096) {
              return problem(413, "request-too-large", "the session exchange is too large");
            }
            const input = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
            if (
              Object.keys(input).length !== 1 ||
              typeof input.grant !== "string" ||
              input.grant.length === 0
            ) {
              throw new Error("invalid grant request");
            }
            body = { grant: input.grant };
          } catch {
            return problem(400, "invalid-json", "the session exchange body is invalid");
          }
          const session = authority.exchange(body.grant, origin);
          if (session === undefined) {
            return problem(401, "grant-refused", "the launch grant is invalid or expired");
          }
          const response: BrowserSessionResponse = {
            formatVersion: 1,
            credential: session.secret,
            expiresAt: new Date(session.expiresAt).toISOString(),
            instanceId,
          };
          return noStoreJson(response);
        }

        if (url.pathname.startsWith("/api/v1/")) {
          const requestOrigin = request.headers.get("origin");
          if (requestOrigin !== null && requestOrigin !== origin) {
            return problem(403, "wrong-origin", "the request Origin does not match this Console");
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            if (requestOrigin !== origin) {
              return problem(403, "origin-required", "a mutation requires this Console Origin");
            }
            if (!isJson(request)) {
              return problem(415, "json-required", "a mutation requires JSON");
            }
            if (Number(request.headers.get("content-length") ?? "0") > 1_048_576) {
              return problem(413, "request-too-large", "the mutation body is too large");
            }
            try {
              const bytes = new Uint8Array(await request.clone().arrayBuffer());
              if (bytes.byteLength > 1_048_576) {
                return problem(413, "request-too-large", "the mutation body is too large");
              }
              JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              return problem(400, "invalid-json", "the mutation body is invalid");
            }
          }
          const session = authority.authenticate(request.headers.get("authorization"));
          if (session === undefined) {
            return problem(401, "session-refused", "Console access is invalid or expired");
          }
          if (request.method === "GET" && url.pathname === "/api/v1/notifications") {
            return notifications.response(request.signal);
          }
          if (request.method === "GET" && url.pathname === "/api/v1/daemon") {
            const projects = await Effect.runPromise(projectRepository.projects);
            const body: DaemonDocument = {
              formatVersion: 1,
              instanceId,
              dataIdentity,
              releaseId: release.releaseId,
              packageVersion: release.packageVersion,
              bunVersion: release.bunVersion,
              platform: process.platform,
              architecture: process.arch,
              startedAt,
              accessExpiresAt: new Date(session.expiresAt).toISOString(),
              projectCount: projects.length,
            };
            return noStoreJson(body);
          }
          const revision = await revisionResponse(request, url, false);
          if (revision !== undefined) return revision;
          const configuration = await configurationResponse(request, url, false);
          if (configuration !== undefined) return configuration;
          if (request.method === "GET" && url.pathname === "/api/v1/projects") {
            return Effect.runPromise(projectApi.snapshot());
          }
          if (request.method === "GET" && url.pathname === "/api/v1/workflows") {
            return Effect.runPromise(projectApi.workflowSnapshot());
          }
          if (request.method === "GET" && url.pathname === "/api/v1/client-requests") {
            return Effect.runPromise(projectApi.recentRequests());
          }
          const operation = url.pathname.match(/^\/api\/v1\/operations\/([A-Za-z0-9_-]+)$/);
          if (request.method === "GET" && operation !== null) {
            return publicOperation(operation[1] ?? "invalid");
          }
          if (request.method === "GET" && url.pathname === "/api/v1/runs") {
            return noStoreJson(await Effect.runPromise(runApi.snapshot()));
          }
          if (request.method === "GET" && url.pathname === "/api/v1/askings") {
            return gateSnapshot();
          }
          if (request.method === "POST" && url.pathname === "/api/v1/gate-answers") {
            return recordGateAnswer(request, false);
          }
          const cancelOneRun = url.pathname.match(
            /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/cancel$/,
          );
          if (request.method === "POST" && cancelOneRun !== null) {
            return cancelRun(request, cancelOneRun[1] ?? "invalid");
          }
          const changeProjectLocation = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/(relocate|archive|restore)$/,
          );
          if (request.method === "POST" && changeProjectLocation !== null) {
            return Effect.runPromise(
              projectApi.locationChange(
                changeProjectLocation[1] ?? "invalid",
                changeProjectLocation[2] as "relocate" | "archive" | "restore",
                await requestJson(request),
              ),
            );
          }
          const retryOneUncertainAction = url.pathname.match(
            /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/retry-uncertain$/,
          );
          if (request.method === "POST" && retryOneUncertainAction !== null) {
            return retryUncertainAction(request, retryOneUncertainAction[1] ?? "invalid");
          }
          const repairOneProject = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/repair$/,
          );
          if (request.method === "POST" && repairOneProject !== null) {
            return repairProjectRunner(request, repairOneProject[1] ?? "invalid");
          }
          const projectAskings = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/askings$/,
          );
          if (request.method === "GET" && projectAskings !== null) {
            return gateSnapshot(projectAskings[1]);
          }
          const oneRun = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_-]+)$/);
          if (request.method === "GET" && oneRun !== null) {
            const run = await Effect.runPromise(runApi.run(oneRun[1] ?? "invalid"));
            return run === undefined
              ? problem(404, "run-not-found", "the selected Run was not found")
              : noStoreJson(run);
          }
          const oneArtifact = url.pathname.match(
            /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/artifacts\/([A-Za-z0-9_-]+)$/,
          );
          if (request.method === "GET" && oneArtifact !== null) {
            const artifact = artifactRepository.read(
              oneArtifact[1] ?? "invalid",
              oneArtifact[2] ?? "invalid",
            );
            if (artifact === undefined)
              return problem(404, "artifact-not-found", "the selected Artifact was not found");
            const content = readFileSync(artifact.path);
            if (url.searchParams.get("download") !== "1") {
              return noStoreJson({
                artifactId: artifact.artifactId,
                name: artifact.name,
                mediaType: artifact.mediaType,
                content: new TextDecoder().decode(content),
              });
            }
            const safeName = artifact.name.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact.txt";
            return new Response(content, {
              headers: {
                "cache-control": "no-store",
                "content-disposition": `attachment; filename="${safeName}"`,
                "content-security-policy": "sandbox; default-src 'none'",
                "content-type": "application/octet-stream",
                "x-content-type-options": "nosniff",
              },
            });
          }
          const projectRuns = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/runs$/);
          if (request.method === "GET" && projectRuns !== null) {
            return noStoreJson(await Effect.runPromise(runApi.snapshot(projectRuns[1])));
          }
          const workflowStart = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/start$/,
          );
          if (request.method === "POST" && workflowStart !== null) {
            return startRun(
              request,
              workflowStart[1] ?? "invalid",
              decodeURIComponent(workflowStart[2] ?? "invalid"),
            );
          }
          const workflowStop = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/stop$/,
          );
          if (request.method === "POST" && workflowStop !== null) {
            return stopWorkflow(
              request,
              workflowStop[1] ?? "invalid",
              decodeURIComponent(workflowStop[2] ?? "invalid"),
            );
          }
          const projectWorkflows = url.pathname.match(
            /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows$/,
          );
          if (request.method === "GET" && projectWorkflows !== null) {
            return Effect.runPromise(projectApi.workflowSnapshot(projectWorkflows[1]));
          }
          const clientRequest = url.pathname.match(
            /^\/api\/v1\/client-requests\/([A-Za-z0-9_-]+)(\/retry)?$/,
          );
          if (clientRequest !== null) {
            const requestId = clientRequest[1] ?? "invalid";
            if (request.method === "GET" && clientRequest[2] === undefined) {
              return Effect.runPromise(projectApi.lookup(requestId));
            }
            if (request.method === "PUT" && clientRequest[2] === undefined) {
              try {
                return Effect.runPromise(projectApi.prepare(requestId, await requestJson(request)));
              } catch {
                return problem(400, "invalid-json", "the mutation body is invalid");
              }
            }
            if (request.method === "POST" && clientRequest[2] === "/retry") {
              return replayPrepared(requestId);
            }
          }
          return problem(404, "not-found", "the requested API resource was not found");
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          return problem(405, "method-not-allowed", "static Console content is read-only");
        }
        return consoleAsset(release.assets, url.pathname);
      });
    },
  });
  const consoleOrigin = `http://127.0.0.1:${consoleServer.port}`;
  const endpoint: DaemonEndpoint = {
    formatVersion: 1,
    consoleOrigin,
    dataIdentity,
    instanceId,
    socketPath,
    ready: true,
  };
  const socketServer = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const url = new URL(request.url);
      const response = await withOrdinaryMutation(mutationGate, request, async () => {
        if (request.method === "GET" && url.pathname === "/ready") {
          return Response.json(endpoint);
        }
        if (request.method === "POST" && url.pathname === "/ui-grants") {
          const grant = authority.issue(consoleOrigin);
          return noStoreJson({
            expiresAt: new Date(grant.expiresAt).toISOString(),
            launchUrl: `${consoleOrigin}/daemon#grant=${encodeURIComponent(grant.secret)}`,
          });
        }
        if (request.method === "GET" && url.pathname === "/api/v1/notifications") {
          return notifications.response(request.signal);
        }
        const revision = await revisionResponse(request, url, true);
        if (revision !== undefined) return revision;
        const upgrade = await upgradeResponse(request, url);
        if (upgrade !== undefined) return upgrade;
        const configuration = await configurationResponse(request, url, true);
        if (configuration !== undefined) return configuration;
        if (request.method === "GET" && url.pathname === "/api/v1/projects") {
          return Effect.runPromise(projectApi.snapshot());
        }
        if (request.method === "GET" && url.pathname === "/api/v1/workflows") {
          return Effect.runPromise(projectApi.workflowSnapshot());
        }
        if (request.method === "GET" && url.pathname === "/api/v1/client-requests") {
          return Effect.runPromise(projectApi.recentRequests());
        }
        const operation = url.pathname.match(/^\/api\/v1\/operations\/([A-Za-z0-9_-]+)$/);
        if (request.method === "GET" && operation !== null) {
          return publicOperation(operation[1] ?? "invalid");
        }
        if (request.method === "GET" && url.pathname === "/api/v1/runs") {
          return noStoreJson(await Effect.runPromise(runApi.snapshot()));
        }
        if (request.method === "GET" && url.pathname === "/api/v1/askings") {
          return gateSnapshot();
        }
        if (request.method === "POST" && url.pathname === "/api/v1/gate-answers") {
          if (!isJson(request)) return problem(415, "json-required", "Gate answer requires JSON");
          return recordGateAnswer(request, true);
        }
        const cancelOneRun = url.pathname.match(
          /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/cancel$/,
        );
        if (request.method === "POST" && cancelOneRun !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Cancel requires JSON");
          return cancelRun(request, cancelOneRun[1] ?? "invalid");
        }
        const changeProjectLocation = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/(relocate|archive|restore)$/,
        );
        if (request.method === "POST" && changeProjectLocation !== null) {
          if (!isJson(request))
            return problem(415, "json-required", "Project location change requires JSON");
          return Effect.runPromise(
            projectApi.locationChange(
              changeProjectLocation[1] ?? "invalid",
              changeProjectLocation[2] as "relocate" | "archive" | "restore",
              await requestJson(request),
            ),
          );
        }
        const retryOneUncertainAction = url.pathname.match(
          /^\/api\/v1\/runs\/([A-Za-z0-9_-]+)\/actions\/retry-uncertain$/,
        );
        if (request.method === "POST" && retryOneUncertainAction !== null) {
          if (!isJson(request))
            return problem(415, "json-required", "Uncertain action retry requires JSON");
          return retryUncertainAction(request, retryOneUncertainAction[1] ?? "invalid");
        }
        const repairOneProject = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/actions\/repair$/,
        );
        if (request.method === "POST" && repairOneProject !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Repair requires JSON");
          return repairProjectRunner(request, repairOneProject[1] ?? "invalid");
        }
        const projectAskings = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/askings$/,
        );
        if (request.method === "GET" && projectAskings !== null) {
          return gateSnapshot(projectAskings[1]);
        }
        const oneRun = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_-]+)$/);
        if (request.method === "GET" && oneRun !== null) {
          const run = await Effect.runPromise(runApi.run(oneRun[1] ?? "invalid"));
          return run === undefined
            ? problem(404, "run-not-found", "the selected Run was not found")
            : noStoreJson(run);
        }
        const projectRuns = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/runs$/);
        if (request.method === "GET" && projectRuns !== null) {
          return noStoreJson(await Effect.runPromise(runApi.snapshot(projectRuns[1])));
        }
        const workflowStart = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/start$/,
        );
        if (request.method === "POST" && workflowStart !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Start requires JSON");
          return startRun(
            request,
            workflowStart[1] ?? "invalid",
            decodeURIComponent(workflowStart[2] ?? "invalid"),
          );
        }
        const workflowStop = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows\/([^/]+)\/actions\/stop$/,
        );
        if (request.method === "POST" && workflowStop !== null) {
          if (!isJson(request)) return problem(415, "json-required", "Stop requires JSON");
          return stopWorkflow(
            request,
            workflowStop[1] ?? "invalid",
            decodeURIComponent(workflowStop[2] ?? "invalid"),
          );
        }
        const projectWorkflows = url.pathname.match(
          /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/workflows$/,
        );
        if (request.method === "GET" && projectWorkflows !== null) {
          return Effect.runPromise(projectApi.workflowSnapshot(projectWorkflows[1]));
        }
        const clientRequest = url.pathname.match(
          /^\/api\/v1\/client-requests\/([A-Za-z0-9_-]+)(\/retry)?$/,
        );
        if (clientRequest !== null) {
          const requestId = clientRequest[1] ?? "invalid";
          if (request.method === "GET" && clientRequest[2] === undefined) {
            return Effect.runPromise(projectApi.lookup(requestId));
          }
          if (request.method === "PUT" && clientRequest[2] === undefined) {
            if (!isJson(request)) return problem(415, "json-required", "the request requires JSON");
            try {
              return Effect.runPromise(projectApi.prepare(requestId, await requestJson(request)));
            } catch {
              return problem(400, "invalid-json", "the mutation body is invalid");
            }
          }
          if (request.method === "POST" && clientRequest[2] === "/retry") {
            return replayPrepared(requestId);
          }
        }
        return new Response("not found", { status: 404 });
      });
      const isHeartbeat = url.pathname === "/ready" || url.pathname === "/api/v1/notifications";
      if (!isHeartbeat && response.status >= 200 && response.status < 400) {
        options.recordOperationSuccess?.();
      }
      return response;
    },
  });
  if (consoleServer === undefined) {
    throw new LifecycleError(
      "DAEMON_HTTP_START_FAILED",
      "the Daemon HTTP transports did not start",
    );
  }
  return { consoleServer, endpoint, socketServer };
};

import { readFileSync } from "node:fs";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type {
  ProjectLocationResult,
  ProjectSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Console, Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { clientExit } from "../../../cli/ClientExit.ts";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import {
  configurationApplyLines,
  configurationCheckLines,
  configurationStatusLines,
} from "../../daemon/adapters/DaemonCommandPresentation.ts";
import { prepareHostClientRequest } from "../../daemon/adapters/prepareHostClientRequest.ts";
import type {
  ConfigurationApplyResult,
  ConfigurationCheck,
  ConfigurationStatus,
} from "../../daemon/models/Configuration.ts";
import type { DaemonPaths } from "../../daemon/models/DaemonPaths.ts";
import { readDaemonEndpoint } from "../../daemon/services/daemonStatus.ts";
import { linuxPaths } from "../../daemon/services/linuxPaths.ts";
import { macPaths } from "../../daemon/services/macPaths.ts";
import type { RevisionDetails } from "../../workflow/models/RevisionMaintenance.ts";
import { exactGitWorkingTree } from "../services/gitWorkingTree.ts";

class ProjectClientError extends Data.TaggedError("ProjectClientError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

const clientError = (cause: unknown): ProjectClientError =>
  cause instanceof ProjectClientError
    ? cause
    : new ProjectClientError({
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const productionPaths = (): DaemonPaths => {
  if (process.platform === "darwin") return macPaths();
  if (process.platform === "linux") return linuxPaths();
  throw new ProjectClientError({ reason: "Kojo Project registration supports macOS and Linux" });
};

const daemonRequest = <A>(
  path: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Effect.Effect<A, ProjectClientError> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = readDaemonEndpoint(productionPaths());
      if (endpoint === undefined) {
        throw new ProjectClientError({
          reason: "the Daemon is not ready; run `kojo daemon status`",
        });
      }
      const response = await fetch(`http://localhost${path}`, {
        unix: endpoint.socketPath,
        method: options.method,
        headers: {
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      } as RequestInit & { readonly unix: string });
      const value = (await response.json()) as {
        readonly problem?: { readonly diagnostic?: string; readonly remedy?: string };
      };
      if (!response.ok) {
        throw new ProjectClientError({
          reason:
            [value.problem?.diagnostic, value.problem?.remedy].filter(Boolean).join(" ") ||
            `the Daemon answered ${response.status}`,
        });
      }
      return value as A;
    },
    catch: clientError,
  });

const register = Command.make(
  "register",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("The exact Git working-tree root to register"),
    ),
    requestId: Flag.string("request-id").pipe(
      Flag.withDescription("Reuse this ID only for the exact same registration request"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ path, requestId }) {
    const paths = yield* Effect.try({
      try: productionPaths,
      catch: clientError,
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    const endpoint = readDaemonEndpoint(paths);
    if (endpoint === undefined)
      return yield* commandFailed("the Daemon is not ready; run `kojo daemon status`");
    const location = yield* Effect.try({
      try: () => exactGitWorkingTree(path),
      catch: clientError,
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    const id = Option.getOrElse(requestId, () => crypto.randomUUID());
    const mutation: MutationEnvelope = {
      mutationVersion: 1,
      requestId: id,
      dataIdentity: endpoint.dataIdentity,
      operation: "registerProject",
      target: { identityVersion: 1, kind: "daemonData", parts: [endpoint.dataIdentity] },
      arguments: { location },
      preconditions: {},
    };
    yield* Effect.try({
      try: () => prepareHostClientRequest(paths, mutation),
      catch: clientError,
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* Console.log(`request ${id}`);
    const receipt = yield* daemonRequest<OperationReceipt>(`/api/v1/client-requests/${id}/retry`, {
      method: "POST",
      body: {},
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    const result = receipt.result as {
      readonly created: boolean;
      readonly project: { readonly projectId: string; readonly factoryState: string };
    };
    yield* Console.log(
      `${result.created ? "registered" : "already registered"} Project ${result.project.projectId}`,
    );
    yield* Console.log(`Factory ${result.project.factoryState}. No Workflow was started.`);
  }),
).pipe(Command.withDescription("Register one exact Git working-tree root with the Daemon"));

const list = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const snapshot = yield* daemonRequest<ProjectSnapshot>("/api/v1/projects").pipe(
      Effect.catch((cause) => commandFailed(cause.reason)),
    );
    if (snapshot.projects.length === 0) {
      yield* Console.log("No Projects are registered.");
      return;
    }
    for (const project of snapshot.projects) {
      yield* Console.log(
        `${project.projectId}\t${project.projectState}\t${project.factoryState}\t${
          project.locationChange.state === "draining"
            ? `${project.locationChange.action}-draining`
            : "steady"
        }\t${project.locationActive ? "active-location" : "retained-location"}\t${project.location}`,
      );
    }
  }),
).pipe(Command.withDescription("Read one authoritative Project catalogue snapshot"));

const projectArgument = Argument.string("project").pipe(
  Argument.withDescription("The full Project ID"),
);

const locationRequestId = Flag.string("request-id").pipe(
  Flag.withDescription("Reuse this ID only for this exact Project location change"),
  Flag.optional,
);

const confirmLocationChange = Flag.boolean("confirm").pipe(
  Flag.withDescription("Confirm the shown location, Workflow, Run, and history consequences"),
);

const runLocationChange = (
  projectId: string,
  action: "relocate" | "archive" | "restore",
  requestId: Option.Option<string>,
  confirm: boolean,
  location?: string,
) =>
  Effect.gen(function* () {
    if (!confirm) {
      return yield* commandFailed(
        "use --confirm after you accept that dispatch drains, Workflows become inactive, and retained Runs keep their pinned revisions",
      );
    }
    const endpoint = readDaemonEndpoint(productionPaths());
    if (endpoint === undefined)
      return yield* commandFailed("the Daemon is not ready; run `kojo daemon status`");
    const id = Option.getOrElse(requestId, () => crypto.randomUUID());
    const mutation: MutationEnvelope = {
      mutationVersion: 1,
      requestId: id,
      dataIdentity: endpoint.dataIdentity,
      operation: `${action}Project`,
      target: { identityVersion: 1, kind: "project", parts: [projectId] },
      arguments: { ...(location === undefined ? {} : { location }) },
      preconditions: { confirm: true },
    };
    yield* Effect.try({
      try: () => prepareHostClientRequest(productionPaths(), mutation),
      catch: clientError,
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* Console.log(`request ${id}`);
    yield* Console.log(`draining Project ${projectId} before ${action}`);
    const receipt = yield* daemonRequest<OperationReceipt>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/actions/${action}`,
      {
        method: "POST",
        body: {
          requestId: id,
          dataIdentity: endpoint.dataIdentity,
          confirm: true,
          ...(location === undefined ? {} : { location }),
        },
      },
    ).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    const result = receipt.result as unknown as ProjectLocationResult;
    yield* Console.log(
      `${result.action} committed for Project ${result.project.projectId}: ${result.project.projectState}`,
    );
    yield* Console.log(`location ${result.project.location}`);
    for (const consequence of result.consequences) yield* Console.log(consequence);
  });

const relocate = Command.make(
  "relocate",
  {
    project: projectArgument,
    to: Flag.directory("to", { mustExist: true }).pipe(
      Flag.withDescription("The exact new Git working-tree root"),
    ),
    requestId: locationRequestId,
    confirm: confirmLocationChange,
  },
  Effect.fn(function* ({ project, to, requestId, confirm }) {
    const location = yield* Effect.try({
      try: () => exactGitWorkingTree(to),
      catch: clientError,
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* runLocationChange(project, "relocate", requestId, confirm, location);
  }),
).pipe(
  Command.withDescription("Relocate or explicitly confirm one Project after execution drains"),
);

const archive = Command.make(
  "archive",
  { project: projectArgument, requestId: locationRequestId, confirm: confirmLocationChange },
  Effect.fn(function* ({ project, requestId, confirm }) {
    yield* runLocationChange(project, "archive", requestId, confirm);
  }),
).pipe(Command.withDescription("Archive one Project without deleting its history"));

const restore = Command.make(
  "restore",
  {
    project: projectArgument,
    to: Flag.directory("to", { mustExist: true }).pipe(
      Flag.withDescription("The exact Git working-tree root to activate"),
    ),
    requestId: locationRequestId,
    confirm: confirmLocationChange,
  },
  Effect.fn(function* ({ project, to, requestId, confirm }) {
    const location = yield* Effect.try({
      try: () => exactGitWorkingTree(to),
      catch: clientError,
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* runLocationChange(project, "restore", requestId, confirm, location);
  }),
).pipe(Command.withDescription("Restore one Archived Project at an unclaimed location"));

const revisionFlag = Flag.string("revision").pipe(
  Flag.withDescription("The full Workflow Revision SHA-256 identity"),
);

export const revisionLines = (document: RevisionDetails): ReadonlyArray<string> => [
  `Workflow Revision ${document.revisionId}`,
  `Package graph ${document.packageGraphId}`,
  `Manifest ${JSON.stringify(document.manifest)}`,
  `Packages ${JSON.stringify(document.packages)}`,
  `Dependent Runs ${JSON.stringify(document.dependentRuns)}`,
  `Active readers ${JSON.stringify(document.activeReaders)}`,
  `Protections ${JSON.stringify(document.protections)}`,
  `Faults ${JSON.stringify(document.faults)}`,
  `Collection ${JSON.stringify(document.collection)}`,
];

const status = Command.make(
  "status",
  {
    project: projectArgument,
    revision: revisionFlag.pipe(Flag.optional),
    details: Flag.boolean("details").pipe(
      Flag.withDescription("Show the complete retained manifest and protections"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Emit one JSON document")),
  },
  Effect.fn(function* ({ project, revision, details, json }) {
    if (!details) {
      return yield* commandFailed("Project status details require --details");
    }
    if (Option.isNone(revision)) {
      const configuration = yield* daemonRequest<ConfigurationStatus>(
        `/api/v1/projects/${encodeURIComponent(project)}/configuration`,
      ).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
      if (json) {
        yield* Console.log(JSON.stringify({ formatVersion: 1, configuration }));
        return;
      }
      for (const statusLine of configurationStatusLines(configuration)) {
        yield* Console.log(statusLine);
      }
      return;
    }
    const document = yield* daemonRequest<RevisionDetails>(
      `/api/v1/projects/${encodeURIComponent(project)}/revisions/${encodeURIComponent(revision.value)}`,
    ).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    if (json) {
      yield* Console.log(JSON.stringify({ formatVersion: 1, revision: document }));
      return;
    }
    for (const line of revisionLines(document)) yield* Console.log(line);
  }),
).pipe(Command.withDescription("Inspect one exact retained Workflow Revision"));

const configure = Command.make(
  "configure",
  {
    project: projectArgument,
    file: Flag.string("file"),
    check: Flag.boolean("check"),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ project, file, check, json }) {
    const patch = yield* Effect.tryPromise({
      try: async () =>
        JSON.parse(file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8")) as unknown,
      catch: (cause) =>
        `configuration file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    }).pipe(Effect.catch((message) => clientExit(2, message)));
    const result = yield* daemonRequest<ConfigurationCheck | ConfigurationApplyResult>(
      `/api/v1/projects/${encodeURIComponent(project)}/actions/configure`,
      { method: "POST", body: { patch, ...(check ? { check: true } : {}) } },
    ).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    if (json) yield* Console.log(JSON.stringify(result));
    else {
      const lines =
        "proposed" in result ? configurationCheckLines(result) : configurationApplyLines(result);
      for (const statusLine of lines) yield* Console.log(statusLine);
    }
  }),
).pipe(Command.withDescription("Check or apply one atomic Project limit patch"));

const repair = Command.make(
  "repair",
  {
    project: projectArgument,
    revision: revisionFlag.pipe(Flag.optional),
    from: Flag.directory("from", { mustExist: true }).pipe(
      Flag.withDescription("A directory containing one verified exact-content copy"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ project, revision, from }) {
    if (Option.isNone(revision) && Option.isNone(from)) {
      const recovery = yield* daemonRequest<{
        readonly state: "healthy" | "recovering" | "held";
        readonly cycle: number;
        readonly attempts: number;
        readonly safety: "safe" | "pending" | "uncertain";
      }>(`/api/v1/projects/${encodeURIComponent(project)}/actions/repair`, {
        method: "POST",
        body: {},
      }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
      yield* Console.log(
        recovery.state === "healthy"
          ? `Project ${project} needs no recovery.`
          : `Project ${project} recovery cycle ${recovery.cycle} started with ${recovery.attempts} attempts used; safety is ${recovery.safety}.`,
      );
      return;
    }
    if (Option.isNone(revision) || Option.isNone(from)) {
      return yield* commandFailed("exact-content repair requires both --revision and --from");
    }
    const document = yield* daemonRequest<RevisionDetails>(
      `/api/v1/projects/${encodeURIComponent(project)}/revisions/${encodeURIComponent(revision.value)}/actions/repair`,
      { method: "POST", body: { from: from.value } },
    ).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* Console.log(`Repaired exact Workflow Revision ${document.revisionId}.`);
    yield* Console.log(
      document.faults.length === 0
        ? "All retained bytes and shared objects match the accepted manifest."
        : `Remaining faults ${JSON.stringify(document.faults)}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Restore exact retained bytes without installation, rebuilding, substitution, or scripts",
  ),
);

export const project = Command.make("project").pipe(
  Command.withDescription("Register and inspect Projects owned by the Daemon"),
  Command.withSubcommands([register, list, relocate, archive, restore, status, configure, repair]),
);

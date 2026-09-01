import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type {
  ClientRequestDocument,
  ProjectSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Console, Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { DaemonPaths } from "../contexts/daemon/models/DaemonPaths.ts";
import { readDaemonEndpoint } from "../contexts/daemon/services/daemonStatus.ts";
import { linuxPaths } from "../contexts/daemon/services/linuxPaths.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";
import { exactGitWorkingTree } from "../contexts/project/services/gitWorkingTree.ts";
import { commandFailed } from "./CommandFailed.ts";

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

const requestIdArgument = Argument.string("request-id").pipe(
  Argument.withDescription("The durable client request ID"),
);

const register = Command.make(
  "register",
  {
    path: Flag.directory("path", { mustExist: true }).pipe(
      Flag.withDescription("The exact Git working-tree root to register"),
      Flag.withDefault("."),
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
    yield* Console.log(`request ${id}`);
    yield* daemonRequest<ClientRequestDocument>(`/api/v1/client-requests/${id}`, {
      method: "PUT",
      body: mutation,
    }).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
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

const lookup = Command.make(
  "request",
  { requestId: requestIdArgument },
  Effect.fn(function* ({ requestId }) {
    const document = yield* daemonRequest<ClientRequestDocument>(
      `/api/v1/client-requests/${requestId}`,
    ).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* Console.log(JSON.stringify(document));
  }),
).pipe(Command.withDescription("Look up an exact retained client request and its receipt"));

const retry = Command.make(
  "retry",
  { requestId: requestIdArgument },
  Effect.fn(function* ({ requestId }) {
    const receipt = yield* daemonRequest<OperationReceipt>(
      `/api/v1/client-requests/${requestId}/retry`,
      { method: "POST", body: {} },
    ).pipe(Effect.catch((cause) => commandFailed(cause.reason)));
    yield* Console.log(JSON.stringify(receipt));
  }),
).pipe(Command.withDescription("Retry the exact retained request without changing its content"));

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
        `${project.projectId}\t${project.projectState}\t${project.factoryState}\t${project.location}`,
      );
    }
  }),
).pipe(Command.withDescription("Read one authoritative Project catalogue snapshot"));

export const project = Command.make("project").pipe(
  Command.withDescription("Register and inspect Projects owned by the Daemon"),
  Command.withSubcommands([register, list, lookup, retry]),
);

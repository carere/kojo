import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { ClientRequestDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { clientExit } from "../../../cli/ClientExit.ts";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import { readDaemonEndpoint } from "../services/daemonStatus.ts";
import { hostPaths } from "../services/hostPaths.ts";
import { replayHostClientRequest } from "./HostClientRequestReplay.ts";

const daemonRequest = <A>(
  path: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Effect.Effect<A, string> =>
  Effect.tryPromise({
    try: async () => {
      const endpoint = readDaemonEndpoint(hostPaths());
      if (endpoint === undefined)
        throw new Error("the Daemon is not ready; run `kojo daemon status`");
      const response = await fetch(`http://localhost${path}`, {
        unix: endpoint.socketPath,
        method: options.method,
        headers: {
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      } as RequestInit & { readonly unix: string });
      const value = (await response.json()) as unknown;
      if (!response.ok) throw new Error(`the Daemon answered ${response.status}`);
      return value as A;
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

const readRequest = (requestId: string): Effect.Effect<ClientRequestDocument, string> =>
  daemonRequest(`/api/v1/client-requests/${encodeURIComponent(requestId)}`);

const timeoutMillis = (value: string): number | undefined => {
  if (value === "none") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
  if (match === null)
    throw new Error("--timeout must be positive ms, s, m, h, bare seconds, or none");
  const amount = Number(match[1]);
  if (!(amount > 0)) throw new Error("--timeout must be positive");
  const unit = match[2] ?? "s";
  return amount * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit] ?? 1_000);
};

/** Top-level inspection, including recovery of one exact durable client request. */
export const status = Command.make(
  "status",
  {
    request: Flag.string("request").pipe(Flag.optional),
    details: Flag.boolean("details"),
    follow: Flag.boolean("follow"),
    wait: Flag.boolean("wait"),
    timeout: Flag.string("timeout").pipe(Flag.optional),
    json: Flag.boolean("json"),
  },
  Effect.fn(function* ({ request, details, follow, wait, timeout, json }) {
    if (follow && wait) return yield* clientExit(2, "--follow and --wait cannot be combined");
    if (!follow && !wait && Option.isSome(timeout))
      return yield* clientExit(2, "--timeout is valid only with --follow or --wait");
    if (Option.isNone(request)) {
      if (follow || wait) return yield* clientExit(2, "--follow and --wait require --request ID");
      const endpoint = yield* Effect.try({
        try: () => readDaemonEndpoint(hostPaths()),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(Effect.catch(commandFailed));
      if (json) {
        yield* Console.log(
          JSON.stringify({ formatVersion: 1, ready: endpoint !== undefined, endpoint }),
        );
      } else {
        yield* Console.log(
          endpoint === undefined ? "Daemon not ready." : `Daemon ready (${endpoint.instanceId}).`,
        );
      }
      return;
    }

    const requestId = request.value;
    const duration = yield* Effect.try({
      try: () =>
        Option.isSome(timeout) ? timeoutMillis(timeout.value) : follow ? undefined : 60_000,
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((message) => clientExit(2, message)));
    let document = yield* readRequest(requestId).pipe(Effect.catch(commandFailed));
    if (follow || wait) {
      const deadline = duration === undefined ? undefined : Date.now() + duration;
      let shown = "";
      while (document.status === "accepted" && (deadline === undefined || Date.now() < deadline)) {
        const line = json
          ? JSON.stringify({ formatVersion: 1, request: document })
          : `Request ${requestId}: ${document.status}`;
        if (follow && line !== shown) {
          yield* Console.log(line);
          shown = line;
        }
        yield* Effect.promise(() => Bun.sleep(250));
        document = yield* readRequest(requestId).pipe(
          Effect.catch(() => clientExit(3, `request ${requestId} disconnected while following`)),
        );
      }
      if (document.status === "accepted")
        return yield* clientExit(3, `request ${requestId} is still in progress`);
    }
    if (json) {
      yield* Console.log(JSON.stringify({ formatVersion: 1, request: document }));
      return;
    }
    yield* Console.log(`Request ${requestId}: ${document.status}`);
    if (details) yield* Console.log(JSON.stringify(document));
  }),
).pipe(Command.withDescription("Inspect the Daemon or one exact durable client request"));

/** Retry one retained request by identity, without accepting replacement mutation content. */
export const retry = Command.make(
  "retry",
  { request: Flag.string("request") },
  Effect.fn(function* ({ request }) {
    const localReceipt = yield* Effect.tryPromise({
      try: () => replayHostClientRequest(hostPaths(), request),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch(commandFailed));
    if (localReceipt !== undefined) {
      yield* Console.log(JSON.stringify(localReceipt));
      return;
    }
    const receipt = yield* daemonRequest<OperationReceipt>(
      `/api/v1/client-requests/${encodeURIComponent(request)}/retry`,
      { method: "POST", body: {} },
    ).pipe(Effect.catch(commandFailed));
    yield* Console.log(JSON.stringify(receipt));
  }),
).pipe(Command.withDescription("Retry one exact retained request without changing its content"));

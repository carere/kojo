import type { Socket as NetSocket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import { RequestId } from "effect/unstable/rpc/RpcMessage";
import {
  type ControlSubscriptionDelivery,
  ProjectIdentity,
  RequestKey,
  WorkflowRunId,
} from "../../src";
import {
  defaultSocketPath,
  disconnectUnixControlConnection,
  IncompatibleProtocolError,
  type KojoControlClient,
  LocalTransportError,
  makeLocalClient,
  makeOperatingSystemHostActivation,
  makeUnixControlRequestRegistry,
  registerUnixControlDisconnectFinalizer,
  trackUnixControlProtocol,
  UnsupportedControlCapabilityError,
} from "../../src/local-client";

it("keeps fallback Host discovery inside the current user's home", () => {
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    expect(defaultSocketPath()).toBe(join(homedir(), ".kojo", "run", "control.sock"));
  } finally {
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
  }
});

const handshake = {
  protocol: { major: 1, minor: 0 },
  hostVersion: "0.1.0",
  capabilities: ["projects:list"],
} as const;

const controlClient = (
  requests: Array<string>,
  host:
    | typeof handshake
    | { readonly protocol: { readonly major: 2; readonly minor: 0 } } = handshake,
) =>
  ({
    Negotiate: () => {
      requests.push("Negotiate");
      return Effect.succeed(host);
    },
    ListProjects: () => {
      requests.push("ListProjects");
      return Effect.succeed({ projects: [] });
    },
  }) as unknown as KojoControlClient;

it.effect("negotiates before reading the authoritative Project list", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];

    const client = makeLocalClient({ connect: Effect.succeed(controlClient(requests)) });
    const overview = yield* client.getHostOverview;

    expect(overview).toEqual({
      host: handshake,
      projects: [],
      readiness: [],
      projectDefinitions: [],
      workflowSchedules: [],
      workflowOccurrences: [],
      workflowRuns: [],
    });
    expect(requests).toEqual(["Negotiate", "ListProjects"]);
  }),
);

it.effect("discovers additive capabilities only after the legacy-safe handshake", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const legacyResponse = {
      protocol: { major: 1, minor: 1 },
      hostVersion: "0.1.0",
      capabilities: ["projects:list"],
    } as const;
    const fullResponse = {
      ...legacyResponse,
      capabilities: ["projects:list", "projects:list-page"],
    } as const;
    const transport = {
      Negotiate: () => {
        requests.push("Negotiate");
        return Effect.succeed(legacyResponse);
      },
      NegotiateCapabilities: () => {
        requests.push("NegotiateCapabilities");
        return Effect.succeed(fullResponse);
      },
      ListProjectPage: () => {
        requests.push("ListProjectPage");
        return Effect.succeed({ ok: true as const, page: { items: [], nextCursor: null } });
      },
    } as unknown as KojoControlClient;

    const result = yield* makeLocalClient({ connect: Effect.succeed(transport) }).listProjectPage();

    expect(result).toEqual({ ok: true, page: { items: [], nextCursor: null } });
    expect(requests).toEqual(["Negotiate", "NegotiateCapabilities", "ListProjectPage"]);
  }),
);

it.effect("keeps every authoritative Project in the unpaged Host overview", () =>
  Effect.gen(function* () {
    const projects = Array.from({ length: 201 }, (_, index) => ({
      identity: Schema.decodeUnknownSync(ProjectIdentity)(
        `00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
      ),
      path: `/projects/${index}`,
    }));
    const transport = {
      Negotiate: () => Effect.succeed(handshake),
      ListProjects: () => Effect.succeed({ projects }),
    } as unknown as KojoControlClient;

    const overview = yield* makeLocalClient({ connect: Effect.succeed(transport) }).getHostOverview;

    expect(overview.projects).toEqual(projects);
  }),
);

it.effect("stops before Project lifecycle work when the protocol major is incompatible", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];

    const client = makeLocalClient({
      connect: Effect.succeed(controlClient(requests, { protocol: { major: 2, minor: 0 } })),
    });
    const error = yield* Effect.flip(client.getHostOverview);

    expect(error).toBeInstanceOf(IncompatibleProtocolError);
    expect(requests).toEqual(["Negotiate"]);
  }),
);

it.effect("gates optional Project operations against negotiated Host capabilities", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const client = makeLocalClient({ connect: Effect.succeed(controlClient(requests)) });
    const identity = Schema.decodeUnknownSync(ProjectIdentity)(
      "019fabda-76fe-7000-a948-c929fc96b3e8",
    );
    const requestKey = Schema.decodeUnknownSync(RequestKey)("10000000-0000-4000-8000-000000000001");

    const pageError = yield* Effect.flip(client.listProjectPage());
    const showError = yield* Effect.flip(client.showProject(identity));
    const registerError = yield* Effect.flip(client.registerProject("/project", requestKey));
    const forgetError = yield* Effect.flip(
      client.forgetProject(identity, { kind: "identity", identity }, requestKey),
    );
    const replayError = yield* Effect.flip(
      client.replayForgetProject({ kind: "identity", identity }, requestKey),
    );

    expect(pageError).toMatchObject({
      _tag: "UnsupportedControlCapabilityError",
      capability: "projects:list-page",
    });
    expect(showError).toMatchObject({
      _tag: "UnsupportedControlCapabilityError",
      capability: "projects:show",
      hostVersion: "0.1.0",
    });
    expect(registerError).toBeInstanceOf(UnsupportedControlCapabilityError);
    expect(forgetError).toBeInstanceOf(UnsupportedControlCapabilityError);
    expect(replayError).toBeInstanceOf(UnsupportedControlCapabilityError);
    expect(requests).toEqual(["Negotiate", "Negotiate", "Negotiate", "Negotiate", "Negotiate"]);
  }),
);

it.effect("activates once and retries discovery within a bound", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let activations = 0;
    const transport = controlClient([]);
    const client = makeLocalClient({
      connect: Effect.suspend(() => {
        attempts += 1;
        return attempts < 3
          ? Effect.fail(new LocalTransportError({ message: "Kojo Host is unavailable." }))
          : Effect.succeed(transport);
      }),
      activate: Effect.sync(() => {
        activations += 1;
      }),
      retryDelay: "0 millis",
      maxAttempts: 3,
    });

    yield* client.getHostOverview;

    expect(attempts).toBe(3);
    expect(activations).toBe(1);
  }),
);

it.effect("reads durable traces and opens explicitly scoped control subscriptions", () =>
  Effect.gen(function* () {
    const identity = Schema.decodeUnknownSync(ProjectIdentity)(
      "00000000-0000-7000-8000-000000000001",
    );
    const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000002");
    const requests: Array<string> = [];
    const host = {
      protocol: { major: 1, minor: 8 },
      hostVersion: "0.1.0",
      capabilities: ["traces:read", "control:subscribe", "control:acknowledge"],
    } as const;
    const transport = {
      Negotiate: () => {
        requests.push("Negotiate");
        return Effect.succeed(host);
      },
      NegotiateCapabilities: () => {
        requests.push("NegotiateCapabilities");
        return Effect.succeed(host);
      },
      ReadExecutionTrace: () => {
        requests.push("ReadExecutionTrace");
        return Effect.succeed({
          ok: true as const,
          page: {
            events: [],
            final: false,
            highWaterSequence: 0,
            nextCursor: null,
            runState: "running" as const,
          },
        });
      },
      SubscribeControl: () => {
        requests.push("SubscribeControl");
        return Stream.succeed({
          deliverySequence: 1,
          kind: "resync-required" as const,
          identity,
          runId,
          highWaterSequence: 0,
          subscriptionId: "subscription" as never,
        });
      },
      AcknowledgeControlSubscription: (delivery: ControlSubscriptionDelivery) => {
        requests.push(`AcknowledgeControlSubscription:${delivery.deliverySequence}`);
        return Effect.succeed({ acknowledged: true as const });
      },
    } as unknown as KojoControlClient;
    const client = makeLocalClient({ connect: Effect.succeed(transport) });

    expect(
      yield* client.readExecutionTrace({
        identity,
        runId,
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: [],
        },
        limit: 100,
      }),
    ).toMatchObject({ ok: true, page: { highWaterSequence: 0 } });
    expect(
      Array.from(
        yield* client
          .subscribeControl({
            projects: [identity],
            topics: ["traces"],
            traces: [{ identity, runId, afterSequence: 0 }],
          })
          .pipe(Stream.runCollect),
      ),
    ).toEqual([
      {
        deliverySequence: 1,
        kind: "resync-required",
        identity,
        runId,
        highWaterSequence: 0,
        subscriptionId: "subscription",
      },
    ]);
    expect(
      yield* client.acknowledgeControlSubscription({
        deliverySequence: 1,
        subscriptionId: "subscription" as never,
      }),
    ).toEqual({ acknowledged: true });
    expect(requests).toEqual([
      "Negotiate",
      "NegotiateCapabilities",
      "ReadExecutionTrace",
      "Negotiate",
      "NegotiateCapabilities",
      "SubscribeControl",
      "Negotiate",
      "NegotiateCapabilities",
      "AcknowledgeControlSubscription:1",
    ]);
  }),
);

it.effect("releases a subscription connection after both terminal delivery and caller abort", () =>
  Effect.gen(function* () {
    const identity = Schema.decodeUnknownSync(ProjectIdentity)(
      "00000000-0000-7000-8000-000000000010",
    );
    const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000011");
    const releases: Array<string> = [];
    const host = {
      protocol: { major: 1, minor: 10 },
      hostVersion: "0.1.0",
      capabilities: ["control:subscribe"],
    } as const;
    const update = {
      deliverySequence: 1,
      kind: "resync-required" as const,
      identity,
      runId,
      highWaterSequence: 0,
      subscriptionId: "subscription" as never,
    };
    const connection = (stream: Stream.Stream<typeof update>) =>
      Effect.acquireRelease(
        Effect.succeed({
          Negotiate: () => Effect.succeed(host),
          NegotiateCapabilities: () => Effect.succeed(host),
          SubscribeControl: () => stream,
        } as unknown as KojoControlClient),
        () => Effect.sync(() => releases.push("released")),
      );

    yield* makeLocalClient({ connect: connection(Stream.succeed(update)) })
      .subscribeControl({
        projects: [identity],
        topics: ["traces"],
        traces: [{ identity, runId, afterSequence: 0 }],
      })
      .pipe(Stream.runDrain);
    yield* makeLocalClient({
      connect: connection(Stream.concat(Stream.succeed(update), Stream.never)),
    })
      .subscribeControl({
        projects: [identity],
        topics: ["traces"],
        traces: [{ identity, runId, afterSequence: 0 }],
      })
      .pipe(Stream.take(1), Stream.runDrain);

    expect(releases).toEqual(["released", "released"]);
  }),
);

it.effect("runs an explicit connector disconnect after terminal delivery and caller abort", () =>
  Effect.gen(function* () {
    const identity = Schema.decodeUnknownSync(ProjectIdentity)(
      "00000000-0000-7000-8000-000000000012",
    );
    const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000013");
    const disconnects: Array<string> = [];
    const host = {
      protocol: { major: 1, minor: 10 },
      hostVersion: "0.1.0",
      capabilities: ["control:subscribe"],
    } as const;
    const update = {
      deliverySequence: 1,
      kind: "resync-required" as const,
      identity,
      runId,
      highWaterSequence: 0,
      subscriptionId: "subscription" as never,
    };
    const clientWith = (stream: Stream.Stream<typeof update>) =>
      makeLocalClient({
        connect: Effect.succeed({
          client: {
            Negotiate: () => Effect.succeed(host),
            NegotiateCapabilities: () => Effect.succeed(host),
            SubscribeControl: () => stream,
          } as unknown as KojoControlClient,
          disconnect: Effect.sync(() => disconnects.push("disconnect")),
        }),
      });
    const input = {
      projects: [identity],
      topics: ["traces" as const],
      traces: [{ identity, runId, afterSequence: 0 }],
    };

    yield* clientWith(Stream.succeed(update)).subscribeControl(input).pipe(Stream.runDrain);
    yield* clientWith(Stream.concat(Stream.succeed(update), Stream.never))
      .subscribeControl(input)
      .pipe(Stream.take(1), Stream.runDrain);

    expect(disconnects).toEqual(["disconnect", "disconnect"]);
  }),
);

it.effect("disconnects the Unix transport before older protocol finalizers", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const scope = yield* Scope.make();
    let destroyed = false;
    const connection = {
      get destroyed() {
        return destroyed;
      },
      destroy: () => {
        events.push("disconnect");
        destroyed = true;
        return connection;
      },
    } as unknown as Pick<NetSocket, "destroy" | "destroyed">;

    yield* Effect.addFinalizer(() => Effect.sync(() => events.push("protocol"))).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    yield* registerUnixControlDisconnectFinalizer(connection).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    yield* Scope.close(scope, Exit.void);

    expect(events).toEqual(["disconnect", "protocol"]);
  }),
);

it.effect(
  "sends Eof then bounds Unix disconnect when a peer does not honor its graceful close",
  () =>
    Effect.gen(function* () {
      const makeSocket = (honorClose: boolean) => {
        const events: Array<string> = [];
        let onClose: (() => void) | undefined;
        let destroyed = false;
        const socket = {
          get destroyed() {
            return destroyed;
          },
          destroy: () => {
            events.push("destroy");
            destroyed = true;
            return socket;
          },
          end: () => {
            events.push("end");
            if (honorClose) onClose?.();
            return socket;
          },
          off: () => socket,
          once: (_event: string, listener: () => void) => {
            onClose = listener;
            return socket;
          },
        } as unknown as Pick<NetSocket, "destroy" | "destroyed" | "end" | "off" | "once">;
        return { events, socket };
      };

      const sent: Array<string> = [];
      const protocol = (requestRegistry: ReturnType<typeof makeUnixControlRequestRegistry>) =>
        ({
          send: (
            _clientId: number,
            message: { readonly _tag: string; readonly requestId?: number },
          ) =>
            Effect.sync(() => {
              sent.push(message._tag);
              if (message._tag === "Interrupt" && message.requestId !== undefined) {
                requestRegistry.terminal(RequestId(message.requestId));
              }
            }),
        }) as never;

      const honoringPeer = makeSocket(true);
      const honoringRequests = makeUnixControlRequestRegistry();
      honoringRequests.add(RequestId(37));
      yield* disconnectUnixControlConnection(
        honoringPeer.socket as NetSocket,
        protocol(honoringRequests),
        honoringRequests,
      );
      expect(honoringPeer.events).toEqual(["end"]);
      expect(sent).toEqual(["Interrupt", "Eof"]);

      sent.length = 0;
      const nonHonoringPeer = makeSocket(false);
      const nonHonoringRequests = makeUnixControlRequestRegistry();
      nonHonoringRequests.add(RequestId(37));
      yield* disconnectUnixControlConnection(
        nonHonoringPeer.socket as NetSocket,
        protocol(nonHonoringRequests),
        nonHonoringRequests,
      );
      expect(nonHonoringPeer.events).toEqual(["end", "destroy"]);
      expect(sent).toEqual(["Interrupt", "Eof"]);
    }),
);

it.effect("waits for terminal Exit after an RPC stream already sent Interrupt", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    let receive: ((response: never) => Effect.Effect<void>) | undefined;
    const socket = {
      destroyed: false,
      destroy: () => socket,
      end: () => {
        events.push("end");
        closeListener?.();
        return socket;
      },
      off: () => socket,
      once: (_event: string, listener: () => void) => {
        closeListener = listener;
        return socket;
      },
    } as unknown as Pick<NetSocket, "destroy" | "destroyed" | "end" | "off" | "once">;
    let closeListener: (() => void) | undefined;
    const requestRegistry = makeUnixControlRequestRegistry();
    const protocol = {
      run: (_clientId: number, onResponse: (response: never) => Effect.Effect<void>) =>
        Effect.sync(() => {
          receive = onResponse;
        }).pipe(Effect.andThen(Effect.never)),
      send: (_clientId: number, message: { readonly _tag: string; readonly requestId?: number }) =>
        Effect.sync(() => {
          if (message._tag !== "Request") events.push(message._tag);
          if (message._tag === "Interrupt" && message.requestId !== undefined) {
            setTimeout(() => {
              const deliver = receive;
              if (deliver !== undefined) {
                void Effect.runPromise(
                  deliver({ _tag: "Exit", requestId: message.requestId } as never),
                );
              }
            }, 1);
          }
        }),
      supportsAck: true,
      supportsTransferables: false,
    } as never;
    const tracked = trackUnixControlProtocol(protocol, requestRegistry);
    const request = { _tag: "Request", headers: [], id: 37, payload: null, tag: "Test" } as never;

    yield* tracked
      .run(0, (response) => Effect.sync(() => events.push(response._tag)))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* tracked.send(0, request);
    yield* tracked.send(0, { _tag: "Interrupt", requestId: 37 });
    yield* disconnectUnixControlConnection(socket as NetSocket, tracked, requestRegistry);

    expect(events).toEqual(["Interrupt", "Exit", "Eof", "end"]);
  }),
);

it.effect("tracks only active Unix RPC requests for disconnect", () =>
  Effect.gen(function* () {
    const requestRegistry = makeUnixControlRequestRegistry();
    requestRegistry.add(RequestId(99));
    let receive: ((response: never) => Effect.Effect<void>) | undefined;
    const protocol = {
      run: (_clientId: number, onResponse: (response: never) => Effect.Effect<void>) =>
        Effect.sync(() => {
          receive = onResponse;
        }).pipe(Effect.andThen(Effect.never)),
      send: () => Effect.void,
      supportsAck: true,
      supportsTransferables: false,
    } as never;
    const tracked = trackUnixControlProtocol(protocol, requestRegistry);
    const request = (id: number) =>
      ({ _tag: "Request", headers: [], id, payload: null, tag: "Test" }) as never;

    yield* tracked.run(0, () => Effect.void).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    const deliver = receive;
    if (deliver === undefined) return yield* Effect.die("Protocol did not start its receive loop.");

    yield* tracked.send(0, request(1));
    expect([...requestRegistry.active]).toEqual([99, 1]);
    yield* deliver({ _tag: "Exit", requestId: 1 } as never);
    expect([...requestRegistry.active]).toEqual([99]);

    yield* tracked.send(0, request(2));
    yield* tracked.send(0, { _tag: "Interrupt", requestId: 2 });
    expect([...requestRegistry.active]).toEqual([99, 2]);
    yield* deliver({ _tag: "Exit", requestId: 2 } as never);
    expect([...requestRegistry.active]).toEqual([99]);

    yield* tracked.send(0, request(3));
    yield* deliver({ _tag: "Defect" } as never);
    expect(requestRegistry.active).toEqual(new Set());
  }),
);

it.effect("returns a safe error when discovery remains unavailable", () =>
  Effect.gen(function* () {
    const client = makeLocalClient({
      connect: Effect.fail(new LocalTransportError({ message: "Kojo Host is unavailable." })),
      activate: Effect.void,
      retryDelay: "0 millis",
      maxAttempts: 2,
    });

    const error = yield* Effect.flip(client.getHostOverview);

    expect(error).toEqual(new LocalTransportError({ message: "Kojo Host is unavailable." }));
  }),
);

it.effect("asks launchd to activate the per-user Host on macOS", () =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    yield* makeOperatingSystemHostActivation({
      platform: "darwin",
      userId: 501,
      run: (command) => {
        commands.push(command);
        return Promise.resolve(0);
      },
    });

    expect(commands).toEqual([["launchctl", "kickstart", "gui/501/dev.kojo.host"]]);
  }),
);

it("bounds a stalled operating-system Host activation", async () => {
  let calls = 0;
  await Effect.runPromise(
    makeOperatingSystemHostActivation({
      platform: "darwin",
      userId: 501,
      activationTimeout: "1 millis",
      run: (_command, signal) => {
        calls += 1;
        return new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => resolve(1), { once: true });
        });
      },
    }),
  );

  expect(calls).toBe(1);
}, 1_000);

it.effect("asks systemd to activate the per-user Host on Linux", () =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    yield* makeOperatingSystemHostActivation({
      platform: "linux",
      userId: 501,
      run: (command) => {
        commands.push(command);
        return Promise.resolve(0);
      },
    });

    expect(commands).toEqual([["systemctl", "--user", "start", "kojo-host.service"]]);
  }),
);

it.effect("returns an explicit transport failure when Host activation is unsupported", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      makeOperatingSystemHostActivation({
        platform: "freebsd",
        userId: 501,
        run: () => Promise.resolve(0),
      }),
    );

    expect(error).toEqual(
      new LocalTransportError({ message: "Kojo Host activation is unsupported on freebsd." }),
    );
  }),
);

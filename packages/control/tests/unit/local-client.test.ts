import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ProjectIdentity, RequestKey } from "../../src";
import {
  defaultSocketPath,
  IncompatibleProtocolError,
  type KojoControlClient,
  LocalTransportError,
  makeLocalClient,
  makeOperatingSystemHostActivation,
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

    expect(overview).toEqual({ host: handshake, projects: [] });
    expect(requests).toEqual(["Negotiate", "ListProjects"]);
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

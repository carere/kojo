// Deep path, never the package barrel: the barrel re-exports BunRedis, which imports the `bun`
// builtin and would end this worker before a single test ran.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, type PlatformError } from "effect";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { indexFile, shell } from "../../../src/console/shell.ts";

/**
 * The static half, on a real socket, over real files.
 *
 * Everything here is the real adapter: `BunHttpServer.layerTest` starts a Bun server on an ephemeral
 * port with a client already pointed at it, the files are on the disk, and the responses come back
 * over TCP. That matters because the claims are about behaviour the framework decides — what
 * `HttpStaticServer` does with a path that is not a file, what content type a file response carries,
 * and what the traversal guard refuses — and none of it can be graded against a fake.
 *
 * The subject is the **hand-rolled** fallback. The built-in one serves the shell only when the stat
 * failed `NotFound` *and* `spa: true` *and* the path has no extension *and* `Accept` contains
 * `text/html`; every request below fails at least one of those conditions and must still get the
 * application.
 */

const built = {
  [indexFile]: "<!doctype html><html><body><div id=root>the real shell</div></body></html>",
  "app.js": "console.log('bundle')",
};

/** A directory that looks like a Console build, and the server serving it. */
const serving = <A, E>(
  files: Record<string, string>,
  use: (assets: string) => Effect.Effect<A, E, HttpClient.HttpClient>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const assets = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-console-" });
    yield* Effect.forEach(Object.entries(files), ([name, content]) =>
      fileSystem.writeFileString(`${assets}/${name}`, content),
    );

    return yield* use(assets).pipe(
      Effect.provide(
        HttpRouter.serve(shell({ assets }), { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(BunHttpServer.layerTest),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

interface Answered {
  readonly status: number;
  readonly type: string;
  readonly body: string;
}

const gets = (path: string): Effect.Effect<Answered, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(path);
    return {
      status: response.status,
      type: response.headers["content-type"] ?? "",
      body: yield* response.text,
    };
  }).pipe(Effect.orDie);

describe("the built assets", () => {
  it.live("serves a real file with its own content type", () =>
    serving(built, () =>
      Effect.gen(function* () {
        const bundle = yield* gets("/app.js");
        expect(bundle.status).toBe(200);
        expect(bundle.body).toBe("console.log('bundle')");
        expect(bundle.type).toContain("text/javascript");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("serves the shell at the root, as HTML", () =>
    serving(built, () =>
      Effect.gen(function* () {
        const root = yield* gets("/");
        expect(root.status).toBe(200);
        expect(root.body).toContain("the real shell");
        expect(root.type).toContain("text/html");
      }),
    ).pipe(Effect.orDie),
  );
});

describe("a deep link", () => {
  it.live("resolves to the shell with no Accept header and no extension", () =>
    serving(built, () =>
      Effect.gen(function* () {
        // The measured case: `curl /runs/r1` bare returns 404 from the built-in fallback, because
        // the client sent no `Accept: text/html`. This is the URL a person pastes to a colleague.
        const deep = yield* gets("/runs/r1");
        expect(deep.status).toBe(200);
        expect(deep.body).toContain("the real shell");
        // `fileResponse` sets no content type, so without the explicit header a browser is offered
        // the Console as a download instead of rendering it.
        expect(deep.type).toContain("text/html");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("resolves to the shell when a segment contains a dot", () =>
    serving(built, () =>
      Effect.gen(function* () {
        // The other measured case: any deep-link segment with a dot in it looks like a file to the
        // built-in fallback and 404s. A phase id carries an attempt and a name, so this is ordinary.
        const dotted = yield* gets("/runs/r1.2/phases/draft.1");
        expect(dotted.status).toBe(200);
        expect(dotted.body).toContain("the real shell");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("never serves a file outside the build, whatever the path claims", () =>
    serving(built, () =>
      Effect.gen(function* () {
        // `HttpStaticServer` owns this guard, and it refuses by resolving to nothing — which reaches
        // the fallback as `RouteNotFound`. So an escape attempt gets the application shell, and at no
        // point is a file outside the root read.
        const escaped = yield* gets("/%2e%2e/%2e%2e/%2e%2e/etc/passwd");
        expect(escaped.status).toBe(200);
        expect(escaped.body).toContain("the real shell");
        expect(escaped.body).not.toContain("root:");
      }),
    ).pipe(Effect.orDie),
  );
});

describe("a directory with no build in it", () => {
  it.live("says the front end is not built, rather than 404ing every path", () =>
    serving({ "notes.txt": "nothing to serve" }, () =>
      Effect.gen(function* () {
        const root = yield* gets("/");
        expect(root.status).toBe(200);
        expect(root.body).toContain("The front end is not built yet");

        const deep = yield* gets("/runs/r1");
        expect(deep.status).toBe(200);
        expect(deep.body).toContain("The front end is not built yet");
      }),
    ).pipe(Effect.orDie),
  );
});

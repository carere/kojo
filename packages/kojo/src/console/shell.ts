import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/unstable/http";

/**
 * The application shell and the files beside it.
 *
 * The Console is a static build — a prerendered shell plus a client bundle, no server functions —
 * so serving it is a directory of files and one rule about what happens when a path is not in it.
 * That rule is the whole of this module, and it is hand-rolled for a measured reason.
 *
 * **The built-in SPA fallback is conditional, and the conditions are wrong for a Console.**
 * `HttpStaticServer` serves the shell only when the stat failed `NotFound` **and** `spa: true`
 * **and** the path has no extension **and** `Accept` contains `text/html`. Verified: `curl /runs/r1`
 * bare returns 404, and a deep link whose segment contains a dot — which every run id with a version
 * in it has — 404s as well. A person pasting a phase URL to a colleague must get the shell, whatever
 * their client sends. So this catches `RouteNotFound` and serves the shell unconditionally.
 *
 * **`fileResponse` sets no content type**, which is why the explicit header below is load-bearing
 * rather than decoration: without it a browser is handed the shell as `application/octet-stream` and
 * offers to download the Console instead of rendering it.
 *
 * What is *not* hand-rolled: the path-traversal guard, byte ranges and ETag are `HttpStaticServer`'s
 * own and are better than a reimplementation. The guard ported from SSSF protects `ArtifactReader`'s
 * id segments — a different surface, and not this one.
 */

/** What a directory has to contain before it can be called a Console build. */
export const indexFile = "index.html";

/** What a shell is, whoever produced it. Set explicitly, because `fileResponse` does not. */
const html = "text/html; charset=utf-8";

/**
 * The placeholder served until `apps/console` exists.
 *
 * It is deliberately not a blank page: a person who runs `kojo ui` before the front end is built
 * should be told what is and is not there, and given the API to look at, rather than left wondering
 * whether the server is broken. It says the same thing the real shell's empty states say — where to
 * look and what to run.
 */
export const placeholder = (options: { readonly assets: string }): string =>
  [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Kojo Console</title>",
    "</head><body>",
    "<h1>Kojo Console</h1>",
    "<p>The API is being served. The front end is not built yet.</p>",
    `<p>No <code>${indexFile}</code> was found under <code>${options.assets}</code>.</p>`,
    "<p>An installed Kojo ships the front end already built, so this page means the engine is running",
    "from a source checkout, where it is build output rather than a committed file. Build the Console",
    "in that checkout, then <strong>restart this server</strong> — the directory above is resolved",
    "once, at startup, so a build under a running server changes nothing here.</p>",
    "<p>The API is at <code>/api/health</code>, <code>/api/runs</code> and <code>/api/gates</code>.</p>",
    "</body></html>",
  ].join("");

/**
 * The built assets, with every unmatched path resolving to the shell.
 *
 * Mounted on `GET /*`, which the router matches only after the API's own paths, so a missing
 * `/api/...` route would fall through to the shell rather than to a 404. That is deliberate for a
 * single-page application and harmless for the API, whose paths are all matched above.
 */
const built = (options: { readonly root: string }) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const path = yield* Path.Path;
      const shell = path.join(path.resolve(options.root), indexFile);

      const files = yield* HttpStaticServer.make({
        root: options.root,
        index: indexFile,
        // Left off on purpose. The built-in fallback would fire for *some* deep links and not
        // others, which is worse than none at all: it would make the four conditions above look
        // like they had been dealt with.
        spa: false,
        // A defect, not an error channel: the only thing this can fail on is the platform services
        // that are not there, which is a mis-wired server rather than a bad request. Leaving it
        // typed would put it in the layer's error channel and from there into `serve`.
      }).pipe(Effect.orDie);

      /**
       * The shell, whatever the path was.
       *
       * The explicit content type is the load-bearing line: `fileResponse` sets none, so without it
       * a browser is handed the Console as `application/octet-stream` and offers to download it.
       */
      const shellResponse = HttpServerResponse.file(shell).pipe(
        Effect.map(HttpServerResponse.setHeader("content-type", html)),
        // The shell has gone from a directory that had it a moment ago. Nothing this server can do
        // is right, so it says so rather than serving a page with no application in it.
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("the Console shell could not be read", { status: 500 }),
        ),
      );

      yield* router.add(
        "GET",
        "/*",
        files.pipe(
          Effect.catch((error) =>
            // **Unconditionally, and that is the difference from the built-in.** `RouteNotFound` is
            // what a deep link produces — `/runs/r1`, or a segment with a dot in it — and every one
            // of them is a page of the application rather than a missing file.
            error.reason._tag === "RouteNotFound"
              ? shellResponse
              : Effect.succeed(
                  HttpServerResponse.text(`the Console build could not be read: ${error.message}`, {
                    status: 500,
                  }),
                ),
          ),
        ),
      );
    }),
  );

/** Every path that is not the API, answered with one page. What runs before ticket 27 lands. */
const unbuilt = (options: { readonly assets: string }) =>
  HttpRouter.add("GET", "/*", HttpServerResponse.html(placeholder({ assets: options.assets })));

/**
 * The shell, from a built directory when there is one and from a placeholder when there is not.
 *
 * The choice is made once, when the layer is built, by asking whether the directory holds an
 * `index.html`. A server that decided per request would stat a missing directory on every deep link,
 * and would change what it serves halfway through a session.
 */
export const shell = (options: { readonly assets: string }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const present = yield* fileSystem
        .exists(path.join(options.assets, indexFile))
        .pipe(Effect.orElseSucceed(() => false));

      return present ? built({ root: options.assets }) : unbuilt(options);
    }),
  );

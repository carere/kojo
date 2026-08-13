import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { api, type FactorySite } from "./api.ts";
import { shell } from "./shell.ts";

/**
 * The whole Console: the JSON API and the static build, in one process.
 *
 * **One server, not two.** console.md §7 rejected TanStack Start's SSR server *being* `kojo ui`: the
 * published package already ships the build output, which under SPA mode is a directory of files,
 * while under SSR it would be a second runtime living inside a CLI whose whole discipline is that
 * every side effect goes through a port. So the API and the assets are two route groups on one
 * router, and `GET /*` answers only what the API's own paths did not.
 *
 * **That is the router's doing, not the merge order's.** An earlier version of this comment said the
 * assets are "mounted last" and implied the ordering is what keeps `/api/health` reachable. It is
 * not: find-my-way's radix tree ranks a static segment above a parametric one and both above a
 * wildcard, whenever each was inserted. Measured during the wave-8 merge — swapping the two
 * arguments to `Layer.mergeAll` below leaves the whole unit tier and every console integration test
 * green, `/api/*` still resolving to the API. The order below is house style; do not treat it as the
 * guard. The guard is the route shapes, and `application.test.ts` is what grades it.
 */

/** Everything one Console instance is: where it reads, and where the built page is. */
export interface ConsoleOptions {
  readonly site: FactorySite;
  /** The directory holding the Console build. A placeholder is served when it holds no shell. */
  readonly assets: string;
}

/**
 * The router's application layer, ready for either `HttpRouter.serve` or `HttpRouter.toWebHandler`.
 *
 * Exported as the application rather than as a running server because the two ways of exercising it
 * take it at exactly this point: `toWebHandler` binds no port at all, and `BunHttpServer.layerTest`
 * binds an ephemeral one. A module that only ever handed back a listening server would make every
 * test of these routes a test of a socket.
 */
export const application = (options: ConsoleOptions) =>
  Layer.mergeAll(api(options.site), shell({ assets: options.assets }));

/**
 * The Console, served.
 *
 * The requirements that come out of this are the four ports, the engine, and an `HttpServer` —
 * `BunHttpServer.layer({ port })`, which is the listener `effect/unstable/http` does not have of its
 * own, and which also supplies the `HttpPlatform` that `HttpStaticServer` needs. The ports arrive as
 * ordinary requirements because every route handler's error channel is empty; a handler that failed
 * would arrive here as an unsatisfied *requirement* instead, and the server would not start.
 */
export const served = (options: ConsoleOptions) => HttpRouter.serve(application(options));

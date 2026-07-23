import { BunHttpServer } from "@effect/platform-bun";
import { Api, type HealthResponse } from "@kojo/domain/api";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveKojoHome } from "./system/lifecycle";
import { inspectSystem } from "./system/process";

interface ServerOptions {
  readonly port: number;
}

const SystemApiHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed({
      service: "kojo",
      status: "ok",
    } satisfies HealthResponse),
  ),
);

const ApiLive = HttpApiBuilder.layer(Api).pipe(Layer.provide(SystemApiHandlers));

const InspectorApiProxy = HttpRouter.add("GET", "/api/inspector/*", (request) =>
  Effect.promise(async () => {
    const system = await inspectSystem(resolveKojoHome());
    if (system === undefined) {
      return HttpServerResponse.fromWeb(
        Response.json(
          { error: { code: "SYSTEM_NOT_RUNNING", message: "Kojo System Process is not running" } },
          { status: 503 },
        ),
      );
    }
    const url = new URL(request.url, "http://localhost");
    try {
      const response = await fetch(`http://localhost${url.pathname}${url.search}`, {
        unix: system.endpoint,
      });
      return HttpServerResponse.fromWeb(response);
    } catch {
      return HttpServerResponse.fromWeb(
        Response.json(
          {
            error: {
              code: "SYSTEM_UNAVAILABLE",
              message: "Kojo System Process could not be reached",
            },
          },
          { status: 503 },
        ),
      );
    }
  }),
);

export const runServer = ({ port }: ServerOptions) =>
  Effect.logInfo("Serving the Dense Inspector System Process gateway").pipe(
    Effect.andThen(
      Layer.launch(
        HttpRouter.serve(Layer.merge(ApiLive, InspectorApiProxy)).pipe(
          Layer.provide(
            BunHttpServer.layer({
              hostname: "127.0.0.1",
              port,
            }),
          ),
        ),
      ),
    ),
  );

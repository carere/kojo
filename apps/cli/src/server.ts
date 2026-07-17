import { resolve } from "node:path";
import { BunHttpServer } from "@effect/platform-bun";
import { Api, type HealthResponse } from "@kojo/domain/api";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

interface ServerOptions {
  readonly port: number;
  readonly project: string;
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

export const runServer = ({ port, project }: ServerOptions) =>
  Effect.logInfo(`Managing ${resolve(project)}`).pipe(
    Effect.andThen(
      Layer.launch(
        HttpRouter.serve(ApiLive).pipe(
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

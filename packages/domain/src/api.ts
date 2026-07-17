import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

export const HealthResponse = Schema.Struct({
  service: Schema.Literal("kojo"),
  status: Schema.Literal("ok"),
}).annotate({ identifier: "HealthResponse" });

export type HealthResponse = Schema.Schema.Type<typeof HealthResponse>;

export class SystemApiGroup extends HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: HealthResponse,
    }),
  )
  .prefix("/api")
  .annotateMerge(
    OpenApi.annotations({
      title: "System",
    }),
  ) {}

export class Api extends HttpApi.make("api")
  .add(SystemApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Kojo API",
    }),
  ) {}

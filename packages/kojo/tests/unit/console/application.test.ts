import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http";
import { WorkflowEngine } from "effect/unstable/workflow";
import type { FactorySite } from "../../../src/console/api.ts";
import { application } from "../../../src/console/server.ts";
import * as InMemoryGateRepository from "../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import * as InMemoryArtifactReader from "../../../src/contexts/trace/adapters/InMemoryArtifactReader.ts";
import * as InMemoryTraceReader from "../../../src/contexts/trace/adapters/InMemoryTraceReader.ts";
import * as InMemoryRunnerRepository from "../../../src/contexts/workflow/adapters/InMemoryRunnerRepository.ts";

/**
 * The API and the shell on one router — which is the whole claim of "one process serves both".
 *
 * The interesting risk is the shell's mount: it is `GET /*`, and a wildcard that swallowed
 * `/api/health` would turn the entire API into a page of HTML with a 200 on it. That failure is
 * invisible to a test of either half on its own, so it is graded here, where both are mounted.
 *
 * No filesystem and no platform: this tier states them, exactly as it states the ports. The real
 * ones are the integration tier's subject.
 */

const site: FactorySite = {
  database: ".kojo/data/kojo.db",
  factory: "present",
  version: "0.0.0",
  commit: "development",
  applied: 1,
  expected: 1,
};

/** A filesystem with no Console build in it, which is the state before ticket 27 lands. */
const noBuild = FileSystem.layerNoop({ exists: () => Effect.succeed(false) });

/**
 * The platform the static server would need, over the filesystem that has nothing.
 *
 * Present to satisfy the type and never reached: with no `index.html` the shell layer takes its
 * placeholder branch, which serves a string and touches no file.
 */
const platform = HttpPlatform.layer.pipe(Layer.provide(Layer.mergeAll(noBuild, Etag.layerWeak)));

const app = application({ site, assets: "/nowhere" }).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      InMemoryTraceReader.of({}),
      InMemoryArtifactReader.of({}),
      InMemoryGateRepository.layer,
      InMemoryRunnerRepository.of([]),
      WorkflowEngine.layerMemory,
      noBuild,
      Path.layer,
      platform,
    ),
  ),
);

const asks = (path: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
    ({ handler }) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => handler(new Request(`http://host${path}`)));
        return {
          status: response.status,
          type: response.headers.get("content-type") ?? "",
          body: yield* Effect.promise(() => response.text()),
        };
      }),
    ({ dispose }) => Effect.promise(dispose),
  );

describe("one router, two halves", () => {
  it.effect("keeps the API's own paths out of the shell's wildcard", () =>
    Effect.gen(function* () {
      const health = yield* asks("/api/health");
      expect(health.status).toBe(200);
      expect(health.type).toContain("application/json");
      expect(JSON.parse(health.body).database).toBe(".kojo/data/kojo.db");
    }),
  );

  it.effect("answers a deep link with the shell, whatever the path looks like", () =>
    Effect.gen(function* () {
      // Three shapes the built-in fallback refuses: no `Accept: text/html` on any of them, a dot in
      // a segment on the second, and a path that is not a file on all three.
      for (const path of ["/runs/r1", "/runs/r1.2/phases/draft.1", "/gates"]) {
        const answered = yield* asks(path);
        expect(answered.status).toBe(200);
        expect(answered.type).toContain("text/html");
        expect(answered.body).toContain("Kojo Console");
      }
    }),
  );

  it.effect("says the front end is not built rather than serving a blank page", () =>
    Effect.gen(function* () {
      const answered = yield* asks("/");
      expect(answered.body).toContain("The front end is not built yet");
      expect(answered.body).toContain("/api/health");
    }),
  );
});

import { Clock, Console, Effect } from "effect";
import { tryExternalPromise } from "../../shared/external-failure";
import { WorkflowError } from "../../types/errors";
import type { PreviewIdentity } from "../../types/preview";
import { STARTUP_TIMEOUT_MS } from "./constants";

export const previewUrl = (identity: PreviewIdentity, port: number) =>
  `http://${identity.hostname}:${port}`;

const isReady = (url: string) =>
  tryExternalPromise("preview", `fetch ${url}`, (signal) =>
    fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    }),
  ).pipe(
    Effect.map((response) => response.status < 500),
    Effect.catch(() => Effect.succeed(false)),
  );

export const waitUntilReady = Effect.fn("waitUntilReady")(function* (url: string) {
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = startedAt + STARTUP_TIMEOUT_MS;
  let now = startedAt;

  while (now < deadline) {
    if (yield* isReady(url)) return;
    yield* Effect.sleep("500 millis");
    now = yield* Clock.currentTimeMillis;
  }

  return yield* new WorkflowError({
    message: `Preview did not become ready within ${STARTUP_TIMEOUT_MS / 1_000} seconds`,
    operation: "preview.waitUntilReady",
  });
});

export const printReady = (identity: PreviewIdentity, port: number) =>
  Effect.gen(function* () {
    yield* Console.log(`Preview ready for '${identity.branch}':`);
    yield* Console.log(previewUrl(identity, port));
  });

import { expect, it } from "vitest";
import { detachResponseOnAbort } from "../../../../../src/contexts/shared/server";

it("waits for source cancellation before completing an aborted browser response", async () => {
  const abort = new AbortController();
  let notifyCancellationStarted: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    notifyCancellationStarted = resolve;
  });
  let finishCancellation: (() => void) | undefined;
  const source = new ReadableStream<Uint8Array>({
    cancel: () => {
      notifyCancellationStarted?.();
      return new Promise<void>((resolve) => {
        finishCancellation = resolve;
      });
    },
  });
  const response = detachResponseOnAbort(new Response(source), abort.signal);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected a streaming response body.");

  const next = reader.read();
  abort.abort();
  await cancellationStarted;

  let completed = false;
  void next.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);

  finishCancellation?.();
  expect(await next).toEqual({ done: true, value: undefined });
});

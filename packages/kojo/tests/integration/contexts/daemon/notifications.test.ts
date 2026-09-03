import { describe, expect, it } from "@effect/vitest";
import { DaemonNotifications } from "../../../../src/contexts/daemon/services/DaemonNotifications.ts";

const event = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const next = await reader.read();
  expect(next.done).toBe(false);
  return new TextDecoder().decode(next.value);
};

describe("Daemon notifications", () => {
  it("preserves final snapshots across reconnect and disconnects slow readers without delaying execution", async () => {
    const notifications = new DaemonNotifications();
    const firstAbort = new AbortController();
    const first = notifications.response(firstAbort.signal).body?.getReader();
    expect(first).toBeDefined();
    expect(await event(first as ReadableStreamDefaultReader<Uint8Array>)).toContain(
      '"resources":["daemon","projects","workflows","runs","askings"]',
    );

    notifications.publish(["runs"]);
    expect(await event(first as ReadableStreamDefaultReader<Uint8Array>)).toContain(
      '"resources":["runs"]',
    );
    firstAbort.abort();
    await first?.cancel();

    const reconnect = notifications.response(new AbortController().signal).body?.getReader();
    expect(await event(reconnect as ReadableStreamDefaultReader<Uint8Array>)).toContain(
      '"resources":["daemon","projects","workflows","runs","askings"]',
    );

    notifications.response(new AbortController().signal);
    const startedAt = performance.now();
    for (let index = 0; index < 8; index += 1) notifications.publish(["runs", "askings"]);
    expect(performance.now() - startedAt).toBeLessThan(20);
    expect(notifications.subscriberCount()).toBe(0);
    notifications.close();
  });
});

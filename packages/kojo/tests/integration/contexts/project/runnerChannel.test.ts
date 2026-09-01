import { connect, createServer, type Socket } from "node:net";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CRITICAL_BUFFER_BYTES,
  MAX_CRITICAL_REQUESTS,
  MAX_ORDINARY_BUFFER_BYTES,
  MAX_ORDINARY_REQUESTS,
  makeRunnerFrameReader,
  makeRunnerFrameWriter,
} from "../../../../src/contexts/project/services/runnerChannel.ts";

const sockets: Socket[] = [];

const pair = async (): Promise<{ readonly daemon: Socket; readonly runner: Socket }> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const runner = connect(address.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    runner.once("connect", resolve);
    runner.once("error", reject);
  });
  const daemon = await accepted;
  server.close();
  sockets.push(daemon, runner);
  return { daemon, runner };
};

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

describe("private Runner channel limits", () => {
  it("terminates only the malformed connection before oversized allocation", async () => {
    const { daemon, runner } = await pair();
    const reader = makeRunnerFrameReader(daemon);
    const observedTraceRows: unknown[] = [];
    const refused = Effect.runPromise(reader.read);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(1024 * 1024 + 1);
    runner.write(prefix);
    await expect(refused).rejects.toThrow("must not exceed");
    await expect(Effect.runPromise(reader.read)).rejects.toThrow("must not exceed");
    expect(daemon.destroyed).toBe(true);
    expect(observedTraceRows).toEqual([]);
  });

  it("backpressures a real slow peer while critical control keeps separate bounded capacity", async () => {
    const { daemon, runner } = await pair();
    runner.pause();
    const writer = makeRunnerFrameWriter(daemon);
    const large = "x".repeat(900_000);
    const ordinary = Array.from({ length: 10 }, (_, index) =>
      Effect.runPromise(
        writer.write({
          version: 1,
          kind: "Fault",
          requestId: `ordinary-${index}`,
          daemonInstanceId: "daemon-1",
          runnerInstanceId: "runner-1",
          body: { large },
        }),
      ),
    );
    await Bun.sleep(20);
    const shutdown = Effect.runPromise(
      writer.write({
        version: 1,
        kind: "Shutdown",
        requestId: "critical-shutdown",
        daemonInstanceId: "daemon-1",
        runnerInstanceId: "runner-1",
        body: null,
      }),
    );
    expect(MAX_ORDINARY_REQUESTS).toBe(64);
    expect(MAX_ORDINARY_BUFFER_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CRITICAL_REQUESTS).toBe(8);
    expect(MAX_CRITICAL_BUFFER_BYTES).toBe(1024 * 1024);

    runner.resume();
    runner.on("data", () => undefined);
    await expect(Promise.all([...ordinary, shutdown])).resolves.toHaveLength(11);
  }, 10_000);
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  listenForProcessStopSignals,
  type ProcessSignalSource,
  type ProcessStopSignal,
  waitForProcessStopSignal,
} from "../../../../../src/contexts/daemon/services/processStopSignals.ts";

const fixture = () => {
  const emitter = new EventEmitter();
  const source: ProcessSignalSource = {
    on: (signal, listener) => {
      emitter.on(signal, listener);
    },
    off: (signal, listener) => {
      emitter.off(signal, listener);
    },
  };
  return { emitter, source };
};

describe("process stop signals", () => {
  it("removes only its stop listeners", () => {
    const { emitter, source } = fixture();
    const existingInterrupt = vi.fn();
    const existingTerminate = vi.fn();
    const listener = vi.fn<(signal: ProcessStopSignal) => void>();
    emitter.on("SIGINT", existingInterrupt);
    emitter.on("SIGTERM", existingTerminate);

    const remove = listenForProcessStopSignals(listener, source);
    remove();
    remove();
    emitter.emit("SIGINT");
    emitter.emit("SIGTERM");

    expect(listener).not.toHaveBeenCalled();
    expect(existingInterrupt).toHaveBeenCalledOnce();
    expect(existingTerminate).toHaveBeenCalledOnce();
    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "removes both wait listeners after %s",
    async (signal) => {
      const { emitter, source } = fixture();
      const existingInterrupt = vi.fn();
      const existingTerminate = vi.fn();
      emitter.on("SIGINT", existingInterrupt);
      emitter.on("SIGTERM", existingTerminate);
      const stopped = waitForProcessStopSignal(source);

      emitter.emit(signal);

      await expect(stopped).resolves.toBe(signal);
      expect(emitter.listenerCount("SIGINT")).toBe(1);
      expect(emitter.listenerCount("SIGTERM")).toBe(1);
      emitter.emit("SIGINT");
      emitter.emit("SIGTERM");
      expect(existingInterrupt).toHaveBeenCalledTimes(signal === "SIGINT" ? 2 : 1);
      expect(existingTerminate).toHaveBeenCalledTimes(signal === "SIGTERM" ? 2 : 1);
    },
  );
});

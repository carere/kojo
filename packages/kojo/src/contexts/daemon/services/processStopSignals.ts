export type ProcessStopSignal = "SIGINT" | "SIGTERM";

export interface ProcessSignalSource {
  readonly on: (signal: ProcessStopSignal, listener: () => void) => void;
  readonly off: (signal: ProcessStopSignal, listener: () => void) => void;
}

const systemProcessSignalSource: ProcessSignalSource = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

export const listenForProcessStopSignals = (
  listener: (signal: ProcessStopSignal) => void,
  source: ProcessSignalSource = systemProcessSignalSource,
): (() => void) => {
  const onInterrupt = (): void => listener("SIGINT");
  const onTerminate = (): void => listener("SIGTERM");
  source.on("SIGINT", onInterrupt);
  source.on("SIGTERM", onTerminate);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    source.off("SIGINT", onInterrupt);
    source.off("SIGTERM", onTerminate);
  };
};

export const waitForProcessStopSignal = (
  source: ProcessSignalSource = systemProcessSignalSource,
): Promise<ProcessStopSignal> =>
  new Promise((resolve) => {
    let removeListeners = (): void => undefined;
    removeListeners = listenForProcessStopSignals((signal) => {
      removeListeners();
      resolve(signal);
    }, source);
  });

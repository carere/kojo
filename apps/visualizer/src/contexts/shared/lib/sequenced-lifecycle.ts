/**
 * Serializes replacement and disposal of an owned asynchronous resource.
 *
 * A new resource is not started until the previous resource's stop operation
 * has completed. This is intentionally small and framework-free so lifecycle
 * ownership can be tested without mounting a browser component.
 */
export interface SequencedLifecycle<Handle> {
  readonly replace: (start: () => Handle | undefined) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export const makeSequencedLifecycle = <Handle>(
  stop: (handle: Handle) => Promise<void>,
): SequencedLifecycle<Handle> => {
  let current: Handle | undefined;
  let disposed = false;
  let generation = 0;
  let chain = Promise.resolve();

  const stopCurrent = async () => {
    const handle = current;
    current = undefined;
    if (handle !== undefined) await stop(handle);
  };

  const replace = (start: () => Handle | undefined) => {
    const requestedGeneration = ++generation;
    const operation = chain.then(async () => {
      await stopCurrent();
      if (disposed || requestedGeneration !== generation) return;
      current = start();
    });
    chain = operation.catch(() => undefined);
    return operation;
  };

  const dispose = () => {
    disposed = true;
    generation += 1;
    const operation = chain.then(stopCurrent);
    chain = operation.catch(() => undefined);
    return operation;
  };

  return { replace, dispose };
};

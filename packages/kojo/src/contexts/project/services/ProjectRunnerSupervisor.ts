export interface ProjectRunnerHandle {
  readonly instanceId: string;
  readonly packageGraphId: string;
  readonly purpose: "execution" | "trigger";
  /** Resolves only after the owned process has stopped. */
  readonly stop: () => Promise<void>;
}

interface ProjectState {
  readonly handle?: ProjectRunnerHandle;
  readonly turn: Promise<void>;
}

/** Owns the only Project Runner process and serializes graph-switch preparation per Project. */
export class ProjectRunnerSupervisor {
  readonly #projects = new Map<string, ProjectState>();

  currentGraph(projectId: string): string | undefined {
    return this.#projects.get(projectId)?.handle?.packageGraphId;
  }

  async prepare<A>(options: {
    readonly projectId: string;
    readonly packageGraphId: string;
    readonly stopCurrentPolling: () => Promise<void>;
    readonly load: () => Promise<A>;
  }): Promise<A> {
    const prior = this.#projects.get(options.projectId);
    const previousTurn = prior?.turn ?? Promise.resolve();
    let finish: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#projects.set(options.projectId, {
      ...(prior?.handle === undefined ? {} : { handle: prior.handle }),
      turn,
    });
    await previousTurn;
    try {
      await options.stopCurrentPolling();
      const current = this.#projects.get(options.projectId)?.handle;
      if (current !== undefined && current.packageGraphId !== options.packageGraphId) {
        await current.stop();
        const selected = this.#projects.get(options.projectId);
        if (selected?.handle?.instanceId === current.instanceId) {
          this.#projects.set(options.projectId, { turn });
        }
      }
      return await options.load();
    } finally {
      finish?.();
    }
  }

  async attach(projectId: string, handle: ProjectRunnerHandle): Promise<void> {
    const state = this.#projects.get(projectId) ?? { turn: Promise.resolve() };
    const current = state.handle;
    if (current !== undefined && current.instanceId !== handle.instanceId) await current.stop();
    this.#projects.set(projectId, { handle, turn: state.turn });
  }

  detach(projectId: string, instanceId: string): void {
    const state = this.#projects.get(projectId);
    if (state?.handle?.instanceId !== instanceId) return;
    this.#projects.set(projectId, { turn: state.turn });
  }

  async stop(projectId: string): Promise<void> {
    const state = this.#projects.get(projectId);
    if (state?.handle === undefined) return;
    await state.handle.stop();
    this.detach(projectId, state.handle.instanceId);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#projects.entries()].map(async ([projectId, state]) => {
        if (state.handle !== undefined) await state.handle.stop();
        this.detach(projectId, state.handle?.instanceId ?? "");
      }),
    );
  }
}

/**
 * What `GET /api/health` answers, as much of it as the run list reads.
 *
 * The server's document carries more — the schema standing, the versions, the runner presence — and
 * this build reads the three fields the list has a use for. Unlisted fields are not an error; see
 * `services/api.ts`.
 */
export interface Health {
  /** The SQLite file this Console reads, exactly as `kojo ui` was given it. */
  readonly database: string;
  /** Whether this repository has a factory at all. */
  readonly factory: "present" | "absent";
  /** The one line worth interrupting a person with, when the server has one. */
  readonly notice?: string;
  /**
   * Whether an answer given right now would move a run.
   *
   * Read on the server from `cluster_runners.last_heartbeat` with its thirty-five second window, and
   * never from `RunnerHealth`, whose noop reports every address alive (adr/gate/0001). `none` is the
   * normal idle state of a factory whose watcher was stopped cleanly, not a fault.
   */
  readonly runner: RunnerPresence;
}

/** The two answers to *is anybody there to apply an answer?* — the server's own literal union. */
export type RunnerPresence = "live" | "none";

/**
 * What the Console says when the repository has no factory.
 *
 * A fallback, not the source: the server writes this same sentence into `health.notice`, and the
 * Console renders what it was told. It is repeated here so that a Console talking to an older server
 * that sent no notice still says the useful thing rather than showing an empty card.
 */
export const noFactoryNotice = "No factory in this repo. Run `kojo init`.";

/** What the Console says when the factory is there and nothing has run in it yet. */
export const noRunsNotice = "No runs yet. Run `kojo run <workflow>`.";

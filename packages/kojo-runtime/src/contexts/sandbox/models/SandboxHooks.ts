/**
 * One command a hook runs, and how long it may take before it is abandoned.
 *
 * The optional fields carry no `| undefined`, unlike the rest of Kojo's option types, because this
 * shape is handed straight to Sandcastle: under `exactOptionalPropertyTypes` a widened optional is
 * not assignable to a plain one, and the assignment is the check that keeps the two in step.
 */
export interface HostHook {
  readonly command: string;
  readonly timeoutMs?: number;
}

/** The same, plus the one thing only an in-sandbox command can ask for. */
export interface SandboxHook extends HostHook {
  readonly sudo?: boolean;
}

/**
 * What runs at the two moments of sandbox setup, in the places those moments exist.
 *
 * **Three slots, not a two-by-two.** The obvious model — `{host, sandbox} × {onWorktreeReady,
 * onSandboxReady}` — has a fourth cell that names nothing: at the moment the worktree is ready
 * there is no sandbox to run a command in, so `sandbox.onWorktreeReady` does not exist and a
 * cross-product type would not compile against Sandcastle. The asymmetry is the shape of the
 * lifecycle, so it is written out rather than generated.
 *
 * Kojo declares this rather than re-exporting Sandcastle's because it is authored surface: a
 * workflow writes it, and `kojo.config.yaml` will eventually decode it. It reaches Sandcastle
 * structurally, so a slot that moves upstream is a compile error here rather than a silent
 * divergence.
 */
export interface SandboxHooks {
  readonly host?: {
    readonly onWorktreeReady?: ReadonlyArray<HostHook>;
    readonly onSandboxReady?: ReadonlyArray<HostHook>;
  };
  readonly sandbox?: {
    readonly onSandboxReady?: ReadonlyArray<SandboxHook>;
  };
}

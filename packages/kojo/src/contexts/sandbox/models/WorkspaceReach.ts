import { Schema } from "effect";

/**
 * What one acquisition answered when it was asked whether its workspace is there.
 *
 * An **observation**, in the same sense as `WorktreeState`: it says what happened when a command ran
 * in the workspace, and it does not say what should be done about it. The difference between the two
 * is which machine answers. `WorktreeState` is read with host git, because the branch lives on the
 * host. This is read from **inside the sandbox**, because the fault it exists to catch is a container
 * whose working directory the host can see perfectly well.
 */
export class WorkspaceReach extends Schema.Class<WorkspaceReach>("WorkspaceReach")({
  /** The command line the probe used, so a reading names what produced it. */
  probe: Schema.String,
  /** The command ran in the workspace and exited zero. Anything else is `false`. */
  reached: Schema.Boolean,
  /**
   * What the probe answered — the directory it resolved, or the reason it could not.
   *
   * One line, because both measured failures are one line and because this field is carried on a
   * persisted error. The whole of it would be a container runtime's stack trace in a database row.
   */
  detail: Schema.String,
}) {}

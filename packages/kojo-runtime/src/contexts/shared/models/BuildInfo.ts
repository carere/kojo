import { hostname } from "node:os";
import { Context } from "effect";

/**
 * What produced a run.
 *
 * Kojo is a versioned dependency under a factory that keeps running across upgrades, so "which
 * engine version produced this run" is a question that will certainly be asked, and no amount of
 * per-phase detail answers it after the fact. The same is true of the other three: the factory's own
 * configuration, the machine, and the image the containers came from all change under a run without
 * leaving a mark on any phase.
 *
 * `commit` is injected at publish time. It reads `development` from a working tree, which is true
 * rather than a plausible-looking placeholder — and every other default here follows that rule.
 */
export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  /**
   * A digest of the factory's configuration file.
   *
   * `unconfigured` until `kojo init` writes one and stamps it. A run under no configuration is a
   * real case — every test in this repository is one — so the default says exactly that.
   */
  readonly configDigest: string;
  /** The machine the run started on. */
  readonly host: string;
  /** The resolved sandbox image digest. Absent until a provider reports one; none does yet. */
  readonly imageDigest?: string | undefined;
}

export const BuildInfo = Context.Reference<BuildInfo>("kojo/shared/BuildInfo", {
  defaultValue: (): BuildInfo => ({
    version: "0.0.0",
    commit: process.env.KOJO_BUILD_COMMIT ?? "development",
    configDigest: "unconfigured",
    host: hostname(),
    imageDigest: undefined,
  }),
});

import { hostname } from "node:os";
import { Context } from "effect";

/**
 * Run provenance supplied by the Runner from its retained Runtime and Workflow Revision.
 * Test and authored layers can supply explicit values. Missing facts remain `unknown`.
 */
export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  /** Full captured Workflow Revision digest, including Factory configuration and packages. */
  readonly configDigest: string;
  /** The machine the run started on. */
  readonly host: string;
  /** The resolved sandbox image digest. Absent until a provider reports one; none does yet. */
  readonly imageDigest?: string | undefined;
}

export const BuildInfo: Context.Reference<BuildInfo> = Context.Reference<BuildInfo>(
  "kojo/shared/BuildInfo",
  {
    defaultValue: (): BuildInfo => ({
      version: "unknown",
      commit: "unknown",
      configDigest: "unknown",
      host: hostname(),
      imageDigest: undefined,
    }),
  },
);

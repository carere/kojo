import { Effect } from "effect";
import type { Workspace } from "../../../sandbox/ports/Workspace.ts";
import { ClaimFault } from "../../models/CheckReport.ts";
import { type Check, make } from "../Check.ts";
import { snapshot } from "../Permissions.ts";

/**
 * The envelope lists exactly the paths the working tree actually changed.
 *
 * Both directions matter, and they fail for different reasons:
 *
 * - **Claimed and unchanged** is an agent reporting work it did not do. Everything downstream —
 *   the commit message, the review, the merge — is then written about a change that is not there.
 * - **Changed and unclaimed** is an agent that did more than it said. That is not a permission
 *   breach, which is about paths it was *not allowed* to touch; it is a permitted change the
 *   envelope hides, and hiding it is what makes a human approve a diff they have not read.
 *
 * The change-set comes from the same fingerprint the permission guard takes, so "changed" means
 * exactly one thing in this codebase: appeared, vanished, or was rewritten relative to `HEAD`.
 * Ignored paths never appear, so the run's own data directory needs no special case.
 *
 * The comparison is against `HEAD`, not against a baseline taken before the call, so an already
 * dirty working tree is read as the agent's work. That is the honest reading for a run on its own
 * branch, which is what a factory gives every agent.
 */
/** @public */
export const diffMatchesClaims = <A>(options: {
  /** The envelope field the paths were read from. It names the field in the correction prompt. */
  readonly claim: string;
  readonly files: (claims: A) => ReadonlyArray<string>;
}): Check<A, Workspace> =>
  make({
    name: "diffMatchesClaims",
    description: `\`${options.claim}\` lists exactly the paths the working tree changed`,
    verify: (claims) =>
      Effect.gen(function* () {
        const changed = yield* snapshot;
        const claimed = new Set(options.files(claims));
        const faults: Array<ClaimFault> = [];

        for (const [index, path] of options.files(claims).entries()) {
          if (!changed.has(path)) {
            faults.push(
              new ClaimFault({
                claim: [options.claim, String(index)],
                subject: path,
                detail: "the working tree holds no change at this path",
              }),
            );
          }
        }

        for (const path of [...changed.keys()].sort()) {
          if (!claimed.has(path)) {
            faults.push(
              new ClaimFault({
                claim: [options.claim],
                subject: path,
                detail: "the working tree changed this path and the answer does not list it",
              }),
            );
          }
        }

        return faults;
      }),
  });

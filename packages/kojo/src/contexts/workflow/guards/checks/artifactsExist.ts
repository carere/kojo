import { Effect, Option } from "effect";
import { Workspace } from "../../../sandbox/ports/Workspace.ts";
import { ClaimFault } from "../../models/CheckReport.ts";
import { type Check, make } from "../Check.ts";

/**
 * Every path the envelope claims it wrote is really there.
 *
 * The cheapest possible verification and the one that catches the most common agent failure: an
 * answer that reports a report file, a patch or a log it never actually wrote. It is worth running
 * on a phase that produces nothing else, because an artifact a later phase reads is a claim the
 * whole rest of the run is built on.
 *
 * Everything goes through the `Workspace` port. `fs.stat` on the host would grade a tree the agent
 * never touched the moment the agent runs in a container, and the check would pass by looking in
 * the wrong place.
 */
export const artifactsExist = <A>(options: {
  /** The envelope field the paths were read from. It names the field in the correction prompt. */
  readonly claim: string;
  readonly paths: (claims: A) => ReadonlyArray<string>;
}): Check<A, Workspace> =>
  make({
    name: "artifactsExist",
    description: `every path \`${options.claim}\` names is really in the workspace`,
    verify: (claims) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const faults: Array<ClaimFault> = [];

        for (const [index, path] of options.paths(claims).entries()) {
          const found = yield* workspace.stat(path);
          if (Option.isNone(found)) {
            faults.push(
              new ClaimFault({
                claim: [options.claim, String(index)],
                subject: path,
                detail: "nothing is at this path, so it was never written or it is named wrongly",
              }),
            );
          }
        }

        return faults;
      }),
  });

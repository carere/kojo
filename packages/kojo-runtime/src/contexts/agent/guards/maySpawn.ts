import type { SandboxKind } from "../../sandbox/models/SandboxProvider.ts";
import type { AgentSpend } from "../models/AgentSpend.ts";
import { spendVariable } from "../models/AgentSpend.ts";

/**
 * The decision that stands between a workflow and a bill.
 *
 * Pure, and given everything it judges rather than reaching for any of it: the mode, who would have
 * been called, and a resolver that answers *what does this binary name actually open on this
 * machine*. That last argument is the whole guard. The two unauthorised calls in this build were
 * spent by a `PATH` override that resolved somewhere other than where its author believed, so a
 * guard that only read the author's intention would have agreed with them and let both through.
 *
 * @see ../models/AgentSpend.ts for the switch itself, and ticket 49 for what it cost to learn.
 */

/** Everything one spawn decision is made of. Nothing is read from the process. */
export interface SpawnRequest {
  readonly spend: AgentSpend;
  /** The roster name, the provider's name, the model, and the run — what the refusal must name. */
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly run: string;
  /** The binary the provider's own command names — `claude`, `pi`. */
  readonly binary: string;
  /** Where that name resolves for the process that would spawn it, or nothing when it resolves nowhere. */
  readonly resolve: (binary: string) => string | undefined;
  /** Where the process would run. A container's `PATH` is not this machine's. */
  readonly sandbox: SandboxKind;
}

/** Spawn, or do not — and when not, the sentence the reader gets. */
export type SpawnVerdict =
  | { readonly _tag: "Spawn" }
  | { readonly _tag: "Refused"; readonly reason: string };

const spawn: SpawnVerdict = { _tag: "Spawn" };

/**
 * Who would have been called, on one line.
 *
 * On **every** refusal, whatever the mode. A person reading `kojo run` output has to be able to see
 * that the run is theirs, which phase stopped, and what it was about to do — and a refusal that
 * said only *refused* would send them looking for a fault in their roster.
 */
const wouldHaveCalled = (request: SpawnRequest): string =>
  `\`${request.agent}\` (${request.provider}, ${request.model}) in run ${request.run}`;

/**
 * May this call spawn a process?
 *
 * Read the three modes in the order they are written below — that order *is* the policy:
 *
 * 1. **Refuse** stops everything, and is what an unattended process gets by default.
 * 2. **StandIn** spawns only what it named, checked against the resolver rather than trusted.
 * 3. **Allow** spawns, and costs money.
 */
export const maySpawn = (request: SpawnRequest): SpawnVerdict => {
  const spend = request.spend;

  if (spend._tag === "Allow") return spawn;

  if (spend._tag === "Refuse") {
    return {
      _tag: "Refused",
      reason:
        `${spendVariable} refused this call before any process was started, so nothing was ` +
        `spawned and nothing was spent. It would have called ${wouldHaveCalled(request)}. ` +
        `Why: ${spend.because}. Set ${spendVariable}=allow to make real calls, or ` +
        `${spendVariable}=stand-in:<absolute path> to run a scripted agent.`,
    };
  }

  // --- stand-in: the mode that has to be checked rather than believed -------------------------

  // A container carries its own filesystem and its own `PATH`, and this process can resolve
  // neither. Answering "the stand-in is in place" about an image nobody looked inside is the exact
  // shape of false assurance this guard exists to end, so the honest answer is that it cannot be
  // checked here.
  if (request.sandbox !== "none") {
    return {
      _tag: "Refused",
      reason:
        `${spendVariable} names a stand-in (${spend.binary}), and this sandbox is ` +
        `${request.sandbox}, so the agent would run inside the image where that path means ` +
        `nothing this process can check. It would have called ${wouldHaveCalled(request)}. ` +
        `Run the stand-in with \`--sandbox none\`, or declare ${spendVariable}=allow and mean it.`,
    };
  }

  const resolved = request.resolve(request.binary);

  if (resolved === undefined) {
    return {
      _tag: "Refused",
      reason:
        `${spendVariable} names the stand-in ${spend.binary}, and nothing called ` +
        `\`${request.binary}\` is on this process's PATH at all. It would have called ` +
        `${wouldHaveCalled(request)}.`,
    };
  }

  if (resolved !== spend.binary) {
    return {
      _tag: "Refused",
      // The sentence this whole ticket is for. Both unauthorised calls in this build would have
      // printed it: the stand-in was on `PATH` and the real binary was what `claude` opened.
      reason:
        `\`${request.binary}\` resolves to ${resolved}, which is not the stand-in ` +
        `${spend.binary} that ${spendVariable} declared. A PATH override is not a guarantee — ` +
        `this exact mismatch spent two unauthorised calls before it was a refusal. It would have ` +
        `called ${wouldHaveCalled(request)}.`,
    };
  }

  return spawn;
};

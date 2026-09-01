/**
 * How one check came out.
 *
 * Three, not two, and the third is what keeps the other two honest. A container check on a factory
 * that runs with `--sandbox none` has no answer — neither *yes* nor *no* is true of it — and a
 * doctor that reported such a check as `ok` would be inventing a reassurance nobody measured. That
 * is edge 6 one level up: a plausible-but-wrong pass is worse than a check that says it did not run.
 */
export type Standing = "ok" | "failed" | "skipped";

/**
 * One thing that was looked at, and what was found.
 *
 * `remedy` is present **exactly** when the standing is `failed`, and the constructors below are the
 * only way to build one — {@link failed} demands it as an argument, so a failure with nothing to do
 * about it is unrepresentable rather than merely discouraged. The criterion this ticket carries
 * ("each failure names what is wrong *and what to do about it*") is therefore a property of the
 * type, so a diagnosis can render it without guessing.
 */
export interface Finding {
  /** What was looked at — `runtime`, `image`, `commands`. One word, so the report is a column. */
  readonly subject: string;
  readonly standing: Standing;
  /** What was measured, in one line. Present whatever the standing. */
  readonly detail: string;
  /** What to do about it. Present exactly when the standing is `failed`. */
  readonly remedy?: string;
}

/** Looked at, and nothing is wrong with it. `detail` says what was actually observed. */
export const ok = (subject: string, detail: string): Finding => ({
  subject,
  standing: "ok",
  detail,
});

/** Looked at, and it is wrong. The remedy is an argument because a failure without one is useless. */
export const failed = (subject: string, detail: string, remedy: string): Finding => ({
  subject,
  standing: "failed",
  detail,
  remedy,
});

/** Not looked at, and the detail says why. Never a pass — see {@link Standing}. */
export const skipped = (subject: string, detail: string): Finding => ({
  subject,
  standing: "skipped",
  detail,
});

/** Everything that came back `failed`, in the order it was looked at. */
export const faults = (findings: ReadonlyArray<Finding>): ReadonlyArray<Finding> =>
  findings.filter((finding) => finding.standing === "failed");

/**
 * Whether this factory can be called ready.
 *
 * A skipped check does not stop a factory being ready, and that is the deliberate reading: a check
 * skips only when it does not apply to how this factory runs. A check that *would* have applied and
 * could not be answered is a `failed`, never a `skipped`.
 */
export const isReady = (findings: ReadonlyArray<Finding>): boolean => faults(findings).length === 0;

/**
 * Kojo's two composite identifiers, read and written in the browser.
 *
 * Both are `runId/name/discriminator` — `makePhaseId` builds `<run>/<name>/<attempt>` and
 * `makeSandboxId` builds `<run>/<name>/<millis>-<sequence>` — and the engine promises a reader that
 * shape. This module is the browser's half of that promise.
 *
 * **Repeated here rather than imported from the engine**, exactly as the waterfall's own reading was:
 * this bundle ships to a browser and must not drag `packages/kojo` into it. The grammar is stated in
 * one place on this side so that a change to it has one reader to fix rather than four.
 *
 * Parsed from the ends rather than from the front. No segment may contain a slash — the trace's own
 * guard holds every one of them to `[A-Za-z0-9._-]+` — so the two readings agree on every identifier
 * the engine can write, and reading from the ends is simply the shorter way to name the first and
 * last of three. Anything that is not `a/b/c` is refused rather than guessed at.
 *
 * That same guard is why these ids need no percent-encoding to travel as URL path segments, which is
 * what lets a phase route be `/runs/:runId/phases/:name/:attempt` and stay readable (console.md §3).
 */

/** The name in the middle — the phase's name, or the scope's. */
export const nameOf = (identifier: string): string | undefined => {
  const first = identifier.indexOf("/");
  const last = identifier.lastIndexOf("/");
  return first < 0 || last <= first ? undefined : identifier.slice(first + 1, last);
};

/** The last segment — a phase's attempt, or an acquisition's `<millis>-<sequence>`. */
export const discriminatorOf = (identifier: string): string =>
  identifier.slice(identifier.lastIndexOf("/") + 1);

/**
 * When a held acquisition began, from the discriminator in its id.
 *
 * The one number a sandbox that has **not been released** can still be drawn from: its record is
 * written on release, so a container in use right now is named by a phase and by nothing else.
 */
export const acquiredAtOf = (sandboxId: string): number | undefined => {
  const millis = Number(discriminatorOf(sandboxId).split("-")[0]);
  return Number.isFinite(millis) ? millis : undefined;
};

/**
 * A phase id, from the three parts a URL carries.
 *
 * The detail route addresses `name` and `attempt` rather than the whole id, because the id already
 * embeds the run — see the route module. This is what puts the two halves back together.
 */
export const phaseIdOf = (runId: string, name: string, attempt: string): string =>
  `${runId}/${name}/${attempt}`;

/** An acquisition id, from the run and the two parts the sandbox route carries. */
export const sandboxIdOf = (runId: string, name: string, acquisition: string): string =>
  `${runId}/${name}/${acquisition}`;

import type { Page } from "@playwright/test";

/**
 * What every browser test shares: which Console is which, and what time it is.
 *
 * Not a `.spec.ts`, so Playwright does not collect it as a suite. It is imported by the tests and by
 * `playwright.config.ts`, which is what keeps one list of servers rather than two that can disagree
 * about a port.
 */

/**
 * One `kojo ui --fixtures` per state that is a property of the server rather than of the page.
 *
 * **Deliberately not near 4321.** That is `kojo ui`'s own default, and a suite that bound the block
 * next to it would fail the moment somebody had a Console open on the same machine — measured, in
 * this repository, on the first run. `reuseExistingServer` stays off for the same reason: a suite
 * that quietly attached to whatever was already listening would grade somebody else's server.
 */
export const servers = [
  /** Every status the run list can draw, including a gate held for forty-one hours. */
  { fixtures: "busy", port: 47231 },
  /**
   * The same records as `busy`, with one live runner registered.
   *
   * **One variable apart, and that is the whole design of it.** A verdict written while a runner is
   * alive is *recorded — applying…*; the same verdict written while nothing is running is *recorded
   * — nothing is running*. The two states differ by the runner table and by nothing else, so serving
   * one set of records from two servers is the only way a browser test can prove the Console reads
   * that table rather than guessing.
   */
  { fixtures: "watching", port: 47235 },
  /** Every run terminal. The Console must stop asking, for good. */
  { fixtures: "settled", port: 47232 },
  /** A factory nobody has used yet. */
  { fixtures: "empty", port: 47233 },
  /** A repository nobody has run `kojo init` in. */
  { fixtures: "absent", port: 47234 },
] as const;

export type FixtureName = (typeof servers)[number]["fixtures"];

/**
 * The Console that is reading a **real** factory — see `realFactory.ts`.
 *
 * It is kept apart from the list above because it is not a fixture and shares nothing with one: no
 * stated records, no frozen clock, and a database on disk that `kojo run` wrote a minute ago. Its
 * port sits in the same block for the same reason theirs do — far from `kojo ui`'s own 4321.
 */
export const realPort = 47236;
export const realConsole = `http://127.0.0.1:${realPort}`;

/** Where each fixture's Console listens. Tests navigate by name, never by number. */
export const consoleAt = Object.fromEntries(
  servers.map((server) => [server.fixtures, `http://127.0.0.1:${server.port}`]),
) as Record<FixtureName, string>;

/**
 * The instant the fixtures are written against — 2026-03-01T12:00:00Z.
 *
 * **It must equal `packages/kojo/src/console/frozenNow.ts`.** It is repeated rather than imported
 * because this process is Playwright's, and reaching across into the package's sources would drag
 * that project's `tsconfig` and its dependencies into a test runner that needs one number. Drift is
 * caught rather than trusted: every deadline assertion below is a string computed from the
 * difference between the two, so a mismatch fails the suite immediately.
 */
export const frozenNow = 1_772_366_400_000;

/**
 * Open a Console with its clock stopped.
 *
 * The freeze is an init script, so it is in place before a single module of the application runs —
 * the clock is read once, at the root of the document, and a value written after that would arrive
 * too late. Freezing this way rather than by emulating `Date.now()` also stops the Console's own
 * one-second tick, which is what makes a screenshot of this page stable rather than merely
 * repeatable.
 */
export const open = async (
  page: Page,
  fixtures: FixtureName,
  now: number = frozenNow,
): Promise<void> => {
  await page.addInitScript(`window.__KOJO_NOW__ = ${now}`);
  await page.goto(consoleAt[fixtures]);
};

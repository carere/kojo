import { createSignal, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";
import type { Now } from "../ports/Now.tsx";

/**
 * The one place in the Console that is allowed to ask the machine what time it is.
 *
 * Everything else takes a `Now`. Keeping the call in an adapter is what makes the requirement
 * checkable: a `Date.now()` anywhere under `components/` is a defect a reader can see, and there is
 * exactly one file to look at when a screenshot goes unstable.
 */

/**
 * Where a test writes the frozen clock.
 *
 * A global rather than Playwright's clock emulation, on purpose. Freezing `Date.now()` from the
 * outside would leave the ticking timer below running against a stopped clock, so the Console would
 * still re-render every second and a screenshot would still be racing something. Reading the frozen
 * value here removes the timer altogether: the page holds one number for its whole life.
 */
const frozenKey = "__KOJO_NOW__";

/** How often a live Console redraws its durations. One second, matching the poll cadence. */
const tickMillis = 1_000;

const frozen = (): number | undefined => {
  const held = (globalThis as unknown as Record<string, unknown>)[frozenKey];
  return typeof held === "number" && Number.isFinite(held) ? held : undefined;
};

/**
 * The browser's clock: frozen when a test froze it, ticking once a second otherwise.
 *
 * On the server it is read once and never again. The only server-side render this application has is
 * the build-time prerender of the shell, which contains no timestamp — and a timer started there
 * would keep the prerender's preview server from closing.
 */
export const browserNow = (): Now => {
  const held = frozen();
  if (held !== undefined) return () => held;

  const [now, setNow] = createSignal(Date.now());
  if (isServer) return now;

  const timer = setInterval(() => setNow(Date.now()), tickMillis);
  onCleanup(() => clearInterval(timer));
  return now;
};

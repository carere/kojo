import { createSignal, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";
import type { Now } from "../ports/Now.tsx";

/**
 * The one place in the Console that is allowed to ask the machine what time it is.
 *
 * Everything else takes a `Now`. Keeping the call in an adapter is what makes the requirement
 * checkable: a `Date.now()` anywhere under `components/` is a defect a reader can see, and there is
 * exactly one place to set the clock update interval.
 */

/** How often a live Console redraws its durations. One second, matching the poll cadence. */
const tickMillis = 1_000;

/**
 * The browser clock ticks once a second.
 *
 * On the server it is read once and never again. The only server-side render this application has is
 * the build-time prerender of the shell, which contains no timestamp — and a timer started there
 * would keep the prerender's preview server from closing.
 */
export const browserNow = (): Now => {
  const [now, setNow] = createSignal(Date.now());
  if (isServer) return now;

  const timer = setInterval(() => setNow(Date.now()), tickMillis);
  onCleanup(() => clearInterval(timer));
  return now;
};

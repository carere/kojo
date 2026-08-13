import { type Accessor, createContext, type JSX, useContext } from "solid-js";

/**
 * The current time, as the Console reads it.
 *
 * **A component never calls `Date.now()`**, and that is a hard requirement rather than a style
 * (console.md §11). The whole Console is timestamps — a deadline, a wait, a duration on a waterfall
 * span — and every one of them is unreadable in a test and unstable in a screenshot if the clock is
 * whatever the machine says at the moment of render. So the clock is a value passed in, the browser
 * tier freezes it, and the fixtures carry fixed timestamps against it.
 *
 * It is an `Accessor` and not a number because a live Console has to redraw as the clock moves: a
 * gate that goes overdue while somebody watches must change on screen without a refetch.
 */
export type Now = Accessor<number>;

const NowContext = createContext<Now>();

/** The clock, given to everything below it. Provided once, at the root of the document. */
export const NowProvider = (props: {
  readonly now: Now;
  readonly children: JSX.Element;
}): JSX.Element => <NowContext.Provider value={props.now}>{props.children}</NowContext.Provider>;

/**
 * The clock, read by a component.
 *
 * It throws rather than falling back to a real clock when no provider is above it. A default would
 * make the requirement above unenforceable: a component that lost its provider would keep working
 * and only its test would go quietly non-deterministic.
 */
export const useNow = (): Now => {
  const now = useContext(NowContext);
  if (now === undefined) {
    throw new Error("no clock: every component reading the time must sit under a <NowProvider>");
  }
  return now;
};

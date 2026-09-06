import { type Accessor, createContext, type JSX, useContext } from "solid-js";

/** Supply one clock to Console components. Browser time and a fixed test clock use the same port. */
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

/**
 * One moment, written so that two people reading it are reading the same moment.
 *
 * **UTC, always.** Every other time on this surface is a duration or an offset from the start of the
 * run, because those are what a waterfall is made of. A detail panel is the one place that has to
 * state the wall-clock instant — *when did this actually happen* is the question somebody asks with a
 * log file open beside the Console — and a local rendering would make the answer depend on who was
 * looking. It would also make a screenshot of the panel move between machines, which console.md §11
 * spends the whole injected clock to prevent.
 *
 * Milliseconds are kept: a phase can last two hundred of them, and a start and an end rounded to the
 * second would read as the same instant.
 */
export const instant = (millis: number): string =>
  `${new Date(millis).toISOString().slice(0, 23).replace("T", " ")} UTC`;

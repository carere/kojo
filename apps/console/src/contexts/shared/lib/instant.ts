/** Format an absolute instant in UTC so logs and Console views agree across Host time zones. */
export const instant = (millis: number): string =>
  `${new Date(millis).toISOString().slice(0, 23).replace("T", " ")} UTC`;

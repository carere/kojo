/** A stop intent owns the terminal outcome once it has been accepted. */
export const preservesStoppedOutcome = (state: string) =>
  state === "stopping" || state === "stopped";

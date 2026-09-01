/** The marker written into a command that a Factory owner must replace. */
/** @public */
export const placeholderMarker = "KOJO-PLACEHOLDER";

/** Whether an authored command is still a generated placeholder. */
/** @public */
export const isPlaceholder = (command: string): boolean => command.includes(placeholderMarker);

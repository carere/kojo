/**
 * The word a fake command says about itself.
 *
 * It is on the command line rather than only in a comment, so it survives everything a command is
 * put through: it is in `.kojo/commands.ts`, it is in the argv the code phase spawns, it is in the
 * container's stderr, and it is in the trace. Nothing can run a placeholder and be unable to say
 * afterwards that a placeholder was what ran.
 */
export const placeholderMarker = "KOJO-PLACEHOLDER";

/**
 * The exit code a placeholder leaves. 78 is `EX_CONFIG` — "something is wrong in the config file".
 *
 * Any non-zero code would do for the run; this one is chosen because it is the one a human reading
 * an exit code in a log can look up and find the right answer to.
 */
export const placeholderExitCode = 78;

/**
 * A command that says it is not a command, refuses to run, and names the file to edit.
 *
 * **Architecture.md edge 6, in one function.** A scaffolded factory cannot know the target's test
 * runner. The tempting output is `npm test` — plausible, frequently wrong, and on a repository
 * with no test script it exits 0 and reports a green suite that never existed. So the scaffolder
 * writes down what it does not know instead of guessing, and writes it down in a way that fails
 * loudly the first time a run reaches it.
 *
 * `sh -c` and not a bare word, because the whole point is that it runs, prints, and exits non-zero
 * wherever a real command would have run.
 */
export const placeholder = (what: string): string =>
  `sh -c 'echo "${placeholderMarker}: no ${what} command yet - write the real one in .kojo/commands.ts" >&2; exit ${placeholderExitCode}'`;

/**
 * Whether a command is one of the above.
 *
 * The mechanical detection edge 6 asks for, and the reason the marker is a string in the command
 * rather than a wrapper type: `kojo doctor` reads `.kojo/commands.ts` as an imported record of
 * strings, and a survivor is a string that still contains the marker. Nothing has to be parsed,
 * and a human who half-edited a command — kept the marker, changed the words — is still caught.
 */
export const isPlaceholder = (command: string): boolean => command.includes(placeholderMarker);

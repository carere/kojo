/** Read the name and attempt suffix from a Run-scoped identifier. */

/** The name in the middle — the phase's name, or the scope's. */
export const nameOf = (identifier: string): string | undefined => {
  const first = identifier.indexOf("/");
  const last = identifier.lastIndexOf("/");
  return first < 0 || last <= first ? undefined : identifier.slice(first + 1, last);
};

/** The last segment — a phase's attempt, or an acquisition's `<millis>-<sequence>`. */
export const discriminatorOf = (identifier: string): string =>
  identifier.slice(identifier.lastIndexOf("/") + 1);

/**
 * When a held acquisition began, from the discriminator in its id.
 *
 * The one number a sandbox that has **not been released** can still be drawn from: its record is
 * written on release, so a container in use right now is named by a phase and by nothing else.
 */
export const acquiredAtOf = (sandboxId: string): number | undefined => {
  const millis = Number(discriminatorOf(sandboxId).split("-")[0]);
  return Number.isFinite(millis) ? millis : undefined;
};

/**
 * A phase id, from the three parts a URL carries.
 *
 * The detail route addresses `name` and `attempt` rather than the whole id, because the id already
 * embeds the run — see the route module. This is what puts the two halves back together.
 */
export const phaseIdOf = (runId: string, name: string, attempt: string): string =>
  `${runId}/${name}/${attempt}`;

/** An acquisition id, from the run and the two parts the sandbox route carries. */
export const sandboxIdOf = (runId: string, name: string, acquisition: string): string =>
  `${runId}/${name}/${acquisition}`;

/**
 * Does one repository path fall under one permission pattern?
 *
 * Small, and written here rather than taken from a library, because the whole permission boundary
 * rests on a single rule: **`*` stops at a path separator.** `.kojo/workflows/*.ts` names the
 * workflow files and nothing else; a matcher whose `*` crosses `/` reads the same pattern as
 * `.kojo/workflows/` plus everything under it, and silently widens every protected path in the
 * factory. `**` is how a pattern says "cross directories", and saying it is the point.
 *
 * Two stock matchers were measured against this rule rather than assumed about, and each is wrong
 * for this job in its own direction — see the tests, which record both:
 *
 * - the naive translation everyone writes by hand, `*` to `.*`, crosses `/`, so a protected pattern
 *   matches paths the operator never named;
 * - `node:path`'s `matchesGlob` keeps `*` inside one segment, but a trailing-slash pattern matches
 *   nothing at all, so `.kojo/workflows/` protects none of the workflows.
 */

const metaCharacters = /[.*+?^${}()|[\]\\]/;

const escaped = (character: string): string =>
  metaCharacters.test(character) ? `\\${character}` : character;

const asRegExp = (pattern: string): RegExp => {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const character = pattern.charAt(index);
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escaped(character);
    index += 1;
  }
  // Anchored at both ends: a permission pattern names a whole path, never a substring of one.
  return new RegExp(`^(?:${source})$`);
};

/**
 * Three shapes, in the order they are tested.
 *
 * A trailing `/` is a directory prefix rather than a glob, because that is how an operator writes
 * "this tree and everything in it" and it must not depend on remembering `**`. A pattern with no
 * wildcard is compared for equality, so a path containing a regular-expression metacharacter is
 * still just a path.
 */
export const matchesPattern = (path: string, pattern: string): boolean => {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.includes("*") || pattern.includes("?")) return asRegExp(pattern).test(path);
  return path === pattern;
};

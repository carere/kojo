import { Option } from "effect";

/**
 * The identifiers a reader is handed from outside, and what makes one safe to use.
 *
 * A run id, a phase id and a commit reach the artifact reader from an HTTP path or a query string.
 * Each is then put somewhere that gives it authority: the first two become directory names under
 * the artifact root, and the third becomes a word on a `git` command line. So each is checked
 * against what it is allowed to be, **before** it is used, and a value that is not allowed is
 * refused rather than repaired.
 *
 * Refusing rather than repairing is the whole rule, ported from SSSF's visualizer, which states it
 * in one sentence: anything that is not a plain identifier is *"rejected outright rather than
 * sanitized into something that might still escape"*. Sanitising is where traversal bugs live —
 * stripping `..` from `....//` leaves `../`, and the caller believes it was checked.
 */

/** One path segment: letters, digits, dot, underscore, hyphen. Nothing else, ever. */
const safeSegment = /^[A-Za-z0-9._-]+$/;

/**
 * A git object name: hex, and long enough to be one.
 *
 * Stricter than a path segment on purpose, and the reason is not traversal. A commit is passed to
 * `git` as an argument, and `-` is a legal character in the segment pattern — so `--upload-pack=…`
 * is a "safe segment" and is also a git flag. `argv` is an array here rather than a shell, so this
 * is argument injection and not command injection, which is a smaller hole and still a hole. Hex
 * closes it: no flag is spelled in hex.
 */
const objectName = /^[0-9a-f]{4,64}$/;

/**
 * Is one identifier safe as one path segment?
 *
 * `.` and `..` are named rather than left to the pattern, because both match it. They are the two
 * segments the pattern cannot refuse and the two that must never be used.
 */
export const isSafeSegment = (value: string): boolean =>
  safeSegment.test(value) && value !== "." && value !== "..";

/**
 * Every segment of one identifier, or `None` when any one of them is not safe.
 *
 * Multi-segment because Kojo's own ids are: `makePhaseId` builds `<run>/<name>/<attempt>` and
 * `makeSandboxId` builds one of the same shape. So a phase id is a *path* of identifiers rather
 * than one identifier, and the guard is applied to each part of it.
 *
 * Three shapes fall out of that and all three are refused: an empty identifier splits to one empty
 * segment, `a//b` yields an empty segment in the middle, and `..` anywhere is refused by name. A
 * Windows separator is refused too, because `\` is not in the pattern, so it never survives as a
 * segment that some other layer might later read as a separator.
 */
export const safeSegments = (identifier: string): Option.Option<ReadonlyArray<string>> => {
  const segments = identifier.split("/");
  return segments.every(isSafeSegment) ? Option.some(segments) : Option.none();
};

/** Is this string a git object name, and therefore safe to hand to `git` as a revision? */
export const isObjectName = (value: string): boolean => objectName.test(value);

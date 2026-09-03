import { Schema } from "effect";

/**
 * What lives at a path.
 *
 * Three cases, not the platform's eight. A check asks "is this a file I can read" or "is this a
 * directory I can walk"; a FIFO and a socket answer the same way, so they share `other` rather
 * than teach every check about device nodes.
 */
export const FileKind = Schema.Literals(["file", "directory", "other"]);
export type FileKind = typeof FileKind.Type;

/** The part of a stat a check has any business reading. */
export class FileStat extends Schema.Class<FileStat>("FileStat")({
  kind: FileKind,
  size: Schema.Finite,
}) {}

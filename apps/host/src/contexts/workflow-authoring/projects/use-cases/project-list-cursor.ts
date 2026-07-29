import { createHash } from "node:crypto";
import type { ProjectIdentity, ProjectListInput, ProjectListResult } from "@kojo/control";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export const projectFilterFingerprint = (input: ProjectListInput) =>
  hash(JSON.stringify({ conditions: [...new Set(input.conditions)].sort() }));

interface ProjectCursor {
  readonly checksum: string;
  readonly direction: "next";
  readonly filterFingerprint: string;
  readonly resourceKind: "project";
  readonly sort: { readonly identity: string };
  readonly version: 1;
}

const cursorContents = (cursor: Omit<ProjectCursor, "checksum">) => JSON.stringify(cursor);

export const encodeProjectCursor = (identity: ProjectIdentity, filters: string) => {
  const contents = {
    version: 1,
    resourceKind: "project",
    direction: "next",
    sort: { identity },
    filterFingerprint: filters,
  } as const;
  return Buffer.from(
    JSON.stringify({ ...contents, checksum: hash(cursorContents(contents)) }),
  ).toString("base64url");
};

export type ProjectCursorDecode =
  | { readonly ok: true; readonly cursor?: ProjectCursor }
  | { readonly ok: false; readonly result: ProjectListResult };

const cursorFailure = (
  code: Extract<ProjectListResult, { ok: false }>["error"]["code"],
  message: string,
): ProjectCursorDecode => ({
  ok: false,
  result: {
    ok: false,
    error: { code, message, next: "Start a new Project list without --cursor." },
  },
});

export const decodeProjectCursor = (
  encoded: string | undefined,
  filters: string,
): ProjectCursorDecode => {
  if (encoded === undefined) return { ok: true };
  try {
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<ProjectCursor>;
    if (decoded.version !== 1) {
      return cursorFailure(
        "project-cursor-version-unsupported",
        "This Project cursor version is not supported.",
      );
    }
    if (
      decoded.resourceKind !== "project" ||
      decoded.direction !== "next" ||
      typeof decoded.sort?.identity !== "string" ||
      typeof decoded.filterFingerprint !== "string" ||
      typeof decoded.checksum !== "string"
    ) {
      return cursorFailure("project-cursor-malformed", "This Project cursor is malformed.");
    }
    const contents = {
      version: 1,
      resourceKind: "project",
      direction: "next",
      sort: { identity: decoded.sort.identity },
      filterFingerprint: decoded.filterFingerprint,
    } as const;
    if (decoded.checksum !== hash(cursorContents(contents))) {
      return cursorFailure("project-cursor-malformed", "This Project cursor checksum is invalid.");
    }
    if (decoded.filterFingerprint !== filters) {
      return cursorFailure(
        "project-cursor-filter-mismatch",
        "This Project cursor belongs to different filters.",
      );
    }
    return { ok: true, cursor: { ...contents, checksum: decoded.checksum } };
  } catch {
    return cursorFailure("project-cursor-malformed", "This Project cursor is malformed.");
  }
};

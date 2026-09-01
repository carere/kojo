import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ProjectStoreError } from "../models/ProjectStoreError.ts";

const invalidLocation = (message: string, cause?: unknown): ProjectStoreError =>
  new ProjectStoreError({
    code: "INVALID_PROJECT_LOCATION",
    message,
    status: 422,
    retry: "never",
    remedy: "Give the exact existing root of a Git working tree.",
    cause,
  });

/** Resolve links and filesystem case, then require the given directory itself to be the Git root. */
export const exactGitWorkingTree = (input: string, excludedRoot?: string): string => {
  try {
    const canonical = realpathSync(resolve(input));
    if (!isAbsolute(canonical) || !statSync(canonical).isDirectory()) {
      throw new Error("the location is not a directory");
    }
    if (excludedRoot !== undefined) {
      const excluded = realpathSync(excludedRoot);
      const fromExcluded = relative(excluded, canonical);
      if (fromExcluded === "" || (!fromExcluded.startsWith("..") && !isAbsolute(fromExcluded))) {
        throw new Error("Daemon-owned worktrees cannot be registered as Projects");
      }
    }
    const reported = execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const root = realpathSync(reported);
    if (root !== canonical) throw new Error(`the exact Git working-tree root is ${root}`);
    return canonical;
  } catch (cause) {
    if (cause instanceof ProjectStoreError) throw cause;
    throw invalidLocation(cause instanceof Error ? cause.message : String(cause), cause);
  }
};

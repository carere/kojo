import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { FactoryObservation } from "../models/Project.ts";

interface Diagnostic {
  readonly subject: string;
  readonly standing: "ok" | "failed" | "skipped";
  readonly detail: string;
  readonly remedy?: string;
}

interface Validation {
  readonly formatVersion: 1;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/** Inspect authored Factory contracts through the Project-local standalone validator. */
export const inspectFactory = (root: string): Effect.Effect<FactoryObservation> =>
  Effect.promise(async () => {
    if (!existsSync(join(root, ".kojo"))) {
      return {
        state: "missing",
        fault: "The Project has no .kojo directory.",
        remedy: "Run `kojo init` in this Project.",
      };
    }

    try {
      const entry = Bun.resolveSync("@carere/kojo-runtime/validator/main", root);
      const child = Bun.spawn([process.execPath, entry, root], {
        cwd: root,
        env: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? "",
          TMPDIR: process.env.TMPDIR ?? "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr.trim() || `validator exited ${exitCode}`);
      const validation = JSON.parse(stdout) as Validation;
      if (validation.formatVersion !== 1 || !Array.isArray(validation.diagnostics)) {
        throw new Error("the Project validator returned an invalid document");
      }
      const failure = validation.diagnostics.find((diagnostic) => diagnostic.standing === "failed");
      return failure === undefined
        ? { state: "available" }
        : {
            state: "invalid",
            fault: `${failure.subject}: ${failure.detail}`,
            remedy: failure.remedy ?? "Run `kojo doctor` in this Project.",
          };
    } catch (cause) {
      return {
        state: "invalid",
        fault: cause instanceof Error ? cause.message : String(cause),
        remedy:
          "Install the Project-declared @carere/kojo-runtime and run `kojo doctor` in this Project.",
      };
    }
  });

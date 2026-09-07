import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedWorkflowRevision } from "../../../src/contexts/workflow/models/RevisionManifest.ts";
import { captureWorkflowRevision } from "../../../src/contexts/workflow/services/captureRevision.ts";

/** One suite's fixed Factory and dependencies. Case-specific inputs belong in the Run payload. */
export const revisionFixture = (workflowName: string) => {
  let root: string | undefined;
  let captured: CapturedWorkflowRevision | undefined;
  return {
    install(project: string, dataRoot: string): CapturedWorkflowRevision {
      root ??= mkdtempSync(join(tmpdir(), "kojo-revision-fixture-"));
      captured ??= captureWorkflowRevision({ project, dataRoot: root, workflowName });
      // Copy only immutable capture data. Each Daemon owns separate files, including objects;
      // no hard links, databases, Runner caches, Projects, or process state cross test cases.
      mkdirSync(join(dataRoot, "revisions"), { recursive: true, mode: 0o700 });
      const publishedPath = join(dataRoot, "revisions", captured.revisionId);
      cpSync(captured.publishedPath, publishedPath, { recursive: true });
      cpSync(join(root, "objects"), join(dataRoot, "objects"), { recursive: true });
      return { ...captured, manifest: structuredClone(captured.manifest), publishedPath };
    },
    dispose(): void {
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
      root = undefined;
      captured = undefined;
    },
  };
};

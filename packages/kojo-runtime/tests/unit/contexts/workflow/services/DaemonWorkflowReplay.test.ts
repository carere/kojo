import { describe, expect, it } from "@effect/vitest";
import {
  canonicalReplayJson,
  externalActionDecision,
  externalActionIdentity,
  recordedReplayDecision,
} from "../../../../../src/contexts/workflow/services/DaemonWorkflowReplay.ts";

describe("Daemon Workflow replay decisions", () => {
  it("canonicalizes replay JSON independently of object key order", () => {
    expect(canonicalReplayJson({ z: 1, nested: { b: true, a: [2, 1] } })).toBe(
      '{"nested":{"a":[2,1],"b":true},"z":1}',
    );
    expect(canonicalReplayJson({ nested: { a: [2, 1], b: true }, z: 1 })).toBe(
      '{"nested":{"a":[2,1],"b":true},"z":1}',
    );
  });

  it("reuses a recorded result and executes only when no result exists", () => {
    const result = { _tag: "Complete", value: { artifact: "retained" } } as const;

    expect(recordedReplayDecision(result)).toEqual({ kind: "reuse", result });
    expect(recordedReplayDecision(undefined)).toEqual({ kind: "execute" });
  });

  it("binds external action identity to Run, Revision, Phase, attempt, and input", () => {
    const first = externalActionIdentity({
      runId: "run-a",
      revisionId: "revision-a",
      phasePath: "deploy",
      attempt: 1,
      payload: { region: "eu", options: { safe: true, count: 2 } },
    });
    const reordered = externalActionIdentity({
      runId: "run-a",
      revisionId: "revision-a",
      phasePath: "deploy",
      attempt: 1,
      payload: { options: { count: 2, safe: true }, region: "eu" },
    });

    expect(reordered).toEqual(first);
    expect(
      externalActionIdentity({
        runId: "run-a",
        revisionId: "revision-b",
        phasePath: "deploy",
        attempt: 1,
        payload: { region: "eu", options: { safe: true, count: 2 } },
      }),
    ).not.toEqual(first);
  });

  it("classifies only annotated activities as recoverable external actions", () => {
    expect(externalActionDecision(undefined)).toBe("ordinary");
    expect(externalActionDecision({ evidence: "required" })).toBe("recoverable-external");
  });
});

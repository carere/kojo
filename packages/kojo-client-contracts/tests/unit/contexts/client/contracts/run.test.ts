import { describe, expect, it } from "vitest";
import { decodeRollbackOutcome } from "../../../../../src/contexts/client/contracts/rollback.ts";
import { isTerminalRunUncertaintyResolved } from "../../../../../src/contexts/client/contracts/run.ts";

const resultConfirmed = {
  actionId: "action_1d89f20c7fa864fa7bec57e41b46e3a8",
  revisionId: "efe5e85d817db248569f86c9267569b80d5893c6f0562081ae4bb41d08cc7101",
  phasePath: "confirm-verdict",
  attempt: 1,
  inputHash: "959b61338958b8ea79d02488e2b24e777ec74f29a6fa22b20f1d037c051c4b56",
  recoveryPolicy: "unresolved",
  state: "result-confirmed",
  uncertaintyRevision: 0,
  evidence: {
    kind: "original-result",
    detail: "The current fenced Project Runner returned the encoded original-contract result.",
    observedAt: "2026-09-02T03:24:21.955Z",
  },
};

describe("terminal Run uncertainty", () => {
  it("accepts absence and the sixth-run confirmed original result", () => {
    expect(isTerminalRunUncertaintyResolved(undefined)).toBe(true);
    expect(isTerminalRunUncertaintyResolved(resultConfirmed)).toBe(true);
  });

  it("rejects unresolved state and missing original-result evidence", () => {
    expect(isTerminalRunUncertaintyResolved({ ...resultConfirmed, state: "unresolved" })).toBe(
      false,
    );
    expect(isTerminalRunUncertaintyResolved({ ...resultConfirmed, evidence: undefined })).toBe(
      false,
    );
  });

  it("rejects coercible malformed authority fields", () => {
    expect(
      isTerminalRunUncertaintyResolved({
        ...resultConfirmed,
        recoveryPolicy: ["unresolved"],
      }),
    ).toBe(false);
    expect(isTerminalRunUncertaintyResolved({ ...resultConfirmed, attempt: "1" })).toBe(false);
    expect(isTerminalRunUncertaintyResolved({ ...resultConfirmed, uncertaintyRevision: "0" })).toBe(
      false,
    );
  });
});

describe("RollbackOutcome", () => {
  it("accepts every domain outcome and keeps the NotUndone reason", () => {
    for (const _tag of ["Deleted", "Restored", "LeftAsIs", "WorkLost"] as const) {
      expect(decodeRollbackOutcome({ _tag })).toEqual({ ok: true, value: { _tag } });
    }
    expect(decodeRollbackOutcome({ _tag: "NotUndone", reason: "workspace refused" })).toEqual({
      ok: true,
      value: { _tag: "NotUndone", reason: "workspace refused" },
    });
  });

  it("rejects primitive and unknown rollback outcomes", () => {
    expect(decodeRollbackOutcome("WorkLost").ok).toBe(false);
    expect(decodeRollbackOutcome({ _tag: "Preserved" }).ok).toBe(false);
    expect(decodeRollbackOutcome({ _tag: "NotUndone" }).ok).toBe(false);
  });
});

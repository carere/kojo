import { describe, expect, it } from "vitest";
import {
  nativeHostKillDiagnostic,
  selectManagedDaemonChild,
} from "../../../support/daemon/nativeHostProcess.ts";

describe("native Host managed Daemon process evidence", () => {
  const launcher =
    "/home/kojo/.local/share/proto/tools/bun/1.4.0/bun /workspace/packages/kojo/src/launcher/main.ts";

  it("selects the managed Daemon instead of the synthetic process-group sibling", () => {
    expect(
      selectManagedDaemonChild([
        { processId: 3_195, command: "sleep 300" },
        { processId: 3_208, command: launcher },
      ]),
    ).toEqual({ processId: 3_208, command: launcher });
    expect(
      selectManagedDaemonChild([
        { processId: 3_195, command: "sleep 300" },
        { processId: 3_208, command: launcher },
        { processId: 3_209, command: launcher },
      ]),
    ).toBeUndefined();
  });

  it("reports the selected PID, kill receipt, liveness, and supervision state", () => {
    const diagnostic = nativeHostKillDiagnostic({
      ownerProcessId: 3_194,
      childrenBefore: [
        { processId: 3_195, command: "sleep 300" },
        { processId: 3_208, command: launcher },
      ],
      selectedChild: { processId: 3_208, command: launcher },
      killReceipt: true,
      selectedChildLiveAfterKill: true,
      supervisionBefore: { state: "running", attempt: { attemptId: "attempt-1" } },
      supervisionAfter: { state: "running", attempt: { attemptId: "attempt-1" } },
      childrenAfter: [
        { processId: 3_195, command: "sleep 300" },
        { processId: 3_208, command: launcher },
      ],
    });

    expect(diagnostic).toContain('"selectedChild":{"processId":3208');
    expect(diagnostic).toContain('"killReceipt":true');
    expect(diagnostic).toContain('"selectedChildLiveAfterKill":true');
    expect(diagnostic).toContain('"supervisionAfter":{"state":"running"');
  });
});

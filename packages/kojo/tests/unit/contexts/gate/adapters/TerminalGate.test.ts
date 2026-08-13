import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import type { DurableDeferred } from "effect/unstable/workflow";
import * as TerminalGate from "../../../../../src/contexts/gate/adapters/TerminalGate.ts";
import { GateRequest } from "../../../../../src/contexts/gate/models/GateRequest.ts";
import { Gate } from "../../../../../src/contexts/gate/ports/Gate.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";

const request = new GateRequest({
  runId: "run-42" as RunId,
  gate: "review",
  asking: "gate/review/1",
  description: "Does this land on main?",
  actor: "engineer",
  choices: ["approve", "reject"],
  token: "tok_abc" as DurableDeferred.Token,
  requestedAt: 0,
  deadlineAt: 172_800_000,
  onExpiry: "fail",
});

describe("the terminal gate", () => {
  it.effect("prints the command that answers the gate, and returns", () =>
    Effect.gen(function* () {
      const port = yield* Gate;
      yield* port.request(request);

      const printed = (yield* TestConsole.logLines).join("\n");
      expect(printed).toContain(`kojo gate answer tok_abc --choice approve --reason "<why>"`);
      expect(printed).toContain(`kojo gate answer tok_abc --choice reject --reason "<why>"`);
      expect(printed).toContain("engineer");
      expect(printed).toContain("Does this land on main?");
      expect(printed).toContain("on expiry: fail");
    }).pipe(Effect.provide(TerminalGate.layer)),
  );

  it.effect("offers one choice flag per choice, never a pair of booleans", () =>
    Effect.gen(function* () {
      const port = yield* Gate;
      // Two independent boolean flags parse `--approve --reject` as both true and accept neither,
      // so a contradictory decision would reach a handler instead of being rejected by the parser.
      expect(port.describe(request)).not.toContain("--approve");
      expect(port.describe(request)).not.toContain("--reject");
    }).pipe(Effect.provide(TerminalGate.layer)),
  );
});

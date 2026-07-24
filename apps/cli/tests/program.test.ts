import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { program } from "../src/program";

describe("Kojo CLI", () => {
  test("starts from a known state", async () => {
    await expect(Effect.runPromise(program)).resolves.toBe("Kojo is ready.");
  });
});

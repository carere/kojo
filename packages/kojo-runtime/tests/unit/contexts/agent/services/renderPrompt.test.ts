import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { AgentDefinition } from "../../../../../src/contexts/agent/models/AgentDefinition.ts";
import {
  contractFor,
  outputTag,
  renderPrompt,
} from "../../../../../src/contexts/agent/services/renderPrompt.ts";
import { EnvelopeBase } from "../../../../../src/contexts/workflow/models/Envelope.ts";

class BuildOutput extends EnvelopeBase.extend<BuildOutput>("BuildOutput")({
  _tag: Schema.tag("BuildOutput"),
  changedFiles: Schema.Array(Schema.String),
  commitMessage: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
}) {}

/** A field that is itself a named schema, so the emitted document keeps a nested `$ref`. */
class Finding extends Schema.Class<Finding>("Finding")({
  path: Schema.String,
  note: Schema.String,
}) {}

class ScoutOutput extends EnvelopeBase.extend<ScoutOutput>("ScoutOutput")({
  _tag: Schema.tag("ScoutOutput"),
  findings: Schema.Array(Finding),
}) {}

const scout = new AgentDefinition({
  name: "scout",
  purpose: "Find the fault",
  model: "claude-sonnet-4-5",
  tools: [],
  system: "You are the scout.",
  user: "Read the repository and report what you find.",
});

/** The JSON block the agent is told to satisfy, taken back out of the text it was written into. */
const contractIn = (prompt: string): Record<string, unknown> => {
  const block = /```json\n([\s\S]*?)\n```/.exec(prompt);
  expect(block).not.toBeNull();
  return JSON.parse(block?.[1] ?? "") as Record<string, unknown>;
};

/** Every `$ref` anywhere in a JSON value. */
const referencesIn = (node: unknown): ReadonlyArray<string> => {
  if (Array.isArray(node)) return node.flatMap(referencesIn);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [value] : referencesIn(value),
  );
};

describe("the contract the phase appends", () => {
  it("carries the envelope's schema, resolved, so no pointer dangles", () => {
    const contract = contractIn(contractFor(ScoutOutput));

    // The document's own root is `{ $ref: "#/$defs/ScoutOutput" }`. Pasted verbatim, that is all
    // the agent would get.
    expect(contract.$ref).toBeUndefined();
    expect(contract.type).toBe("object");

    const defs = (contract.$defs ?? {}) as Record<string, unknown>;
    const references = referencesIn(contract);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const name = reference.split("/").at(-1) ?? "";
      expect(Object.hasOwn(defs, name)).toBe(true);
    }
  });

  it("prints one self-contained object when nothing is left to point at", () => {
    const contract = contractIn(contractFor(BuildOutput));

    expect(referencesIn(contract)).toEqual([]);
    // And the definition is not printed a second time beside itself.
    expect(contract.$defs).toBeUndefined();
    expect(Object.keys(contract.properties as object)).toEqual([
      "_tag",
      "changedFiles",
      "commitMessage",
    ]);
  });

  it("takes the output tag from the envelope, so the example cannot drift from the contract", () => {
    expect(outputTag(BuildOutput)).toEqual(Option.some("BuildOutput"));
    expect(outputTag(ScoutOutput)).toEqual(Option.some("ScoutOutput"));

    const section = contractFor(BuildOutput);
    expect(section).toContain('Set `_tag` to exactly `"BuildOutput"`.');
    expect(section).not.toContain("ScoutOutput");

    // The tag in the prose and the tag the decoder enforces are one string, read from one place.
    const contract = contractIn(section);
    const properties = contract.properties as Record<string, { enum: ReadonlyArray<string> }>;
    expect(properties._tag?.enum).toEqual([Option.getOrThrow(outputTag(BuildOutput))]);
  });

  it("asserts no tag for a schema that declares none, rather than inventing one", () => {
    expect(outputTag(Schema.Struct({ lane: Schema.String }))).toEqual(Option.none());
    expect(contractFor(Schema.Struct({ lane: Schema.String }))).not.toContain("_tag");
  });
});

describe("the prompt a cold turn carries", () => {
  /**
   * **The identity is in the text, and this is the assertion that says so.**
   *
   * `claudeCode()` — used as it ships, which is the decision this whole path rests on — has no
   * `--system-prompt` and no `--tools`. So a roster's `system.md` reaches the model through the
   * prompt or it does not reach it at all, and an agent spawned without it is a *different agent*
   * that still succeeds. Delete the `system` line from `renderPrompt` and this goes red.
   */
  it("carries the agent's identity, its task template, and the task, in that order", () => {
    const prompt = renderPrompt({ agent: scout, task: "The parser drops a token." });

    expect(prompt.indexOf("You are the scout.")).toBe(0);
    expect(prompt.indexOf("Read the repository and report what you find.")).toBeGreaterThan(0);
    expect(prompt.indexOf("The parser drops a token.")).toBeGreaterThan(
      prompt.indexOf("Read the repository and report what you find."),
    );
  });

  it("drops a section the roster left empty rather than leaving a hole in the prompt", () => {
    const silent = new AgentDefinition({ ...scout, user: "" });

    expect(renderPrompt({ agent: silent, task: "Do it." })).toBe("You are the scout.\n\nDo it.");
  });
});

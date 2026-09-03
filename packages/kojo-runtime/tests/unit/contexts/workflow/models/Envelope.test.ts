import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { EnvelopeBase } from "../../../../../src/contexts/workflow/models/Envelope.ts";

// The envelope from the design record, written the way a factory author writes it: the explicit
// self type parameter is mandatory, and the tag is declared here rather than inherited.
class BuildOutput extends EnvelopeBase.extend<BuildOutput>("BuildOutput")({
  _tag: Schema.tag("BuildOutput"),
  changedFiles: Schema.Array(Schema.String),
  commitMessage: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
}) {}

class ScoutOutput extends EnvelopeBase.extend<ScoutOutput>("ScoutOutput")({
  _tag: Schema.tag("ScoutOutput"),
  findings: Schema.Array(Schema.String),
}) {}

describe("an envelope extending the base", () => {
  it("reports its own tag in the type, at runtime, and in its JSON Schema", () => {
    const built = new BuildOutput({ changedFiles: ["src/fix.ts"], commitMessage: "fix the fault" });

    // In the type. The annotation is the assertion: a `string` here would not be assignable, which
    // is what would happen if the tag came from the base.
    const inTheType: "BuildOutput" = built._tag;
    expect(inTheType).toBe("BuildOutput");

    // At runtime.
    expect(built._tag).toBe("BuildOutput");

    // In the JSON Schema — the third place, and the one the agent actually reads. It is a
    // *document*, so the definition has to be reached through `definitions`; pasting the object
    // verbatim into a prompt hands the agent a dangling `$ref`.
    const document = Schema.toJsonSchemaDocument(BuildOutput);
    expect(document.schema).toEqual({ $ref: "#/$defs/BuildOutput" });
    expect(document.definitions.BuildOutput).toMatchObject({
      properties: { _tag: { enum: ["BuildOutput"] } },
    });
  });

  it("gives two envelopes off one base two different tags", () => {
    expect(new ScoutOutput({ findings: ["the fault is in the parser"] })._tag).toBe("ScoutOutput");
    expect(Schema.toJsonSchemaDocument(ScoutOutput).definitions.ScoutOutput).toMatchObject({
      properties: { _tag: { enum: ["ScoutOutput"] } },
    });
  });

  it("decodes an agent's JSON, filling the decode-side default for a key it left out", () => {
    const fromTheAgent: unknown = { _tag: "BuildOutput", changedFiles: ["src/fix.ts"] };
    expect(Schema.decodeUnknownSync(BuildOutput)(fromTheAgent)).toEqual(
      new BuildOutput({ changedFiles: ["src/fix.ts"], commitMessage: "" }),
    );
  });

  it("is an instance of the base, so anything holding an envelope holds this", () => {
    expect(new ScoutOutput({ findings: [] })).toBeInstanceOf(EnvelopeBase);
  });
});

describe("the base", () => {
  it("cannot be a tagged class, and the compiler is the proof", () => {
    class TaggedBase extends Schema.TaggedClass<TaggedBase>()("TaggedBase", {}) {}

    // `extend` merges fields, so a tagged base owns `_tag` for every descendant. Declaring an own
    // tag against it does not compile — this is the failure the plain base exists to avoid, and
    // `@ts-expect-error` fails the build if it ever starts compiling.
    // @ts-expect-error
    class TaggedChild extends TaggedBase.extend<TaggedChild>("TaggedChild")({
      _tag: Schema.tag("TaggedChild"),
    }) {}

    // And without an own tag the child silently answers to the base's tag — in the type, at
    // runtime, and in the JSON Schema the agent is shown.
    class InheritedTag extends TaggedBase.extend<InheritedTag>("InheritedTag")({
      findings: Schema.Array(Schema.String),
    }) {}

    expect(new InheritedTag({ findings: [] })._tag).toBe("TaggedBase");
    expect(Schema.toJsonSchemaDocument(InheritedTag).definitions.InheritedTag).toMatchObject({
      properties: { _tag: { enum: ["TaggedBase"] } },
    });
    expect(TaggedChild).toBeDefined();
  });
});

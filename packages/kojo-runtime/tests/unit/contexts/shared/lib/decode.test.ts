import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { decodeUnknown } from "../../../../../src/contexts/shared/lib/decode.ts";
import { DecodeIssue } from "../../../../../src/contexts/shared/models/DecodeIssue.ts";

const Envelope = Schema.Struct({
  agent: Schema.String,
  branch: Schema.String,
  commitMessage: Schema.String,
});

const Nested = Schema.Struct({
  build: Schema.Struct({ changedFiles: Schema.Array(Schema.String) }),
});

describe("the decode helper", () => {
  it.effect("reports every issue, not the first one", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeUnknown(Envelope)({}));
      const issues = DecodeIssue.fromSchemaError(error);

      // Three fields wrong, three issues. Under the default the correction loop would learn about
      // one field per retry, and burn one whole agent call to learn each of the other two.
      expect(issues.map((issue) => issue.path.join("."))).toEqual([
        "agent",
        "branch",
        "commitMessage",
      ]);
    }),
  );

  it.effect("is the reason to have a helper at all — the default reports one", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Schema.decodeUnknownEffect(Envelope)({}));
      expect(DecodeIssue.fromSchemaError(error)).toHaveLength(1);
    }),
  );

  it.effect("carries the path to each fault, not a rendered message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeUnknown(Nested)({ build: { changedFiles: [42] } }));
      const issues = DecodeIssue.fromSchemaError(error);

      // The path is what makes the correction prompt worth sending: it names the element, not the
      // envelope.
      expect(issues.map((issue) => issue.path)).toEqual([["build", "changedFiles", "0"]]);
      expect(issues[0]?.message).toBeTruthy();
    }),
  );

  it.effect("keeps the issue tree on the failure itself", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeUnknown(Envelope)({}));
      // `SchemaError`, carrying a `SchemaIssue.Issue`. There is no `ParseError` in v4, and the tree
      // is what lets the feedback name paths.
      expect(Schema.isSchemaError(error)).toBe(true);
      expect(error.issue._tag).toBeTruthy();
    }),
  );

  it("takes no per-call options, so no call site can widen or narrow the report", () => {
    const decode = decodeUnknown(Envelope);
    // @ts-expect-error
    const withOptions = decode({}, { errors: "first" });

    expect(withOptions).toBeDefined();
  });

  it.effect("decodes what is valid", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeUnknown(Envelope)({
        agent: "hotfixer",
        branch: "kojo/hotfix/1",
        commitMessage: "fix the fault",
      });
      expect(decoded.agent).toBe("hotfixer");
    }),
  );
});

describe("a decode issue", () => {
  it("survives being persisted and read back", () => {
    const issue = new DecodeIssue({ path: ["build", "changedFiles"], message: "Expected array" });
    const wire = Schema.encodeUnknownSync(DecodeIssue)(issue);

    expect(Schema.decodeUnknownSync(DecodeIssue)(JSON.parse(JSON.stringify(wire)))).toEqual(issue);
  });
});

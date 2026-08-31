import { Schema } from "effect";

/**
 * What every envelope extends.
 *
 * An envelope is one declaration serving four uses — the TypeScript type at the call site, the
 * decoder, the JSON Schema rendered into the agent's prompt, and the wire contract. Drift between
 * them is what this base exists to make inexpressible.
 *
 * Two shape decisions, both load-bearing:
 *
 * **The base is a plain `Schema.Class`, and each envelope declares its own
 * `_tag: Schema.tag("Name")` among its extend fields.** `extend` *merges* fields, so a
 * `Schema.TaggedClass` base is inherited: every envelope would report the base's tag at runtime and
 * in its generated JSON Schema — the agent would be shown one contract and judged against another —
 * and declaring an own `_tag` against a tagged base does not compile at all. See the test beside
 * this file, which pins all three places the tag has to be right.
 *
 * **The base carries no fields.** An envelope is an agent's output, so a field here is a field
 * every agent must produce, in every factory, forever. The base fixes the shape; it does not levy a
 * tax. One place remains for a genuinely universal field to land, if one is ever earned.
 */
export class EnvelopeBase extends Schema.Class<EnvelopeBase>("EnvelopeBase")({}) {}

# ADR 0003: An absent field is absent on the wire

- Status: Accepted

## Context

The Daemon API uses optional fields for facts that do not apply to one Project, Run, Phase, Gate,
or Artifact. The CLI and Console share the browser-safe client contract package.

## Decision

An optional field with no value is omitted from JSON. It is not encoded as `null`.

Wire contracts use exact optional properties. Producers add the key only when they have a value.
Daemon API tests validate encoded bytes, not only TypeScript assignability.

## Consequences

- CLI and Console clients read one wire shape.
- `undefined` never becomes an accidental `null` through serialization.
- SQLite adapters must convert nullable columns before they construct a contract document.
- Adding a producer requires a wire test for optional fields.

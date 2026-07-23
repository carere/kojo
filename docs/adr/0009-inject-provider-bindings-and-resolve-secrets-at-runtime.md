# Inject provider bindings and resolve secrets at runtime

Kojo will supply Sandbox Providers and Agent Providers as replaceable Effect runtime services. Each
service pairs a constructed Sandcastle provider object with a stable name and an explicitly safe,
non-secret description. Kojo's CLI supplies a local Docker Sandbox Provider as a fallback; each
Developer Workflow chooses its Agent Provider and may replace either provider within a narrower
scope. Different Agent Steps may use different Agent Providers inside one Sandbox, while one
Sandbox keeps the Sandbox Provider it was created with.

Kojo's provider wrappers remain provider-neutral. Provider-specific settings stay in Developer
Workflow code or reusable repository modules that construct Sandcastle providers. The CLI supplies
the process environment as the default configuration source, and tests or external secret systems
may replace that source. Runtime services do not belong in `kojo.config.ts`.

The Sandbox binding accepts Sandcastle's full `SandboxProvider` union without narrowing it to
Docker or to providers known by Kojo. This includes built-in bind-mount, isolated, and no-sandbox
providers as well as custom providers produced by Sandcastle's bind-mount and isolated factories.
The Agent binding accepts Sandcastle's `AgentProvider` interface directly, including custom
implementations; model metadata is present only when it applies to that provider.

Secrets are resolved only when a provider service is acquired and are unwrapped only to construct
the plain-string environment Sandcastle requires. They never enter Workflow or Activity schemas,
the Runtime Configuration Snapshot, Execution Evidence, fingerprints, or rendered output. Effect
`Redacted` protects inspection but is not treated as proof that a value cannot be encoded. This
guarantee covers Kojo's provider path; trusted repository-local workflow code remains responsible
for not copying secrets into its own durable values or output.

The Runtime Configuration Snapshot is append-only. When a Sandbox or Agent Step first reaches its
durable boundary, Kojo records the provider name, model when applicable, adapter version,
explicitly safe public fields, and a fingerprint of the remaining non-secret configuration. A
later attempt at the same Step must reproduce that entry before Kojo creates a Sandbox or runs an
agent. Secret rotation does not affect Runtime Configuration Compatibility. A new Step may record a
new entry.

Missing CLI fallback configuration prevents creation of a Workflow Run. A changed provider
description blocks the affected Step as Runtime Configuration Incompatibility, separately from
Workflow Revision compatibility. Failure to start an otherwise matching provider is a Typed
Failure recorded in Execution Evidence. The Execution Trace shows only the safe provider name,
model, and adapter version.

The factual API constraints behind this decision are recorded in
[`docs/research/sandcastle-provider-effect-configuration.md`](../research/sandcastle-provider-effect-configuration.md).

## Considered Options

- Select providers and models through a central string-keyed Kojo registry.
- Pass raw Sandcastle provider objects to every `Sandbox.use` and `Agent.run` call.
- Put runtime provider services in `kojo.config.ts`.
- Let the CLI silently choose an Agent Provider and model.
- Persist provider objects, secret values, or secret fingerprints with durable Workflow state.
- Resolve whatever provider configuration is current on every attempt without checking it against
  earlier attempts.

## Consequences

- Built-in and custom adapters must provide a stable name, adapter version, model when applicable,
  safe public fields, and a non-secret configuration fingerprint alongside the Sandcastle object.
- Provider-specific options remain fully expressive because Kojo does not normalize them into a
  common settings schema.
- Workflow authors can replace providers with ordinary Effect composition, including test
  providers, without changing Kojo's durable operation APIs.
- Runtime Configuration Compatibility becomes another resume preflight concern without changing
  Workflow Run State or Workflow Revision compatibility.
- Credentials may rotate between Execution Attempts, but provider, model, adapter, and non-secret
  behavior cannot silently change for an already-recorded Step.
- Adapter authors must explicitly mark display-safe fields; Kojo never infers that arbitrary
  provider configuration is safe to persist or render.

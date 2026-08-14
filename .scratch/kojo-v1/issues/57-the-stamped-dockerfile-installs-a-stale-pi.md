# 57 — `kojo init` stamps a pi that is eleven releases old, under a name pi has left

**What to build:** A stamped pi factory that installs the pi `kojoPi` is written against. Today it
installs a different package.

## What was measured

    npm view @mariozechner/pi-coding-agent version    → 0.73.1
    npm view @earendil-works/pi-coding-agent version  → 0.84.2

`src/contexts/scaffold/models/FactoryChoices.ts:70` stamps:

    RUN npm install -g @mariozechner/pi-coding-agent

and `tests/unit/contexts/scaffold/services/plan.test.ts:141` asserts that exact line, so the test
holds the stale name in place.

The binary on this machine — the one every measurement in tickets 52 and 56 was taken against — is
`@earendil-works/pi-coding-agent` **0.80.10**, installed at
`~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`.

## Why it matters

`kojoPi` builds a command line out of `--system-prompt`, `--tools`, `--extension`, `--thinking`,
`--session-dir`, and `--session` / `--fork`. Ticket 56's whole design was read off **0.80.10's**
`SessionManager.create`. Nothing has ever checked that 0.73.1 has those flags or that layout, and
the failure mode of a missing flag on an agent binary is the one `kojoPi` exists to prevent: the
process runs, the identity is silently dropped, and a *different agent* answers under the roster's
name.

So a stamped pi factory is, today, running an untested binary — and the one place that would have
noticed is the paid test, which is skipped.

## The decision inside it

Not simply a rename. Two things need saying out loud:

- **Which version to pin.** `latest` on a coding agent is a moving target under a factory that must
  be reproducible; the audit's own rule is to pin at the version the measurement was taken against.
- **Whether the old name is dead or merely old.** 0.73.1 still installs, so this does not fail
  loudly — which is exactly why it survived.

**Blocked by:** none.

**Status:** done — the rename and the pin landed with ticket 56; the image check is carried forward

- [x] The stamped Dockerfile installs `@earendil-works/pi-coding-agent`, pinned at `0.84.2`, with
      the reason in a comment beside it
- [x] `plan.test.ts` grades the new line, and grades that it is **pinned** rather than floating —
      including an assertion that the old scope cannot come back
- [x] Every remaining mention of `@mariozechner/pi-coding-agent` is corrected or is explicitly about
      the history
- [ ] A check that the stamped image can actually run the agent it installs: `pi --version` inside
      the built image. **Not done.** No tier builds a pi image today — the container tests build
      Kojo's own — and adding one is a tier-shaped change that would arrive in the same commit as
      the criterion it grades. Carried forward
- [ ] The flags `kojoPi` sends are confirmed present in the pinned version, by `pi --help` rather
      than by reading a changelog. **Not done.** The binary on this machine is 0.80.10 and the pin
      is 0.84.2, so `pi --help` here answers about a different version than the one stamped

## Comments

### 2026-08-14 — the rename and the pin, landed alongside ticket 56

Opened while fixing ticket 56 and closed in the same breath, because the owner asked for the current
version as soon as the two package names were measured:

    npm view @mariozechner/pi-coding-agent version    → 0.73.1
    npm view @earendil-works/pi-coding-agent version  → 0.84.2

**Pinned at `0.84.2` rather than floating on `latest`.** The owner asked for *the latest version*,
and this is it — but a tag and a version are different promises. This repository pins `effect` and
`sandcastle` at the versions its API audit was performed against, and drifting off them invalidates
the audit; a coding agent is the same case with a shorter half-life. Ticket 56's whole design was
read off pi's `SessionManager.create` at 0.80.x, so a factory built next month against a `latest`
that had moved would run a binary nothing here has measured. Moving the pin should be a deliberate
act with a measurement behind it. **Say so if you would rather it floated — it is one line, in
`agentInstalls.pi.beforeUser`.**

**Two criteria are carried forward rather than ticked**, and both are honest gaps: nothing here
builds a pi image, and the binary installed on this machine (0.80.10) is not the version now stamped
(0.84.2), so `pi --help` cannot answer about the pin. The first buys the second — a tier that built
the stamped image could run `pi --help` inside it and grade every flag `kojoPi` sends.

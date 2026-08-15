# kojo-v1

The implementation ticket graph for the full Kojo build order —
[docs/design/typescript-effect.md §12](../../docs/design/typescript-effect.md), phases 0 through 8.

## Sources of truth

In precedence order. Where they disagree, the higher entry wins.

1. [docs/research/effect-v4-api-audit.md](../../docs/research/effect-v4-api-audit.md) — the only
   file backed by executed code. Every API detail comes from here.
2. [docs/design/typescript-effect.md](../../docs/design/typescript-effect.md) — the project as built.
3. [docs/design/architecture.md](../../docs/design/architecture.md) — the model, D1–D9, and the edges (ten when this was written; fourteen now).
4. [docs/design/console.md](../../docs/design/console.md) — the Console.
5. [docs/adr/](../../docs/adr) — three recorded decisions.
6. [docs/context/](../../docs/context/map.md) — the ubiquitous language. Ticket and code vocabulary
   comes from here.

## Working the graph

Each ticket names the tickets that block it. The **frontier** is every ticket whose blockers are all
done — pick the lowest-numbered one. Tickets carry `Status: ready-for-agent`; set it as you go.

Phase ordering is deliberate and encoded as blocking edges. In particular **durability lands before
sandboxing**: suspension is what this design is for, it is where the model can be structurally wrong,
and it is fully testable with no container in sight. Discovering at phase 6 that gates and sandboxes
do not compose would invalidate everything built on top of them.

## Shape of the graph

- **01–03** phase 0, strictly serial. Nothing is verifiable until the package builds green.
- **04** lands the schema-backed errors and the envelope base before any call sites exist. With code
  in place this would be a wide refactor needing expand–contract; here it is one ticket.
- **04–07** phase 1, the contract. **08–12** phase 2, durability. **13–15** phase 3, ports.
- **16–19** phase 4, sandboxes. **20–23** phase 5, the factory.
- **24–31** phase 6, the trace and the Console. **31** blocks nothing and can be dropped.
- **32–33** phase 7, triggers. **34–36** phase 8, reach.
- **37** was added after ticket 19 found a real fault running a lane on Docker: a sandbox rebuilt
  after a gate can come back with a workspace the container cannot resolve. It is not in the
  original build order because nobody predicted it — it took a real container to surface.
- **50–53** were opened on 2026-08-13 by an audit of the closed tickets. Each one carries a
  criterion a closed ticket left unchecked and no other ticket took: the sandbox mount (from 14), a
  repaired envelope that decodes (from 15 and 48), a real `pi` session resume (from 18), and the
  waterfall over concurrent lanes (from 35). A closed ticket with an open box is not done; it is
  work with no owner.

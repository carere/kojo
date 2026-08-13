# 27 — The Console scaffold and the run list

**What to build:** The Console boots and lists runs. Opening it in a fresh repo says what to do rather than showing an error. This ticket settles the whole frontend toolchain so the later UI tickets are only UI.

**Blocked by:** 26

**Status:** done

- [x] The application builds to static assets — a prerendered shell plus a client bundle, no server functions
- [x] The build output is a build dependency of the published package, so the Console works for someone who installed Kojo rather than cloned it
- [x] The run list shows id, workflow, status, open gate, and deadline, and polls while runs are live
- [x] Server data is loaded by the query library; no client store fetches
- [x] Empty and broken states are handled: no factory here, no runs yet, and an unreachable API keeps the last data on screen
- [x] The browser test tier runs against in-memory readers behind the real server, and the current time is injected so screenshots are stable

## Comments

**The app.** `apps/console` — SolidJS, TanStack Start (Solid) in SPA mode, TanStack Router,
TanStack Query, TanStack Table v9, Zaidan-style components, Tailwind v4, `@playwright/test`.
`moon run console:build` writes a prerendered shell plus the client bundle into
`packages/kojo/console`, which is the directory `kojo ui` already defaulted to. `kojo:build` depends
on `console:build` and then asserts what landed, so a package published without a front end fails the
build instead of serving a placeholder to everybody who installed it.

**Two framework facts that were measured rather than assumed.** The SPA shell is written to
`<spa.prerender.outputPath>.html` verbatim — the default `/_shell` produces `_shell.html`, so the
config names it `/index`. And the client output directory is `join(build.outDir, "client")` unless
`environments.client.build.outDir` says otherwise, so the path to `packages/kojo` is set on the
environment rather than on the root.

**The clock is a port.** `contexts/shared/ports/Now.tsx` is the only way a component reads the time
and `contexts/shared/adapters/browserNow.ts` is the only file that calls `Date.now()`. A browser test
freezes it through `window.__KOJO_NOW__` before the first module runs, which also stops the
one-second tick — so the page holds one number for its whole life. Ticket 28's waterfall depends on
this entirely.

**The browser tier is `kojo ui --fixtures <name>`.** A new flag on the real command swaps the SQLite
readers for the in-memory ones and opens no database at all. Four named fixtures — `busy`, `settled`,
`empty`, `absent` — are four `kojo ui` processes in `playwright.config.ts`, because three of the
states are properties of the server rather than of the page. Every timestamp is fixed against
`console/frozenNow.ts`.

**Two deviations, both deliberate.**

- **Solux is not installed yet.** The rule is that it is local to a highly interactive component and
  never global; the run list has no such component, and console.md scopes Solux to the waterfall.
  Installing it here would have meant either an unused dependency (knip fails) or a global store
  (the rule breaks). Ticket 28 adds it with the waterfall it belongs to.
- **Zaidan's components are hand-written rather than pulled with the shadcn CLI.** Zaidan is
  copy-in, not a package, and its CLI is interactive. `Table`, `Badge` and `Notice` are written in
  its shape with its `cn` helper; none of them needs Kobalte or Corvu.

**One root file had to change, and it is the check-that-did-nothing again.** `moon.yml` at the root
carries a comment explaining that the root project declares `dependsOn: [kojo]` so moon does not
prune the root `tsconfig.json` references. `apps/console` cannot join that list — moon's layer
constraint refuses one `application` depending on another. Measured: with the console reference
pruned, `bun tsc --build --force --verbose` printed *"Projects in this build: packages/kojo, ."* and
exited 0 with the whole Console compiled by nothing. The fix is
`toolchains.typescript.syncProjectReferences: false` on the root project, so the committed root
`tsconfig.json` is hand-held and nothing rewrites it. Verified by mutation: a deliberate type error
in `apps/console/src/contexts/shared/lib/cn.ts` now fails `bun tsc --build --force`.

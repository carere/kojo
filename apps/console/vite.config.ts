import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * The Console's build: a prerendered shell plus a client bundle, and no server functions.
 *
 * Three settings here are load-bearing, and each is a measured fact about the framework rather than
 * a preference.
 *
 * **`spa.prerender.outputPath` is `/index`, not the default.** The shell page is queued with
 * `outputPath` taken from `spa.prerender`, and the prerenderer recognises it as the shell — so it
 * writes `<outputPath>.html` verbatim instead of the `<path>/index.html` it writes for ordinary
 * pages. The default `/_shell` therefore produces `_shell.html`, and `kojo ui` looks for
 * `index.html`. Naming the output `/index` is what makes the two agree.
 *
 * **The client output lands inside `packages/kojo`.** `kojo ui` has to work for somebody who
 * installed Kojo rather than only for somebody who cloned this repository, so the published package
 * carries the build (console.md §12). The path is the one `src/cli/ui.ts` already defaults to, and
 * it is set on the `client` environment rather than on `build.outDir` because the plugin derives the
 * client directory as `join(build.outDir, "client")` — setting the root would bury the shell one
 * level too deep.
 *
 * **The `ssr` environment still builds, and that is not a server function.** SPA mode prerenders the
 * shell by starting a Vite preview server and fetching `/` from it once, at build time. What ships is
 * the HTML it produced. Nothing under `apps/console/dist/` is served at run time, and there is no
 * `createServerFn` anywhere in this app.
 */
export default defineConfig({
  plugins: [
    // Before the Solid plugin, and the order is not stylistic: the Start plugin has to transform a
    // route module before JSX compilation turns it into `template()` calls.
    tanstackStart({
      spa: { enabled: true, prerender: { outputPath: "/index" } },
      // The generated route tree imports its route modules by path. With extensions on, those paths
      // carry `.tsx`, which is what `allowImportingTsExtensions` in this repo's tsconfig expects and
      // what the no-barrel rule asks of every other import in the workspace.
      router: { addExtensions: true },
    }),
    solid({ ssr: true }),
    tailwindcss(),
  ],
  environments: {
    client: {
      build: {
        outDir: "../../packages/kojo/console",
        // The directory is outside this project's root, so Vite refuses to clear it unless it is
        // told to. A build that left the previous bundle behind would ship two of them.
        emptyOutDir: true,
      },
    },
  },
  server: {
    // `moon run console:dev` serves the front end; the API keeps coming from `kojo ui`, which is the
    // only thing that can read a trace. The port is `ui`'s own default.
    proxy: { "/api": "http://localhost:4321" },
  },
});

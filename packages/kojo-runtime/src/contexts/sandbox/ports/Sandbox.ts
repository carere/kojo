import { Context } from "effect";
import type { SandboxHandle } from "../models/SandboxHandle.ts";

/**
 * The sandbox a phase is currently running inside.
 *
 * Present only within a `sandboxed` scope, which is the point: a phase that needs a container says
 * so in its requirements, and an author who puts one outside every scope finds out from the compiler
 * rather than from a run. A routing agent that only reads a ticket needs no container and asks for
 * none.
 *
 * Sandboxes nest, and this service is how. An inner scope provides `Sandbox` again over the same
 * body, so a lane inside a lane sees the innermost one — branches of the graph, not a global
 * wrapper.
 */
export class Sandbox extends Context.Service<Sandbox, SandboxHandle>()("kojo/sandbox/Sandbox") {}

// This file is Kojo's own.
//
// Kojo's definition of done — what an agent's answer has to survive before a human is asked to look
// at it.
//
// A check never asks the agent anything. It compares a claim against the repository, and it returns
// faults rather than a boolean, because a correction turn is written from the fault.

import type { Workspace } from "kojo/contexts/sandbox/ports/Workspace";
import type { Check } from "kojo/contexts/workflow/guards/Check";
import { artifactsExist } from "kojo/contexts/workflow/guards/checks/artifactsExist";
import { diffMatchesClaims } from "kojo/contexts/workflow/guards/checks/diffMatchesClaims";
import type { Built, Planned } from "./envelopes.ts";

/**
 * The planner really wrote the plan it says it wrote.
 *
 * Worth running on a phase that changes no code: the builder after it is told to read these files,
 * so a plan that is not there is a fault the whole rest of the lane inherits — and it would surface
 * as a builder that invented its own approach and looked, from the trace, like it had followed one.
 */
export const planned: ReadonlyArray<Check<Planned, Workspace>> = [
  artifactsExist<Planned>({ claim: "artifacts", paths: (answer) => answer.artifacts }),
];

/**
 * A writing agent listed exactly the paths the working tree changed.
 *
 * Both directions are faults, and in this repository each has a specific way of hurting:
 *
 * - **claimed and unchanged** is work that was not done, and the commit message, the review and the
 *   merge are then all written about a change that is not there;
 * - **changed and unclaimed** is a change a reviewer approves without having read it — which in a
 *   repository where the product *is* the engine means an unreviewed edit to the engine.
 *
 * The envelope has to be named — `diffMatchesClaims<Built>` — because `Built` appears only in the
 * selector's parameter, and a bare arrow gives the compiler nothing to infer it from.
 */
export const built: ReadonlyArray<Check<Built, Workspace>> = [
  diffMatchesClaims<Built>({ claim: "changedFiles", files: (answer) => answer.changedFiles }),
];

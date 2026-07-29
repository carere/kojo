import { Schema } from "effect";

export const ProjectIdentity = Schema.String.pipe(Schema.brand("ProjectIdentity"));
export type ProjectIdentity = typeof ProjectIdentity.Type;

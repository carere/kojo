import { Schema } from "effect";

export const ProjectIdentity = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    expected: "a full Project Identity",
  }),
).pipe(Schema.brand("ProjectIdentity"));
export type ProjectIdentity = typeof ProjectIdentity.Type;

export interface KojoConfiguration {
  readonly workflows: ReadonlyArray<unknown>;
}

export const defineConfig = <const Configuration extends KojoConfiguration>(
  configuration: Configuration,
): Configuration => configuration;

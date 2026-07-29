import { Schema } from "effect";

export const HostIdentity = Schema.String.check(
  Schema.isPattern(/^host:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    expected: "an opaque Host Identity",
  }),
).pipe(Schema.brand("HostIdentity"));
export type HostIdentity = typeof HostIdentity.Type;

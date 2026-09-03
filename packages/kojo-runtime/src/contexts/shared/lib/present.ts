/**
 * One optional field, spelled the only way this codebase is allowed to spell it: **absent, never
 * `null`, and never a key holding `undefined`.**
 *
 * Every record the Console reads declares its optional fields with `Schema.optionalKey`, which is an
 * *exact* optional property: the key may be missing, and it may not be present holding `undefined`.
 * That is what fixes the wire shape, because the JSON serializer encodes a present `undefined` as
 * `null` and a missing key as nothing at all. Those are two different documents, and before
 * adr/trace/0003 this build sent both — the fixtures omitted the key and the SQLite readers passed
 * `undefined` — so the Console met a `null` it had never been shown in a test and the run view threw.
 *
 * With `exactOptionalPropertyTypes`, `{ sandboxId: undefined }` no longer type-checks against such a
 * record. So the mistake is a compile error rather than a shape a reader meets at three in the
 * morning, and this helper is what a producer writes instead:
 *
 * ```ts
 * new PhaseRecord({ …, ...present("sandboxId", row.sandbox_id) })
 * ```
 *
 * A `null` column and an absent value are the same thing here, which is why both are accepted: SQL
 * has no absence, so a nullable column *is* how a table writes one down.
 *
 * The cast is the whole reason this is a function rather than a spread written out at each call. A
 * computed key gives TypeScript `{ [x: string]: A }` and nothing narrows it back to the one-key
 * shape, so the cast has to exist somewhere; here it exists once, under this comment, rather than
 * fourteen times in the readers.
 */
export const present = <const K extends string, A>(
  key: K,
  value: A | null | undefined,
): { readonly [P in K]?: A } =>
  (value === null || value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: A };

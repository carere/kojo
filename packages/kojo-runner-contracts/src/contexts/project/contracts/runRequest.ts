import {
  type DecodePath,
  type DecodeResult,
  decodeClosedRecord,
  decodeString,
  decodeSuccess,
} from "../../shared/codecs/json.ts";

/** Only explicitly selected public fields can cross the request presentation boundary. */
export const decodeRunRequest = (
  input: unknown,
  path: DecodePath = [],
): DecodeResult<{
  readonly title: string;
  readonly url?: string;
  readonly fields: Readonly<Record<string, string>>;
}> => {
  const record = decodeClosedRecord(input, ["title", "url", "fields"], path);
  if (!record.ok) return record;
  const title = decodeString(record.value.title, [...path, "title"]);
  if (!title.ok) return title;
  const url =
    record.value.url === undefined ? undefined : decodeString(record.value.url, [...path, "url"]);
  if (url !== undefined && !url.ok) return url;
  const rawFields = record.value.fields;
  const fields = decodeClosedRecord(
    rawFields,
    typeof rawFields === "object" && rawFields !== null ? Object.keys(rawFields) : [],
    [...path, "fields"],
  );
  if (!fields.ok) return fields;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields.value)) {
    const field = decodeString(value, [...path, "fields", key]);
    if (!field.ok) return field;
    Object.defineProperty(values, key, { value: field.value, enumerable: true });
  }
  return decodeSuccess({
    title: title.value,
    fields: values,
    ...(url === undefined ? {} : { url: url.value }),
  });
};

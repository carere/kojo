import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeString,
  decodeSuccess,
} from "../../shared/codecs/json.ts";

export interface Cursor {
  readonly cursorVersion: 1;
  readonly value: string;
}

export interface PaginationRequest {
  readonly paginationVersion: 1;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface PageMetadata {
  readonly paginationVersion: 1;
  readonly totalMatching: number;
  readonly snapshotVersion: number;
  readonly nextCursor?: Cursor;
}

export const decodeCursor = (
  input: unknown,
  path: ReadonlyArray<number | string> = [],
): DecodeResult<Cursor> => {
  const record = decodeClosedRecord(input, ["cursorVersion", "value"], path);
  if (!record.ok) return record;
  if (record.value.cursorVersion !== 1) {
    return decodeFailure([...path, "cursorVersion"], "Expected cursor version 1");
  }
  const value = decodeString(record.value.value, [...path, "value"], {
    minLength: 1,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
  if (!value.ok) return value;
  return decodeSuccess({ cursorVersion: 1, value: value.value });
};

export const decodePaginationRequest = (input: unknown): DecodeResult<PaginationRequest> => {
  const record = decodeClosedRecord(input, ["paginationVersion", "limit", "cursor"]);
  if (!record.ok) return record;
  if (record.value.paginationVersion !== 1) {
    return decodeFailure(["paginationVersion"], "Expected pagination version 1");
  }
  const limit = decodeInteger(record.value.limit, ["limit"], { minimum: 1, maximum: 200 });
  if (!limit.ok) return limit;
  if (!("cursor" in record.value)) {
    return decodeSuccess({ paginationVersion: 1, limit: limit.value });
  }
  const cursor = decodeCursor(record.value.cursor, ["cursor"]);
  if (!cursor.ok) return cursor;
  return decodeSuccess({ paginationVersion: 1, limit: limit.value, cursor: cursor.value });
};

export const decodePageMetadata = (input: unknown): DecodeResult<PageMetadata> => {
  const record = decodeClosedRecord(input, [
    "paginationVersion",
    "totalMatching",
    "snapshotVersion",
    "nextCursor",
  ]);
  if (!record.ok) return record;
  if (record.value.paginationVersion !== 1) {
    return decodeFailure(["paginationVersion"], "Expected pagination version 1");
  }
  const totalMatching = decodeInteger(record.value.totalMatching, ["totalMatching"], {
    minimum: 0,
  });
  if (!totalMatching.ok) return totalMatching;
  const snapshotVersion = decodeInteger(record.value.snapshotVersion, ["snapshotVersion"], {
    minimum: 0,
  });
  if (!snapshotVersion.ok) return snapshotVersion;
  if (!("nextCursor" in record.value)) {
    return decodeSuccess({
      paginationVersion: 1,
      totalMatching: totalMatching.value,
      snapshotVersion: snapshotVersion.value,
    });
  }
  const nextCursor = decodeCursor(record.value.nextCursor, ["nextCursor"]);
  if (!nextCursor.ok) return nextCursor;
  return decodeSuccess({
    paginationVersion: 1,
    totalMatching: totalMatching.value,
    snapshotVersion: snapshotVersion.value,
    nextCursor: nextCursor.value,
  });
};

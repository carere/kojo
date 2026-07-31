import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";

export type ProjectStoreConnection = Database;

export interface ProjectStoreAdapter {
  readonly databasePath: (projectPath: string) => string;
  readonly transaction: <A>(connection: ProjectStoreConnection, operation: () => A) => A;
  readonly withWritableProjectStore: <A>(
    project: { readonly path: string },
    operation: (connection: ProjectStoreConnection) => A,
  ) => A;
  readonly withReadableProjectStore: <A>(
    project: { readonly path: string },
    operation: (connection: ProjectStoreConnection) => A,
  ) => A;
}

export const databasePath = (projectPath: string) => join(projectPath, ".kojo", "kojo.sqlite");

export const assertDatabaseFile = (path: string) => {
  const information = lstatSync(path);
  const userId = process.getuid?.();
  if (
    information.isSymbolicLink() ||
    !information.isFile() ||
    (userId !== undefined && information.uid !== userId) ||
    (information.mode & 0o777) !== 0o600
  ) {
    throw new Error("unsafe Project database");
  }
  return information;
};

const pragmaNumber = (connection: ProjectStoreConnection, name: string) => {
  const row = connection.query(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  return row?.[name];
};

export const configureWritable = (connection: ProjectStoreConnection) => {
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA synchronous = FULL");
  const journal = connection.query("PRAGMA journal_mode = WAL").get() as
    | { readonly journal_mode: string }
    | undefined;
  if (
    journal?.journal_mode.toLowerCase() !== "wal" ||
    pragmaNumber(connection, "foreign_keys") !== 1 ||
    pragmaNumber(connection, "synchronous") !== 2
  ) {
    throw new Error("Project database safety settings are unavailable");
  }
};

export const configureReadOnly = (connection: ProjectStoreConnection) => {
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA query_only = ON");
};

export const transaction = <A>(connection: ProjectStoreConnection, operation: () => A): A => {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // The statement which failed may already have rolled the transaction back.
    }
    throw error;
  }
};

export const withWritableProjectStore = <A>(
  project: { readonly path: string },
  operation: (connection: ProjectStoreConnection) => A,
): A => {
  const path = databasePath(project.path);
  assertDatabaseFile(path);
  const connection = new Database(path, { strict: true });
  try {
    configureWritable(connection);
    return operation(connection);
  } finally {
    connection.close();
  }
};

export const withReadableProjectStore = <A>(
  project: { readonly path: string },
  operation: (connection: ProjectStoreConnection) => A,
): A => {
  const path = databasePath(project.path);
  assertDatabaseFile(path);
  const connection = new Database(path, { readonly: true, strict: true });
  try {
    configureReadOnly(connection);
    return operation(connection);
  } finally {
    connection.close();
  }
};

export const ProjectStoreAdapterLive: ProjectStoreAdapter = {
  databasePath,
  transaction,
  withWritableProjectStore,
  withReadableProjectStore,
};

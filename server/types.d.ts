// Shared types for the server, the mock Meta API and the server tests.

/** A database row or a Meta API object. Column and field names come from SQL and Meta, so values are not narrowed further. */
type Row = Record<string, any>;
type SqlArg = string | number | boolean | bigint | null | undefined;
/** One write in a batch: the SQL, then its arguments. */
type BatchItem = [sql: string, ...args: SqlArg[]];

interface Db {
  kind: 'sqlite' | 'libsql';
  get(sql: string, ...args: SqlArg[]): Promise<Row | undefined>;
  all(sql: string, ...args: SqlArg[]): Promise<Row[]>;
  run(sql: string, ...args: SqlArg[]): Promise<{ changes: number }>;
  /** Several writes, applied together. Each item: [sql, ...args]. */
  batch(list: BatchItem[]): Promise<void>;
  close(): void;
}

/** The part of @libsql/client's Client that the app (and the test stand-in) uses. */
interface LibsqlClient {
  execute(stmt: string | { sql: string; args?: unknown[] }): Promise<{ columns: string[]; rows: any[][]; rowsAffected: number; lastInsertRowid?: unknown }>;
  batch(stmts: (string | { sql: string; args?: unknown[] })[], mode?: string): Promise<unknown>;
  close?(): void;
  calls?: number;
}

interface Logger { info(m: string): void; warn(m: string): void; error(e: unknown): void }

type EntityLevel = 'campaign' | 'adset' | 'ad';

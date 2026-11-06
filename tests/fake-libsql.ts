// A stand-in for @libsql/client's Client, backed by node:sqlite, with the same
// result shapes (ResultSet: { columns, rows, rowsAffected }, rows array-like with
// column-name properties) and batch(statements, "write") semantics.
// Lets the tests run the server against the libSQL code path without the package.
const { DatabaseSync }: typeof import('node:sqlite') = require('node:sqlite');

interface Stmt { sql: string; args: any[] }

function createFakeClient(): LibsqlClient & { calls: number } {
  const db = new DatabaseSync(':memory:');
  const toStmt = (s: string | { sql: string; args?: unknown[] }): Stmt => (typeof s === 'string' ? { sql: s, args: [] } : { sql: s.sql, args: s.args || [] });
  function run({ sql, args }: Stmt) {
    for (const a of args) if (a === undefined) throw new TypeError('libsql: undefined is not a valid argument');
    const st = db.prepare(sql);
    const reader = /^\s*(select|pragma|with)/i.test(sql) || /\breturning\b/i.test(sql);
    if (reader) {
      const objs = st.all(...args) as Row[];
      const columns = st.columns().map((c) => c.name as string);
      const rows = objs.map((o) => { const r = columns.map((c) => o[c]); columns.forEach((c, i) => { Object.defineProperty(r, c, { value: r[i], enumerable: false }); }); return r; });
      return { columns, rows, rowsAffected: 0, lastInsertRowid: undefined };
    }
    const r = st.run(...args);
    return { columns: [], rows: [], rowsAffected: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  return {
    calls: 0,
    async execute(stmt: string | { sql: string; args?: unknown[] }) { this.calls++; return run(toStmt(stmt)); },
    async batch(stmts: (string | { sql: string; args?: unknown[] })[], mode?: string) {
      this.calls++;
      if (mode !== 'write' && mode !== 'read' && mode !== 'deferred') throw new Error('bad mode');
      db.exec('BEGIN');
      try { const out = stmts.map((s) => run(toStmt(s))); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },
  };
}

const api = { createFakeClient };
module.exports = api;
export type FakeLibsqlApi = typeof api;

// SPDX-License-Identifier: Apache-2.0
// Narrow compile-only contract for the existing offline native package, which
// carries no declaration files. Runtime cases load the actual pinned binary.
declare module 'better-sqlite3' {
  class NativeDatabase {
    constructor(path: string);
    pragma(value: string): unknown;
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
    };
    readonly inTransaction: boolean;
    transaction<T>(work: () => T): () => T;
    backup(destination: string): Promise<unknown>;
    close(): void;
  }
  namespace NativeDatabase { type Database = NativeDatabase; }
  export default NativeDatabase;
}

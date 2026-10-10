/** One statement per exec. workerd's SQL API does not take a multi-statement script. */
export function ensureTables(sql: SqlStorage, statements: readonly string[]): void {
  for (const statement of statements) sql.exec(statement);
}

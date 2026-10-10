/** DO SQLite helpers. Statements are single-line; workerd rejects scripts. */

export function metaGet(sql: SqlStorage, key: string): string | null {
  const rows = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
  return rows[0]?.value ?? null;
}

export function metaSet(sql: SqlStorage, key: string, value: string): void {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

export function metaDelete(sql: SqlStorage, key: string): void {
  sql.exec("DELETE FROM meta WHERE key = ?", key);
}

export interface StoredCommand extends Record<string, SqlStorageValue> {
  result: string;
  revision: number;
}

export function commandGet(sql: SqlStorage, id: string): StoredCommand | null {
  const rows = sql.exec<StoredCommand>("SELECT result, revision FROM commands WHERE id = ?", id).toArray();
  return rows[0] ?? null;
}

export function commandPut(sql: SqlStorage, id: string, result: string, revision: number, now = Date.now()): void {
  sql.exec(
    "INSERT INTO commands (id, result, revision, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET result = excluded.result, revision = excluded.revision",
    id,
    result,
    revision,
    now,
  );
}

export interface OutboxRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: string;
  payload: string;
  status: string;
  created_at: number;
}

export function pendingOutbox(sql: SqlStorage): OutboxRow | null {
  const rows = sql.exec<OutboxRow>(
    "SELECT id, kind, payload, status, created_at FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
  ).toArray();
  return rows[0] ?? null;
}

export function insertPending(sql: SqlStorage, id: string, kind: string, payload: string, now = Date.now()): void {
  sql.exec(
    "INSERT INTO outbox (id, kind, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, payload = excluded.payload, status = 'pending', created_at = excluded.created_at WHERE outbox.status != 'committed'",
    id,
    kind,
    payload,
    now,
  );
}

export function setOutboxStatus(sql: SqlStorage, id: string, status: "committed" | "aborted" | "pending"): void {
  sql.exec("UPDATE outbox SET status = ? WHERE id = ?", status, id);
}

/** Fixed 2-second buckets. Returns false when this event exceeds the limit (the event is counted). */
export function bumpBucket(sql: SqlStorage, key: string, limit: number, now = Date.now()): boolean {
  const raw = metaGet(sql, key);
  let bucket = { t: now, n: 0 };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { t?: unknown; n?: unknown };
      if (typeof parsed.t === "number" && typeof parsed.n === "number") bucket = { t: parsed.t, n: parsed.n };
    } catch {
      bucket = { t: now, n: 0 };
    }
  }
  if (now - bucket.t >= 2_000) bucket = { t: now, n: 0 };
  bucket.n += 1;
  metaSet(sql, key, JSON.stringify(bucket));
  return bucket.n <= limit;
}

export function purgeOldRows(sql: SqlStorage, now = Date.now()): void {
  const cutoff = now - 24 * 60 * 60 * 1000;
  sql.exec("DELETE FROM commands WHERE created_at < ?", cutoff);
  sql.exec("DELETE FROM outbox WHERE status != 'pending' AND created_at < ?", cutoff);
}

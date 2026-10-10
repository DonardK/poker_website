/** Fixed 2s window, 20 frames, matching the table socket budget. ping/pong are not passed in. */
export function allowFrame(sql: SqlStorage, connId: string, now: number): boolean {
  const rows = sql
    .exec<{ window_start: number; n: number }>("SELECT window_start, n FROM frame_rate WHERE conn_id = ?", connId)
    .toArray();
  const row = rows[0];
  if (!row || now - Number(row.window_start) >= 2_000) {
    if (!row) sql.exec("INSERT INTO frame_rate (conn_id, window_start, n) VALUES (?, ?, 1)", connId, now);
    else sql.exec("UPDATE frame_rate SET window_start = ?, n = 1 WHERE conn_id = ?", now, connId);
    return true;
  }
  if (Number(row.n) >= 20) return false;
  sql.exec("UPDATE frame_rate SET n = ? WHERE conn_id = ?", Number(row.n) + 1, connId);
  return true;
}

export function clearFrameRate(sql: SqlStorage, connId: string): void {
  sql.exec("DELETE FROM frame_rate WHERE conn_id = ?", connId);
}

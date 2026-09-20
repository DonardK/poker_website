-- Prevent cascading deletion of completed hand records by the runtime role.
REVOKE DELETE ON public."Table", public."User" FROM poker_server;
-- The unique user index already supports seat lookups.
DROP INDEX public."TableSeat_userId_idx";

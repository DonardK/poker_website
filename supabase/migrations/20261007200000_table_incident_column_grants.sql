-- TableIncident is an audit trail: once an incident is recorded, only its
-- resolution (resolvedAt and resolvedBy, set together by an operator) may
-- change. 20261003100000_game_reliability granted the runtime role UPDATE on
-- the whole table, so kind, reason and createdAt could be rewritten after the
-- fact. Narrow UPDATE to the two resolution columns. Privileges only: no
-- table, column, constraint or row changes, so this is safe on a live database.
REVOKE UPDATE ON TABLE public."TableIncident" FROM poker_server;
GRANT UPDATE ("resolvedAt", "resolvedBy") ON TABLE public."TableIncident" TO poker_server;

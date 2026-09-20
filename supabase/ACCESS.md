# Access status

OnlinePoker (`tgfudufxslhrxbdxcnyl`) is accessible through the connected Supabase plugin and the application's restricted database login. The connection was verified on 2026-09-20. SSL enforcement is on.

No administrator database password is stored in the application. Schema migrations require a separately provisioned administrator connection (`DIRECT_URL`) or authorized Supabase tools. Runtime credentials belong only in the ignored root `.env` or a deployment secret manager.

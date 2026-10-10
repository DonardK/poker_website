/** Explicitly authorized READ-ONLY live inspection. No writes, no personal
 * data, no secrets. Imports root .env intentionally only for this probe.
 * First statement sets the whole transaction to READ ONLY. */
import {prisma} from '../../../apps/server/dist/db/prisma.js';
try {
 const result=await prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  const counts=await tx.$queryRaw`SELECT
   (SELECT count(*)::int FROM public."Table") AS tables,
   (SELECT count(*)::int FROM public."Table" WHERE status='CLOSED') AS closed_tables,
   (SELECT count(*)::int FROM public."TableSeat" s JOIN public."Table" t ON t.id=s."tableId" WHERE t.status='CLOSED' AND (s."userId" IS NOT NULL OR s.stack<>0 OR s.status<>'EMPTY')) AS nonempty_closed_seats,
   (SELECT count(*)::int FROM public."Table" WHERE status='IN_HAND' AND "stateCiphertext" IS NULL) AS active_tables_missing_ciphertext,
   (SELECT count(*)::int FROM public."User" WHERE bankroll<0) AS negative_wallets,
   (SELECT count(*)::int FROM public."TableSeat" WHERE stack<0) AS negative_stacks,
   (SELECT count(*)::int FROM public."Session" WHERE "expiresAt"<now()) AS expired_sessions,
   (SELECT count(*)::int FROM public."Table" WHERE status='IN_HAND' AND "updatedAt"<now()-interval '5 minutes') AS old_active_rows,
   (SELECT count(*)::int FROM public."Hand" WHERE "auditRecord" IS NULL AND "startedAt">=(SELECT min("startedAt") FROM public."Hand" WHERE "auditRecord" IS NOT NULL)) AS missing_audit_after_first_audited_start`;
  const privileges=await tx.$queryRaw`SELECT has_table_privilege(current_user,'public."User"','UPDATE') AS can_update_users, has_column_privilege(current_user,'public."User"','role','UPDATE') AS can_update_roles, has_column_privilege(current_user,'public."User"','passwordHash','SELECT') AS can_read_password_hashes, has_table_privilege(current_user,'public."Hand"','UPDATE') AS can_update_history, has_table_privilege(current_user,'public."Hand"','DELETE') AS can_delete_history, has_table_privilege(current_user,'public."User"','DELETE') AS can_delete_users`;
  return {counts,privileges};
 },{timeout:20000,maxWait:10000});console.log(JSON.stringify(result,null,2));
}catch(e){console.error(JSON.stringify({error:'Read-only aggregate check failed',type:e.name,code:e.code??null}));process.exitCode=1;}
finally{await prisma.$disconnect();}

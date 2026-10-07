/** Review-only wrapper for existing bad-behavior probes. No live connection. */
Object.assign(process.env,{DATABASE_URL:'postgresql://review:unused@127.0.0.1:1/review',DIRECT_URL:'postgresql://review:unused@127.0.0.1:1/review',DATABASE_TEST_ADMIN_URL:'postgresql://review:unused@127.0.0.1:1/review',REDIS_URL:'',GAME_ENCRYPTION_KEY:'31'.repeat(32),JWT_ACCESS_SECRET:'synthetic-access-'.padEnd(64,'a'),JWT_REFRESH_SECRET:'synthetic-refresh-'.padEnd(64,'b'),NODE_ENV:'test'});
await import('../../../scripts/security-review.mjs');

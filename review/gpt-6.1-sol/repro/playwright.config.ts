import {defineConfig} from '@playwright/test';
import path from 'node:path';
const root=path.resolve(__dirname,'../../..');
export default defineConfig({
 testDir:'.',testMatch:'browser-defects.spec.ts',workers:1,fullyParallel:false,timeout:20000,
 globalTeardown:path.join(root,'apps/web/test/support/restore-next-env.ts'),
 outputDir:path.join(root,'review/gpt-6.1-sol/browser-results'),
 use:{baseURL:'http://127.0.0.1:3107',channel:'chrome',viewport:{width:1440,height:1000}},
 webServer:[
 {command:'node review/gpt-6.1-sol/repro/browser-fixture.mjs',cwd:root,url:'http://127.0.0.1:4107/health',timeout:30000},
 {command:'node ../../node_modules/next/dist/bin/next dev --port 3107 --hostname 127.0.0.1',cwd:path.join(root,'apps/web'),url:'http://127.0.0.1:3107',timeout:120000,env:{NEXT_PUBLIC_API_URL:'http://127.0.0.1:4107',NEXT_PUBLIC_SOCKET_URL:'http://127.0.0.1:4107',POKER_TEST_DIST_DIR:'.next-browser-test',NEXT_TELEMETRY_DISABLED:'1'}}
 ]
});

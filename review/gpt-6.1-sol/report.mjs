/** Render only the authorized new report and review-owned artifacts. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {findings} from './findings.mjs';
const base='review/gpt-6.1-sol/';
const initial=JSON.parse(readFileSync(base+'baseline-tree.json','utf8'));
const final=JSON.parse(readFileSync(base+'final-tree.json','utf8'));
const log=readFileSync(base+'verification.ndjson','utf8').trim().split(/\r?\n/).map(JSON.parse);
const safe=s=>String(s).replaceAll('|','\\|').replaceAll('\n','<br>');
const table=(cols,rows)=>'| '+cols.join(' | ')+' |\n|'+cols.map(()=>'---').join('|')+'|\n'+rows.map(r=>'| '+r.map(safe).join(' | ')+' |').join('\n')+'\n';
const count=(key)=>findings.reduce((a,f)=>(a[f[key]]=(a[f[key]]??0)+1,a),{});
const sev={S0:0,S1:0,S2:0,S3:0,S4:0,...count('severity')};
const cat=count('category');
const verified=findings.filter(f=>f.confidence.startsWith('CONFIRMED')).length;
const priorFiles=Object.keys(initial.fingerprints).filter(p=>!p.startsWith('review/gpt-6.1-sol/'));
const changes=priorFiles.filter(p=>!existsSync(p)||createHash('sha256').update(readFileSync(p)).digest('hex')!==initial.fingerprints[p]);
if(changes.length)throw new Error('Pre-existing files changed: '+changes.join(', '));
const currentDiff=execFileSync('git',['diff','HEAD'],{encoding:'utf8',maxBuffer:30e6});
const diffHash=createHash('sha256').update(currentDiff).digest('hex');
if(diffHash!==initial.diffSHA256)throw new Error('Tracked diff changed; report must investigate before completion');
const untracked=initial.untracked.filter(p=>!p.startsWith('review/'));
const inventory=final.inventory.filter(p=>p!=='GPT-6.1-SOL-REVIEW.md');
const fullyReadTests=new Set(['apps/server/test/game-flow.test.mjs','apps/server/test/security.test.mjs','apps/server/test/human-tables.test.mjs','apps/server/test/integration.test.mjs','apps/web/test/browser/game-flow.spec.ts','apps/web/test/support/game-server.mjs','apps/web/test/support/restore-next-env.ts','packages/engine/src/__tests__/helpers/drive.ts','packages/engine/src/__tests__/helpers/stats.ts']);
const coverage=inventory.map(path=>{
 let status='FULL',note='Read current source/config/document; see section 9 for grouped claim checks.';
 if(path.includes('/test/')||path.includes('/__tests__/')) {if(!fullyReadTests.has(path)){status='PARTIAL';note='Executed relevant suite (integration excepted); inspected selected assertions, fixtures/descriptors and relevant behavior, not every line independently.';}else note='Read complete fixture/test/helper; integration read only and not executed; other applicable baseline suites executed.';}
 if(path==='package-lock.json'){status='PARTIAL';note='Parsed complete lock inventory, production audit/license scan and workspace/version/dependency structure; not every dependency implementation reviewed.';}
 if(path==='CLAUDE-REVIEW.md'){status='PARTIAL';note='Independent concurrent report added after baseline; inspected index/some claims, not relied upon as executed evidence for this report.';}
 if(path==='.cursor/mcp.json'){status='PARTIAL';note='Only configuration structure inspected (one server); secret-bearing values deliberately not printed/copied.';}
 if(path==='.audit.json'){status='PARTIAL';note='Generated prior advisory result; inspected metadata only, replaced by newly executed audit evidence.';}
 if(path==='apps/server/certs/supabase-pooler-root.pem'){status='PARTIAL';note='Public CA/config use inspected; actual DB TLS was verified, not an independent CA provenance/certificate-chain audit.';}
 if(path==='supabase/authenticated-account/database.types.ts'){status='NOT REVIEWED';note='Generated types for the documented other/historical account; not a runtime dependency of the poker application.';}
 if(path==='supabase/.temp/cli-latest'){status='NOT REVIEWED';note='Generated CLI-version cache; no application behavior.';}
 if(path.startsWith('supabase/authenticated-account/')&&status==='FULL')note='Historical/other-account metadata read to establish scope; not evidence for current OnlinePoker security.';
 const ids=findings.filter(f=>f.where.startsWith(path+':')||f.related.includes(path+':')).map(f=>f.id);
 const add=(idsToAdd)=>ids.push(...idsToAdd);
 if(path==='apps/server/src/game/manager.ts')add(['SOL-005','SOL-006','SOL-008','SOL-010','SOL-014','SOL-015','SOL-016','SOL-018','SOL-025','SOL-029','SOL-035','SOL-036']);
 if(path==='apps/server/src/socket/index.ts')add(['SOL-011','SOL-013','SOL-032','SOL-036']);
 if(path==='apps/web/src/components/auth-hydrator.tsx')add(['SOL-011','SOL-012','SOL-013','SOL-016','SOL-031','SOL-038']);
 if(path==='apps/web/src/hooks/use-table-socket.ts')add(['SOL-012','SOL-036','SOL-045']);
 if(path==='apps/server/prisma/schema.prisma')add(['SOL-002','SOL-004','SOL-005','SOL-006','SOL-024','SOL-027','SOL-036','SOL-038','SOL-040']);
 if(path==='packages/shared/src/events.ts')add(['SOL-016','SOL-036','SOL-038']);
 if(path==='packages/shared/src/audit.ts')add(['SOL-025','SOL-026']);
 if(path==='COMPLIANCE.md'||path==='SECURITY-REVIEW.md'||path==='README.md')add(['SOL-002','SOL-023','SOL-025','SOL-026','SOL-028']);
 if(path==='packages/shared/src/poker.ts')note='Production types FULL; odd-chip comment is false (actual left of button), see section 9; correct algorithm must remain.';
 return {path,status,findings:[...new Set(ids)],note};
});
writeFileSync(base+'coverage.json',JSON.stringify(coverage,null,2)+'\n');
const production=coverage.filter(x=>/^(apps\/(server|web)|packages\/(engine|shared))\/src\//.test(x.path)&&!x.path.includes('/__tests__/'));
const coverageCounts=coverage.reduce((a,x)=>(a[x.status]=(a[x.status]??0)+1,a),{});
let report='# GPT-6.1-SOL-REVIEW\n\n## 1. Header\n\n';
report+='- **Date:** 2026-09-30 (Europe/Budapest); review began on 2026-09-29.\n';
report+='- **Reviewer:** GPT-6.1-Sol, the review label requested in the brief; prepared by the Codex agent in this session. This label is not an independently verified model-identity claim.\n';
report+=`- **HEAD:** \`${initial.head}\`.\n- **SHA-256 of exact UTF-8 git diff HEAD output:** \`${initial.diffSHA256}\` (unchanged at report generation).\n`;
report+='- **Environment:** Windows 11, PowerShell 5.1, Node v24.19.0, npm 11.17.0, installed Chrome and existing workspace node_modules. API fixtures use loopback; existing owner ports 3000/4000 were untouched.\n';
report+=`- **Untracked application/docs reviewed at baseline:** ${untracked.map(p=>'`'+p+'`').join(', ')}. \`CLAUDE-REVIEW.md\` and \`review/claude/**\` appeared independently during review and were preserved; only the former was partially consulted.\n`;
report+=`- **Preservation:** ${priorFiles.length} pre-existing tracked/untracked file fingerprints match. The initial tree already had 23 tracked modifications; no additional tracked change remains. Next build/browser runs temporarily rewrote \`apps/web/next-env.d.ts\`; the existing browser teardown restored its original content. No state-changing Git command, live database write, dependency change or application fix was made.\n\n`;
report+='**Scope:** Working-tree engine/shared/server/web production source, migrations/schema/grants, HTTP/socket auth and financial orchestration, browser behavior, docs/claims, configuration/dependencies and launch prerequisites. This is a review with isolated executable evidence and two explicitly read-only live database inspections. Test/helper/dependency and external-infrastructure review is partial as marked in section 12. The latest brief permits only this report and review-owned artifacts, so `progress.md` and existing model reports are preserved despite earlier requests to update them. No assurance of certification, legal compliance or absence of defects is made.\n\n';
report+='## 2. Executive summary\n\n';
report+='**Public play-chip launch: NO-GO until player-harm, privacy and essential disclosure issues are resolved; private demo testing may continue with explicit nonredeemable chips.**\n';
report+='**Real money/crypto: NO-GO.** Financial ledger/payments/custody, eligibility/AML, responsible gaming, published player policies and external approvals are not demonstrated.\n';
report+=`**${findings.length} distinct findings:** ${Object.entries(sev).map(([k,v])=>k+' '+v).join('; ')}. ${verified} have executed repro/inspection evidence; ${findings.length-verified} are code-based/externally unverified findings. Severity is for real-money use; current demo impact is stated per item.\n`;
report+='**Categories:** '+Object.entries(cat).map(([k,v])=>k+' '+v).join('; ')+'.\n';
report+='The 22 earlier F findings remain open; F21 is split into two fixes, with no duplicate counting. New findings include refresh races, post-commit bot failure, missed warnings and UI clock/sound defects.\n';
report+='Core checks passed: typecheck, production build, 451 engine tests, 64 baseline server tests (one TLS skip later resolved), all 56 existing browser tests, exhaustive evaluator and production dependency audit (0 known advisories).\n';
report+='The additional 1,000-run engine probe passed; targeted BAD-behavior probes confirmed defects. Passing those probes means the defects exist.\n';
report+='Not everything is application-encrypted: game state/sealed audits/hole cards are AES-GCM; passwords/refresh tokens are hashes; profile/balance/seat/session metadata are readable DB fields. Live inspected DB transport used TLS1.3.\n';
report+='**Ten findings to fix first:** SOL-001 cash-out loss; SOL-010 cleanup coupling; SOL-011 outage logout; SOL-014 post-commit failure; SOL-008 downtime turns; SOL-012 token rotation; SOL-013 tab race; SOL-016 missed warning; SOL-022 secret logging; SOL-032 revoked private fan-out.\n';
report+='Cash prerequisites SOL-002–007 and independent gates SOL-028–029 block any monetary launch even after current code defects are repaired.\n';
report+=`Production source ledger: ${production.length}/${production.length} FULL. Overall ${inventory.length} files: ${Object.entries(coverageCounts).map(([k,v])=>k+' '+v).join('; ')}. Complete manual test/a11y/external infrastructure review was not achieved.\n`;
report+='No disposable Postgres/Redis was available: actual locks/crash races and real multi-worker behavior remain unverified. No live money flow exists to certify.\n\n';
report+='## 3. Findings index\n\n';
report+=table(['ID','Severity','Category','Confidence','Fix type','Primary location','Title'],findings.map(f=>[f.id,f.severity,f.category,f.confidence.startsWith('CONFIRMED')?'CONFIRMED':'LIKELY',f.fixType,'`'+f.where+'`',f.title]));
report+='\n## 4. Verification log\n\n';
report+='Exact underlying commands and measured child durations are below. Commands invoked through `node review/gpt-6.1-sol/run.mjs <label> <command...>` received loopback port-1 connection variables and synthetic keys before imports; appendix gives the runnable PowerShell forms. Browser runs were approved outside the restricted sandbox. Read-only live commands are the explicitly identified exceptions. Logs/NDJSON remain under the authorized review directory.\n\n';
const notes={
 typecheck:['4 workspaces; 0 type errors','PASS'],tests:['Engine 14 suites / 451 passed. Server 65 total / 64 passed / 1 skipped (OpenSSL absent from initial PATH).','PASS'],audit:['0 known production advisories; metadata 234 prod, 298 dev, 16 optional, 543 total. Does not assess dev advisories or supply-chain compromise.','PASS'],build:['All workspaces; Next 15.5.25 build succeeded. Temporary next-env side effect restored.','PASS'],evaluator:['All 2,598,960 five-card hands/category counts; independent of this report’s new probes.','PASS'],
 'known-backend':['11 groups of known BAD observations, not a security pass.','PASS (bad behavior confirmed)'],browser:['56/56 Chrome desktop + Pixel7 tests, no skips/failures. Isolated fixture, not real DB.','PASS'],
 'engine-properties':['Initial 100-run version: 2,101 transitions, 210 settlements, 41 round-trips, 886 rejects. Final file is expanded to 1,000.','PASS'],
 'server-faults':['Original version confirms 9 groups; final expanded file has 11 grouped observations.','PASS (bad behavior confirmed)'],
 'browser-defects':['7 passed / 3 failed. New reviewer assertions only: wrong error wording, premature motion expectation, and wrong lobby-fetch trigger. Corrected below; not existing-suite regressions.','FAIL (review probes corrected)'],licenses:['237 production entries: MIT192; Apache2 18; ISC8; UNKNOWN8; BSD3 6; BSD2 2; CC-BY4 1; 0BSD1; Apache2 AND LGPL3+ 1. Seven unknowns are uninstalled platform SWC variants; one xmlhttprequest-ssl manifest.','PASS inventory; clearance pending'],
 'browser-defects-corrected':['10/10, including one diagnostic-only reduced-motion case. Logs measure 3.1859 contrast and empty .01ms reduced-motion clock. Nine other assertions confirm bad behaviors.','PASS (bad behavior confirmed)'],
 'secret-scan':['189 tracked files + 320 available history blobs, 509 contents; 9 synthetic DB-URL candidates, 0 suspicious heuristic matches. Ignored secrets/reflogs/unfetched remotes not scanned.','PASS heuristic scan'],
 'direct-tls':['1/1 selected TLS test passed, 0 skipped. Installed Git OpenSSL supplied in child PATH.','PASS'],
 'engine-properties-extended':['Reviewer driver reused a late-player ID across hands; legitimate ALREADY_SEATED rejection. Corrected driver only; no application fix.','FAIL (review driver corrected)'],
 'engine-properties-corrected':['1,000 runs; 21,814 transitions; 18,262 projections; 2,212 settlements; 431 encryption round-trips; 54,786 invalid requests rejected. OS deck randomness not seeded.','PASS'],
 'server-faults-extended':['Reviewer bot probe left manager stopped, so timers intentionally did not run. Corrected only the probe to enable timers.','FAIL (review driver corrected)'],
 'absence-config':['30 hands / 75 timeouts: absent player stays in with 915/1,000 chips. Three unusable config values accepted. Policy/config observations.','PASS (gap confirmed)'],
 'server-faults-corrected':['11 groups: missing/corrupt state, cleanup rollback, committed bot failure, worker grace, wallet order, DB refresh/socket loss, tab rotation race, guest collision and missed warning.','PASS (bad behavior confirmed)'],
 'known-wrapper':['Repeated 11 original bad-observation groups; downtime fold observed in 7ms.','PASS (bad behavior confirmed)']};
const rows=log.map(r=>{const n=notes[r.label]??['See captured log',r.exitCode===0?'PASS':'FAIL'];return ['`'+r.command+'` (`'+r.label+'`)',n[1],n[0],r.durationSeconds+'s','`'+r.log+'`'];});
rows.unshift(['`git rev-parse HEAD`; `git status --porcelain=v1`; `git diff HEAD --stat`; SHA-256 via collect.mjs','CAPTURED','Initial/final diff identity above; 23 pre-existing tracked modifications.','Not individually timed','Read-only Git only.']);
rows.push(['`node scripts/review-database.mjs` (restricted sandbox attempt)','FAIL','Prisma connection blocked/unavailable in sandbox.','1.045s','No fallback write; explicitly rerun with approved network access.']);
rows.push(['`node scripts/review-database.mjs` (approved read-only live)','PASS','Role poker_server; TLS1.3 / TLS_AES_256_GCM_SHA384; 6 authenticated encrypted states; 241 encrypted hole-card pairs, empty plaintext arrays; 56 hands, 2 full new audits and 54 legacy.','2.486s','READ ONLY transaction, rollback; aggregates only.']);
rows.push(['`node review/gpt-6.1-sol/repro/live-aggregates.mjs` (approved read-only live)','PASS','6 tables / 3 closed; closed occupied seats0; missing active ciphertext0; negative balances/stacks0; expired sessions1; old IN_HAND0; audits missing after first audited hand0. User update/role update/hash select true, Hand UPDATE/DELETE and User DELETE false.','1.744s','READ ONLY transaction, rollback; no private row values printed.']);
rows.push(['`npm.cmd run test:integration -w @poker/server`','NOT RUN','No disposable Postgres/Docker/psql; root live database must not be used.','—','Opt-in normal-suite integration is not evidence of a passed integration test.']);
rows.push(['Two actual server workers + Redis, load/kill/restore/drain/production ingress tests','NOT RUN','Only in-memory manager scheduling fault comparison was executed.','—','External staging/isolated CI required.']);
rows.push(['Manual NVDA/VoiceOver, Safari/Firefox, actual phone/landscape/400% zoom and whole-site WCAG audit','NOT RUN','Existing Chrome/mobile suite and selected computed-style tests only.','—','SOL-041–043 plus residual risk.']);
report+=table(['Command / label','Result','Counts / observations','Duration','Notes / evidence'],rows);
report+='\n### Trimmed failure/skip output\n\n```text\nBaseline server skip: production with direct TLS ... SKIP openssl unavailable\nBrowser exploratory: 7 passed, 3 failed (reviewer-only probes)\n  decimal expected wording differed: actual "Amount must be a positive whole number of chips"\n  reduced-motion expected matrix(0, 0, 0, 1, 0, 0), sampled approximately 0.998 before settled style\n  wallet probe did not trigger the targeted delayed /me path\nEngine extended driver: EngineError: That player already has a seat (code: ALREADY_SEATED)\nServer extended driver: AssertionError [ERR_ASSERTION]: Missing expected rejection.\nRead-only DB sandbox attempt: PrismaClientInitializationError: Can\'t reach database server\n```\n\nRaw verbatim assertion output is retained in the named review logs; the explanatory lines above trim private infrastructure information and distinguish reviewer probe mistakes from existing test failures. The initial read helper also rejected an incorrectly formatted file argument (ENOENT); no application defect was inferred. All corrected review probes then completed. Minor Git ignore permission/LF-to-CRLF warnings and the review helper’s trusted fixed-argument npm shell deprecation were tooling warnings, not application findings.\n\n';
let sections=readFileSync(base+'sections.md','utf8');
const testLocations=findings.map(f=>f.where.startsWith('apps/web/')?'apps/web/test/browser/review-regressions.spec.ts (new)':f.where.startsWith('packages/engine/')?'packages/engine/src/__tests__/review-regressions.test.ts (new)':'apps/server/test/review-regressions.test.mjs (new)');
testLocations[1]='apps/server/test/financial-ledger.test.mjs (new) and disposable integration suite';
testLocations[3]='apps/server/test/payments.test.mjs (new) and provider sandbox';
testLocations[4]='apps/server/test/eligibility.test.mjs (new)';
testLocations[5]='apps/server/test/responsible-gaming.test.mjs (new)';
testLocations[24]='apps/server/test/audit-witness.test.mjs (new)';
testLocations[27]='external laboratory/penetration-test acceptance plan for exact build';
testLocations[28]='apps/server/test/integration.test.mjs and new two-worker race suite';
testLocations[51]='packages/engine/src/__tests__/pots-reference.test.ts (existing)';
const blocks='## 6. Findings\n\nSorted by real-money severity, then suggested fix order. A missing cash capability is a launch blocker even where it is intentional in today’s demo. CONFIRMED names an executed observation; a related end-to-end impact may remain explicitly code-based. Code excerpts use ellipses for omitted intervening code.\n\n'+findings.map((f,i)=>[
`### ${f.id}: ${f.title}\n`,
`- **Severity:** ${f.severity} for real-money use; current play-chip impact: ${f.current}`,
`- **Category:** ${f.category}`,
`- **Confidence:** ${f.confidence}`,
`- **Fix type:** ${f.fixType}`,
`- **Where:** \`${f.where}\` (\`${f.function}\`); excerpt: \`${f.excerpt}\`.`,
`- **Related:** ${f.related}`,
`- **What happens:** ${f.what}`,
`- **Impact:** ${f.impact}`,
`- **Reproduce:** ${f.reproduce}`,
`- **Root cause:** ${f.root}`,
`- **Recommended fix:** ${f.fix}`,
`- **Regression test:** \`${testLocations[i]}\`: ${f.test}`,
`- **Acceptance criteria:** ${f.accept}`,
`- **Risk of the fix:** ${f.risk}`
].join('\n')).join('\n\n')+'\n';
sections=sections.replace('<!-- FINDINGS -->',blocks);
const ledger='## 12. Coverage ledger\n\n'+`Inventory: ${coverage.length} source/test/config/migration/doc/artifact files, including tracked and untracked work. ${Object.entries(coverageCounts).map(([k,v])=>k+' '+v).join('; ')}. Every production application source file (${production.length}) is FULL. FULL means the file content/implementation was read for this scope; not independent formal verification. PARTIAL records explicit limits; no blank entry means “implicitly covered”.\n\n`+
'Excluded from application inventory: node_modules, build/dist/.next output, .git, .agents/.codex/.aws, npm caches, .env secret files, log files, test results and review-generated artifacts. Existing tsbuildinfo/platform metadata are also generated output. .cursor connector structure is partial to avoid secrets. The complete review artifact list is in section 14; concurrently generated review/claude artifacts are preserved, not audited application source.\n\n'+
table(['File','Coverage','Findings / result','Scope note'],coverage.map(x=>['`'+x.path+'`',x.status,x.findings.length?x.findings.join(', '):'— (no distinct finding; see note)',x.note]));
sections=sections.replace('<!-- COVERAGE -->',ledger);
const status=execFileSync('git',['status','--porcelain=v1'],{encoding:'utf8',maxBuffer:1e6});
const end='### End-of-review Git status and preservation\n\n'+
`The brief’s “no modified tracked files” instruction cannot literally describe a tree that began with 23 modified tracked files. The enforceable preservation check is **no additional tracked modification**: all ${priorFiles.length} pre-existing file fingerprints are unchanged and the exact diff hash still equals \`${diffHash}\`. No existing source/test/doc/config was edited by this review. The two review helpers present when the baseline was captured were excluded from owner-file comparison.\n\n`+
'The following status was captured at report generation (the new report line is included). The modified paths were present initially, and CLAUDE-REVIEW.md/review/claude are independent concurrent additions.\n\n```text\n'+status.trimEnd()+(status.includes('?? GPT-6.1-SOL-REVIEW.md')?'':'\n?? GPT-6.1-SOL-REVIEW.md')+'\n```\n\n'+
'No live SQL mutation, migration, seeded production fixture, dependency installation, Git mutation or owner-process termination was performed. No commit or deployment is part of this deliverable.\n';
sections=sections.replace('<!-- ENDSTATUS -->',end);
report+=sections;
// Keep failure quotations exact; explanatory diagnoses remain outside these excerpts.
const failureExcerpt=[
 '### Trimmed failure/skip output','',
 'Verbatim lines from the captured logs (trimmed to the relevant assertion):','',
 '```text',
 '﹣ production with direct TLS (node:https): TLS requests pass, plaintext cannot connect (7.0882ms) # openssl unavailable: spawnSync openssl ENOENT',
 '    Error: expect(locator).toBeVisible() failed',
 "    Locator: getByText('Bet must be an integer')",'    Expected: visible','    Timeout: 5000ms','    Error: element(s) not found','',
 '    Error: expect(received).toBe(expected) // Object.is equality',
 '    Expected: "matrix(0, 0, 0, 1, 0, 0)"','    Received: "matrix(0.998578, 0, 0, 1, 0, 0)"','',
 '    Error: expect(received).toBeGreaterThan(expected)','    Expected: > 0','    Received:   0','    - Timeout 5000ms exceeded while waiting on the predicate','',
 '  3 failed','  7 passed (37.9s)','',
 'EngineError: Already seated at this table',"  code: 'ALREADY_SEATED'",'',
 'AssertionError [ERR_ASSERTION]: Missing expected rejection.','```','',
 'The read-only live attempt failed with PrismaClientInitializationError / inability to reach the database in the restricted sandbox; private connection details are omitted. It succeeded after approved escalation.','',
 'The three browser failures and two extended probe failures were reviewer assertion/driver errors, corrected in review-owned files. They are not failing existing application tests.',''
].join('\n');
report=report.replace(/### Trimmed failure\/skip output[\s\S]*?(?=Raw verbatim assertion output)/,failureExcerpt);
report=report.replace('Opt-in normal-suite integration is not evidence of a passed integration test.','Integration is excluded from the default command and was not opted in; no real-database test passed in this review.');
report=report.replace(/(## 2\. Executive summary\n\n)([\s\S]*?)(?=\n## 3\. Findings index)/,(_all,header,body)=>header+body.trim().split('\n').filter(Boolean).map(line=>'- '+line).join('\n')+'\n');
writeFileSync('GPT-6.1-SOL-REVIEW.md',report);
writeFileSync(base+'report-metadata.json',JSON.stringify({findings:findings.length,severity:sev,categories:cat,confirmed:verified,likely:findings.length-verified,coverage:coverageCounts,productionSourceFiles:production.length,preExistingFilesUnchanged:priorFiles.length,diffSHA256:diffHash},null,2)+'\n');
console.log(JSON.stringify({written:'GPT-6.1-SOL-REVIEW.md',characters:report.length,findings:findings.length,severity:sev,coverage:coverageCounts,production:production.length,preserved:priorFiles.length},null,2));

/** Review artifact consistency checks; no application changes. */
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {findings} from './findings.mjs';
const text=readFileSync('GPT-6.1-SOL-REVIEW.md','utf8');
const headings=[...text.matchAll(/^## (\d+)\. /gm)].map(x=>Number(x[1]));
assert.deepEqual(headings,Array.from({length:14},(_,i)=>i+1));
const fields=['Severity','Category','Confidence','Fix type','Where','Related','What happens','Impact','Reproduce','Root cause','Recommended fix','Regression test','Acceptance criteria','Risk of the fix'];
const blocks=text.split(/^### SOL-\d{3}:/m).slice(1);
assert.equal(blocks.length,findings.length);
for(let i=0;i<blocks.length;i++)for(const field of fields)assert.equal((blocks[i].match(new RegExp('^- \\*\\*'+field+':\\*\\*','gm'))??[]).length,1,`${i+1} ${field}`);
for(const f of findings){const m=f.where.match(/^(.+):(\d+)(?:-(\d+))?/);assert.ok(m,f.id);assert.ok(existsSync(m[1]),f.id);const lines=readFileSync(m[1],'utf8').split(/\r?\n/).length;assert.ok(Number(m[2])<=lines&&Number(m[3]??m[2])<=lines,f.id+' out-of-range location');}
const coverage=JSON.parse(readFileSync('review/gpt-6.1-sol/coverage.json','utf8'));
assert.ok(coverage.every(x=>['FULL','PARTIAL','NOT REVIEWED'].includes(x.status)&&x.note.length>0));
assert.ok(!/<!-- (FINDINGS|COVERAGE|ENDSTATUS) -->/.test(text));
assert.ok(!/### SOL-\d{3}: [^\n]+\n- \*\*/.test(text),'blank line after heading required');
const counts=findings.reduce((a,f)=>(a[f.severity]=(a[f.severity]??0)+1,a),{});
assert.deepEqual(counts,{S0:7,S1:22,S2:19,S3:3,S4:1});
console.log(JSON.stringify({result:'PASS',sections:headings.length,findings:blocks.length,fieldsPerFinding:fields.length,coverageFiles:coverage.length,locations:'all paths/line bounds exist',severity:counts},null,2));

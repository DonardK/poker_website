/** Read-only heuristic scan. Never prints matching text or secret values. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const git=(...a)=>execFileSync('git',a,{encoding:'utf8',maxBuffer:40_000_000});
const rules=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],['aws-access',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],['github-token',/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/],['jwt',/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}/],['db-url',/postgres(?:ql)?:\/\/[^\s:'"/]+:[^\s@'"/]+@[^\s'"/]+/]];
const hits=[];let scanned=0;
const inspect=(text,location)=>{scanned++;for(const [rule,re] of rules)if(re.test(text))hits.push({location,rule,syntheticOnly:rule==='db-url'&&[...text.matchAll(/postgres(?:ql)?:\/\/[^\s'"`]+/g)].every(m=>/localhost|127\.0\.0\.1|audit:unused|review:unused/.test(m[0]))});};
const tracked=git('ls-files','-z').split('\0').filter(Boolean);
for(const p of tracked)try{inspect(readFileSync(p,'utf8'),'working:'+p);}catch{}
const objects=git('rev-list','--objects','--all').trim().split('\n');let blobs=0;
for(const line of objects){const id=line.split(' ')[0];const type=git('cat-file','-t',id).trim();if(type!=='blob')continue;blobs++;inspect(git('cat-file','-p',id),'history-object:'+id);}
const suspicious=hits.filter(h=>!h.syntheticOnly);
writeFileSync('review/gpt-6.1-sol/secret-scan.json',JSON.stringify({method:'Heuristic; no matching contents retained. Does not inspect ignored .env, reflogs or remote refs.',trackedFiles:tracked.length,historyBlobs:blobs,scanned,hits,suspicious},null,2));
console.log(JSON.stringify({trackedFiles:tracked.length,historyBlobs:blobs,scanned,syntheticMatches:hits.length-suspicious.length,suspiciousCount:suspicious.length},null,2));

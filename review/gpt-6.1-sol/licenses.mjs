/** Offline license inventory; no installs or dependency modifications. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
const rows=Object.entries(lock.packages).filter(([p,x])=>p.includes('node_modules/')&&!x.dev&&!x.link).map(([p,x])=>{
 const manifest=existsSync(p+'/package.json')?JSON.parse(readFileSync(p+'/package.json','utf8')):{};
 return {path:p,name:manifest.name??p.split('node_modules/').at(-1),version:x.version,license:x.license??manifest.license??'UNKNOWN',optional:!!x.optional};
});
const counts={};for(const r of rows)counts[r.license]=(counts[r.license]??0)+1;
writeFileSync('review/gpt-6.1-sol/production-licenses.json',JSON.stringify({source:'package-lock and installed package manifests; not legal clearance',rows,counts},null,2));
console.log(JSON.stringify({packages:rows.length,licenses:counts,unknown:rows.filter(r=>r.license==='UNKNOWN').map(r=>({name:r.name,version:r.version}))},null,2));

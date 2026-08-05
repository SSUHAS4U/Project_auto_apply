import { firefox } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const SRC='C:/Users/ssuha/AppData/Roaming/JobPilot/worker/.profile-ff';
const dst=fs.mkdtempSync(path.join(os.tmpdir(),'wd-'));
const SKIP=new Set(['cache2','startupCache','shader-cache','thumbnails','.parentlock','parent.lock','lock']);
for(const e of fs.readdirSync(SRC,{withFileTypes:true})){ if(SKIP.has(e.name))continue;
  try{ fs.cpSync(path.join(SRC,e.name),path.join(dst,e.name),{recursive:true}); }catch{} }
const exe=path.join(os.homedir(),'AppData','Local','camoufox','camoufox','Cache','camoufox.exe');
const ctx=await firefox.launchPersistentContext(dst,{executablePath:exe,headless:true,viewport:null});
const page=ctx.pages()[0]||await ctx.newPage();
await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
await page.waitForTimeout(9000);
for(let i=0;i<2;i++){ await page.evaluate(()=>window.scrollBy(0,1200)); await page.waitForTimeout(1500); }
const r=await page.evaluate(()=>{
  const c=x=>(x||'').replace(/\s+/g,' ').trim();
  const btns=[...document.querySelectorAll('button,[role="button"]')];
  const wd=btns.filter(b=>/withdraw/i.test((b.getAttribute('aria-label')||'')+' '+(b.innerText||'')));
  // The row that holds a Withdraw button also holds the person + how long ago it was sent.
  const rows=wd.slice(0,6).map(b=>{
    let box=b; for(let i=0;i<8&&box.parentElement;i++){ box=box.parentElement;
      if(/\bsent\b|ago/i.test(box.innerText||'')&&box.querySelector('a[href*="/in/"]')) break; }
    const t=c(box.innerText);
    return {label:c((b.getAttribute('aria-label')||'')+' | '+(b.innerText||'')).slice(0,60),
      age:(t.match(/sent\s+([^\u2022\n]{2,22}ago)/i)||t.match(/(\d+\s+(?:day|week|month|year)s?\s+ago)/i)||[])[1]||'?',
      who:c(box.querySelector('a[href*="/in/"]')?.innerText).slice(0,24)};
  });
  return {total:btns.length, withdraw:wd.length, rows,
    counts:c(document.body.innerText).match(/People \((\d+)\)/)?.[1]||'?'};
}).catch(e=>({err:String(e).slice(0,70)}));
console.log('pending shown  :',r.counts);
console.log('withdraw btns  :',r.withdraw,'of',r.total,'buttons');
for(const x of r.rows||[]) console.log(`   ${(x.who||'?').padEnd(26)} sent ${x.age.padEnd(16)} [${x.label}]`);
console.log('\n(read-only — nothing withdrawn)');
await ctx.close(); try{fs.rmSync(dst,{recursive:true,force:true});}catch{}

/** Assertions intentionally confirm current BAD behavior. No production data. */
import {test,expect} from '@playwright/test';
const fixture='http://127.0.0.1:4107';
test.beforeEach(async({request})=>{await request.post(fixture+'/__review/reset',{data:{mode:'active'}});});
test('optional sound storage failure prevents sending and leaves actions disabled',async({page,request})=>{
 await page.goto('/table/fixture-table');const call=page.getByRole('button',{name:'Call $10',exact:true});await expect(call).toBeEnabled();
 await page.evaluate(()=>{const get=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='poker-sound-enabled')throw new DOMException('Synthetic storage unavailable','SecurityError');return get.call(this,k);};});
 await call.click();await expect(call).toBeDisabled();expect((await(await request.get(fixture+'/__test/actions')).json()).actionCount).toBe(0);
 await page.waitForTimeout(300);await expect(call).toBeDisabled();
});
test('decimal raise stays selectable and is sent despite integer engine requirements',async({page,request})=>{
 await page.goto('/table/fixture-table');await expect(page.getByRole('button',{name:'Call $10',exact:true})).toBeEnabled();
 await page.getByLabel('Raise to',{exact:true}).fill('20.5');await page.getByRole('button',{name:'Raise to $20.5',exact:true}).click();
 expect((await(await request.get(fixture+'/__test/actions')).json()).actionCount).toBe(1);
 await expect(page.getByText('Amount must be a positive whole number of chips')).toBeVisible();
});
test('browser clock skew empties a live turn clock',async({page})=>{
 await page.addInitScript(()=>{const now=Date.now;Date.now=()=>now()+3600000;});
 await page.goto('/table/fixture-table');await expect(page.getByRole('button',{name:'Call $10',exact:true})).toBeEnabled();
 const transform=await page.locator('.seat-hud--active .origin-left').evaluate(e=>getComputedStyle(e).transform);
 expect(transform).toBe('matrix(0, 0, 0, 1, 0, 0)');
});
test('diagnose reduced motion turn clock without assuming a failure',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/table/fixture-table');await expect(page.getByRole('button',{name:'Call $10',exact:true})).toBeEnabled();
 await page.waitForTimeout(100);const details=await page.locator('.seat-hud--active .origin-left').evaluate(e=>{const c=getComputedStyle(e);return {transform:c.transform,duration:c.animationDuration,name:c.animationName,media:matchMedia('(prefers-reduced-motion: reduce)').matches,animations:e.getAnimations().map(a=>({currentTime:a.currentTime,playState:a.playState}))};});console.log('REDUCED_CLOCK',JSON.stringify(details));
 await page.waitForTimeout(1200);console.log('REDUCED_CLOCK_LATER',await page.locator('.seat-hud--active .origin-left').evaluate(e=>getComputedStyle(e).transform));expect(details.media).toBe(true);
});
test('lobby refresh can overwrite a newer wallet patch',async({page,request})=>{
 await page.goto('/table/fixture-table');await page.getByRole('button',{name:'Fold & leave',exact:true}).click();await expect(page).toHaveURL(/3107\/$/);await page.waitForTimeout(300);
 await request.post(fixture+'/__test/hold-me');await request.post(fixture+'/__review/remove-no-pay');await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await expect.poll(async()=> (await(await request.get(fixture+'/__test/waiting-me')).json()).count).toBeGreaterThan(0);
 await request.post(fixture+'/__review/wallet');await expect(page.getByText('$10,000',{exact:true})).toBeVisible();
 await request.post(fixture+'/__test/release-me');await expect(page.getByText('$9,000',{exact:true})).toBeVisible();
});
test('actual token rotation resets the playable table while rejoining',async({page,request})=>{
 await page.clock.install();await page.goto('/table/fixture-table');await expect(page.getByRole('button',{name:'Call $10',exact:true})).toBeEnabled();
 await request.post(fixture+'/__review/rotate');await page.clock.fastForward(301000);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await expect(page.getByRole('button',{name:'Call $10',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Call $10',exact:true})).toBeEnabled();
});
test('warning started before lobby authentication is not shown',async({page,request})=>{
 await request.post(fixture+'/__test/idle-warning');await page.goto('/');await expect(page.getByText('$9,000',{exact:true})).toBeVisible();
 await expect(page.getByRole('alertdialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Return to your table'})).toBeVisible();
});
test('fresh visit to a closed table loses the participant audit control',async({page,request})=>{
 await request.post(fixture+'/__test/close-idle');await request.post(fixture+'/__test/finish-close');await page.goto('/table/fixture-table');
 await expect(page.getByRole('alertdialog')).toBeVisible();await expect(page.getByRole('button',{name:'Verify hand',exact:true})).toHaveCount(0);
});
test('web origin has no CSP or anti-frame policy headers',async({page})=>{
 const response=await page.goto('/');const h=response!.headers();expect(h['content-security-policy']).toBeUndefined();expect(h['x-frame-options']).toBeUndefined();
});
test('call button text has insufficient normal-text contrast',async({page})=>{
 await page.goto('/table/fixture-table');const call=page.getByRole('button',{name:'Call $10',exact:true});await expect(call).toBeEnabled();
 const measurement=await call.evaluate(e=>{const style=getComputedStyle(e);const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d')!;
 const rgb=(color:string)=>{c.clearRect(0,0,1,1);c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3);};
 const lum=(a:number[])=>a.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
 const a=lum(rgb(style.color)),b=lum(rgb(style.backgroundColor));return {contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fontSize:style.fontSize,fontWeight:style.fontWeight};});
 console.log('CALL_CONTRAST',JSON.stringify(measurement));expect(measurement.contrast).toBeLessThan(4.5);
});

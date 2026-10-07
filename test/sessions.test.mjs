import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {authenticate, authConfig, issueSession} from '../lib/auth.mjs';
import {createDashboardServer} from '../server.mjs';
import {recordEvent} from '../lib/observability.mjs';
const config=authConfig({PUBLIC_ORIGIN:'https://home.example',GOOGLE_CLIENT_ID:'synthetic',GOOGLE_CLIENT_SECRET:'synthetic',SESSION_SECRET:'synthetic-session-secret-over-32-bytes',OWNER_GOOGLE_EMAIL:'owner@example.invalid'});
const owner={sub:'owner-sub',email:'owner@example.invalid'};
function registry(){
 const rows=new Map();
 return {rows,createSession:async(identity,id,exp)=>rows.set(id,{sub:identity.sub,exp}),
 isSessionActive:async(identity,id)=>rows.get(id)?.sub===identity.sub&&rows.get(id).exp>Date.now(),
 revokeSession:async(identity,all)=>{for(const [id,row]of rows)if(row.sub===identity.sub&&(all||id===identity.sessionId))rows.delete(id)},
 health:async()=>{},ensureUser:async()=>{},refreshIfDue:async()=>{},snapshot:async()=>({mode:'cloud',homes:[]})};
}
const request=cookie=>({headers:{cookie}});
test('registered sessions are owner-bound, expired sessions and replay after revocation fail closed',async()=>{
 const store=registry(); const cookie=await issueSession(owner,config,store);
 const signed=JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0],'base64url'));
 const identity=await authenticate(request(cookie),config,undefined,store);
 assert.equal(identity.sub,owner.sub); assert.match(identity.sessionId,/^[a-f0-9]{64}$/);
 assert.notEqual(identity.sessionId,signed.sid);
 assert.equal(await authenticate(request(cookie),{...config,ownerEmail:'changed@example.invalid'},undefined,store),null);
 assert.equal(await authenticate(request(cookie),config),null);
 assert.equal(await authenticate(request(cookie),config,undefined,{isSessionActive:async()=>{throw new Error('private db error')}}),null);
 await store.revokeSession(identity); assert.equal(await authenticate(request(cookie),config,undefined,store),null);
 const expired={...signed,exp:Date.now()-1};
 const payload=Buffer.from(JSON.stringify(expired)).toString('base64url');
 const signature=createHmac('sha256',config.sessionSecret).update(payload).digest('base64url');
 assert.equal(await authenticate(request(`yl_session=${payload}.${signature}`),config,undefined,store),null);
});
test('logout requires same-origin POST, revokes current or all browsers, and leaves a signed-out page',async()=>{
 const store=registry();const events=[];
 const app=createDashboardServer({mode:'cloud',config,store,emit:(event)=>events.push(event)});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.address().port}`;
 try{
  const one=await issueSession(owner,config,store),two=await issueSession(owner,config,store);
  const page=await fetch(base+'/',{headers:{cookie:one}});
  assert.equal(page.headers.get('referrer-policy'),'same-origin');
  const callback=await fetch(base+'/auth/callback?state=invalid&code=invalid');
  assert.equal(callback.headers.get('referrer-policy'),'no-referrer');
  const options={headers:{cookie:one,origin:config.origin},redirect:'manual'};
  assert.equal((await fetch(base+'/auth/logout',options)).status,405);
  assert.equal((await fetch(base+'/auth/logout',{...options,method:'POST',headers:{cookie:one,origin:'https://attacker.example'}})).status,403);
  assert.equal((await fetch(base+'/auth/logout',{method:'POST',headers:{cookie:one},redirect:'manual'})).status,403);
  assert.equal(store.rows.size,2);
  const out=await fetch(base+'/auth/logout',{...options,method:'POST'});
  assert.equal(out.status,303);assert.equal(out.headers.get('location'),'/signed-out');assert.match(out.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal(await authenticate(request(one),config,undefined,store),null);
  assert.ok(await authenticate(request(two),config,undefined,store));
  await issueSession(owner,config,store);
  assert.equal((await fetch(base+'/auth/logout/all',{method:'POST',headers:{cookie:two,origin:config.origin},redirect:'manual'})).status,303);
  assert.equal(store.rows.size,0);
  assert.equal((await fetch(base+'/api/v1/dashboard',{headers:{cookie:two}})).status,401);
  assert.equal((await fetch(base+'/signed-out',{redirect:'manual'})).status,200);
  assert.deepEqual(events,['login_rejected','session_revoked','session_revoked']);
 }finally{app.closeAllConnections();await new Promise(resolve=>app.close(resolve))}
});
test('structured operational events drop private or uncontrolled fields',()=>{
 const lines=[];recordEvent('refresh_failed',{reason:'database',durationMs:30.2,devices:2,email:'secret',url:'private',error:'private',cookie:'private'},line=>lines.push(line));
 recordEvent('arbitrary-private-event',{},line=>lines.push(line));
 assert.equal(lines.length,1);assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(),['at','devices','durationMs','event','reason']);
 assert.ok(!lines[0].includes('private'));assert.ok(!lines[0].includes('secret'));
});

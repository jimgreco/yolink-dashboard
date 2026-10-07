import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createStore,encryptCredential,encryptionKey} from '../lib/store.mjs';
import {issueSession,authenticate,authConfig} from '../lib/auth.mjs';

const databaseUrl=process.env.HOME_WATCH_TEST_DATABASE_URL;
test('local PostgreSQL migration, forced RLS, durable sessions and refresh races', {skip:!databaseUrl}, async()=>{
 const parsed=new URL(databaseUrl);
 assert.equal(parsed.hostname,'127.0.0.1');assert.match(parsed.pathname,/^\/home_watch_test_[a-z0-9_]+$/);
 const pg=(await import('pg')).default;
 const admin=new pg.Pool({connectionString:databaseUrl,max:1});
 const role='home_watch_test_app_'+process.pid;
 let first,second;
 const keyValue=Buffer.alloc(32,4).toString('base64');const key=encryptionKey(keyValue);
 const owner={sub:'synthetic-owner',email:'owner@example.invalid'};
 const outsider={sub:'synthetic-outsider',email:'outsider@example.invalid'};
 const config=authConfig({PUBLIC_ORIGIN:'https://home.example',GOOGLE_CLIENT_ID:'fake',GOOGLE_CLIENT_SECRET:'fake',SESSION_SECRET:'synthetic-session-secret-over-32-bytes',OWNER_GOOGLE_EMAIL:owner.email});
 try{
  for(const file of ['001_initial.sql','002_personal_houses.sql','003_browser_sessions.sql']) await admin.query(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE ON dashboard_users,dashboard_snapshots TO ${role}; GRANT SELECT,INSERT,DELETE ON dashboard_sessions TO ${role}; GRANT SELECT ON yolink_connections TO ${role}; GRANT UPDATE(last_attempt_at) ON yolink_connections TO ${role}`);
  parsed.username=role;
  let releasePoll,rejectPoll;let polls=0;const events=[];
  const make=()=>createStore(parsed.href,keyValue,{emit:(event)=>events.push(event),pollHome:async()=>{polls++;return new Promise((resolve,reject)=>{releasePoll=resolve;rejectPoll=reject})}});
  first=await make();second=await make();
  const cookie=await issueSession(owner,config,first);
  let identity=await authenticate({headers:{cookie}},config,undefined,second);
  assert.equal(identity.sub,owner.sub); // Independent process/store can validate.
  assert.equal(await second.isSessionActive(outsider,identity.sessionId),false);
  await second.revokeSession(identity);
  assert.equal(await authenticate({headers:{cookie}},config,undefined,first),null);
  const a=await issueSession(owner,config,first),b=await issueSession(owner,config,second);
  identity=await authenticate({headers:{cookie:a}},config,undefined,first);
  await first.revokeSession(identity,true);
  assert.equal(await authenticate({headers:{cookie:b}},config,undefined,second),null);
  const id=randomUUID();const cipher=encryptCredential({uaid:'synthetic',secret:'synthetic'},key,owner.sub,id,'personal_uac');
  await admin.query(`INSERT INTO yolink_connections(id,owner_sub,provider,label,expected_home_id,credential_cipher,credential_nonce,credential_tag) VALUES($1,$2,'personal_uac','Manhattan','home',$3,$4,$5)`,[id,owner.sub,cipher.credential_cipher,cipher.credential_nonce,cipher.credential_tag]);
  await Promise.all([first.refreshIfDue(owner),second.refreshIfDue(owner)]);
  // Wait for the async synthetic provider to start without unbounded sleeps.
  for(let i=0;i<100&&!releasePoll;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(polls,1);assert.ok(releasePoll);
  await admin.query('UPDATE yolink_connections SET enabled=false WHERE id=$1',[id]);
  releasePoll({devices:[],fetchedAt:new Date().toISOString(),limited:false});
  await Promise.all([first.waitForRefreshes(),second.waitForRefreshes()]);
  assert.equal((await admin.query('SELECT * FROM dashboard_snapshots')).rowCount,0);
  assert.ok(events.includes('refresh_discarded'));
  // Successful refresh persists under the restricted role and remains invisible to another owner.
  await admin.query("UPDATE yolink_connections SET enabled=true,last_attempt_at=now()-interval '6 minutes' WHERE id=$1",[id]);
  releasePoll=null;await first.refreshIfDue(owner);
  for(let i=0;i<100&&!releasePoll;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(releasePoll);releasePoll({devices:[{id:'synthetic-device',stateAvailable:true}],fetchedAt:new Date().toISOString(),limited:false});
  await first.waitForRefreshes();assert.equal((await first.snapshot(owner)).homes[0].devices.length,1);
  assert.deepEqual((await second.snapshot(outsider)).homes,[]);
  assert.ok(events.includes('refresh_succeeded'));
  // A failed provider fetch preserves a previous alert; a Home-ID mismatch clears it.
  for(const mismatch of [false,true]){
    await admin.query("UPDATE yolink_connections SET last_attempt_at=now()-interval '6 minutes' WHERE id=$1",[id]);
    releasePoll=null;await first.refreshIfDue(owner);
    for(let i=0;i<100&&!releasePoll;i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(releasePoll);rejectPoll(new Error(mismatch?'home ID does not match':'private provider error'));
    await first.waitForRefreshes();
    const view=await first.snapshot(owner);
    assert.equal(view.homes[0].devices.length,mismatch?0:1);
    assert.equal(view.homes[0].error,mismatch?'Home connection mismatch':'Refresh failed');
    assert.ok(!JSON.stringify(view).includes('private provider error'));
  }
  // Credential replacement while polling rejects stale results, even when still enabled.
  await admin.query("UPDATE yolink_connections SET last_attempt_at=now()-interval '6 minutes' WHERE id=$1",[id]);
  releasePoll=null;await first.refreshIfDue(owner);
  for(let i=0;i<100&&!releasePoll;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(releasePoll);
  await admin.query("UPDATE yolink_connections SET credential_tag=$2 WHERE id=$1",[id,Buffer.alloc(16,9)]);
  releasePoll({devices:[{id:'stale-result'}],fetchedAt:new Date().toISOString(),limited:false});
  await first.waitForRefreshes();assert.equal((await first.snapshot(owner)).homes[0].devices.length,0);
  // Changing the verified Home while an old fetch is running also invalidates its result.
  await admin.query("UPDATE yolink_connections SET credential_tag=$2,last_attempt_at=now()-interval '6 minutes' WHERE id=$1",[id,cipher.credential_tag]);
  releasePoll=null;await first.refreshIfDue(owner);
  for(let i=0;i<100&&!releasePoll;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(releasePoll);await admin.query("UPDATE yolink_connections SET expected_home_id='changed-home' WHERE id=$1",[id]);
  releasePoll({devices:[{id:'old-home-result'}],fetchedAt:new Date().toISOString(),limited:false});
  await first.waitForRefreshes();assert.equal((await first.snapshot(owner)).homes[0].devices.length,0);
  const restricted=new pg.Pool({connectionString:parsed.href,max:1});
  try {assert.equal((await restricted.query('SELECT * FROM dashboard_sessions')).rowCount,0)}finally{await restricted.end()}
 }finally{if(first)await first.close();if(second)await second.close();await admin.end()}
});

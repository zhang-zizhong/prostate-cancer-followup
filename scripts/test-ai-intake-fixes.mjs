import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3131;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = await mkdtemp(path.join(tmpdir(), 'pcd-ai-fix-'));

let child = null;
let logs = '';
async function start() {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT), DATA_DIR: TMP, UPLOAD_DIR: path.join(TMP, 'uploads'),
    DB_FILE: path.join(TMP, 'clinical.db'),
    JWT_SECRET: 'x'.repeat(64),
    INIT_ADMIN_USER: 'testadmin', INIT_ADMIN_PASS: 'test-password-123',
    DASHSCOPE_API_KEY: '', AI_INTAKE_ENABLED: 'true'
  });
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'testadmin',password:'test-password-123'}) });
      if (r.ok) return (await r.json()).token;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start\n' + logs);
}
async function stop() {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));
  child = null;
}
function call(token, p, opts={}) {
  return fetch(BASE + p, Object.assign({}, opts, { headers: Object.assign({ Authorization:'Bearer '+token, 'Content-Type':'application/json' }, opts.headers||{}) }))
    .then(async r => { const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } if (!r.ok) throw new Error(p+' '+r.status+' '+JSON.stringify(d)); return d; });
}
try {
  let token = await start();
  const p = await call(token, '/api/patients', { method:'POST', body: JSON.stringify({ name:'离线结构化测试', birth:'1950-01-01', date:'2024-01-01', psa:12.3, psaDate:'2024-01-01' }) });
  assert.equal(p.castration, null);
  assert.equal(p.metCount, null);
  assert.equal(p.metExtraPelvis, null);
  assert.equal(p.visceralMet, null);
  const med = await call(token, `/api/patients/${p.id}/medications`, { method:'POST', body: JSON.stringify({ category:'adt', drug:'戈舍瑞林', startDate:'2024-03-01', dose:'3.6mg', schedule:'q4w', notes:'' }) });
  assert.equal(med.medications[0].dose, '3.6mg');
  assert.equal(med.medications[0].schedule, 'q4w');
  const op = await call(token, `/api/patients/${p.id}`, { method:'PUT', body: JSON.stringify({ oligoType:'oligo_sync' }) });
  assert.equal(op.oligoType, 'oligo_sync');
  await assert.rejects(call(token, `/api/patients/${p.id}`, { method:'PUT', body: JSON.stringify({ oligoType:'同时性寡转移/低瘤负荷' }) }));

  const fd = new FormData(); fd.append('patientId', p.id); fd.append('docType', 'progress'); fd.append('text', '离线结构化演示');
  const cr = await fetch(BASE + '/api/ai-intake/sessions', { method:'POST', headers:{ Authorization:'Bearer '+token }, body:fd });
  const created = await cr.json();
  assert.ok(cr.ok, JSON.stringify(created));
  let s;
  for (let i=0;i<100;i++) { await new Promise(r=>setTimeout(r,100)); s = await call(token, '/api/ai-intake/sessions/'+created.sessionId); if (s.status==='pending') break; if (s.status==='failed') throw new Error('AI failed: '+JSON.stringify(s)); }
  assert.equal(s.status, 'pending');
  const result = await call(token, '/api/ai-intake/sessions/'+created.sessionId+'/result');
  assert.ok(result.offline, 'must be offline mock');
  assert.equal(result.modelUsed, 'offline-mock');
  assert.ok(result.items.some(x => x.duplicateOf), 'offline mock should expose duplicate items');
  const decisions = result.items.filter(x => x.risk !== 'danger').map(x => ({ itemId:x.id, decision:'adopt' }));
  const adopted = await call(token, '/api/ai-intake/sessions/'+created.sessionId+'/adopt', { method:'POST', body: JSON.stringify({decisions}) });
  assert.ok(adopted.adopted >= 1, JSON.stringify(adopted));
  assert.ok((adopted.skipped || []).some(x => /重复/.test(x.reason || '')), 'duplicate items should be skipped by default');
  const after = await call(token, '/api/patients/'+p.id);
  assert.equal(after.treatment, '根治性手术');
  assert.equal(after.surgDate, '2024-05-06');
  assert.equal(after.rtEndDate, '2024-07-15');
  assert.equal(after.metCount, 2);
  assert.equal(after.metExtraPelvis, false);
  assert.equal(after.visceralMet, null, 'bone-only imaging must not fabricate visceral negative');
  assert.equal(after.gleason, '4+3=7');
  assert.equal(after.pathologicStage, 'pT3aN0M0');
  assert.equal(after.pathologyReports.length, 2);
  assert.equal(after.imagingStudies.length, 1);
  assert.equal(after.radiationRecords.length, 1);
  assert.equal(after.outcomes.length, 1);
  assert.equal(after.medications.find(x=>x.drug==='戈舍瑞林').dose, '3.6mg');
  assert.equal(after.medications.find(x=>x.drug==='戈舍瑞林').schedule, 'q4w');
  assert.equal(after.labValues.length, 1);
  assert.equal(after.labValues[0].itemCode, 'CREAT');
  assert.equal(after.labValues[0].value, 89.3);
  assert.ok(after.clinicalRecords.some(x => x.item === 'DEXA_T' && x.category === 'bone' && Number(x.val) === -2.1));
  assert.equal(after.treatmentLines.length, 1);
  assert.ok(after.events.some(e => e.type === '化验/监测' && /\[结构化化验\]/.test(e.notes || '')));
  assert.ok(!after.events.some(e => e.type === 'ADT启动'), 'duplicate ADT event should not be written');
  assert.ok(after.events.some(e => e.structured && e.structured.kind === 'pathology'));
  assert.ok(after.events.some(e => e.structured && e.structured.kind === 'imaging'));
  assert.ok(after.events.some(e => e.structured && e.structured.kind === 'radiation'));
  assert.ok(after.events.some(e => e.structured && e.structured.kind === 'outcome'));

  // tri-state migration: write 0s, remove marker (simulate legacy DB), restart, expect NULL
  await call(token, `/api/patients/${p.id}`, { method:'PUT', body: JSON.stringify({ castration:0, metCount:0, metExtraPelvis:0, visceralMet:0 }) });
  const raw = new Database(path.join(TMP, 'clinical.db'));
  raw.prepare("DELETE FROM meta WHERE key='tri_state_0_to_null_v1'").run();
  raw.close();
  await stop();
  token = await start();
  const migrated = await call(token, '/api/patients/'+p.id);
  assert.equal(migrated.castration, null);
  assert.equal(migrated.metCount, null);
  assert.equal(migrated.metExtraPelvis, null);
  assert.equal(migrated.visceralMet, null);
  // marker is set now: an explicit 0 after migration must survive a restart
  await call(token, `/api/patients/${p.id}`, { method:'PUT', body: JSON.stringify({ castration:0 }) });
  await stop();
  token = await start();
  const kept = await call(token, '/api/patients/'+p.id);
  assert.equal(kept.castration, false, 'explicit 0 must survive restart after one-time migration');
  console.log('✅ AI P0/P1 integration verification passed');
} finally {
  await stop();
  await rm(TMP, { recursive:true, force:true });
}

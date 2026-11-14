/* AI新增患者（无 patientId 会话 → 采纳时建档）集成验证。
   与 test-ai-intake-fixes.mjs 同一套临时环境方式：独立端口 + 临时数据库，
   离线演练模式，不发任何网络请求、不触碰真实数据。 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3132;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = await mkdtemp(path.join(tmpdir(), 'pcd-ai-new-'));

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
      const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'testadmin', password: 'test-password-123' }) });
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
function call(token, p, opts = {}) {
  return fetch(BASE + p, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {}) }))
    .then(async r => { const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } if (!r.ok) { const e = new Error(p + ' ' + r.status + ' ' + JSON.stringify(d)); e.status = r.status; e.data = d; throw e; } return d; });
}
async function newSession(token, fields) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const d = await r.json();
  assert.ok(r.ok, JSON.stringify(d));
  return d.sessionId;
}
async function waitPending(token, sid) {
  let s;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    s = await call(token, '/api/ai-intake/sessions/' + sid);
    if (s.status === 'pending') return s;
    if (s.status === 'failed') throw new Error('AI failed: ' + JSON.stringify(s));
  }
  throw new Error('session never became pending');
}
const pick = (items, kind, field) => items.find(x => x.kind === kind && (field === undefined || (x.field || (x.payload && x.payload.field)) === field));

try {
  const token = await start();

  /* 1. 无 patientId、无姓名、无图片、只有文本 → 400 */
  const fdBad = new FormData(); fdBad.append('text', '只有文字没有姓名');
  const rBad = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fdBad });
  assert.equal(rBad.status, 400);

  /* 2. 新建会话：newPatientName + 文本，离线演练 */
  const sid = await newSession(token, { newPatientName: 'AI新建测试', docType: 'mixed', text: 'AI新增患者集成验证材料' });
  const s = await waitPending(token, sid);
  assert.equal(s.patientId, null);
  assert.equal(s.newPatientName, 'AI新建测试');
  const result = await call(token, '/api/ai-intake/sessions/' + sid + '/result');
  assert.ok(result.offline, 'must be offline mock');
  assert.equal(result.patientId, null);

  /* 3. 缺出生日期 → 拒绝建档，且患者数不变 */
  const before = await call(token, '/api/patients');
  const noBirth = [
    { itemId: pick(result.items, 'profile', 'name').id, decision: 'adopt' },
    { itemId: pick(result.items, 'profile', 'date').id, decision: 'adopt' },
    { itemId: pick(result.items, 'psa').id, decision: 'adopt' }
  ];
  await assert.rejects(
    call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: noBirth }) }),
    /出生日期/);
  const mid = await call(token, '/api/patients');
  assert.equal(mid.length, before.length, '缺项拒绝后不得产生患者');
  const still = await call(token, '/api/ai-intake/sessions/' + sid);
  assert.equal(still.status, 'pending', '拒绝建档后会话应仍可审核');

  /* 4. 四项齐全 → 建档成功，会话回写 patient_id */
  const four = [
    { itemId: pick(result.items, 'profile', 'name').id, decision: 'adopt' },
    { itemId: pick(result.items, 'profile', 'birth').id, decision: 'adopt' },
    { itemId: pick(result.items, 'profile', 'date').id, decision: 'adopt' },
    { itemId: pick(result.items, 'psa').id, decision: 'adopt' }
  ];
  const adopted = await call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: four }) });
  assert.ok(adopted.patientId, '应返回新患者 id');
  assert.ok(adopted.patient && adopted.patient.name === 'AI新建测试');
  const p = await call(token, '/api/patients/' + adopted.patientId);
  assert.equal(p.name, 'AI新建测试');
  assert.equal(p.birth, '1958-06-15');
  assert.ok(p.psa.length >= 1, '初始 PSA 应已写入');
  const after = await call(token, '/api/ai-intake/sessions/' + sid);
  assert.equal(after.patientId, adopted.patientId, '会话应回写新患者 id');
  const hist = await call(token, '/api/ai-intake/sessions?patientId=' + adopted.patientId);
  assert.ok(hist.some(x => x.id === sid), '新患者的历史列表应能看到该会话');

  /* 5. 同名同生日 → 拦截并提示选择已有患者 */
  const sid2 = await newSession(token, { newPatientName: 'AI新建测试', docType: 'mixed', text: '重复建档验证' });
  await waitPending(token, sid2);
  const result2 = await call(token, '/api/ai-intake/sessions/' + sid2 + '/result');
  const dup = [
    { itemId: pick(result2.items, 'profile', 'name').id, decision: 'adopt' },
    { itemId: pick(result2.items, 'profile', 'birth').id, decision: 'adopt' },
    { itemId: pick(result2.items, 'profile', 'date').id, decision: 'adopt' },
    { itemId: pick(result2.items, 'psa').id, decision: 'adopt' }
  ];
  await assert.rejects(
    call(token, '/api/ai-intake/sessions/' + sid2 + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: dup }) }),
    /同名同生日/);

  /* 6. 医生改名后采纳 → 正常建档（姓名以医生采纳值为准） */
  const sid3 = await newSession(token, { newPatientName: 'AI新建测试', docType: 'mixed', text: '改名验证' });
  await waitPending(token, sid3);
  const result3 = await call(token, '/api/ai-intake/sessions/' + sid3 + '/result');
  const renamed = [
    { itemId: pick(result3.items, 'profile', 'name').id, decision: 'adopt', value: { value: 'AI新建改名' } },
    { itemId: pick(result3.items, 'profile', 'birth').id, decision: 'adopt' },
    { itemId: pick(result3.items, 'profile', 'date').id, decision: 'adopt' },
    { itemId: pick(result3.items, 'psa').id, decision: 'adopt' }
  ];
  const adopted3 = await call(token, '/api/ai-intake/sessions/' + sid3 + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: renamed }) });
  const p3 = await call(token, '/api/patients/' + adopted3.patientId);
  assert.equal(p3.name, 'AI新建改名');

  console.log('✅ AI新增患者 integration verification passed');
} finally {
  await stop();
  await rm(TMP, { recursive: true, force: true });
}
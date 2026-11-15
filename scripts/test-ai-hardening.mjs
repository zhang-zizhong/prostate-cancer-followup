/* AI 登记加固修复回归测试（2026-11-15 问题清单）。
   隔离临时库 + 本地桩模型（非离线，可采纳），逐条验证：
   H1 离线禁采纳 / H2 改值重校验 / H3 睾酮单位 / M2 回写会话归属 /
   M4 截断禁采纳 / M6 上传白名单+嗅探 / M7 重试 / L1 上传错误友好 /
   L2 超长截断警告 / L4 reject 状态 / H4 删患者级联 / M3 备份往返 / M1 脱敏开关。 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3137, STUB = 3138;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = await mkdtemp(path.join(tmpdir(), 'pcd-hard-'));

/* 1x1 透明 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/* 桩模型：按 currentContent 返回抽取 JSON；可注入 finish_reason */
let currentContent = '{}';
let currentFinish = 'stop';
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: currentContent }, finish_reason: currentFinish }], usage: { prompt_tokens: 10, completion_tokens: 10 }, model: 'stub-model' }));
  });
});

let child = null, logs = '';
function startServer(extraEnv) {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT), DATA_DIR: TMP, UPLOAD_DIR: path.join(TMP, 'uploads'),
    DB_FILE: path.join(TMP, 'clinical.db'), JWT_SECRET: 'x'.repeat(64),
    INIT_ADMIN_USER: 'testadmin', INIT_ADMIN_PASS: 'test-password-123',
    DASHSCOPE_API_KEY: 'stub-key', DASHSCOPE_BASE_URL: 'http://127.0.0.1:' + STUB,
    AI_MODEL_EXTRACT: 'stub-model', AI_INTAKE_ENABLED: 'true', AI_REDACT_ENABLED: 'false'
  }, extraEnv || {});
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
}
async function waitLogin() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'testadmin', password: 'test-password-123' }) });
      if (r.ok) return (await r.json()).token;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server 未启动\n' + logs.slice(-1500));
}
async function stopServer() { if (child) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); child = null; } }
function call(token, p, opts = {}) {
  return fetch(BASE + p, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {}) }))
    .then(async r => { const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } if (!r.ok) { const e = new Error(p + ' ' + r.status + ' ' + JSON.stringify(d)); e.status = r.status; e.data = d; throw e; } return d; });
}
async function mkPatient(token, name) {
  return call(token, '/api/patients', { method: 'POST', body: JSON.stringify({ name, birth: '1955-01-01', date: '2024-01-01', psa: 4.0, psaDate: '2024-01-01' }) });
}
async function mkSession(token, pid, content, finish) {
  currentContent = JSON.stringify(content); currentFinish = finish || 'stop';
  const fd = new FormData(); fd.append('patientId', pid); fd.append('docType', 'progress'); fd.append('text', '回归测试材料');
  const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const d = await r.json(); assert.ok(r.ok, JSON.stringify(d));
  let s;
  for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 150)); s = await call(token, '/api/ai-intake/sessions/' + d.sessionId); if (s.status === 'pending' || s.status === 'failed') break; }
  return { sid: d.sessionId, s };
}
const results = [];
function check(name, fn) { return fn().then(() => { results.push('✅ ' + name); }).catch(e => { results.push('❌ ' + name + ' → ' + (e.message || e)); }); }

await new Promise(r => stub.listen(STUB, '127.0.0.1', r));
try {
  startServer();
  const token = await waitLogin();
  const db = new Database(path.join(TMP, 'clinical.db'));

  /* H3 睾酮单位 */
  await check('H3 睾酮 nmol/l 小写正确换算', async () => {
    const p = await mkPatient(token, '睾酮小写');
    const { sid, s } = await mkSession(token, p.id, { items: [{ kind: 'testosterone', payload: { date: '2025-06-01', value: 0.62, unit: 'nmol/l' }, evidence: '总睾酮 0.62 nmol/l' }] });
    assert.equal(s.status, 'pending');
    const r = await call(token, '/api/ai-intake/sessions/' + sid + '/result');
    const it = r.items.find(x => x.kind === 'testosterone');
    await call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: it.id, decision: 'adopt' }] }) });
    const rec = db.prepare('SELECT value,unit,entered_value FROM testosterone_records WHERE patient_id=?').get(p.id);
    assert.equal(rec.unit, 'nmol/L');
    assert.ok(Math.abs(rec.value - 17.88) < 0.1, '换算值应≈17.88，实际 ' + rec.value);
    assert.equal(rec.entered_value, 0.62);
  });
  await check('H3 睾酮非法单位改值被拒', async () => {
    const p = await mkPatient(token, '睾酮非法单位');
    const { sid } = await mkSession(token, p.id, { items: [{ kind: 'testosterone', payload: { date: '2025-06-01', value: 0.62, unit: 'nmol/L' }, evidence: '总睾酮 0.62 nmol/L' }] });
    const r = await call(token, '/api/ai-intake/sessions/' + sid + '/result');
    const it = r.items.find(x => x.kind === 'testosterone');
    await assert.rejects(
      call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: it.id, decision: 'adopt', value: { unit: '随便' } }] }) }),
      e => /单位/.test(JSON.stringify(e.data || e.message)));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM testosterone_records WHERE patient_id=?').get(p.id).n, 0);
  });

  /* H2 改值重校验 */
  await check('H2 给药记录非法日期改值被拒', async () => {
    const p = await mkPatient(token, '改值非法日期');
    const { sid } = await mkSession(token, p.id, { items: [{ kind: 'administration', payload: { adminDate: '2025-06-01', drug: '戈舍瑞林', dose: '3.6mg' }, evidence: '戈舍瑞林 3.6mg' }] });
    const r = await call(token, '/api/ai-intake/sessions/' + sid + '/result');
    const it = r.items.find(x => x.kind === 'administration');
    await assert.rejects(
      call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: it.id, decision: 'adopt', value: { adminDate: '2025-13-99' } }] }) }),
      e => /日期/.test(JSON.stringify(e.data || e.message)));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM medication_administrations WHERE patient_id=?').get(p.id).n, 0);
  });
  await check('H2 疾病分类非法枚举改值被拒', async () => {
    const p = await mkPatient(token, '改值疾病分类');
    const { sid } = await mkSession(token, p.id, { items: [{ kind: 'profile', field: 'diseaseCategory', value: 'mHSPC', evidence: 'mHSPC' }] });
    const r = await call(token, '/api/ai-intake/sessions/' + sid + '/result');
    const it = r.items.find(x => x.kind === 'profile' && (x.field === 'diseaseCategory'));
    const out = await call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: it.id, decision: 'adopt', value: { value: '随便阶段' } }] }) });
    assert.ok((out.skipped || []).some(e => /疾病阶段/.test(e.reason)), JSON.stringify(out));
    assert.ok(!db.prepare('SELECT disease_category FROM patients WHERE id=?').get(p.id).disease_category, '非法疾病分类不应写入');
  });

  /* M2 回写会话归属 */
  await check('M2 跨会话回写不篡改他人条目', async () => {
    const p = await mkPatient(token, '回写归属');
    const a = await mkSession(token, p.id, { items: [{ kind: 'psa', payload: { date: '2025-06-01', value: 5.0 }, evidence: 'PSA 5.0' }] });
    const b = await mkSession(token, p.id, { items: [{ kind: 'psa', payload: { date: '2025-07-01', value: 6.0 }, evidence: 'PSA 6.0' }] });
    const ra = await call(token, '/api/ai-intake/sessions/' + a.sid + '/result');
    const rb = await call(token, '/api/ai-intake/sessions/' + b.sid + '/result');
    const itemA = ra.items.find(x => x.kind === 'psa');
    const itemB = rb.items.find(x => x.kind === 'psa');
    /* 采纳 B，但 decisions 里夹带 A 的 itemId 试图篡改 */
    await call(token, '/api/ai-intake/sessions/' + b.sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: itemB.id, decision: 'adopt' }, { itemId: itemA.id, decision: 'reject' }] }) });
    const decA = db.prepare('SELECT decision FROM ai_intake_items WHERE id=?').get(itemA.id).decision;
    assert.equal(decA, 'pending', 'A 会话条目不应被 B 的采纳请求篡改');
  });

  /* M4 截断禁采纳 */
  await check('M4 截断输出禁止采纳', async () => {
    const p = await mkPatient(token, '截断');
    const { sid } = await mkSession(token, p.id, { items: [{ kind: 'psa', payload: { date: '2025-06-01', value: 5.0 }, evidence: 'PSA 5.0' }] }, 'length');
    const r = await call(token, '/api/ai-intake/sessions/' + sid + '/result');
    const it = r.items.find(x => x.kind === 'psa');
    await assert.rejects(call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: it.id, decision: 'adopt' }] }) }), /截断/);
  });

  /* L4 reject 状态 */
  await check('L4 已采纳会话不能再拒绝', async () => {
    const p = await mkPatient(token, '拒绝状态');
    const { sid } = await mkSession(token, p.id, { items: [{ kind: 'psa', payload: { date: '2025-06-01', value: 5.0 }, evidence: 'PSA 5.0' }] });
    const r = await call(token, '/api/ai-intake/sessions/' + sid + '/result');
    const it = r.items.find(x => x.kind === 'psa');
    await call(token, '/api/ai-intake/sessions/' + sid + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: it.id, decision: 'adopt' }] }) });
    await assert.rejects(call(token, '/api/ai-intake/sessions/' + sid + '/reject', { method: 'POST', body: JSON.stringify({ reason: 'x' }) }), /已采纳/);
  });

  /* M6 上传白名单 + 嗅探 */
  await check('M6 SVG 被拒（400）', async () => {
    const p = await mkPatient(token, 'SVG');
    const fd = new FormData(); fd.append('patientId', p.id); fd.append('files', new Blob([SVG], { type: 'image/svg+xml' }), 'x.svg');
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    assert.equal(r.status, 400);
  });
  await check('M6 伪装 mime 的文本被嗅探拒绝', async () => {
    const p = await mkPatient(token, '伪装');
    const fd = new FormData(); fd.append('patientId', p.id); fd.append('files', new Blob([Buffer.from('this is plain text not an image')], { type: 'image/png' }), 'fake.png');
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    assert.equal(r.status, 400);
  });
  await check('M6 合法 PNG 可上传', async () => {
    const p = await mkPatient(token, '合法图');
    const fd = new FormData(); fd.append('patientId', p.id); fd.append('files', new Blob([PNG], { type: 'image/png' }), 'ok.png');
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    assert.equal(r.status, 202);
  });

  /* L1 + 自动分批：9 张（>单批8）不再报错，自动分批识别成功 */
  await check('自动分批 9 张图识别成功并合并', async () => {
    const p = await mkPatient(token, '分批9张');
    currentContent = JSON.stringify({ items: [{ kind: 'psa', payload: { date: '2025-06-01', value: 5.0 }, evidence: 'PSA 5.0', page: 1 }] }); currentFinish = 'stop';
    const fd = new FormData(); fd.append('patientId', p.id);
    for (let i = 0; i < 9; i++) { fd.append('files', new Blob([PNG], { type: 'image/png' }), 'p' + i + '.png'); fd.append('w' + i, '100'); fd.append('h' + i, '100'); }
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const d = await r.json(); assert.ok(r.ok, JSON.stringify(d));
    let s;
    for (let i = 0; i < 160; i++) { await new Promise(r => setTimeout(r, 150)); s = await call(token, '/api/ai-intake/sessions/' + d.sessionId); if (s.status === 'pending' || s.status === 'failed') break; }
    assert.equal(s.status, 'pending', '9 张应自动分批成功：' + JSON.stringify(s));
    assert.ok((s.warnings || []).some(w => /自动分 2 批/.test(w)), '应有分批提示：' + JSON.stringify(s.warnings));
    const res = await call(token, '/api/ai-intake/sessions/' + d.sessionId + '/result');
    /* 两批各返回 1 条 PSA，合并后应有 2 条（跨批重复由去重标注，但都在 items 里） */
    assert.ok(res.items.filter(x => x.kind === 'psa').length >= 2, '两批结果应合并：' + res.items.length);
  });
  /* L1：超过会话总量 32 张才返回友好 400 */
  await check('L1 超过会话总量返回 400 而非 500', async () => {
    const p = await mkPatient(token, '超总量');
    const fd = new FormData(); fd.append('patientId', p.id);
    for (let i = 0; i < 33; i++) fd.append('files', new Blob([PNG], { type: 'image/png' }), 'p' + i + '.png');
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    assert.equal(r.status, 400);
    const d = await r.json(); assert.ok(/最多/.test(d.error), JSON.stringify(d));
  });

  /* L2 超长文本截断警告 */
  await check('L2 超长文本截断有警告', async () => {
    const p = await mkPatient(token, '超长');
    currentContent = JSON.stringify({ items: [] }); currentFinish = 'stop';
    /* 150001 字符：超过截断阈值(按 token 预算反推)但预估 token 仍在预算内，
       确保走到截断分支而非被 M5 提前拦截 */
    const fd = new FormData(); fd.append('patientId', p.id); fd.append('text', 'a'.repeat(150001));
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const d = await r.json(); assert.ok(r.ok, JSON.stringify(d));
    let s;
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 150)); s = await call(token, '/api/ai-intake/sessions/' + d.sessionId); if (s.status === 'pending' || s.status === 'failed') break; }
    assert.ok((s.warnings || []).some(w => /截断/.test(w)), JSON.stringify(s.warnings));
  });

  /* M7 重试 */
  await check('M7 失败会话可重试', async () => {
    const p = await mkPatient(token, '重试');
    /* 用空模型输出造一个 failed：桩返回非法 JSON */
    currentContent = '这不是JSON'; currentFinish = 'stop';
    const fd = new FormData(); fd.append('patientId', p.id); fd.append('text', '重试材料');
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const d = await r.json();
    let s;
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 150)); s = await call(token, '/api/ai-intake/sessions/' + d.sessionId); if (s.status === 'failed' || s.status === 'pending') break; }
    assert.equal(s.status, 'failed');
    currentContent = JSON.stringify({ items: [{ kind: 'psa', payload: { date: '2025-06-01', value: 5.0 }, evidence: 'PSA 5.0' }] });
    const rt = await call(token, '/api/ai-intake/sessions/' + d.sessionId + '/retry', { method: 'POST' });
    assert.equal(rt.status, 'queued');
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 150)); s = await call(token, '/api/ai-intake/sessions/' + d.sessionId); if (s.status === 'pending' || s.status === 'failed') break; }
    assert.equal(s.status, 'pending');
  });

  /* M3 备份往返 */
  await check('M3 备份含 AI 数据且可往返', async () => {
    const backup = await call(token, '/api/backup/export');
    assert.equal(backup.version, 14);
    assert.ok(backup.aiIntake.sessions.length > 0);
    const sessCount = backup.aiIntake.sessions.length;
    await call(token, '/api/backup/import', { method: 'POST', body: JSON.stringify({ data: backup, mode: 'overwrite' }) });
    const after = await call(token, '/api/backup/export');
    assert.equal(after.aiIntake.sessions.length, sessCount);
  });

  /* H4 删患者级联 */
  await check('H4 删患者清理 AI 三表与文本', async () => {
    const p = await mkPatient(token, '级联删除');
    const { sid } = await mkSession(token, p.id, { items: [{ kind: 'psa', payload: { date: '2025-06-01', value: 5.0 }, evidence: 'PSA 5.0' }] });
    assert.ok(db.prepare('SELECT COUNT(*) n FROM ai_intake_sessions WHERE patient_id=?').get(p.id).n > 0);
    await call(token, '/api/patients/' + p.id, { method: 'DELETE' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_intake_sessions WHERE patient_id=?').get(p.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_intake_items WHERE session_id=?').get(sid).n, 0);
    const fs = await import('node:fs');
    assert.ok(!fs.existsSync(path.join(TMP, 'uploads', 'ai-intake', sid + '.txt')), '文本材料应被清理');
  });

  /* M1 脱敏开关 */
  await check('M1 状态接口暴露脱敏开关', async () => {
    const st = await call(token, '/api/ai-intake/status');
    assert.equal(st.redactEnabled, false);
  });

  db.close();
  await stopServer();

  /* H1 离线禁采纳：单独起一个无 Key 的服务 */
  await check('H1 离线演练禁止采纳', async () => {
    startServer({ DASHSCOPE_API_KEY: '', DASHSCOPE_BASE_URL: '', AI_ALLOW_OFFLINE_ADOPT: '' });
    const tk = await waitLogin();
    const p = await mkPatient(tk, '离线禁采纳');
    const fd = new FormData(); fd.append('patientId', p.id); fd.append('text', '离线材料');
    const r = await fetch(BASE + '/api/ai-intake/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: fd });
    const d = await r.json();
    let s;
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 150)); s = await call(tk, '/api/ai-intake/sessions/' + d.sessionId); if (s.status === 'pending' || s.status === 'failed') break; }
    assert.equal(s.status, 'pending');
    const res = await call(tk, '/api/ai-intake/sessions/' + d.sessionId + '/result');
    assert.ok(res.offline);
    const it = res.items.find(x => x.risk !== 'danger');
    await assert.rejects(call(tk, '/api/ai-intake/sessions/' + d.sessionId + '/adopt', { method: 'POST', body: JSON.stringify({ decisions: [{ itemId: it.id, decision: 'adopt' }] }) }), /离线演练/);
    await stopServer();
  });
} finally {
  await stopServer();
  stub.close();
  await rm(TMP, { recursive: true, force: true });
}

console.log('\n==== 加固回归结果 ====');
results.forEach(r => console.log(r));
const failed = results.filter(r => r.startsWith('❌'));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) process.exit(1);
console.log('✅ AI 登记加固回归全部通过');
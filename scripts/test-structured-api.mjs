/* =========================================================
 * 结构化专病数据 API 集成测试（独立脚本，不依赖 node:test）
 * 启动临时 server + 临时 SQLite，验证事件/科研/备份往返。
 * 运行：node scripts/test-structured-api.mjs
 * ========================================================= */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 3127;
const BASE = 'http://127.0.0.1:' + PORT;

async function waitForServer(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testadmin', password: 'test-password-123' })
      });
      if (r.status === 200) return await r.json();
    } catch (e) { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'pcd-api-'));
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR: tmp,
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    DB_FILE: path.join(tmp, 'clinical.db'),
    JWT_SECRET: 'x'.repeat(64),
    INIT_ADMIN_USER: 'testadmin',
    INIT_ADMIN_PASS: 'test-password-123'
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });
  child.on('error', e => { logs += '\nSPAWN ERROR: ' + e.message; });

  try {
    const auth = await waitForServer();
    const token = auth.token;
    const call = async (p, opts = {}) => {
      const r = await fetch(BASE + p, Object.assign({}, opts, {
        headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {})
      }));
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + (data && data.error ? data.error : text));
      return data;
    };

    const p = await call('/api/patients', {
      method: 'POST',
      body: JSON.stringify({ name: '结构化测试', birth: '1955-01-01', date: '2024-01-01', psa: 12.3, psaDate: '2024-01-01' })
    });
    const pid = p.id;
    assert.ok(pid);

    const pathEvent = await call('/api/patients/' + pid + '/events', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-01-10', type: '前列腺穿刺活检病理报告', structured: { kind: 'pathology', data: {
        specimenType: 'biopsy', reportDate: '2024-01-10', coresTotal: 12, coresPositive: 5,
        gleasonPrimary: 4, gleasonSecondary: 3, marginStatus: 'unknown', isPrimary: 1
      } } })
    });
    assert.ok(pathEvent.newEventId);

    await call('/api/patients/' + pid + '/events', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-02-01', type: 'PSMA PET-CT', structured: { kind: 'imaging', data: {
        modality: 'PSMA_PET', studyDate: '2024-02-01', lesionCount: 3, metastaticSites: 'bone,lymph_node',
        psmaPositive: 1, psmaSuvmax: 9.2, oligoStatus: 'oligo', isCurrent: 1
      } } })
    });

    /* MRI 三径：4.2×3.8×3.5 → 29.0 ml（服务端重算，前端给的体积一律不信）。
       用独立患者，避免影响上面按 pid 统计的报告条数断言。 */
    const dimsP = await call('/api/patients', {
      method: 'POST',
      body: JSON.stringify({ name: 'API-三径', birth: '1960-06-01', date: '2024-01-01', psa: 12.5, psaDate: '2024-01-01' })
    });
    const mriEv = await call('/api/patients/' + dimsP.id + '/events', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-02-10', type: '多参数磁共振(mpMRI)', guidedBatch: 'testbatch01',
        structured: { kind: 'imaging', data: {
        modality: 'mpMRI', studyDate: '2024-02-10', pirads: 4,
        dimTransverseCm: 4.2, dimApCm: 3.8, dimCranialCm: 3.5, prostateVolumeMl: 999
      } } })
    });
    const dimsDetail = await call('/api/patients/' + dimsP.id);
    const mriRow = dimsDetail.imagingStudies.find(x => x.eventId === mriEv.newEventId);
    assert.equal(mriRow.prostateVolumeMl, 29, '三径自动算体积');
    assert.equal(mriRow.dimTransverseCm, 4.2);
    const badDims = await fetch(BASE + '/api/patients/' + dimsP.id + '/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2024-02-11', type: '多参数磁共振(mpMRI)', structured: { kind: 'imaging', data: {
        modality: 'mpMRI', studyDate: '2024-02-11', dimTransverseCm: 4.2
      } } })
    });
    assert.equal(badDims.status, 400, '三径不齐必须拒绝');
    /* 旧事件名保留为别名：旧备份/旧客户端仍可写结构化病理 */
    const legacyBiopsy = await call('/api/patients/' + dimsP.id + '/events', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-02-12', type: '穿刺病理报告', structured: { kind: 'pathology', data: {
        specimenType: 'biopsy', reportDate: '2024-02-12', coresTotal: 6, coresPositive: 1,
        gleasonPrimary: 3, gleasonSecondary: 3, isPrimary: 0
      } } })
    });
    assert.ok(legacyBiopsy.newEventId, '旧名别名仍可创建病理结构');

    await call('/api/patients/' + pid + '/events', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-03-01', type: '外照射放疗(EBRT)', structured: { kind: 'radiation', data: {
        rtType: 'EBRT', startDate: '2024-03-01', endDate: '2024-04-15', doseGy: 78, fractions: 39,
        target: 'prostate', concurrentAdt: 1, adtDurationMonths: 6, isCurrent: 1
      } } })
    });

    await call('/api/patients/' + pid + '/events', {
      method: 'POST',
      body: JSON.stringify({ date: '2024-06-01', type: '生化复发确认', structured: { kind: 'outcome', data: {
        outcomeType: 'BCR', eventDate: '2024-06-01', subtype: 'recurrence', basis: 'PSA', psaValue: 0.2, imagingNegative: 1
      } } })
    });

    await call('/api/patients/' + pid + '/treatment-lines', {
      method: 'POST',
      body: JSON.stringify({ lineNo: 1, setting: '辅助', regimen: 'ADT+达罗他胺', startDate: '2024-03-01',
        stopReasonCode: 'toxicity', responseCode: 'PSA50', agents: [{ drug: '戈舍瑞林', dose: '3.6mg' }] })
    });

    const spec = await call('/api/patients/' + pid + '/specimens', {
      method: 'POST',
      body: JSON.stringify({ sampleType: 'tissue_RP', collectionDate: '2024-01-20', timepoint: 'postop',
        treatmentStatus: 'naive', storage: 'FFPE', tumorCellPct: 70, biobankId: 'B-API-001' })
    });
    const specId = spec.specimens[0].id;

    await call('/api/patients/' + pid + '/genomic-tests', {
      method: 'POST',
      body: JSON.stringify({ testType: 'germline', testDate: '2024-01-25', specimenId: specId,
        genes: ['BRCA2', 'ATM'], hrrStatus: 'pathogenic', msiStatus: 'MSS', tmbValue: 3.2 })
    });
    await call('/api/patients/' + pid + '/ihc-results', {
      method: 'POST',
      body: JSON.stringify({ marker: 'PTEN', result: 'lost', percent: 0, specimenId: specId, testDate: '2024-01-25' })
    });

    const detail = await call('/api/patients/' + pid);
    assert.equal(detail.pathologyReports.length, 1);
    assert.equal(detail.imagingStudies.length, 1);
    assert.equal(detail.radiationRecords.length, 1);
    assert.equal(detail.outcomes.length, 1);
    assert.equal(detail.specimens.length, 1);
    assert.equal(detail.genomicTests.length, 1);
    assert.equal(detail.ihcResults.length, 1);
    assert.equal(detail.treatmentLines.length, 1);
    assert.equal(detail.pathologyReports[0].gleasonTotal, 7);
    assert.equal(detail.pathologyReports[0].isup, 3);
    assert.equal(detail.gleason, '4+3=7');
    assert.ok(detail.events.some(e => e.structured && e.structured.kind === 'pathology'));

    const list = await call('/api/patients');
    assert.ok(list.length >= 1);
    assert.equal(Object.prototype.hasOwnProperty.call(list[0], 'pathologyReports'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(list[0], 'specimens'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(list[0], 'research'), true);
    const summaryResearch = list[0].research;
    assert.equal(summaryResearch.specimenCount, 1);
    assert.equal(summaryResearch.tissueCount, 1);
    assert.equal(summaryResearch.timepointCount, 1);
    assert.equal(summaryResearch.tumorCellCount, 1);
    assert.equal(summaryResearch.biobankCount, 1);
    assert.equal(summaryResearch.genomicCount, 1);
    assert.equal(summaryResearch.pairedGenomicCount, 1);
    assert.equal(summaryResearch.hrrStatus, 'pathogenic');
    assert.equal(summaryResearch.msiStatus, 'MSS');
    assert.equal(summaryResearch.tmbValue, 3.2);
    assert.equal(summaryResearch.ihcCount, 1);
    assert.equal(summaryResearch.pairedIhcCount, 1);
    assert.equal(summaryResearch.ptenLoss, true);
    assert.equal(summaryResearch.radiationCount, 1);

    const backup = await call('/api/backup/export');
    assert.equal(backup.version, 13);
    assert.ok(backup.patients.every(x => Object.prototype.hasOwnProperty.call(x, 'v13')));
    assert.ok(Array.isArray(backup.files));
    assert.ok(backup.patients.some(x => x.id === pid && x.pathologyReports.length === 1));

    await call('/api/backup/import', { method: 'POST', body: JSON.stringify({ data: backup, mode: 'overwrite' }) });
    const after = await call('/api/patients/' + pid);
    assert.equal(after.pathologyReports.length, 1);
    /* 引导登记批号必须随备份往返（时间轴分组靠它） */
    const dimsAfter = await call('/api/patients/' + dimsP.id);
    const batchEv = dimsAfter.events.find(e => e.type === '多参数磁共振(mpMRI)' && e.guidedBatch);
    assert.equal(batchEv && batchEv.guidedBatch, 'testbatch01', '批号需随备份导入恢复');
    assert.equal(after.imagingStudies.length, 1);
    assert.equal(after.radiationRecords.length, 1);
    assert.equal(after.outcomes.length, 1);
    assert.equal(after.specimens.length, 1);
    assert.equal(after.genomicTests.length, 1);
    assert.equal(after.ihcResults.length, 1);
    assert.equal(after.treatmentLines.length, 1);
    assert.equal(after.pathologyReports[0].eventId, after.events.find(e => e.type === '前列腺穿刺活检病理报告').id);
    assert.equal(after.genomicTests[0].specimenId, after.specimens[0].id);

    const outcome = after.outcomes[0];
    const outcomeEventId = outcome.eventId;
    await call('/api/patients/' + pid + '/outcomes/' + outcome.id, { method: 'DELETE' });
    const cleared = await call('/api/patients/' + pid);
    assert.equal(cleared.outcomes.length, 0);
    assert.equal(cleared.events.some(e => e.id === outcomeEventId), false);
    /* ---- 2026-10-21 修复回归：病理主档来源 / 未来日期 / 死亡守卫 / 重复患者 / 睾酮编辑 ---- */
    const raw = async (path, opts = {}) => {
      const r = await fetch(BASE + path, Object.assign({}, opts, {
        headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {})
      }));
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      return { status: r.status, data };
    };

    const syncP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-病理来源', birth: '1980-01-01', date: '2025-01-01', psa: 8, psaDate: '2024-12-20',
      clinicalStage: 'cT2aN0M0', gleason: '4+3=7', treatment: '根治性手术'
    }) });
    const biopsyEvent = await call('/api/patients/' + syncP.id + '/events', {
      method: 'POST',
      body: JSON.stringify({
        date: '2025-01-05', type: '前列腺穿刺活检病理报告', structured: { kind: 'pathology', data: {
          specimenType: 'biopsy', gleasonPrimary: 3, gleasonSecondary: 3, coresTotal: 12, coresPositive: 10, isPrimary: 1
        } }
      })
    });
    let syncDetail = await call('/api/patients/' + syncP.id);
    assert.equal(syncDetail.gleason, '3+3=6');
    assert.match(syncDetail.gleasonSource, /^pathology:/);
    const rpEvent = await call('/api/patients/' + syncP.id + '/events', {
      method: 'POST',
      body: JSON.stringify({
        date: '2025-02-01', type: '手术病理报告', structured: { kind: 'pathology', data: {
          specimenType: 'RP', gleasonPrimary: 4, gleasonSecondary: 4, ptnm: 'pT3aN0M0', isPrimary: 1
        } }
      })
    });
    syncDetail = await call('/api/patients/' + syncP.id);
    assert.equal(syncDetail.gleason, '3+3=6', 'RP 不能覆盖活检 Gleason');
    assert.equal(syncDetail.pathologicStage, 'pT3aN0M0');
    assert.match(syncDetail.pathologicStageSource, /^pathology:/);
    const backup2 = await call('/api/backup/export');
    const bp = backup2.patients.find(x => x.id === syncP.id);
    assert.match(bp.gleasonSource, /^pathology:/);
    assert.match(bp.pathologicStageSource, /^pathology:/);
    await call('/api/patients/' + syncP.id + '/events/' + rpEvent.newEventId, { method: 'DELETE' });
    syncDetail = await call('/api/patients/' + syncP.id);
    assert.equal(syncDetail.pathologicStage, '');
    assert.equal(syncDetail.gleason, '3+3=6');

    await call('/api/patients/' + syncP.id + '/events', {
      method: 'POST',
      body: JSON.stringify({ date: '2025-03-01', type: 'PSMA PET-CT', structured: { kind: 'imaging', data: {
        modality: 'PSMA_PET', studyDate: '2025-03-01', metastaticSites: '骨,淋巴结', lesionCount: 2, isCurrent: 1
      } } })
    });
    syncDetail = await call('/api/patients/' + syncP.id);
    const img = syncDetail.imagingStudies[syncDetail.imagingStudies.length - 1];
    assert.equal(img.metastaticSites, 'bone,lymph_node');

    const fut = await raw('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-未来诊断', birth: '1980-01-01', date: '2030-01-01', psa: 8, psaDate: '2025-01-01'
    }) });
    assert.equal(fut.status, 400);
    assert.match(fut.data.error, /诊断日期不能晚于今天/);

    const dupBody = JSON.stringify({ name: 'API-重复', birth: '1981-01-01', date: '2025-01-01', psa: 8, psaDate: '2025-01-01' });
    await call('/api/patients', { method: 'POST', body: dupBody });
    const dup = await raw('/api/patients', { method: 'POST', body: dupBody });
    assert.equal(dup.status, 409);
    assert.ok(dup.data.duplicateOf);
    const dupOk = await raw('/api/patients', { method: 'POST', body: JSON.stringify(Object.assign(JSON.parse(dupBody), { confirmDuplicate: true })) });
    assert.equal(dupOk.status, 200);

    const deathP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-死亡守卫', birth: '1940-01-01', date: '2025-01-01', psa: 10, psaDate: '2025-01-01'
    }) });
    const deathNoOutcome = await raw('/api/patients/' + deathP.id, { method: 'PUT', body: JSON.stringify({ followupStatus: '死亡' }) });
    assert.equal(deathNoOutcome.status, 400);
    await call('/api/patients/' + deathP.id + '/events', {
      method: 'POST',
      body: JSON.stringify({
        date: '2025-06-01', type: '终止随访/死亡', structured: { kind: 'outcome', data: {
          outcomeType: 'death', eventDate: '2025-06-01', deathCause: 'unknown'
        } }
      })
    });
    let deathDetail = await call('/api/patients/' + deathP.id);
    assert.equal(deathDetail.followupStatus, '死亡');
    const afterDeath = await raw('/api/patients/' + deathP.id + '/psa', { method: 'POST', body: JSON.stringify({ date: '2025-07-01', val: 5 }) });
    assert.equal(afterDeath.status, 400);
    assert.match(afterDeath.data.error, /死亡日期/);
    assert.doesNotMatch(afterDeath.data.error, /日期日期/);
    const beforeDeath = await raw('/api/patients/' + deathP.id + '/psa', { method: 'POST', body: JSON.stringify({ date: '2025-05-01', val: 5 }) });
    assert.equal(beforeDeath.status, 200);

    const testoP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-睾酮编辑', birth: '1950-01-01', date: '2025-01-01', psa: 10, psaDate: '2025-01-01'
    }) });
    await call('/api/patients/' + testoP.id + '/testo', { method: 'POST', body: JSON.stringify({ date: '2025-02-01', val: 30, unit: 'ng/dl' }) });
    let tDetail = await call('/api/patients/' + testoP.id);
    const trid = tDetail.testo[0].id;
    await call('/api/patients/' + testoP.id + '/testo/' + trid, { method: 'PUT', body: JSON.stringify({ date: '2025-02-02', val: 1.0, unit: 'nmol/L', assayMethod: 'CLIA', lab: '本院' }) });
    tDetail = await call('/api/patients/' + testoP.id);
    assert.equal(tDetail.testo[0].date, '2025-02-02');
    assert.equal(tDetail.testo[0].unit, 'nmol/L');
    assert.ok(Math.abs(tDetail.testo[0].val - 28.84) < 0.01);
    assert.ok(tDetail.events.some(e => e.testoRecordId === trid && e.date === '2025-02-02'));


    /* ---- 2026-10-21 审计 P0/P1 回归 ---- */
    /* P0-01：非主要病理不改主档，删除 primary 后回退手工值 */
    const np = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-非主要病理', birth: '1950-01-01', date: '2025-01-01', psa: 6, psaDate: '2025-01-01',
      clinicalStage: 'cT1cN0M0', gleason: '3+3=6', treatment: '主动监测'
    }) });
    await call('/api/patients/' + np.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-01-05', type: '前列腺穿刺活检病理报告', structured: { kind: 'pathology', data: {
        specimenType: 'biopsy', gleasonPrimary: 3, gleasonSecondary: 3,
        coresTotal: 12, coresPositive: 3, isPrimary: 1
      } }
    }) });
    const secondaryEvent = await call('/api/patients/' + np.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-02-01', type: '前列腺穿刺活检病理报告', structured: { kind: 'pathology', data: {
        specimenType: 'biopsy', gleasonPrimary: 4, gleasonSecondary: 4,
        coresTotal: 12, coresPositive: 5, isPrimary: 0
      } }
    }) });
    let npDetail = await call('/api/patients/' + np.id);
    assert.equal(npDetail.gleason, '3+3=6', '非主要病理不能改写主档 Gleason');
    assert.equal(npDetail.pathologyReports.filter(x => x.isPrimary).length, 1);
    await call('/api/patients/' + np.id + '/events/' + secondaryEvent.newEventId, { method: 'DELETE' });
    npDetail = await call('/api/patients/' + np.id);
    assert.equal(npDetail.gleason, '3+3=6');
    const primaryEvent = npDetail.pathologyReports.find(x => x.isPrimary);
    await call('/api/patients/' + np.id + '/events/' + primaryEvent.eventId, { method: 'DELETE' });
    npDetail = await call('/api/patients/' + np.id);
    assert.equal(npDetail.gleason, '3+3=6', '删除 primary 后应回退手工 Gleason');
    assert.equal(npDetail.gleasonSource, 'manual');

    /* P1-04：事件类型与结局类型必须一致 */
    const outcomeP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-结局错配', birth: '1950-01-01', date: '2025-01-01', psa: 8, psaDate: '2025-01-01'
    }) });
    const mismatch = await raw('/api/patients/' + outcomeP.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-02-01', type: '生化复发确认', structured: { kind: 'outcome', data: {
        outcomeType: 'death', eventDate: '2025-02-01', deathCause: 'unknown'
      } }
    }) });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.data.error, /结局类型必须与事件类型一致/);

    /* P1-05：失访必须有结局 + 末次接触日期；不能只手改状态 */
    const lostP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-失访守卫', birth: '1950-01-01', date: '2025-01-01', psa: 8, psaDate: '2025-01-01'
    }) });
    const statusOnly = await raw('/api/patients/' + lostP.id, { method: 'PUT', body: JSON.stringify({ followupStatus: '失访' }) });
    assert.equal(statusOnly.status, 400);
    assert.match(statusOnly.data.error, /失访确认/);
    const lostNoDate = await raw('/api/patients/' + lostP.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-02-01', type: '失访确认', structured: { kind: 'outcome', data: {
        outcomeType: 'lost', eventDate: '2025-02-01', lostReason: '搬迁'
      } }
    }) });
    assert.equal(lostNoDate.status, 400);
    assert.match(lostNoDate.data.error, /末次接触日期/);
    await call('/api/patients/' + lostP.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-02-01', type: '失访确认', structured: { kind: 'outcome', data: {
        outcomeType: 'lost', eventDate: '2025-02-01', lostReason: '搬迁', lastContactDate: '2025-01-20'
      } }
    }) });
    let lostDetail = await call('/api/patients/' + lostP.id);
    assert.equal(lostDetail.followupStatus, '失访');
    assert.equal(lostDetail.outcomes.find(x => x.outcomeType === 'lost').lastContactDate, '2025-01-20');
    const backToActive = await raw('/api/patients/' + lostP.id, { method: 'PUT', body: JSON.stringify({ followupStatus: '在访' }) });
    assert.equal(backToActive.status, 400);
    const deathAfterLost = await raw('/api/patients/' + lostP.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-03-01', type: '终止随访/死亡', structured: { kind: 'outcome', data: {
        outcomeType: 'death', eventDate: '2025-03-01', deathCause: 'unknown'
      } }
    }) });
    assert.equal(deathAfterLost.status, 400);
    assert.match(deathAfterLost.data.error, /失访结局/);
    const lostOutcome = lostDetail.outcomes.find(x => x.outcomeType === 'lost');
    await call('/api/patients/' + lostP.id + '/outcomes/' + lostOutcome.id, { method: 'DELETE' });
    lostDetail = await call('/api/patients/' + lostP.id);
    assert.equal(lostDetail.followupStatus, '在访');

    /* P1-03：首次影像默认不同步；空字段不能清空档案负荷 */
    const imgP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-影像负荷', birth: '1950-01-01', date: '2025-01-01', psa: 20, psaDate: '2025-01-01',
      stage: 'cT2aN0M1b', metCount: 5, metExtraPelvis: 1, visceralMet: 1, oligoType: 'widespread'
    }) });
    await call('/api/patients/' + imgP.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-02-01', type: 'PSMA PET-CT', structured: { kind: 'imaging', data: {
        modality: 'PSMA_PET', studyDate: '2025-02-01', isCurrent: 1
      } }
    }) });
    const imgDetail = await call('/api/patients/' + imgP.id);
    assert.equal(imgDetail.metCount, 5, '空 lesionCount 不能清空 met_count');
    assert.equal(imgDetail.metExtraPelvis, true);
    assert.equal(imgDetail.visceralMet, true, '空转移部位不能把 visceral 1 改成 0');
    assert.equal(imgDetail.oligoType, 'widespread');

    /* P1-08：早于初始 PSA 的记录允许只改数值，不允许再改日期 */
    const earlyP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-早期PSA', birth: '1950-01-01', date: '2025-01-01', psa: 5, psaDate: '2025-01-01'
    }) });
    await call('/api/patients/' + earlyP.id + '/psa', { method: 'POST', body: JSON.stringify({ date: '2024-12-01', val: 4 }) });
    let earlyDetail = await call('/api/patients/' + earlyP.id);
    const earlyRec = earlyDetail.psa.find(x => x.date === '2024-12-01');
    assert.ok(earlyRec);
    await call('/api/patients/' + earlyP.id + '/psa/' + earlyRec.id, { method: 'PUT', body: JSON.stringify({ val: 4.5 }) });
    earlyDetail = await call('/api/patients/' + earlyP.id);
    assert.equal(earlyDetail.psa.find(x => x.id === earlyRec.id).val, 4.5);
    const moveEarlier = await raw('/api/patients/' + earlyP.id + '/psa/' + earlyRec.id, { method: 'PUT', body: JSON.stringify({ date: '2024-11-01', val: 4.6 }) });
    assert.equal(moveEarlier.status, 400);
    assert.match(moveEarlier.data.error, /早于初始PSA日期/);

    /* P1-11/P1-12：治疗线同步药物 + 结构化化验 + 时间轴投影 */
    const p1 = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-P1治疗化验', birth: '1955-01-01', date: '2025-01-01', psa: 10, psaDate: '2025-01-01'
    }) });
    const lineRes = await call('/api/patients/' + p1.id + '/treatment-lines', { method: 'POST', body: JSON.stringify({
      lineNo: 1, setting: 'mHSPC', regimen: 'ADT+阿比特龙', startDate: '2025-02-01', endDate: null,
      agents: [
        { drug: '戈舍瑞林', dose: '3.6mg', schedule: 'q4w', startDate: '2025-02-01', endDate: null },
        { drug: '阿比特龙', dose: '1000mg', schedule: 'qd', startDate: '2025-02-01', endDate: null }
      ],
      syncMedications: true
    }) });
    assert.equal(lineRes.sync.created, 2);
    const line = lineRes.treatmentLines.find(x => x.lineNo === 1);
    assert.ok(line);
    const linked = lineRes.medications.filter(m => m.lineId === line.id);
    assert.equal(linked.length, 2);
    assert.ok(linked.every(m => m.source === 'line_sync'));
    assert.equal(linked.find(m => m.drug === '戈舍瑞林').dose, '3.6mg');

    let labDetail = await call('/api/patients/' + p1.id + '/lab-values', { method: 'POST', body: JSON.stringify({
      date: '2025-03-01', itemCode: 'CREAT', value: 88.8, unit: 'μmol/L', lab: '本院'
    }) });
    const lab = labDetail.labValues.find(x => x.date === '2025-03-01' && x.itemCode === 'CREAT');
    assert.ok(lab);
    let summary = labDetail.events.find(e => e.date === '2025-03-01' && e.type === '化验/监测');
    assert.ok(summary && /\[结构化化验\]/.test(summary.notes));
    assert.equal(lab.eventId, summary.id);

    labDetail = await call('/api/patients/' + p1.id + '/lab-values/' + lab.id, { method: 'PUT', body: JSON.stringify({
      date: '2025-03-01', itemCode: 'CREAT', value: 91.2, unit: 'μmol/L', lab: '本院'
    }) });
    summary = labDetail.events.find(e => e.date === '2025-03-01' && e.type === '化验/监测');
    assert.match(summary.notes, /91.2/);
    const guarded = await raw('/api/patients/' + p1.id + '/events/' + summary.id, { method: 'PUT', body: JSON.stringify({
      date: summary.date, type: summary.type, notes: '不应允许'
    }) });
    assert.equal(guarded.status, 400);

    labDetail = await call('/api/patients/' + p1.id + '/lab-values/' + lab.id, { method: 'DELETE' });
    assert.equal(labDetail.labValues.some(x => x.id === lab.id), false);
    assert.equal(labDetail.events.some(e => e.date === '2025-03-01' && e.type === '化验/监测'), false);

    /* P2-16：隐藏字段 UI 对应 API 可写、可读 */
    const p2 = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-P2字段', birth: '1950-01-01', date: '2025-01-01', psa: 6, psaDate: '2025-01-01'
    }) });
    let d2 = await call('/api/patients/' + p2.id + '/specimens', { method: 'POST', body: JSON.stringify({
      sampleType: 'tissue_RP', collectionDate: '2025-02-01', timepoint: 'postop',
      treatmentStatus: 'ADT', storage: 'FFPE', tumorCellPct: 70,
      nucleicQuality: 'RIN 7.2 / DV200 78%', libraryId: 'LIB-TEST', biobankId: 'BIO-TEST'
    }) });
    assert.equal(d2.specimens.at(-1).treatmentStatus, 'ADT');
    assert.equal(d2.specimens.at(-1).nucleicQuality, 'RIN 7.2 / DV200 78%');
    assert.equal(d2.specimens.at(-1).libraryId, 'LIB-TEST');

    d2 = await call('/api/patients/' + p2.id + '/genomic-tests', { method: 'POST', body: JSON.stringify({
      testType: 'somatic', testDate: '2025-02-02', platform: 'NGS panel', genes: 'BRCA2',
      hrrStatus: 'pathogenic', msiStatus: 'MSS', tmbValue: 8.2,
      arStatus: 'amplified', tp53Status: 'mutated', ptenStatus: 'loss', rb1Status: 'retained'
    }) });
    const g = d2.genomicTests.at(-1);
    assert.equal(g.platform, 'NGS panel');
    assert.equal(g.arStatus, 'amplified');
    assert.equal(g.tp53Status, 'mutated');
    assert.equal(g.ptenStatus, 'loss');
    assert.equal(g.rb1Status, 'retained');

    d2 = await call('/api/patients/' + p2.id + '/clinical-records', { method: 'POST', body: JSON.stringify({
      category: 'cardio', item: 'SBP', date: '2025-02-04', val: 130, unit: 'mmHg', status: '已完成'
    }) });
    assert.equal(d2.clinicalRecords.at(-1).item, 'BP_SYS');

    d2 = await call('/api/patients/' + p2.id + '/ihc-results', { method: 'POST', body: JSON.stringify({
      marker: 'AR', result: 'positive', percent: 80, intensity: 'strong', testDate: '2025-02-03'
    }) });
    assert.equal(d2.ihcResults.at(-1).intensity, 'strong');

    d2 = await call('/api/patients/' + p2.id + '/treatment-lines', { method: 'POST', body: JSON.stringify({
      lineNo: 1, setting: 'mHSPC', regimen: 'ADT', startDate: '2025-03-01', endDate: '2025-06-01',
      stopReason: '毒性', stopReasonCode: 'toxicity', response: 'PSA50', responseCode: 'PSA50', agents: []
    }) });
    const line2 = d2.treatmentLines.at(-1);
    assert.equal(line2.stopReasonCode, 'toxicity');
    assert.equal(line2.responseCode, 'PSA50');

    await call('/api/patients/' + p2.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-04-01', type: '外照射放疗(EBRT)', structured: { kind: 'radiation', data: {
        rtType: 'EBRT', startDate: '2025-04-01', endDate: '2025-05-01', target: 'prostate',
        isCurrent: 1, notes: 'P2 字段测试'
      } }
    }) });
    d2 = await call('/api/patients/' + p2.id);
    const rt = d2.radiationRecords.at(-1);
    assert.equal(rt.isCurrent, true);
    assert.equal(rt.notes, 'P2 字段测试');


    /* v13：治疗段 -> 就诊（含影像）-> 把既有病理挂到就诊 */
    const ep = await call('/api/patients/' + p2.id + '/episodes', { method: 'POST', body: JSON.stringify({
      episodeType: 'surgery', templateCode: 'RP', intent: 'radical', startDate: '2025-03-01', status: 'completed', label: '测试RP'
    }) });
    const epId = ep.id;
    assert.ok(epId);
    const visit = await call('/api/patients/' + p2.id + '/visits', { method: 'POST', body: JSON.stringify({
      visitDate: '2025-03-02', visitType: 'outpatient', summary: 'v13 就诊测试',
      psa: [{ val: 0.03, belowLod: true, lod: 0.03 }],
      imaging: [{ modality: 'mpMRI', studyDate: '2025-03-02', pirads: 3, lesionCount: 1, notes: 'v13 影像' }],
      episodes: [{ episodeId: epId, overallResponse: 'CR', responseBasis: 'psa',
        adverseEvents: [{ termCode: 'urinary_incontinence', grade: 1, recoveryStatus: 'recovering' }] }]
    }) });
    assert.ok(visit.visitId);
    const afterVisit = await call('/api/patients/' + p2.id);
    const v13Img = afterVisit.imagingStudies.at(-1);
    assert.equal(v13Img.visitId, visit.visitId);
    assert.equal(v13Img.pirads, 3);
    /* 新版就诊里的附加记录：事件 + 结构化影像都要挂到同一个 visit */
    const linkedEv = await call('/api/patients/' + p2.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-03-02', type: 'PSMA PET-CT', visitId: visit.visitId,
      structured: { kind: 'imaging', data: { modality: 'PSMA_PET', studyDate: '2025-03-02', notes: '就诊附加影像' } }
    }) });
    assert.ok(linkedEv.newEventId, '附加事件应创建成功');
    const linkedDetail = await call('/api/patients/' + p2.id);
    assert.equal(linkedDetail.events.find(x => Number(x.id) === Number(linkedEv.newEventId)).visitId, visit.visitId);
    const linkedImg = linkedDetail.imagingStudies.find(x => Number(x.eventId) === Number(linkedEv.newEventId));
    assert.ok(linkedImg, '附加影像结构应存在');
    assert.equal(linkedImg.visitId, visit.visitId);
    const pathRec = afterVisit.pathologyReports.find(x => x.specimenType === 'biopsy');
    if (pathRec) {
      await call('/api/patients/' + p2.id + '/visits/' + visit.visitId + '/attach', { method: 'POST', body: JSON.stringify({ type: 'pathology', id: pathRec.id }) });
      const attached = await call('/api/patients/' + p2.id);
      assert.equal(attached.pathologyReports.find(x => x.id === pathRec.id).visitId, visit.visitId);
    }

    /* P2-15：报告上传 -> file_assets -> 统一文件列表/下载/删除 */
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nRsAAAAASUVORK5CYII=', 'base64');
    const fd = new FormData();
    fd.append('reports', new Blob([png], { type: 'image/png' }), 'p2-report.png');
    const up = await fetch(BASE + '/api/patients/' + p2.id + '/reports', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd
    });
    if (up.status !== 200) assert.fail(await up.text());
    const reportPatient = await up.json();
    assert.ok((reportPatient.reports || []).length >= 1);
    const files = await call('/api/patients/' + p2.id + '/files');
    const reportAsset = files.find(x => x.source === 'report');
    assert.ok(reportAsset);
    const dl = await fetch(BASE + reportAsset.url, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(dl.status, 200);
    assert.ok((await dl.arrayBuffer()).byteLength > 0);
    await call('/api/reports/' + reportPatient.reports.at(-1).id, { method: 'DELETE' });
    const filesAfter = await call('/api/patients/' + p2.id + '/files');
    assert.equal(filesAfter.some(x => x.source === 'report' && x.sourceId === reportAsset.sourceId), false);

    /* ---- 2026-11-11 临床穿行测试回归 ---- */
    /* 备份往返：primary 活检 + primary RP 必须各自保留；初始 PSA 按标记而非数组位置 */
    const rtP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-备份往返', birth: '1955-01-01', date: '2025-01-01', psa: 8, psaDate: '2024-12-20'
    }) });
    await call('/api/patients/' + rtP.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-01-02', type: '前列腺穿刺活检病理报告', structured: { kind: 'pathology', data: {
        specimenType: 'biopsy', reportDate: '2025-01-02', coresTotal: 12, coresPositive: 4,
        gleasonPrimary: 3, gleasonSecondary: 4, isPrimary: 1
      } }
    }) });
    await call('/api/patients/' + rtP.id + '/events', { method: 'POST', body: JSON.stringify({
      date: '2025-01-18', type: '手术病理报告', structured: { kind: 'pathology', data: {
        specimenType: 'RP', reportDate: '2025-01-18', gleasonPrimary: 3, gleasonSecondary: 4,
        ptnm: 'pT3aN0M0', marginStatus: 'positive', ece: 1, svi: 0, lnPositive: 0, lnExamined: 12, isPrimary: 1
      } }
    }) });
    await call('/api/patients/' + rtP.id + '/psa', { method: 'POST', body: JSON.stringify({ date: '2025-03-01', val: 0.01, belowLod: true, lod: 0.02 }) });
    const bakRes = await fetch(BASE + '/api/backup/export', { headers: { Authorization: 'Bearer ' + token } });
    const bak = await bakRes.json();
    const impRes = await fetch(BASE + '/api/backup/import', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: bak, mode: 'overwrite' })
    });
    assert.equal(impRes.status, 200, '覆盖导入应成功');
    const rtAfter = await call('/api/patients/' + rtP.id);
    assert.equal(rtAfter.pathologyReports.filter(x => x.specimenType === 'biopsy' && x.isPrimary).length, 1, '导入后 primary 活检保留');
    assert.equal(rtAfter.pathologyReports.filter(x => x.specimenType === 'RP' && x.isPrimary).length, 1, '导入后 primary RP 保留');
    assert.equal(rtAfter.gleason, '3+4=7', '导入后主档 Gleason 保留');
    assert.equal(rtAfter.pathologicStage, 'pT3aN0M0', '导入后病理分期保留');
    const rtInit = rtAfter.psa.filter(x => x.isInitial);
    assert.equal(rtInit.length, 1, '导入后初始 PSA 唯一');
    assert.equal(rtInit[0].date, '2024-12-20', '导入后初始 PSA 仍是最早记录');
    /* 乱序 PSA 数组的旧式备份：初始标记按最早日期重建，而不是数组第一条 */
    const bak2 = JSON.parse(JSON.stringify(bak));
    const bp2 = bak2.patients.find(x => x.id === rtP.id);
    bp2.psa = [bp2.psa[1], bp2.psa[0]];
    bp2.psa.forEach(x => { delete x.isInitial; });
    const impRes2 = await fetch(BASE + '/api/backup/import', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: bak2, mode: 'overwrite' })
    });
    assert.equal(impRes2.status, 200);
    const rtAfter2 = await call('/api/patients/' + rtP.id);
    const rtInit2 = rtAfter2.psa.filter(x => x.isInitial);
    assert.equal(rtInit2.length, 1, '乱序备份导入后初始 PSA 唯一');
    assert.equal(rtInit2[0].date, '2024-12-20', '乱序备份导入后初始 PSA 是最早日期');

    /* 死亡日期冲突检查必须覆盖 v13 就诊 */
    const deathVisitP = await call('/api/patients', { method: 'POST', body: JSON.stringify({
      name: 'API-死亡就诊冲突', birth: '1950-01-01', date: '2024-01-01', psa: 20, psaDate: '2024-01-01'
    }) });
    await call('/api/patients/' + deathVisitP.id + '/visits', { method: 'POST', body: JSON.stringify({
      visitDate: '2025-06-01', visitType: 'outpatient', summary: '死亡前的就诊'
    }) });
    const deathConflict = await fetch(BASE + '/api/patients/' + deathVisitP.id + '/events', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2025-01-01', type: '终止随访/死亡', structured: { kind: 'outcome', data: {
        outcomeType: 'death', eventDate: '2025-01-01', deathCause: 'prostate_cancer'
      } } })
    });
    assert.equal(deathConflict.status, 400, '死亡日期早于既有就诊必须拒绝');

    console.log('✅ structured API test passed');
  } catch (e) {
    console.error('❌ structured API test failed');
    console.error(e);
    console.error(logs.slice(-2000));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    try { child.kill('SIGKILL'); } catch (e) {}
    await rm(tmp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error(e); process.exit(1); });

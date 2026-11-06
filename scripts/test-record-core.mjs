/* =========================================================
 * 结构化专病数据核心验收测试
 * 运行：npm test
 * ========================================================= */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const code = readFileSync(new URL('../public/record-core.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, console };
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const R = sandbox.module.exports;

test('Gleason 解析与 ISUP 映射', () => {
  const g = R.parseGleason('4+3=7');
  assert.equal(g.primary, 4); assert.equal(g.secondary, 3); assert.equal(g.total, 7);
  assert.equal(R.isupFromGleason('4+3=7'), 3);
  assert.equal(R.isupFromGleason('3+4=7'), 2);
  assert.equal(R.isupFromGleason('4+4=8'), 4);
  assert.equal(R.isupFromGleason('5+5=10'), 5);
  assert.equal(R.formatGleason(4, 3), '4+3=7');
});

test('阳性针数百分比', () => {
  assert.equal(R.positiveCorePct(12, 5), 41.7);
  assert.equal(R.positiveCorePct(12, 0), 0);
  assert.equal(R.positiveCorePct(0, 0), null);
});

test('病理校验：阳性针数不能大于总针数，Gleason 必须成对', () => {
  const bad1 = R.validatePathology({ specimenType: 'biopsy', reportDate: '2026-01-01', coresTotal: 12, coresPositive: 13 });
  assert.match(bad1.error, /阳性针数/);
  const bad2 = R.validatePathology({ specimenType: 'biopsy', reportDate: '2026-01-01', gleasonPrimary: 4 });
  assert.match(bad2.error, /同时/);
  const ok = R.validatePathology({
    specimenType: 'RP', reportDate: '2026-01-01', gleasonPrimary: 4, gleasonSecondary: 3,
    ptnm: 'pT3aN0M0', marginStatus: 'positive', ece: 1, svi: 0, lnPositive: 1, lnExamined: 12, isPrimary: 1
  });
  assert.equal(ok.error, null);
  assert.equal(ok.value.gleasonTotal, 7);
  assert.equal(ok.value.isup, 3);
  assert.equal(ok.value.isPrimary, 1);
});

test('前列腺体积与 PSAD：三径换算、既往 PSA、同日取最后一条', () => {
  assert.equal(R.prostateVolumeFromDims(4.2, 3.8, 3.5), 29.0);
  assert.equal(R.prostateVolumeFromDims(4, null, 3), null);
  assert.equal(R.prostateVolumeFromDims(0, 3, 3), null);
  const psa = [{ date: '2026-01-01', val: 10 }, { date: '2026-03-01', val: 12.5 }, { date: '2026-03-01', val: 13 }];
  const feb = R.psadOf(psa, '2026-02-01', 25);
  assert.equal(feb.psa, 10, '取该日期之前最近一次');
  assert.equal(feb.psad, 0.4);
  const mar = R.psadOf(psa, '2026-03-01', 25);
  assert.equal(mar.psa, 13, '同日多条取最后录入的一条');
  assert.equal(R.psadOf([], '2026-03-01', 25), null, '无既往 PSA 时不给假值');
  assert.equal(R.psadOf(psa, '2025-12-01', 25), null, '只有未来 PSA 时同样留空');
});

test('影像校验：模态/日期/枚举', () => {
  /* 2026-10：MRI 已成为合法模态（腹盆腔 MRI 与 PSMA PET-MRI 都要用），
     非法值改用未收录的 'PET'，测试意图不变：模态白名单必须拦得住。 */
  const bad = R.validateImaging({ modality: 'PET', studyDate: '2026-01-01' });
  assert.match(bad.error, /模态/);
  const ok = R.validateImaging({
    modality: 'PSMA_PET', studyDate: '2026-01-01', lesionCount: 3,
    metastaticSites: ['bone', 'lymph_node'], psmaPositive: 1, psmaSuvmax: 8.2,
    recist: 'SD', oligoStatus: 'oligo', isCurrent: 1
  });
  assert.equal(ok.error, null);
  assert.equal(ok.value.metastaticSites, 'bone,lymph_node');
  assert.equal(ok.value.isCurrent, 1);
});

test('放疗校验：结束日期不能早于开始日期', () => {
  const bad = R.validateRadiation({ rtType: 'EBRT', startDate: '2026-02-01', endDate: '2026-01-01' });
  assert.match(bad.error, /结束日期/);
  const ok = R.validateRadiation({ rtType: 'EBRT', startDate: '2026-01-01', endDate: '2026-02-01', doseGy: 78, fractions: 39, target: 'prostate', concurrentAdt: 1, adtDurationMonths: 6 });
  assert.equal(ok.error, null);
  assert.equal(ok.value.doseGy, 78);
});

test('结局校验：BCR 亚型/死亡原因', () => {
  const bcr = R.validateOutcome({ outcomeType: 'BCR', eventDate: '2026-01-01', subtype: 'recurrence', basis: 'PSA', psaValue: 0.2 });
  assert.equal(bcr.error, null);
  const bad = R.validateOutcome({ outcomeType: 'death', eventDate: '2026-01-01', deathCause: 'unknown_cause' });
  assert.match(bad.error, /死亡原因/);
});

test('摘要函数输出关键字段', () => {
  const p = {
    specimenType: 'RP', gleasonPrimary: 4, gleasonSecondary: 3, gleasonTotal: 7, isup: 3,
    ptnm: 'pT3aN0M0', marginStatus: 'positive', ece: 1, svi: 0, lnPositive: 1, lnExamined: 12
  };
  const text = R.pathologySummary(p);
  assert.match(text, /G 4\+3=7/);
  assert.match(text, /ISUP 3/);
  assert.match(text, /pT3aN0M0/);
  assert.match(text, /切缘阳性/);
  assert.match(text, /LN 1\/12/);
});

test('治疗线：按当前日期选活动线，fallback 最后一条', () => {
  const p = { treatmentLines: [
    { lineNo: 1, setting: 'mHSPC', regimen: 'ADT', startDate: '2025-01-01', endDate: '2025-06-01' },
    { lineNo: 2, setting: 'mCRPC', regimen: 'ADT+ARPI', startDate: '2025-06-02', endDate: null }
  ] };
  assert.equal(R.activeTreatmentLine(p, '2025-07-01').lineNo, 2);
  assert.equal(R.activeTreatmentLine(p, '2025-03-01').lineNo, 1);
});

test('完整度：缺项可定位，legacy 数据不被当成结构化病理', () => {
  const p = {
    birth: '1950-01-01', date: '2024-01-01', clinicalStage: 'cT2aN0M0', gleason: '3+3=6',
    psa: [{ val: 6, isInitial: true }], pathologicStage: 'pT3aN0M0', treatmentLines: [{ lineNo: 1, setting: '局限治疗', regimen: 'RP', startDate: '2024-02-01' }],
    pathologyReports: [], outcomes: []
  };
  const c = R.completeness(p);
  assert.ok(c.pct > 0 && c.pct < 100);
  assert.ok(c.missing.some(x => x.key === 'specimenType'));
});

test('转移部位中文别名归一化，未知值报错', () => {
  const ok = R.validateImaging({ modality: 'PSMA_PET', studyDate: '2026-01-01', metastaticSites: '骨,淋巴结' });
  assert.equal(ok.error, null);
  assert.equal(ok.value.metastaticSites, 'bone,lymph_node');
  const bad = R.validateImaging({ modality: 'PSMA_PET', studyDate: '2026-01-01', metastaticSites: '脑' });
  assert.match(bad.error, /转移部位/);
});

/* ---------- 2026-10-21 审计回归 ---------- */

test('P2-05 影像摘要优先 isCurrent，不被后补局部 mpMRI 覆盖', () => {
  const p = { imagingStudies: [
    { id: 1, studyDate: '2025-01-01', modality: 'PSMA_PET', isCurrent: 1, metastaticSites: 'bone', lesionCount: 3 },
    { id: 2, studyDate: '2025-06-01', modality: 'mpMRI', isCurrent: 0, metastaticSites: '', lesionCount: null }
  ] };
  assert.equal(R.latestImaging(p).id, 1);
});

test('P1-05 失访结局必须填写末次接触日期', () => {
  const bad = R.validateOutcome({ outcomeType: 'lost', eventDate: '2026-01-01', lostReason: '搬迁' });
  assert.match(bad.error, /末次接触日期/);
  const ok = R.validateOutcome({ outcomeType: 'lost', eventDate: '2026-01-01', lostReason: '搬迁', lastContactDate: '2025-12-20' });
  assert.equal(ok.error, null);
});

test('P0-03 完整度包含术后 6–12 周 PSA', () => {
  const p = {
    birth: '1950-01-01', date: '2026-01-01', clinicalStage: 'cT1cN0M0', gleason: '3+3=6',
    psa: [{ date: '2026-08-20', val: 6, isInitial: true }], surgDate: '2026-09-01',
    treatmentLines: [{ lineNo: 1, setting: '局限治疗', regimen: 'RP', startDate: '2026-09-01' }],
    pathologyReports: [], outcomes: []
  };
  const c = R.completeness(p);
  assert.ok(c.missing.some(x => x.key === 'postopWindowPsa'));
});

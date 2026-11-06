/* =========================================================
 * 科研队列统计核心验收测试
 * 运行：npm test
 * ========================================================= */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

function load(file, extra = {}) {
  const sandbox = Object.assign({ module: { exports: {} }, console }, extra);
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox);
  return sandbox.module.exports;
}
const C = load(new URL('../public/clinical-core.js', import.meta.url));
const K = load(new URL('../public/cohort-core.js', import.meta.url), { ClinicalCore: C });

function patient(over = {}) {
  return Object.assign({
    id: 'CP-' + Math.random().toString(36).slice(2, 8),
    age: 70, date: '2020-01-01', clinicalStage: 'cT2aN0M0', pathologicStage: '',
    gleason: '3+4=7', treatment: '', followupStatus: '在访',
    race: 'Han', familyHistory: false, lastFollowupDate: '2023-01-01',
    psa: [{ id: 1, date: '2019-12-01', val: 8, isInitial: true }],
    testo: [], events: [], medications: [], clinicalRecords: [],
    treatmentLines: [{ lineNo: 1, setting: '局限治疗', regimen: '根治性前列腺切除术(RP)', startDate: '2020-02-01' }],
    pathologyReports: [{ id: 1, specimenType: 'biopsy', isPrimary: 1, reportDate: '2019-12-20',
      coresTotal: 12, coresPositive: 3, gleasonPrimary: 3, gleasonSecondary: 4, gleasonTotal: 7, isup: 2,
      marginStatus: 'unknown' }],
    imagingStudies: [], outcomes: [], research: {
      specimenCount: 1, tissueCount: 1, timepointCount: 1, genomicCount: 1, ihcCount: 1,
      pairedGenomicCount: 1, hrrStatus: 'pathogenic', msiStatus: 'MSS', ptenLoss: false
    }
  }, over);
}

test('中位数/四分位：空值、奇偶', () => {
  assert.equal(K.median([]), null);
  assert.equal(K.median([3, 1, 2]), 2);
  assert.equal(K.median([1, 2, 3, 4]), 2.5);
  assert.equal(K.quantile([0, 10], 0.25), 2.5);
});

test('诊断 PSA 优先 isInitial，其次最早', () => {
  const p = patient({ psa: [{ date: '2020-02-01', val: 3 }, { date: '2019-12-01', val: 8, isInitial: true }] });
  assert.equal(K.diagnosticPsa(p).val, 8);
  assert.equal(K.diagnosticPsa(patient({ psa: [{ date: '2020-02-01', val: 3 }] })).val, 3);
});

test('随访月数：死亡用死亡日期，失访用末次接触', () => {
  const p = patient({
    date: '2020-01-01',
    outcomes: [{ outcomeType: 'death', eventDate: '2022-01-01' }],
    psa: [{ date: '2022-06-01', val: 1 }]
  });
  assert.ok(Math.abs(K.followupMonths(p, '2024-01-01') - 24) < 1);
  const lost = patient({ date: '2020-01-01', followupStatus: '失访', outcomes: [{ outcomeType: 'lost', eventDate: '2021-01-01', lastContactDate: '2020-12-01' }] });
  assert.ok(K.followupMonths(lost, '2024-01-01') < 12);
});

test('治疗分类：手术/放疗/ADT/ADT+ARPI/ARPI/化疗/主动监测/观察等待', () => {
  assert.equal(K.classifyTreatment('根治性前列腺切除术(RP)'), 'surgery');
  assert.equal(K.classifyTreatment('挽救性放疗(SRT)'), 'rt');
  assert.equal(K.classifyTreatment('戈舍瑞林 ADT'), 'adt');
  assert.equal(K.classifyTreatment('ADT+阿比特龙'), 'adt_arpi');
  assert.equal(K.classifyTreatment('恩扎卢胺'), 'arpi');
  assert.equal(K.classifyTreatment('多西他赛化疗'), 'chemo');
  assert.equal(K.classifyTreatment('主动监测'), 'as');
  assert.equal(K.classifyTreatment('观察等待'), 'ww');
  assert.equal(K.classifyTreatment('手术去势'), 'adt');
});

test('一线治疗取 lineNo 最小，无线回退旧首选治疗', () => {
  const p = patient({ treatmentLines: [
    { lineNo: 2, setting: 'mCRPC', regimen: '多西他赛', startDate: '2022-01-01' },
    { lineNo: 1, setting: '局限治疗', regimen: 'RP', startDate: '2020-02-01' }
  ] });
  assert.equal(K.firstLine(p).lineNo, 1);
  assert.equal(K.firstLineGroup(p), 'surgery');
  assert.equal(K.firstLineGroup(patient({ treatmentLines: [], treatment: '放疗' })), 'rt');
});

test('治疗暴露可重叠识别，线数分组', () => {
  const p = patient({
    treatmentLines: [{ lineNo: 1, setting: 'mHSPC', regimen: 'ADT+阿比特龙', startDate: '2020-02-01' }],
    medications: [{ category: 'arpi', drug: '阿比特龙' }],
    events: [{ type: '外照射放疗(EBRT)', date: '2021-01-01' }]
  });
  const e = K.treatmentExposure(p);
  assert.equal(e.adt, true);
  assert.equal(e.arpi, true);
  assert.equal(e.rt, true);
  assert.equal(K.lineCountGroup(p), '1');
  assert.equal(K.lineCountGroup(patient({ treatmentLines: [] })), '0');
});

test('风险分组把数据不足子类合并', () => {
  assert.equal(K.riskGroup({ strata: { strata: '低危' } }), 'low');
  assert.equal(K.riskGroup({ strata: { strata: '中危(预后良好)' } }), 'fav');
  assert.equal(K.riskGroup({ strata: { strata: '中危(预后不良)' } }), 'unfav');
  assert.equal(K.riskGroup({ strata: { strata: '需活检确认' } }), 'insufficient');
  assert.equal(K.riskGroup({ strata: { strata: '转移' } }), 'metastatic');
});

test('分期/年龄/ISUP 分组', () => {
  assert.equal(K.cStageGroup(patient({ clinicalStage: 'cT3aN0M0' })), 'T3');
  assert.equal(K.mStageGroup(patient({ clinicalStage: 'cT2aN0M1b' })), 'M1b');
  assert.equal(K.isupOfPatient(patient()), 2);
  assert.equal(K.ageGroup(patient({ age: 59 })), 'lt60');
  assert.equal(K.ageGroup(patient({ age: 80 })), 'ge80');
});

test('结局计数与中位时间；无日期只计数', () => {
  const p1 = patient({ date: '2020-01-01', outcomes: [{ outcomeType: 'BCR', eventDate: '2021-01-01' }] });
  const p2 = patient({ date: '2020-01-01', outcomes: [{ outcomeType: 'BCR' }] }); // 无日期
  const rows = K.endpointRows([p1, p2], p => C.assess(p, '2024-01-01'));
  const bcr = rows.find(x => x.key === 'bcr');
  assert.equal(bcr.n, 2);
  assert.equal(bcr.dated, 1);
  assert.ok(bcr.medianMonths > 11 && bcr.medianMonths < 13);
});

test('科研就绪六层与缺失名单', () => {
  const ready = patient();
  assert.ok(K.readiness(ready, '2024-01-01').every(x => x.ready));
  const missing = patient({ race: '', research: {} });
  const layers = K.readiness(missing, '2024-01-01');
  assert.equal(layers.find(x => x.key === 'baseline').ready, false);
  assert.equal(layers.find(x => x.key === 'sample').ready, false);
  const rows = K.readinessRows([ready, missing], '2024-01-01');
  assert.equal(rows.find(x => x.key === 'baseline').n, 1);
  assert.equal(rows.find(x => x.key === 'sample').ids.length, 1);
});

test('病理高危特征按可评估分母计数', () => {
  const p = patient();
  const rows = K.pathologyRows([p]);
  assert.equal(rows.find(x => x.key === 'isup4').n, 0);
  assert.equal(rows.find(x => x.key === 'cores50').n, 0);
  assert.equal(rows.find(x => x.key === 'isup4').eligible, 1);
});

test('buildOverview 空队列不产生 NaN', () => {
  const o = K.buildOverview([], { today: '2024-01-01', assess: () => null });
  assert.equal(o.n, 0);
  assert.equal(o.kpis.medianAge, null);
  assert.equal(o.kpis.medianPsa, null);
  assert.equal(o.pies.disease.reduce((s, x) => s + x.n, 0), 0);
  assert.equal(o.research.readiness.length, 6);
});

test('buildOverview 生成饼图 bucket 与 ids，筛选计数可复现', () => {
  const p1 = patient({ id: 'A' });
  const p2 = patient({ id: 'B', treatmentLines: [], treatment: '放疗' });
  const o = K.buildOverview([p1, p2], { today: '2024-01-01', assess: p => C.assess(p, '2024-01-01') });
  assert.equal(o.n, 2);
  assert.equal(o.pies.treatment.find(x => x.key === 'surgery').n, 1);
  assert.equal(o.pies.treatment.find(x => x.key === 'rt').n, 1);
  const bucket = o.pies.treatment.find(x => x.key === 'surgery');
  assert.deepEqual(bucket.ids, ['A']);
});

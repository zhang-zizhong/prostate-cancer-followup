/* =========================================================
 * 临床判定核心验收测试
 * 运行：npm test
 * ========================================================= */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const code = readFileSync(new URL('../public/clinical-core.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, console };
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const C = sandbox.module.exports;

let idSeq = 1;
function rec(date, val, extra = {}) {
  return { id: idSeq++, date, val, belowLod: false, lod: null, ...extra };
}
function patient(over = {}) {
  const p = {
    id: 'PC-T' + (idSeq++),
    name: '测试患者',
    age: 70,
    date: '2024-01-01',
    stage: 'cT2aN0M0',
    gleason: '3+3=6',
    treatment: '根治性手术',
    surgDate: null,
    rtEndDate: null,
    adtStartDate: null,
    followupStatus: '在访',
    legacyStatus: null,
    castration: null,
    psa: [],
    testo: [],
    events: [],
    medications: [],
    ...over
  };
  /* 审计 P0-01 后，临床风险只认显式 primary 的活检。
     测试默认补一份 primary 活检，避免每个风险用例重复写 pathologyReports；
     需要“无活检”的场景显式传 pathologyReports: []。 */
  if (!Array.isArray(p.pathologyReports) && p.gleason) {
    const m = String(p.gleason).match(/^(\d)\+?(\d)/);
    if (m) {
      p.pathologyReports = [{
        id: 90000 + idSeq, specimenType: 'biopsy', isPrimary: 1, reportDate: '2024-01-01',
        gleasonPrimary: Number(m[1]), gleasonSecondary: Number(m[2]),
        gleasonTotal: Number(m[1]) + Number(m[2])
      }];
    }
  }
  return p;
}
function basePsa(v = 6, date = '2024-01-01') { return [rec(date, v)]; }

/* ---------- 风险分层：N1/M1 必须单列 ---------- */
test('风险分层：局限低/中/高/极高危', () => {
  const cases = [
    ['cT1cN0M0', '3+3=6', 6, '低危'],
    ['cT2bN0M0', '3+3=6', 8, '中危(预后良好)'],
    ['cT2cN0M0', '4+3=7', 15, '中危(预后不良)'],
    /* CSCO 5.2 的极高危为“cT3-4 / ISUP4-5 / PSA>40 至少两项”：
       cT3a + ISUP4 已满足两项，按现行 CSCO 规则归极高危；
       高危用例改用无 cT3 的 ISUP4 + PSA>20。 */
    ['cT2cN0M0', '4+4=8', 25, '高危'],
    ['cT3aN0M0', '4+4=8', 25, '极高危'],
    ['cT3bN0M0', '5+5=10', 50, '极高危']
  ];
  for (const [stage, gleason, psa0, want] of cases) {
    const p = patient({ stage, gleason, psa: basePsa(psa0) });
    assert.equal(C.cscoStrata(p).strata, want, stage);
  }
});

test('风险分层：N1 归区域、M1 归转移，不套局限风险', () => {
  const n1 = patient({ stage: 'cT1cN1M0', gleason: '3+3=6', psa: basePsa(6) });
  assert.equal(C.cscoStrata(n1).strata, '区域');
  const m1 = patient({ stage: 'cT1cM1b', gleason: '3+3=6', psa: basePsa(6) });
  assert.equal(C.cscoStrata(m1).strata, '转移');
});

test('风险分层：缺 N/M 时归分期不足', () => {
  const p = patient({ stage: 'cT2a', gleason: '3+3=6', psa: basePsa(6) });
  assert.equal(C.cscoStrata(p).strata, '分期不足');
});

/* ---------- 术后 BCR：persistence vs recurrence ---------- */
test('临床分期优先：cT2a + pT3b 仍按临床分期判低危', () => {
  const p = patient({
    stage: 'cT2aN0M0', clinicalStage: 'cT2aN0M0', pathologicStage: 'pT3bN0M0',
    gleason: '3+3=6', psa: basePsa(6)
  });
  assert.equal(C.cscoStrata(p).strata, '低危');
  assert.equal(C.highRecurrenceRisk(p, '低危', false), true); /* pT3b 仍属高复发风险 */
});

test('只有 pTNM 时显示需临床分期，不硬套风险组', () => {
  const p = patient({ stage: '', clinicalStage: '', pathologicStage: 'pT3bN0M0', gleason: '4+4=8', psa: basePsa(25) });
  assert.equal(C.cscoStrata(p).strata, '需临床分期');
});

test('病理分期 M1 也识别为转移，M 分期优先临床、缺失时读病理', () => {
  const p = patient({ stage: '', clinicalStage: 'cT2aN0M0', pathologicStage: 'pT3bN0M1b' });
  assert.equal(C.isM1(p), true);
  assert.equal(C.mStageOf(p), 'M1b');
});

test('治疗线决定治疗情境与 PSA 序列起点', () => {
  const p = patient({
    treatment: '', treatmentLines: [{
      id: 1, lineNo: 1, setting: 'mHSPC', regimen: 'ADT+达罗他胺',
      startDate: '2025-02-01', endDate: null, agents: [{ drug: '戈舍瑞林' }]
    }],
    psa: [rec('2025-01-01', 10), rec('2025-03-01', 1), rec('2025-06-01', 0.5)]
  });
  const a = C.assess(p, '2025-07-01');
  assert.equal(a.ctx.kind, 'adt');
  assert.equal(a.ctx.since, '2025-02-01');
  assert.deepEqual(a.seq.map(x => x.date), ['2025-03-01', '2025-06-01']);
});

test('术前 DRE 不作为术后随访锚点', () => {
  const p = patient({
    surgDate: '2023-06-10',
    psa: [rec('2023-06-01', 6), rec('2025-09-10', 0.01)],
    events: [{ id: 1, date: '2023-02-18', type: '直肠指检(DRE)' }]
  });
  const plan = C.assess(p, '2025-10-01').plan;
  const dre = plan.intervals.find(x => x.item === 'DRE');
  assert.equal(dre.lastDone, '2023-06-10');
  assert.equal(dre.due, '2024-06-10');
});

test('结构化 DEXA 记录成为随访计划锚点', () => {
  const p = patient({
    treatment: '内分泌治疗', adtStartDate: '2025-06-01',
    clinicalRecords: [{ id: 1, category: 'bone', item: 'DEXA_T', date: '2025-12-01', val: -2.1, unit: 'T', status: '异常' }]
  });
  const plan = C.assess(p, '2026-03-01').plan;
  const dex = plan.intervals.find(x => x.item.includes('DEXA'));
  assert.equal(dex.lastDone, '2025-12-01');
  assert.equal(dex.due, '2026-12-01');
});

test('术后 BCR：术后 8 周 0.2→0.3 判 persistence，不判 recurrence', () => {
  const p = patient({
    surgDate: '2025-01-01',
    psa: [rec('2025-02-20', 0.2), rec('2025-03-20', 0.3)]
  });
  const a = C.assess(p, '2025-06-01');
  assert.equal(a.bcr.state, 'persistent');
  assert.equal(a.disease.code, 'persistent');
  assert.equal(a.warning.color, 'red');
});

test('术后 BCR：不可测后 0.05→0.08 判 recurrence', () => {
  const p = patient({
    surgDate: '2025-01-01',
    psa: [
      rec('2025-02-20', 0.02, { belowLod: true, lod: 0.02 }),
      rec('2025-06-01', 0.05),
      rec('2025-08-01', 0.08)
    ]
  });
  const a = C.assess(p, '2025-09-01');
  assert.equal(a.bcr.state, 'recurrence');
  assert.equal(a.disease.code, 'bcr');
  assert.equal(a.warning.color, 'red');
});

test('术后 BCR：轻度上升未达 0.05 判 pending，预警为需关注', () => {
  const p = patient({
    surgDate: '2025-01-01',
    psa: [
      rec('2025-02-20', 0.02, { belowLod: true, lod: 0.02 }),
      rec('2025-05-01', 0.03),
      rec('2025-07-01', 0.04)
    ]
  });
  const a = C.assess(p, '2025-08-01');
  assert.equal(a.bcr.state, 'pending');
  assert.equal(a.disease.code, 'stable');
  assert.equal(a.warning.color, 'yellow');
});

test('放疗后 BCR：nadir+2 判 recurrence', () => {
  const p = patient({
    treatment: '放疗',
    rtEndDate: '2025-01-01',
    psa: [rec('2025-02-01', 0.1), rec('2025-03-01', 0.5), rec('2025-05-01', 1.0), rec('2025-07-01', 2.2)]
  });
  const a = C.assess(p, '2025-08-01');
  assert.equal(a.bcr.state, 'recurrence');
  assert.equal(a.disease.code, 'bcr');
});

/* ---------- 去势状态与 CRPC ---------- */
test('睾酮 80 时不能诊断 nmCRPC，并提示未达去势', () => {
  const p = patient({
    treatment: '内分泌治疗',
    adtStartDate: '2025-01-01',
    testo: [rec('2025-06-01', 80)],
    psa: [rec('2025-02-01', 0.2), rec('2025-03-01', 0.4), rec('2025-04-01', 0.8)]
  });
  const a = C.assess(p, '2025-07-01');
  assert.equal(a.castration.status, 'noncastrate');
  assert.equal(a.crpc.state, 'not_castrate');
  assert.notEqual(a.disease.code, 'crpc');
  assert.match(a.warning.note, /未达去势/);
});

test('去势水平下 PSA 连续上升可诊断 nmCRPC，状态为去势抵抗', () => {
  const p = patient({
    treatment: '内分泌治疗',
    adtStartDate: '2025-01-01',
    testo: [rec('2025-06-01', 30)],
    psa: [rec('2025-02-01', 0.2), rec('2025-03-01', 0.4), rec('2025-04-01', 0.8)]
  });
  const a = C.assess(p, '2025-07-01');
  assert.equal(a.castration.status, 'castrate');
  assert.equal(a.crpc.state, 'confirmed');
  assert.equal(a.disease.code, 'crpc');
  assert.equal(a.warning.color, 'red');
});

test('M1 患者睾酮 200 时不能诊断 mCRPC', () => {
  const p = patient({
    stage: 'cT4N1M1b',
    treatment: '内分泌治疗',
    adtStartDate: '2025-01-01',
    testo: [rec('2025-06-01', 200)],
    psa: [rec('2025-02-01', 2.0), rec('2025-03-01', 3.0), rec('2025-04-01', 5.0)]
  });
  const a = C.assess(p, '2025-07-01');
  assert.equal(a.mprog.state, 'not_castrate');
  assert.equal(a.disease.code, 'metastasis');
});

test('M1 + 去势水平 + PSA 进展诊断 mCRPC，状态为去势抵抗', () => {
  const p = patient({
    stage: 'cT4N1M1b',
    treatment: '内分泌治疗',
    adtStartDate: '2025-01-01',
    testo: [rec('2025-06-01', 30)],
    psa: [rec('2025-02-01', 2.0), rec('2025-03-01', 3.0), rec('2025-04-01', 5.0)]
  });
  const a = C.assess(p, '2025-07-01');
  assert.equal(a.mprog.state, 'confirmed');
  assert.equal(a.disease.code, 'crpc');
});

/* ---------- 状态与预警 ---------- */
test('M1 分期自动归转移；死亡状态不再生成随访计划', () => {
  const m1 = patient({ stage: 'cT4N0M1c', psa: basePsa(10) });
  assert.equal(C.assess(m1, '2025-01-01').disease.code, 'metastasis');

  const dead = patient({ followupStatus: '死亡', psa: basePsa(10) });
  const a = C.assess(dead, '2025-01-01');
  assert.equal(a.disease.code, 'death');
  assert.equal(a.plan.intervals.length, 0);
  assert.equal(a.warning.color, 'gray');
});

test('生化复发确认事件可把状态标为生化复发', () => {
  const p = patient({
    followupStatus: '在访',
    psa: basePsa(0.2),
    events: [{ id: 1, date: '2025-01-01', type: '生化复发确认' }]
  });
  const a = C.assess(p, '2025-02-01');
  assert.equal(a.disease.code, 'bcr');
});

test('去势抵抗确认/转移确认事件可覆盖自动状态', () => {
  const crpc = patient({
    treatment: '内分泌治疗',
    psa: basePsa(0.2),
    events: [{ id: 1, date: '2025-01-01', type: '去势抵抗确认' }]
  });
  assert.equal(C.assess(crpc, '2025-02-01').disease.code, 'crpc');

  const met = patient({
    stage: 'cT2aN0M0',
    psa: basePsa(10),
    events: [{ id: 1, date: '2025-01-01', type: '转移确认' }]
  });
  assert.equal(C.assess(met, '2025-02-01').disease.code, 'metastasis');
});

test('手填去势但无近期睾酮时，CRPC 无法判定而不是阴性', () => {
  const p = patient({
    treatment: '内分泌治疗',
    castration: false,
    psa: basePsa(0.2),
    testo: []
  });
  const a = C.assess(p, '2025-02-01');
  assert.equal(a.castration.source, 'manual');
  assert.equal(a.castration.verified, false);
  assert.equal(a.crpc.state, 'indeterminate');
});

test('旧版手填状态与自动状态不一致时给出提示，但不改变自动状态', () => {
  const p = patient({
    stage: 'cT4N0M1b',
    psa: basePsa(10),
    legacyStatus: '稳定'
  });
  const a = C.assess(p, '2025-01-01');
  assert.equal(a.disease.code, 'metastasis');
  assert.ok(a.dataIssues.some(x => x.includes('旧版手填状态')));
});

test('PSA 随访已到期时稳定患者预警变为需关注', () => {
  /* 观察等待只有 PSA 一个随访项目，避免 DRE/影像到期抢在 PSA 前面；
     本轮规则是“PSA/睾酮到期”才进入黄色预警，其他项目只提示不出预警色。 */
  const p = patient({
    treatment: '观察等待',
    psa: [rec('2020-02-01', 0.02, { belowLod: true, lod: 0.02 }), rec('2020-03-01', 0.02, { belowLod: true, lod: 0.02 })],
    events: []
  });
  const a = C.assess(p, '2026-01-01');
  assert.equal(a.disease.code, 'stable');
  assert.ok(a.plan.overdue);
  assert.match(a.plan.overdue.item, /PSA/);
  assert.equal(a.warning.color, 'yellow');
});

/* ---------- M 分期分组 ---------- */
test('M 分期汇总/明细：M1a/b/c、M1 未细分、空分期', () => {
  assert.equal(C.mStageOf({ stage: 'cT4N0M1a' }), 'M1a');
  assert.equal(C.mStageOf({ stage: 'cT4N0M1b' }), 'M1b');
  assert.equal(C.mStageOf({ stage: 'cT4N0M1c' }), 'M1c');
  assert.equal(C.mStageOf({ stage: 'cT4N0M1' }), 'M1（未细分）');
  assert.equal(C.mStageOf({ stage: 'cT2aN0M0' }), 'M0');
  assert.equal(C.mStageOf({ stage: 'cT2aN0' }), '未评估/Mx');
  assert.equal(C.mStageSummaryOf({ stage: 'cT4N0M1a' }), 'M1');
  assert.equal(C.mStageSummaryOf({ stage: 'cT2aN0M0' }), 'M0');
  assert.equal(C.mStageSummaryOf({ stage: '' }), '未评估/Mx');
});

/* ---------- 睾酮单位换算 ---------- */
test('睾酮单位换算：1.7 nmol/L ≈ 49.03 ng/dl；80 ng/dl ≈ 2.77 nmol/L', () => {
  assert.equal(C.toNgdl(1.7, 'nmol/L'), 49.03);
  assert.equal(C.fromNgdl(80, 'nmol/L'), 2.77);
  assert.equal(C.toNgdl(50, 'ng/dl'), 50);
});

/* ---------- 随访计划：按项目各自锚点 ---------- */
test('随访计划：PSA/睾酮/DEXA 各自按上次完成日计算到期', () => {
  const p = patient({
    treatment: '内分泌治疗',
    adtStartDate: '2025-06-01',
    psa: [rec('2025-12-01', 0.1), rec('2026-01-10', 0.1)],
    testo: [rec('2025-12-01', 30), rec('2026-02-10', 30)],
    events: [{ id: 1, date: '2025-12-01', type: '骨密度检测(DEXA)' }]
  });
  const plan = C.assess(p, '2026-03-01').plan;
  const byItem = Object.fromEntries(plan.intervals.map(x => [x.item, x]));
  assert.equal(byItem['血清 PSA'].lastDone, '2026-01-10');
  assert.equal(byItem['血清睾酮'].lastDone, '2026-02-10');
  assert.equal(byItem['骨密度(DEXA)'].lastDone, '2025-12-01');
  assert.equal(byItem['血清 PSA'].due, '2026-04-10');
  assert.equal(byItem['血清睾酮'].due, '2026-05-10');
  assert.equal(byItem['骨密度(DEXA)'].due, '2026-12-01');
});

/* ---------- 日期工具 ---------- */
test('addMonths 处理月末溢出', () => {
  assert.equal(C.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(C.addMonths('2026-12-31', 2), '2027-02-28');
});

/* ---------- 2026-10-21 修复回归：阳性针数 / RP 不覆盖临床风险 / BCR 窗口 / M1 证据 ---------- */
test('风险分层：穿刺 10/12 阳性判中危(预后不良)', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '3+4=7', psa: basePsa(8),
    pathologyReports: [{ id: 11, specimenType: 'biopsy', isPrimary: 1, reportDate: '2024-01-01',
      coresTotal: 12, coresPositive: 10, gleasonPrimary: 3, gleasonSecondary: 4 }]
  });
  const s = C.cscoStrata(p);
  assert.equal(s.strata, '中危(预后不良)');
  assert.match(s.why, /10\/12/);
});

test('RP 4+4 不改变活检 cT1c 的临床风险，但术后随访按 RP 高危', () => {
  const p = patient({
    stage: 'cT1cN0M0', gleason: '3+3=6', psa: basePsa(5),
    treatment: '根治性手术', surgDate: '2025-01-01',
    pathologyReports: [
      { id: 11, specimenType: 'biopsy', isPrimary: 1, reportDate: '2024-12-20',
        coresTotal: 12, coresPositive: 3, gleasonPrimary: 3, gleasonSecondary: 3 },
      { id: 12, specimenType: 'RP', isPrimary: 1, reportDate: '2025-02-01',
        ptnm: 'pT3aN0M0', isup: 4, gleasonPrimary: 4, gleasonSecondary: 4 }
    ],
    psa: [rec('2025-01-20', 5), rec('2025-03-01', 0.01)]
  });
  assert.equal(C.cscoStrata(p).strata, '低危');
  const a = C.assess(p, '2025-06-01');
  const psaPlan = a.plan.intervals.find(x => x.item === '血清 PSA');
  assert.equal(psaPlan.every, 3);
});

test('术后 7 天 0.2、8 周 0.01：不判 persistence，判已达临床治愈', () => {
  const p = patient({
    treatment: '根治性手术', surgDate: '2025-01-01',
    psa: [rec('2025-01-08', 0.2), rec('2025-03-01', 0.01), rec('2025-06-01', 0.01)]
  });
  const a = C.assess(p, '2025-08-01');
  assert.equal(a.bcr.state, 'undetectable');
  assert.equal(a.cure.state, '已达临床治愈');
  assert.equal(a.disease.code, 'stable');
});

test('术后窗口内 0.05→0.08：pending，不是持续不可测', () => {
  const p = patient({
    treatment: '根治性手术', surgDate: '2025-01-01',
    psa: [rec('2025-03-01', 0.05), rec('2025-03-20', 0.08)]
  });
  const a = C.assess(p, '2025-06-01');
  assert.equal(a.bcr.state, 'pending');
  assert.equal(a.disease.code, 'stable');
  assert.equal(a.warning.color, 'yellow');
});

test('影像骨转移 + 转移确认 = M1b，mCRPC 可算', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '4+4=8', treatment: '内分泌治疗', adtStartDate: '2025-01-01',
    psa: [rec('2025-01-20', 20), rec('2025-04-01', 30), rec('2025-05-01', 40), rec('2025-06-01', 60)],
    testo: [{ id: 1, date: '2025-06-10', val: 30, unit: 'ng/dl', enteredVal: 30 }],
    imagingStudies: [{ id: 1, studyDate: '2025-03-01', modality: 'PSMA_PET', metastaticSites: 'bone', lesionCount: 3 }],
    outcomes: [{ id: 1, outcomeType: 'metastasis', eventDate: '2025-03-01', metastaticSites: 'bone', lesionCount: 3 }]
  });
  assert.equal(C.isM1(p), true);
  assert.equal(C.mStageOf(p), 'M1b');
  const a = C.assess(p, '2025-08-01');
  assert.equal(a.mprog.confirmed, true);
  assert.equal(a.disease.code, 'crpc');
});

test('风险用 isInitial，不再用数组第一条 PSA', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '4+3=7',
    psa: [rec('2025-01-01', 30, { isInitial: false }), rec('2025-02-01', 20, { isInitial: true })]
  });
  assert.equal(C.cscoStrata(p).strata, '中危(预后不良)');
});

test('PSA 正好 40 + ISUP4 判极高危', () => {
  const p = patient({ stage: 'cT2cN0M0', gleason: '4+4=8', psa: basePsa(40) });
  assert.equal(C.cscoStrata(p).strata, '极高危');
});

test('只录治疗线也能生成随访计划', () => {
  const p = patient({
    stage: 'cT3aN0M0', gleason: '4+4=8', treatment: '', psa: basePsa(15),
    treatmentLines: [{ lineNo: 1, setting: 'mHSPC', regimen: 'ADT+阿帕他胺', startDate: '2025-01-05' }]
  });
  const a = C.assess(p, '2025-03-01');
  assert.notEqual(a.disease.code, 'pending');
  assert.ok(a.plan.intervals.length > 0);
});

test('ADT 无基线 DEXA：标记 missingBaseline，不冒充已完成', () => {
  const p = patient({
    treatment: '内分泌治疗', adtStartDate: '2026-09-01',
    psa: [rec('2026-08-01', 20)]
  });
  const a = C.assess(p, '2026-10-20');
  const dex = a.plan.intervals.find(x => x.item.includes('DEXA'));
  assert.equal(dex.lastDone, null);
  assert.equal(dex.missingBaseline, true);
  assert.ok(a.plan.missing.some(x => x.item.includes('DEXA')));
});

test('pN1 随访强度保持现状（按科室决定暂不改）', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '3+3=6', psa: basePsa(6), treatment: '根治性手术', surgDate: '2025-01-10',
    pathologicStage: 'pT2N1M0',
    pathologyReports: [{ id: 21, specimenType: 'RP', isPrimary: 1, ptnm: 'pT2N1M0', isup: 1, gleasonPrimary: 3, gleasonSecondary: 3 }],
    psa: [rec('2025-01-05', 6), rec('2025-03-01', 0.01)]
  });
  const a = C.assess(p, '2025-07-01');
  const psaPlan = a.plan.intervals.find(x => x.item === '血清 PSA');
  assert.equal(psaPlan.every, 6);
});

/* ---------- 2026-10-21 虚拟临床医生审计回归 ---------- */

test('P0-01 非主要病理不改主档 Gleason/风险，只有 primary 活检参与分层', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '3+3=6', psa: basePsa(6),
    pathologyReports: [
      { id: 101, specimenType: 'biopsy', isPrimary: 1, reportDate: '2025-01-01', gleasonPrimary: 3, gleasonSecondary: 3 },
      { id: 102, specimenType: 'biopsy', isPrimary: 0, reportDate: '2025-02-01', gleasonPrimary: 4, gleasonSecondary: 4 }
    ]
  });
  assert.equal(C.pickBiopsyPathology(p).id, 101);
  assert.equal(C.cscoStrata(p).strata, '低危');
  assert.match(C.cscoStrata(p).basis, /#101/);
});

test('P0-02 结构化手术线识别 + 后续 ADT 不抹掉术后 BCR', () => {
  const surgery = { lineNo: 1, setting: '局限治疗', regimen: '根治性前列腺切除术(RP)', startDate: '2025-01-10' };
  const p = patient({
    stage: 'cT2aN0M0', gleason: '3+4=7', treatment: '', surgDate: '2025-01-10',
    psa: [rec('2025-01-01', 8, { isInitial: true }), rec('2025-02-25', 0.02), rec('2025-06-01', 0.05), rec('2025-09-01', 0.08)],
    treatmentLines: [surgery],
    events: [{ id: 1, date: '2025-01-10', type: '根治性前列腺切除术(RP)', isSurgery: 1 }]
  });
  let a = C.assess(p, '2025-10-21');
  assert.equal(a.bcr.state, 'recurrence');
  assert.equal(a.disease.code, 'bcr');

  p.treatmentLines = [surgery, { lineNo: 2, setting: '辅助', regimen: '戈舍瑞林 ADT', startDate: '2025-10-01' }];
  a = C.assess(p, '2025-10-21');
  assert.equal(a.ctx.kind, 'adt');
  assert.equal(a.bcr.state, 'recurrence', '加辅助 ADT 后 BCR 仍应保留');
  assert.equal(a.disease.code, 'bcr');
  assert.equal(a.plan.intervals.find(x => x.item === '血清 PSA').every, 3);
  assert.ok(a.plan.intervals.some(x => x.item.includes('睾酮')), 'ADT 睾酮监测不能因 BCR 而丢失');
});

test('P0-03 术后无 6–12 周 PSA：术后待复查，随访锚定手术日期', () => {
  const p = patient({
    stage: 'cT1cN0M0', gleason: '3+3=6', treatment: '根治性手术', surgDate: '2026-09-01',
    events: [{ id: 1, date: '2026-09-01', type: '根治性前列腺切除术(RP)', isSurgery: 1 }],
    psa: [rec('2026-08-20', 6, { isInitial: true })]
  });
  const a = C.assess(p, '2026-10-21');
  assert.equal(a.disease.code, 'postop_pending');
  assert.equal(a.disease.label, '术后待复查');
  assert.equal(a.warning.color, 'yellow');
  const item = a.plan.intervals.find(x => x.item === '术后 6–12 周 PSA');
  assert.ok(item);
  assert.equal(item.lastDone, '2026-09-01');
  assert.equal(item.due, '2026-10-13');
  assert.equal(item.windowEnd, '2026-11-30');
  assert.ok(a.dataIssues.some(x => x.includes('术后 6–12 周 PSA')));
});

test('P1-01 只录用药 ADT 也能生成治疗情境与随访计划', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '4+3=7', treatment: '', psa: basePsa(20),
    medications: [{ id: 1, category: 'adt', drug: '戈舍瑞林', startDate: '2026-08-01' }]
  });
  const a = C.assess(p, '2026-10-21');
  assert.equal(a.ctx.kind, 'adt');
  assert.notEqual(a.disease.code, 'pending');
  assert.ok(a.plan.intervals.length > 0);
  assert.equal(a.plan.intervals.find(x => x.item.includes('睾酮')).every, 1);
});

test('P1-02 疾病 pending 不掩盖已可计算的极高危风险', () => {
  const p = patient({ stage: 'cT3aN0M0', gleason: '4+4=8', psa: basePsa(25), treatment: '' });
  assert.equal(C.cscoStrata(p).strata, '极高危');
  assert.equal(C.assess(p, '2025-01-01').disease.code, 'pending');
});

test('P1-06 nmCRPC 情境生成影像随访（9 个月，不与 mCRPC 混淆）', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '4+4=8', treatment: '', psa: basePsa(10),
    treatmentLines: [{ lineNo: 1, setting: 'nmCRPC', regimen: '达罗他胺', startDate: '2025-01-05' }]
  });
  const a = C.assess(p, '2025-03-01');
  assert.equal(a.ctx.kind, 'adt');
  const img = a.plan.intervals.find(x => x.item.includes('影像学复查'));
  assert.ok(img);
  assert.equal(img.every, 9);
});

test('P1-07 mCRPC 历史标签不因换新线回退', () => {
  const p = patient({
    stage: 'cT2aN0M1b', gleason: '4+4=8', treatment: '', psa: basePsa(10),
    testo: [{ id: 1, date: '2025-03-01', val: 20, unit: 'ng/dl', enteredVal: 20 }],
    treatmentLines: [
      { lineNo: 1, setting: 'mCRPC', regimen: '阿比特龙', startDate: '2025-01-05' },
      { lineNo: 2, setting: '化疗', regimen: '多西他赛', startDate: '2025-04-01' }
    ]
  });
  assert.equal(C.assess(p, '2025-05-01').disease.code, 'crpc');
});

test('P1-10 无 primary 活检时不出低/中/高危，提示需活检确认', () => {
  const p = patient({ stage: 'cT1cN0M0', gleason: '3+3=6', psa: basePsa(6), pathologyReports: [] });
  assert.equal(C.cscoStrata(p).strata, '需活检确认');
});

test('P1-11 CHAARTED 高/低瘤负荷派生', () => {
  assert.equal(C.tumorBurden(patient({ visceralMet: true })).level, 'high');
  assert.equal(C.tumorBurden(patient({ metCount: 4, metExtraPelvis: true })).level, 'high');
  assert.equal(C.tumorBurden(patient({ metCount: 3, metExtraPelvis: false })).level, 'low');
  assert.equal(C.tumorBurden(patient({ metCount: 4, metExtraPelvis: null, visceralMet: false })).level, 'unknown');
});

test('P0-03 追加：错过 6–12 周窗口但后续长期不可测，不再永久判术后待复查', () => {
  const p = patient({
    stage: 'cT2aN0M0', gleason: '3+4=7', treatment: '根治性手术', surgDate: '2025-01-10',
    events: [{ id: 1, date: '2025-01-10', type: '根治性前列腺切除术(RP)', isSurgery: 1 }],
    psa: [rec('2025-01-01', 8, { isInitial: true }), rec('2025-04-20', 0.02), rec('2025-09-01', 0.01)]
  });
  const a = C.assess(p, '2025-12-01');
  assert.equal(a.bcr.state, 'undetectable');
  assert.equal(a.bcr.missingWindow, true);
  assert.equal(a.disease.code, 'stable');
  assert.equal(a.warning.color, 'yellow');
  assert.equal(a.plan.intervals.some(x => x.item === '术后 6–12 周 PSA'), false);
});

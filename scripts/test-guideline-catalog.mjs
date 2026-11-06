import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_VERSION, FIGURES, DISEASE_STATES, RISK_STRATA, SCENARIOS,
  TREATMENT_OPTIONS, FOLLOWUP_TEMPLATES, TOXICITY_TERMS, COMORBIDITIES,
  DRUG_REGIMENS, RESPONSE_RULES, FOLLOWUP_ITEMS, optionById, templateByCode,
  toxicityByCode, comorbidityByCode, catalogSummary
} from '../lib/guideline-catalog.mjs';

test('目录版本与四图元数据完整', () => {
  assert.match(CATALOG_VERSION, /^2026\./);
  assert.equal(FIGURES.length, 4);
  assert.equal(FIGURES.reduce((n, f) => n + f.nodes, 0), 286);
  assert.ok(FIGURES.every(f => f.id && f.title && f.chapters && f.source));
});

test('状态机与危险分层覆盖', () => {
  assert.ok(DISEASE_STATES.length >= 12);
  assert.deepEqual(DISEASE_STATES.slice(0, 9).map(s => s.code), ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  assert.ok(RISK_STRATA.some(s => s.code === 'favorable_intermediate'));
  assert.ok(RISK_STRATA.some(s => s.code === 'very_high'));
  assert.ok(RISK_STRATA.every(s => s.criteria && s.figure));
});

test('全部治疗选项有唯一 id、场景、级别和出处', () => {
  assert.ok(TREATMENT_OPTIONS.length >= 100, '至少 100 个治疗选项');
  const ids = new Set();
  const scenarioKeys = new Set(SCENARIOS.map(s => s.key));
  for (const op of TREATMENT_OPTIONS) {
    assert.ok(op.id && !ids.has(op.id), '重复/空 id: ' + op.id);
    ids.add(op.id);
    assert.ok(scenarioKeys.has(op.scenario), '未知场景: ' + op.scenario + ' @ ' + op.id);
    assert.ok(op.label && op.level, '缺 label/level: ' + op.id);
    assert.ok(op.source, '缺 source: ' + op.id);
    assert.ok(Array.isArray(op.components));
    assert.ok(optionById(op.id));
  }
});

test('图一/图二的场景都有选项（de novo M1 走图二）', () => {
  const counts = {};
  TREATMENT_OPTIONS.forEach(o => { counts[o.scenario] = (counts[o.scenario] || 0) + 1; });
  for (const key of ['localized_low', 'localized_favorable_intermediate', 'localized_high',
    'cN1', 'bcr_post_rp_no_met', 'mHSPC_sync_low', 'mHSPC_high', 'nmCRPC', 'mCRPC_1L',
    'mCRPC_2L_arpi_fail', 'mCRPC_2L_arpi_chemo_fail', 'bone_events']) {
    assert.ok(counts[key] > 0, key + ' 无选项');
  }
  assert.ok(counts.mHSPC_high >= 10, '高瘤负荷选项应完整');
  assert.ok(counts.mCRPC_1L >= 15, 'mCRPC 一线选项应完整');
});

test('随访模板与 AE 词表闭合', () => {
  assert.equal(FOLLOWUP_TEMPLATES.length, 8);
  for (const t of FOLLOWUP_TEMPLATES) {
    assert.ok(t.code && t.label && t.intervalMonths >= 1);
    assert.ok(Array.isArray(t.core) && t.core.length > 0);
    assert.ok(Array.isArray(t.aeTerms));
    for (const code of t.aeTerms) assert.ok(toxicityByCode(code), t.code + ' 未知 AE ' + code);
    for (const d of t.due || []) assert.ok(d.code && d.label && d.everyMonths || d.everyCycles);
  }
  assert.ok(templateByCode('RP') && templateByCode('CHEMO'));
});

test('毒性术语封顶与定义', () => {
  assert.ok(TOXICITY_TERMS.length >= 16);
  const codes = new Set();
  for (const t of TOXICITY_TERMS) {
    assert.ok(!codes.has(t.code));
    codes.add(t.code);
    assert.ok(t.maxGrade >= 3 && t.maxGrade <= 5, t.code + ' maxGrade');
    assert.ok(Array.isArray(t.definitions) && t.definitions.length >= 2);
    assert.ok(t.definitions.some(d => d.grade === 0 || d.grade === 1));
    assert.equal(toxicityByCode(t.code).code, t.code);
  }
  assert.equal(toxicityByCode('urinary_incontinence').maxGrade, 3);
  assert.equal(toxicityByCode('anemia').maxGrade, 5);
  assert.equal(toxicityByCode('myelosuppression').maxGrade, 4);
  assert.equal(toxicityByCode('myelosuppression').computed, true);
});

test('合并症按 p2 实拍页列全 21 项；药物/疗效/随访参考存在', () => {
  assert.equal(COMORBIDITIES.length, 21);
  assert.equal(new Set(COMORBIDITIES.map(c => c.code)).size, 21);
  for (const c of COMORBIDITIES) assert.ok(c.system && c.label && comorbidityByCode(c.code));
  assert.ok(DRUG_REGIMENS.some(x => x.name === '阿比特龙'));
  assert.ok(DRUG_REGIMENS.some(x => x.name === '镭-223'));
  assert.ok(RESPONSE_RULES.some(x => x.code === 'CRPC'));
  assert.ok(FOLLOWUP_ITEMS.length >= 4);
});

test('catalogSummary 可用于前端缓存版本', () => {
  const s = catalogSummary();
  assert.equal(s.version, CATALOG_VERSION);
  assert.equal(s.templates, 8);
  assert.equal(s.comorbidities, 21);
  assert.ok(s.options >= 100);
});

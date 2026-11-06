import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEpisodeInput, validateVisitInput, validateRowInput, validateAdverseEventInput,
  validateSurgeryInput, validateChemoCycleInput, validateComorbidityInput, validateDiseaseStateInput,
  computeMyelosuppressionGrade, nextVisitNo, missedVisitEstimate
} from '../lib/visit-rules.mjs';

test('治疗段校验：模板/类型/日期/场景', () => {
  const ok = validateEpisodeInput({ episodeType: 'surgery', templateCode: 'RP', intent: 'radical', startDate: '2026-01-01' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.templateCode, 'RP');
  assert.equal(validateEpisodeInput({ episodeType: 'surgery', templateCode: 'NOPE', startDate: '2026-01-01' }).ok, false);
  assert.equal(validateEpisodeInput({ episodeType: 'chemotherapy', templateCode: 'CHEMO', startDate: '2026-01-01' }).ok, false);
  assert.equal(validateEpisodeInput({ episodeType: 'surgery', templateCode: 'RP', startDate: '2026-02-30' }).ok, false);
  assert.equal(validateEpisodeInput({ episodeType: 'surgery', templateCode: 'RP', startDate: '2099-01-01' }).ok, false);
  assert.equal(validateEpisodeInput({ episodeType: 'surgery', templateCode: 'RP', startDate: '2026-01-02', endDate: '2026-01-01' }).ok, false);
});

test('就诊校验：日期/ECOG/疼痛/下次随访', () => {
  const ok = validateVisitInput({ visitDate: '2026-11-01', visitType: 'outpatient', ecog: 1, painNrs: 2 });
  assert.equal(ok.ok, true);
  assert.equal(validateVisitInput({ visitDate: '2099-01-01' }).ok, false);
  assert.equal(validateVisitInput({ visitDate: '2026-11-01', visitType: 'bad' }).ok, false);
  assert.equal(validateVisitInput({ visitDate: '2026-11-01', ecog: 6 }).ok, false);
  assert.equal(validateVisitInput({ visitDate: '2026-11-01', painNrs: 11 }).ok, false);
  assert.equal(validateVisitInput({ visitDate: '2026-11-01', nextVisitDate: '2026-10-01' }).ok, false);
});

test('就诊行校验：疗效必须有依据', () => {
  const ok = validateRowInput({ overallResponse: 'CR', responseBasis: 'psa' });
  assert.equal(ok.ok, true);
  const auto = validateRowInput({ overallResponse: 'PR' });
  assert.equal(auto.ok, true);
  assert.equal(auto.value.responseBasis, 'combined');
  assert.equal(validateRowInput({ overallResponse: 'XX' }).ok, false);
  assert.equal(validateRowInput({ overallResponse: 'CR', responseBasis: 'bad' }).ok, false);
});

test('AE 分级：功能毒性封顶 3、贫血可到 5、骨髓抑制 0–4', () => {
  assert.equal(validateAdverseEventInput({ termCode: 'urinary_incontinence', grade: 3 }).ok, true);
  assert.equal(validateAdverseEventInput({ termCode: 'urinary_incontinence', grade: 4 }).ok, false);
  assert.equal(validateAdverseEventInput({ termCode: 'anemia', grade: 5 }).ok, true);
  assert.equal(validateAdverseEventInput({ termCode: 'myelosuppression', grade: 5 }).ok, false);
  assert.equal(validateAdverseEventInput({ termCode: 'myelosuppression', grade: null }).ok, true);
  assert.equal(validateAdverseEventInput({ termCode: 'nope', grade: 1 }).ok, false);
});

test('骨髓抑制按 Hb/ANC/PLT 取最重一级；无数据返回 null', () => {
  const g = computeMyelosuppressionGrade({ hb: 95, anc: 0.8, plt: 60 });
  assert.equal(g.grade, 3);
  assert.match(g.basis, /ANC=0.8→G3/);
  assert.equal(computeMyelosuppressionGrade({}), null);
  assert.equal(computeMyelosuppressionGrade({ hb: 120, anc: 2.2, plt: 180 }).grade, 0);
});

test('手术/化疗/合并症/状态校验', () => {
  assert.equal(validateSurgeryInput({ surgeryDate: '2026-01-01', lnExaminedLeft: 10, lnPositiveLeft: 11 }).ok, false);
  assert.equal(validateSurgeryInput({ surgeryDate: '2026-01-01', lnExaminedLeft: 10, lnPositiveLeft: 2 }).ok, true);
  assert.equal(validateChemoCycleInput({ cycleNo: 1, cycleDate: '2026-01-01', bsa: 1.8 }).ok, true);
  assert.equal(validateChemoCycleInput({ cycleNo: 0, cycleDate: '2026-01-01' }).ok, false);
  assert.equal(validateChemoCycleInput({ cycleNo: 1, cycleDate: '2026-01-01', doseReductionPct: 120 }).ok, false);
  assert.equal(validateComorbidityInput({ diseaseCode: 'diabetes', status: 'active' }).ok, true);
  assert.equal(validateComorbidityInput({ diseaseCode: 'nope', status: 'active' }).ok, false);
  assert.equal(validateComorbidityInput({ diseaseCode: 'diabetes', status: 'bad' }).ok, false);
  assert.equal(validateDiseaseStateInput({ stateCode: 'S7', sinceDate: '2026-01-01' }).ok, true);
  assert.equal(validateDiseaseStateInput({ stateCode: 'X9', sinceDate: '2026-01-01' }).ok, false);
});

test('序号与漏访估算', () => {
  assert.equal(nextVisitNo([]), 1);
  assert.equal(nextVisitNo([{ visitNo: 3 }, { visitNo: 5 }]), 6);
  assert.equal(missedVisitEstimate('2026-01-01', '2026-07-01', 3), 1);
  assert.equal(missedVisitEstimate('2026-01-01', '2026-02-01', 3), 0);
});

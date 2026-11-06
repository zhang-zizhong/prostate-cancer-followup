/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * 就诊/治疗段/不良事件 等新对象的纯校验与派生规则
 * ---------------------------------------------------------
 * 服务端写库前调用；测试直接 import。目录（指南选项、模板、
 * 毒性词表）来自 guideline-catalog.mjs，避免页面/服务端两套。
 * ========================================================= */
import {
  templateByCode, toxicityByCode, comorbidityByCode, optionById,
  scenarioByKey, DISEASE_STATES
} from './guideline-catalog.mjs';

export const EPISODE_TYPES = ['surgery', 'radiotherapy', 'endocrine', 'systemic', 'chemo', 'surveillance', 'other'];
export const EPISODE_INTENTS = ['radical', 'adjuvant', 'salvage', 'palliative', 'neoadjuvant', 'active_surveillance', 'watchful_waiting'];
export const EPISODE_STATUSES = ['planned', 'active', 'completed', 'stopped'];
export const VISIT_TYPES = ['baseline', 'outpatient', 'inpatient', 'phone', 'external', 'mdt', 'chemo', 'other'];
export const VISIT_STATUSES = ['draft', 'final'];
export const ROW_TYPES = ['baseline', 'followup', 'chemo_cycle', 'chemo_reassessment', 'unscheduled'];
export const RESPONSES = ['CR', 'PR', 'SD', 'PD', 'NE', 'NA'];
export const RESPONSE_BASES = ['psa', 'imaging', 'clinical', 'combined', 'none'];
export const PSA_RESPONSES = ['PSA50', 'PSA30', 'PSA_PROGRESSION', 'UNDETECTABLE', 'STABLE', 'NA'];
export const IMAGING_RESPONSES = ['CR', 'PR', 'SD', 'PD', 'NE', 'NA'];
export const CLINICAL_RESPONSES = ['improved', 'stable', 'worsened', 'NA'];
export const AE_RECOVERY = ['recovered', 'recovering', 'not_recovered', 'unknown'];
export const AE_ACTIONS = ['none', 'dose_reduce', 'delay', 'interrupt', 'stop'];
export const COMORBIDITY_STATUSES = ['active', 'history', 'negative', 'unknown'];
export const DISEASE_STATE_STATUSES = ['suggested', 'confirmed', 'rejected'];
export const STOP_REASON_CODES = ['progression', 'toxicity', 'completed', 'patient_choice', 'other'];

const TEMPLATE_TYPES = {
  RP: 'surgery', RT: 'radiotherapy', ADT: 'endocrine', SYSTEMIC: 'systemic',
  CHEMO: 'chemo', AS: 'surveillance', WW: 'surveillance', OTHER: 'other'
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2100;
}
export function todayIso() {
  const tz = process.env.APP_TZ || 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = k => (parts.find(x => x.type === k) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
export function cleanText(v, max = 1000) {
  return String(v == null ? '' : v).trim().slice(0, max);
}
export function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export function intOrNull(v) {
  const n = numOrNull(v);
  return n == null || !Number.isInteger(n) ? null : n;
}
const ok = value => ({ ok: true, value });
const bad = error => ({ ok: false, error });
const inList = (list, v) => list.includes(String(v || ''));

export function validateEpisodeInput(body, opts = {}) {
  const b = body || {};
  const today = opts.today || todayIso();
  const episodeType = cleanText(b.episodeType, 30);
  const templateCode = cleanText(b.templateCode, 20).toUpperCase();
  if (!inList(EPISODE_TYPES, episodeType)) return bad('治疗段类型不合法');
  if (!templateByCode(templateCode)) return bad('随访模板不存在');
  if (TEMPLATE_TYPES[templateCode] && TEMPLATE_TYPES[templateCode] !== episodeType) {
    return bad('治疗段类型与随访模板不匹配');
  }
  const intent = cleanText(b.intent, 30) || (templateCode === 'AS' ? 'active_surveillance' : templateCode === 'WW' ? 'watchful_waiting' : 'radical');
  if (!inList(EPISODE_INTENTS, intent)) return bad('治疗意图不合法');
  const status = cleanText(b.status, 20) || 'active';
  if (!inList(EPISODE_STATUSES, status)) return bad('治疗段状态不合法');
  const startDate = cleanText(b.startDate, 10);
  if (!isDate(startDate)) return bad('治疗段开始日期格式不正确');
  if (status !== 'planned' && startDate > today) return bad('治疗段开始日期不能晚于今天');
  const endDate = b.endDate ? cleanText(b.endDate, 10) : '';
  if (endDate && !isDate(endDate)) return bad('治疗段结束日期格式不正确');
  if (endDate && endDate < startDate) return bad('治疗段结束日期不能早于开始日期');
  if (endDate && endDate > today) return bad('治疗段结束日期不能晚于今天');
  const interval = intOrNull(b.followupIntervalDays);
  if (interval != null && (interval < 7 || interval > 365)) return bad('随访间隔需在 7–365 天之间');
  const scenario = cleanText(b.guidelineScenario, 60);
  if (scenario && !scenarioByKey(scenario)) return bad('指南场景不存在');
  const optionId = cleanText(b.guidelineOptionId, 80);
  if (optionId) {
    const op = optionById(optionId);
    if (!op) return bad('指南治疗选项不存在');
    if (scenario && op.scenario !== scenario) return bad('指南选项与场景不匹配');
  }
  const lineId = intOrNull(b.lineId);
  return ok({
    episodeType, templateCode, intent, status, startDate, endDate: endDate || null,
    label: cleanText(b.label, 120) || (templateByCode(templateCode) || {}).label || '',
    lineId, guidelineScenario: scenario, guidelineOptionId: optionId,
    recommendationLevel: cleanText(b.recommendationLevel, 20),
    guidelineRef: cleanText(b.guidelineRef, 200),
    followupIntervalDays: interval,
    stopReasonCode: cleanText(b.stopReasonCode, 20),
    notes: cleanText(b.notes, 1000)
  });
}

export function validateVisitInput(body, opts = {}) {
  const b = body || {};
  const today = opts.today || todayIso();
  const visitDate = cleanText(b.visitDate, 10);
  if (!isDate(visitDate)) return bad('就诊日期格式不正确');
  if (visitDate > today) return bad('就诊日期不能晚于今天');
  const visitType = cleanText(b.visitType, 20) || 'outpatient';
  if (!inList(VISIT_TYPES, visitType)) return bad('就诊类型不合法');
  const status = cleanText(b.status, 20) || 'final';
  if (!inList(VISIT_STATUSES, status)) return bad('就诊状态不合法');
  const ecog = intOrNull(b.ecog);
  if (ecog != null && (ecog < 0 || ecog > 5)) return bad('ECOG 需在 0–5');
  const pain = intOrNull(b.painNrs);
  if (pain != null && (pain < 0 || pain > 10)) return bad('疼痛 NRS 需在 0–10');
  const nextDate = b.nextVisitDate ? cleanText(b.nextVisitDate, 10) : '';
  if (nextDate && !isDate(nextDate)) return bad('下次随访日期格式不正确');
  if (nextDate && nextDate < visitDate) return bad('下次随访日期不能早于本次就诊');
  return ok({
    visitDate, visitType, status,
    department: cleanText(b.department, 60),
    physician: cleanText(b.physician, 60),
    chiefComplaint: cleanText(b.chiefComplaint, 1000),
    ecog, painNrs: pain,
    summary: cleanText(b.summary, 4000),
    nextPlan: cleanText(b.nextPlan, 2000),
    nextVisitDate: nextDate || null,
    mdtParticipants: cleanText(b.mdtParticipants, 500),
    mdtConclusion: cleanText(b.mdtConclusion, 2000)
  });
}

export function validateRowInput(body) {
  const b = body || {};
  const rowType = cleanText(b.rowType, 30) || 'followup';
  if (!inList(ROW_TYPES, rowType)) return bad('就诊行类型不合法');
  const overall = cleanText(b.overallResponse, 10).toUpperCase() || 'NA';
  if (!inList(RESPONSES, overall)) return bad('总体疗效不合法');
  let basis = cleanText(b.responseBasis, 20) || 'none';
  if (!inList(RESPONSE_BASES, basis)) return bad('疗效依据不合法');
  if (overall !== 'NA' && basis === 'none') basis = 'combined';
  const psaResponse = cleanText(b.psaResponse, 30).toUpperCase() || 'NA';
  if (!inList(PSA_RESPONSES, psaResponse)) return bad('PSA 疗效不合法');
  const imagingResponse = cleanText(b.imagingResponse, 10).toUpperCase() || 'NA';
  if (!inList(IMAGING_RESPONSES, imagingResponse)) return bad('影像疗效不合法');
  const clinicalResponse = cleanText(b.clinicalResponse, 20) || 'NA';
  if (!inList(CLINICAL_RESPONSES, clinicalResponse)) return bad('临床疗效不合法');
  const ecog = intOrNull(b.ecog);
  if (ecog != null && (ecog < 0 || ecog > 5)) return bad('ECOG 需在 0–5');
  const pain = intOrNull(b.painNrs);
  if (pain != null && (pain < 0 || pain > 10)) return bad('疼痛 NRS 需在 0–10');
  const visitNo = intOrNull(b.visitNo);
  if (visitNo != null && visitNo < 1) return bad('复诊序号需 ≥1');
  return ok({
    rowType, overallResponse: overall, responseBasis: basis,
    psaResponse, imagingResponse, clinicalResponse,
    ecog, painNrs: pain, visitNo,
    symptomStatus: cleanText(b.symptomStatus, 100),
    summary: cleanText(b.summary, 4000),
    notes: cleanText(b.notes, 2000),
    nextVisitDate: cleanText(b.nextVisitDate, 10) || null
  });
}

export function validateAdverseEventInput(body) {
  const b = body || {};
  const termCode = cleanText(b.termCode, 60);
  const term = toxicityByCode(termCode);
  if (!term) return bad('毒性术语不在分级字典中');
  const rawGrade = b.grade;
  let grade = null;
  if (rawGrade !== '' && rawGrade != null) {
    grade = intOrNull(rawGrade);
    if (grade == null || grade < 0 || grade > term.maxGrade) {
      return bad(term.label + ' 分级需在 0–' + term.maxGrade + (term.functional ? '（功能性毒性封顶 3 级）' : ''));
    }
  }
  const onset = cleanText(b.onsetDate, 10);
  if (onset && !isDate(onset)) return bad('毒性开始日期格式不正确');
  const resolution = cleanText(b.resolutionDate, 10);
  if (resolution && !isDate(resolution)) return bad('毒性缓解日期格式不正确');
  if (onset && resolution && resolution < onset) return bad('缓解日期不能早于开始日期');
  const recovery = cleanText(b.recoveryStatus, 20) || 'unknown';
  if (!inList(AE_RECOVERY, recovery)) return bad('恢复状态不合法');
  const action = cleanText(b.action, 20) || 'none';
  if (!inList(AE_ACTIONS, action)) return bad('处理动作不合法');
  return ok({
    termCode, termLabel: term.label, grade,
    ctcaeVersion: cleanText(b.ctcaeVersion, 20) || 'CTCAE 5.0',
    gradeBasis: cleanText(b.gradeBasis, 500),
    onsetDate: onset || null, resolutionDate: resolution || null,
    recoveryStatus: recovery, auxMeds: cleanText(b.auxMeds, 500),
    management: cleanText(b.management, 1000), action,
    causality: cleanText(b.causality, 100), notes: cleanText(b.notes, 1000)
  });
}

export function validateSurgeryInput(body) {
  const b = body || {};
  const surgeryDate = cleanText(b.surgeryDate, 10);
  if (!isDate(surgeryDate)) return bad('手术日期格式不正确');
  if (surgeryDate > todayIso()) return bad('手术日期不能晚于今天');
  const nums = ['lnExaminedLeft', 'lnPositiveLeft', 'lnExaminedRight', 'lnPositiveRight', 'catheterDays', 'drainDays', 'bloodLossMl', 'hospitalDays'];
  const out = { surgeryDate, surgeon: cleanText(b.surgeon, 60), procedure: cleanText(b.procedure, 60) || 'RP',
    approach: cleanText(b.approach, 30) || 'robot', nerveSparing: cleanText(b.nerveSparing, 30) || 'none',
    lnDissection: cleanText(b.lnDissection, 30) || 'none',
    complications: Array.isArray(b.complications) ? b.complications.map(x => cleanText(x, 80)).filter(Boolean).slice(0, 20) : [],
    complicationManagement: cleanText(b.complicationManagement, 1000),
    conversion: b.conversion ? 1 : 0, notes: cleanText(b.notes, 1000) };
  for (const k of nums) {
    const n = intOrNull(b[k]);
    if (n != null && n < 0) return bad(k + ' 不能为负数');
    out[k] = n;
  }
  if (out.lnPositiveLeft != null && out.lnExaminedLeft != null && out.lnPositiveLeft > out.lnExaminedLeft) return bad('左侧阳性淋巴结不能多于送检数');
  if (out.lnPositiveRight != null && out.lnExaminedRight != null && out.lnPositiveRight > out.lnExaminedRight) return bad('右侧阳性淋巴结不能多于送检数');
  return ok(out);
}

export function validateChemoCycleInput(body) {
  const b = body || {};
  const cycleNo = intOrNull(b.cycleNo);
  if (cycleNo == null || cycleNo < 1 || cycleNo > 999) return bad('化疗周期号需为 1–999');
  const cycleDate = cleanText(b.cycleDate, 10);
  if (!isDate(cycleDate)) return bad('化疗日期格式不正确');
  if (cycleDate > todayIso()) return bad('化疗日期不能晚于今天');
  const bsa = numOrNull(b.bsa);
  if (bsa != null && (bsa < 0.5 || bsa > 3)) return bad('BSA 需在 0.5–3 m²');
  const reduction = numOrNull(b.doseReductionPct);
  if (reduction != null && (reduction < 0 || reduction > 100)) return bad('减量百分比需在 0–100');
  const delay = intOrNull(b.delayDays);
  if (delay != null && delay < 0) return bad('延迟天数不能为负');
  const ecog = intOrNull(b.ecog);
  if (ecog != null && (ecog < 0 || ecog > 5)) return bad('ECOG 需在 0–5');
  const next = cleanText(b.nextCycleDate, 10) || null;
  if (next && (!isDate(next) || next < cycleDate)) return bad('下次化疗日期不合法');
  return ok({
    cycleNo, cycleDate, regimen: cleanText(b.regimen, 200),
    agents: Array.isArray(b.agents) ? b.agents : [],
    bsa, plannedDose: cleanText(b.plannedDose, 100), actualDose: cleanText(b.actualDose, 100),
    doseReductionPct: reduction, delayDays: delay, delayReason: cleanText(b.delayReason, 300),
    gcsf: b.gcsf ? 1 : 0, ecog, nextCycleDate: next, notes: cleanText(b.notes, 1000)
  });
}

export function validateComorbidityInput(body) {
  const b = body || {};
  const code = cleanText(b.diseaseCode, 60);
  const catalog = comorbidityByCode(code);
  if (!catalog && code !== 'other') return bad('合并症不在词表中');
  const status = cleanText(b.status, 20) || 'unknown';
  if (!inList(COMORBIDITY_STATUSES, status)) return bad('合并症状态不合法');
  return ok({
    diseaseCode: code,
    diseaseLabel: catalog ? catalog.label : cleanText(b.diseaseLabel, 120),
    system: catalog ? catalog.system : cleanText(b.system, 40),
    status, severity: cleanText(b.severity, 20),
    diagnosedDate: cleanText(b.diagnosedDate, 10) || null,
    notes: cleanText(b.notes, 1000)
  });
}

export function validateDiseaseStateInput(body) {
  const b = body || {};
  const code = cleanText(b.stateCode, 10).toUpperCase();
  const state = DISEASE_STATES.find(x => x.code === code);
  if (!state) return bad('疾病状态码不存在');
  const sinceDate = cleanText(b.sinceDate, 10);
  if (!isDate(sinceDate)) return bad('状态日期格式不正确');
  if (sinceDate > todayIso()) return bad('状态日期不能晚于今天');
  const status = cleanText(b.status, 20) || 'confirmed';
  if (!inList(DISEASE_STATE_STATUSES, status)) return bad('状态快照类型不合法');
  return ok({
    stateCode: code, stateLabel: state.label, sinceDate, status,
    basis: cleanText(b.basis, 1000), evidenceJson: b.evidenceJson ? JSON.stringify(b.evidenceJson).slice(0, 4000) : ''
  });
}

/* ---- 骨髓抑制分级：按 CTCAE 从实验室值取最重一级 ---- */
function gradeHb(v) {
  if (v == null) return null;
  if (v >= 110) return 0; if (v >= 100) return 1; if (v >= 80) return 2; if (v >= 65) return 3; return 4;
}
function gradeWbc(v) {
  if (v == null) return null;
  if (v >= 4.0) return 0; if (v >= 3.0) return 1; if (v >= 2.0) return 2; if (v >= 1.0) return 3; return 4;
}
function gradeAnc(v) {
  if (v == null) return null;
  if (v >= 2.0) return 0; if (v >= 1.5) return 1; if (v >= 1.0) return 2; if (v >= 0.5) return 3; return 4;
}
function gradePlt(v) {
  if (v == null) return null;
  if (v >= 100) return 0; if (v >= 75) return 1; if (v >= 50) return 2; if (v >= 25) return 3; return 4;
}
export function computeMyelosuppressionGrade(labs = {}) {
  const hb = numOrNull(labs.hb ?? labs.HB);
  const wbc = numOrNull(labs.wbc ?? labs.WBC);
  const anc = numOrNull(labs.anc ?? labs.ANC);
  const plt = numOrNull(labs.plt ?? labs.PLT);
  const parts = [
    ['Hb', hb, gradeHb(hb)], ['WBC', wbc, gradeWbc(wbc)],
    ['ANC', anc, gradeAnc(anc)], ['PLT', plt, gradePlt(plt)]
  ].filter(x => x[2] != null);
  if (!parts.length) return null;
  /* 中性粒细胞减少按 ANC 优先；没有 ANC 时才用 WBC，避免把 WBC 正常误当 ANC 正常 */
  const useAnc = anc != null;
  const filtered = parts.filter(x => !(useAnc && x[0] === 'WBC'));
  const worst = filtered.reduce((a, b) => (b[2] > a[2] ? b : a));
  return {
    grade: worst[2],
    basis: filtered.map(x => x[0] + '=' + (x[1] == null ? '—' : x[1]) + '→G' + x[2]).join('; '),
    components: filtered.map(([name, value, grade]) => ({ name, value, grade }))
  };
}

export function normalizeToxicityTerm(code) {
  return toxicityByCode(code) || null;
}

/* 段内下一次序号：允许补录时手工修正，但给出建议 */
export function nextVisitNo(rows = []) {
  const nums = rows.map(x => Number(x.visitNo || x.visit_no || 0)).filter(n => Number.isInteger(n) && n > 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/* 预计漏访：按模板间隔与相邻就诊日期估算 */
export function missedVisitEstimate(prevDate, currentDate, intervalMonths = 3) {
  if (!prevDate || !currentDate || !isDate(prevDate) || !isDate(currentDate)) return 0;
  const a = Date.parse(prevDate + 'T00:00:00Z');
  const b = Date.parse(currentDate + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  const months = (b - a) / (30.4375 * 86400000);
  const expected = Math.max(1, Math.round(months / Math.max(1, intervalMonths)));
  return Math.max(0, expected - 1);
}

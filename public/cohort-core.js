/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * 前列腺随访 2.0 · 科研队列统计核心
 * ---------------------------------------------------------
 * 纯函数模块：只读患者摘要对象，不碰 DOM / fetch / 数据库。
 * 浏览器：<script src="/cohort-core.js"></script> → window.CohortCore
 * Node 测试：vm.runInNewContext 读取本文件，取 module.exports
 *
 * 依赖 public/clinical-core.js（患者级判定只保留一套算法）。
 * 统计口径见 docs/总览统计口径_2026-10-23.md。
 * ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root && root.ClinicalCore);
  else root.CohortCore = factory(root && root.ClinicalCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CC) {
  'use strict';

  const C = CC || {};
  const GLEASONS = ['3+3=6', '3+4=7', '4+3=7', '4+4=8', '3+5=8', '5+3=8', '4+5=9', '5+4=9', '5+5=10'];

  const COLOR = {
    blue: '#2A4E86', teal: '#2A7480', green: '#00875A', lightGreen: '#7FBFA5',
    amber: '#E0AE33', orange: '#C2662D', red: '#A8443C', darkRed: '#7A2E28',
    purple: '#5A4A87', gray: '#5A5A5A', lightGray: '#C9C9C9', brown: '#8A5A2B'
  };

  const PIE = {
    treatment: [
      { key: 'surgery', label: '根治性手术', color: COLOR.blue },
      { key: 'rt', label: '放疗', color: COLOR.purple },
      { key: 'adt', label: 'ADT', color: COLOR.amber },
      { key: 'adt_arpi', label: 'ADT+ARPI', color: COLOR.orange },
      { key: 'arpi', label: 'ARPI', color: COLOR.teal },
      { key: 'chemo', label: '化疗', color: COLOR.red },
      { key: 'as', label: '主动监测', color: COLOR.lightGreen },
      { key: 'ww', label: '观察等待', color: COLOR.gray },
      { key: 'other', label: '其他/未录', color: COLOR.lightGray }
    ],
    disease: [
      { key: 'pending', label: '待评估', color: COLOR.gray },
      { key: 'stable', label: '稳定', color: COLOR.green },
      { key: 'postop_pending', label: '术后待复查', color: COLOR.amber },
      { key: 'bcr', label: '生化复发', color: COLOR.orange },
      { key: 'persistent', label: '术后持续可测', color: COLOR.red },
      { key: 'crpc', label: '去势抵抗', color: COLOR.darkRed },
      { key: 'metastasis', label: '转移', color: COLOR.red },
      { key: 'lost', label: '失访', color: COLOR.brown },
      { key: 'death', label: '死亡', color: COLOR.lightGray }
    ],
    warning: [
      { key: 'red', label: '紧急预警', color: COLOR.red },
      { key: 'yellow', label: '需关注', color: COLOR.amber },
      { key: 'green', label: '稳定', color: COLOR.green },
      { key: 'pending', label: '待评估', color: COLOR.gray },
      { key: 'gray', label: '已终止随访', color: COLOR.lightGray }
    ],
    risk: [
      { key: 'low', label: '低危', color: COLOR.green },
      { key: 'fav', label: '中危(预后良好)', color: COLOR.teal },
      { key: 'unfav', label: '中危(预后不良)', color: COLOR.amber },
      { key: 'high', label: '高危', color: COLOR.orange },
      { key: 'veryhigh', label: '极高危', color: COLOR.red },
      { key: 'regional', label: '区域', color: COLOR.purple },
      { key: 'metastatic', label: '转移', color: COLOR.darkRed },
      { key: 'insufficient', label: '数据不足', color: COLOR.gray }
    ],
    mstage: [
      { key: 'M0', label: 'M0', color: COLOR.green },
      { key: 'M1a', label: 'M1a', color: COLOR.amber },
      { key: 'M1b', label: 'M1b', color: COLOR.orange },
      { key: 'M1c', label: 'M1c', color: COLOR.red },
      { key: 'm1_nos', label: 'M1（未细分）', color: COLOR.lightGray },
      { key: 'unknown', label: '未评估/Mx', color: COLOR.gray }
    ],
    cstage: [
      { key: 'T1', label: 'cT1', color: COLOR.green },
      { key: 'T2', label: 'cT2', color: COLOR.teal },
      { key: 'T3', label: 'cT3', color: COLOR.amber },
      { key: 'T4', label: 'cT4', color: COLOR.red },
      { key: 'unknown', label: '未录', color: COLOR.gray }
    ],
    isup: [
      { key: '1', label: 'ISUP 1', color: COLOR.green },
      { key: '2', label: 'ISUP 2', color: COLOR.teal },
      { key: '3', label: 'ISUP 3', color: COLOR.amber },
      { key: '4', label: 'ISUP 4', color: COLOR.orange },
      { key: '5', label: 'ISUP 5', color: COLOR.red },
      { key: 'unknown', label: '未评估', color: COLOR.gray }
    ],
    age: [
      { key: 'lt60', label: '<60岁', color: COLOR.blue },
      { key: '60_69', label: '60–69岁', color: COLOR.teal },
      { key: '70_79', label: '70–79岁', color: COLOR.amber },
      { key: 'ge80', label: '≥80岁', color: COLOR.purple }
    ],
    lines: [
      { key: '0', label: '0 线', color: COLOR.gray },
      { key: '1', label: '1 线', color: COLOR.blue },
      { key: '2', label: '2 线', color: COLOR.teal },
      { key: '3', label: '≥3 线', color: COLOR.purple }
    ]
  };

  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function median(values) {
    const a = (values || []).filter(v => Number.isFinite(v)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function quantile(values, q) {
    const a = (values || []).filter(v => Number.isFinite(v)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    if (a.length === 1) return a[0];
    const pos = (a.length - 1) * Math.max(0, Math.min(1, q));
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function iqr(values) {
    return [quantile(values, 0.25), quantile(values, 0.75)];
  }
  function pct(n, d) {
    return d ? Math.round((n / d) * 1000) / 10 : 0;
  }
  function byDate(a, b) {
    return String(a && (a.date || a.eventDate || a.reportDate || a.studyDate || a.startDate) || '')
      .localeCompare(String(b && (b.date || b.eventDate || b.reportDate || b.studyDate || b.startDate) || ''));
  }
  function maxDate(list) {
    const a = (list || []).filter(Boolean).slice().sort();
    return a.length ? a[a.length - 1] : null;
  }

  function diagnosticPsa(p) {
    const list = ((p && p.psa) || []).filter(x => num(x && x.val) != null).slice().sort(byDate);
    return list.find(x => x && (x.isInitial || x.is_initial)) || list[0] || null;
  }
  function localToday() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function lastContact(p, today) {
    const cap = today || localToday();
    const dates = [];
    if (p && p.lastFollowupDate) dates.push(p.lastFollowupDate);
    ((p && p.psa) || []).forEach(x => dates.push(x.date));
    ((p && p.testo) || []).forEach(x => dates.push(x.date));
    ((p && p.events) || []).forEach(x => dates.push(x.date));
    ((p && p.medications) || []).forEach(x => { dates.push(x.startDate); dates.push(x.endDate); });
    ((p && p.outcomes) || []).forEach(x => { dates.push(x.eventDate); dates.push(x.lastContactDate); });
    const valid = dates.filter(d => d && d <= cap).sort();
    return valid.length ? valid[valid.length - 1] : null;
  }
  function followupMonths(p, today) {
    if (!p || !p.date || !C.monthsBetween) return null;
    const cap = today || localToday();
    const death = ((p.outcomes || []).find(x => x && x.outcomeType === 'death') || {}).eventDate;
    const lost = ((p.outcomes || []).find(x => x && x.outcomeType === 'lost') || {});
    const end = death || lost.lastContactDate || lost.eventDate || lastContact(p, cap);
    if (!end || end < p.date) return null;
    const m = C.monthsBetween(p.date, end > cap ? cap : end);
    return m == null || m < 0 ? null : m;
  }

  function localIsSurgery(text) {
    const s = String(text || '');
    if (!s) return false;
    if (/去势/.test(s) && !/根治|RP|前列腺切除/i.test(s)) return false;
    /* 与 clinical-core.isSurgeryText 同口径：TURP/电切不是根治术 */
    if (/TURP|电切/i.test(s) && !/根治/i.test(s)) return false;
    return /前列腺癌根治术|根治性前列腺切除术|根治性手术|根治术|前列腺切除|\bRP\b|手术/i.test(s);
  }
  function classifyTreatment(text) {
    const s = String(text || '').trim();
    if (!s) return 'other';
    if (C.isSurgeryText ? C.isSurgeryText(s) : localIsSurgery(s)) return 'surgery';
    if (/放疗|EBRT|SBRT|近距离|粒子植入|SRT/i.test(s)) return 'rt';
    if (/化疗|多西他赛|卡巴他赛|米托蒽醌/i.test(s)) return 'chemo';
    const arpi = /阿比特龙|阿帕他胺|恩扎卢胺|达罗他胺|瑞维鲁胺|PARP|奥拉帕利|尼拉帕利|他拉唑帕利/i.test(s);
    const adt = /ADT|内分泌|去势|戈舍瑞林|亮丙瑞林|曲普瑞林|地加瑞克|瑞卢戈利|比卡鲁胺|氟他胺|尼鲁米特/i.test(s);
    if (arpi && adt) return 'adt_arpi';
    if (arpi) return 'arpi';
    if (adt) return 'adt';
    if (/主动监测/.test(s)) return 'as';
    if (/观察等待|观察/.test(s)) return 'ww';
    return 'other';
  }
  function firstLine(p) {
    const lines = ((p && p.treatmentLines) || []).slice()
      .sort((a, b) => (Number(a.lineNo) || 999) - (Number(b.lineNo) || 999) ||
        String(a.startDate || '').localeCompare(String(b.startDate || '')));
    if (lines.length) return lines[0];
    if (p && p.treatment) return { lineNo: 0, setting: '旧版首选治疗', regimen: p.treatment, startDate: null, legacy: true };
    return null;
  }
  function firstLineGroup(p) {
    const line = firstLine(p);
    if (!line) return 'other';
    return classifyTreatment([line.setting, line.regimen].filter(Boolean).join(' '));
  }
  function treatmentExposure(p) {
    const text = [];
    ((p && p.treatmentLines) || []).forEach(l => text.push(l.setting, l.regimen));
    ((p && p.medications) || []).forEach(m => text.push(m.drug, m.category));
    ((p && p.events) || []).forEach(e => text.push(e.type));
    const s = text.filter(Boolean).join(' ');
    const out = {
      surgery: !!(C.surgeryContext && C.surgeryContext(p)) || localIsSurgery(s),
      rt: /放疗|EBRT|SBRT|近距离|粒子植入|SRT/i.test(s),
      adt: /ADT|内分泌|去势|戈舍瑞林|亮丙瑞林|曲普瑞林|地加瑞克|瑞卢戈利|比卡鲁胺|氟他胺|尼鲁米特/i.test(s) ||
        ((p && p.medications) || []).some(m => m && ['adt', 'endocrine'].includes(m.category)),
      arpi: /阿比特龙|阿帕他胺|恩扎卢胺|达罗他胺|瑞维鲁胺/i.test(s) ||
        ((p && p.medications) || []).some(m => m && m.category === 'arpi'),
      chemo: /化疗|多西他赛|卡巴他赛|米托蒽醌/i.test(s),
      parp: /PARP|奥拉帕利|尼拉帕利|他拉唑帕利/i.test(s),
      trial: /临床试验/.test(s)
    };
    out.systemic = out.adt || out.arpi || out.chemo || out.parp;
    return out;
  }
  function lineCountGroup(p) {
    const n = ((p && p.treatmentLines) || []).length;
    return n <= 0 ? '0' : n === 1 ? '1' : n === 2 ? '2' : '3';
  }

  function gleasonOf(p) {
    if (p && p.gleason) return p.gleason;
    const b = C.pickBiopsyPathology ? C.pickBiopsyPathology(p) : null;
    if (b && b.gleasonPrimary != null && b.gleasonSecondary != null) {
      return b.gleasonPrimary + '+' + b.gleasonSecondary + '=' + (b.gleasonPrimary + b.gleasonSecondary);
    }
    return '';
  }
  function isupOfPatient(p) {
    const b = C.pickBiopsyPathology ? C.pickBiopsyPathology(p) : null;
    if (b && b.isup != null) return Number(b.isup);
    const g = gleasonOf(p);
    return (C.isupOf ? C.isupOf(g) : null);
  }
  function cStageGroup(p) {
    if (!p) return 'unknown';
    const raw = p.clinicalStage || (p.stage && !/^p/i.test(p.stage) ? p.stage : '');
    const st = C.parseStage ? C.parseStage(raw) : { t: '' };
    const t = String(st.t || '').toUpperCase();
    const n = parseInt(t.replace(/^T/, ''), 10);
    return Number.isFinite(n) && n >= 1 && n <= 4 ? 'T' + n : 'unknown';
  }
  function mStageGroup(p) {
    if (!C.mStageOf) return 'unknown';
    const s = C.mStageOf(p);
    if (s === 'M1（未细分）') return 'm1_nos';
    if (s === '未评估/Mx' || !s) return 'unknown';
    return s;
  }
  function ageGroup(p) {
    const a = p && num(p.age);
    if (a == null) return 'unknown';
    if (a < 60) return 'lt60';
    if (a < 70) return '60_69';
    if (a < 80) return '70_79';
    return 'ge80';
  }
  function riskGroup(a) {
    const s = String((a && a.strata && a.strata.strata) || '');
    if (s === '低危') return 'low';
    if (s === '中危(预后良好)') return 'fav';
    if (s === '中危(预后不良)') return 'unfav';
    if (s === '中危') return 'unfav';
    if (s === '高危') return 'high';
    if (s === '极高危') return 'veryhigh';
    if (s === '区域') return 'regional';
    if (s === '转移') return 'metastatic';
    return 'insufficient';
  }
  function diseaseGroup(a) {
    const code = String((a && a.disease && a.disease.code) || 'pending');
    const allowed = ['pending', 'stable', 'postop_pending', 'bcr', 'persistent', 'crpc', 'metastasis', 'lost', 'death'];
    return allowed.includes(code) ? code : 'pending';
  }
  function warningGroup(a) {
    const c = String((a && a.warning && a.warning.color) || 'gray');
    return ['red', 'yellow', 'green', 'pending', 'gray'].includes(c) ? c : 'gray';
  }

  function bucketize(patients, keyFn, cats, testFn) {
    return cats.map(c => {
      const ids = (patients || []).filter(p => testFn ? testFn(p) : keyFn(p) === c.key).map(p => p.id);
      return Object.assign({}, c, { n: ids.length, ids });
    });
  }

  function outcomeDate(p, type) {
    const dates = ((p && p.outcomes) || []).filter(x => x && x.outcomeType === type && x.eventDate)
      .map(x => x.eventDate).sort();
    return dates[0] || null;
  }
  function eventDate(p, types) {
    const dates = ((p && p.events) || []).filter(e => e && e.date && types.includes(e.type))
      .map(e => e.date).sort();
    return dates[0] || null;
  }
  function endpointDefs() {
    return [
      { key: 'bcr', label: 'BCR', outcome: 'BCR', events: ['生化复发确认'], auto: a => !!a.bcrConfirmed },
      { key: 'crpc', label: 'CRPC', outcome: 'CRPC', events: ['去势抵抗确认'], auto: a => a.disease && a.disease.code === 'crpc' },
      { key: 'met', label: '转移事件', outcome: 'metastasis', events: ['转移确认', '转移灶局部治疗'], auto: () => false },
      { key: 'death', label: '死亡', outcome: 'death', events: [], auto: p => p.followupStatus === '死亡' },
      { key: 'lost', label: '失访', outcome: 'lost', events: [], auto: p => p.followupStatus === '失访' }
    ];
  }
  function endpointRows(patients, aOf) {
    const defs = endpointDefs();
    return defs.map(d => {
      const ids = (patients || []).filter(p => {
        const a = aOf(p);
        const hasOutcome = ((p.outcomes || []).some(o => o && o.outcomeType === d.outcome));
        const hasEvent = d.events.some(t => (p.events || []).some(e => e && e.type === t));
        return hasOutcome || hasEvent || d.auto(a, p);
      }).map(p => p.id);
      const times = ids.map(id => {
        const p = patients.find(x => x.id === id);
        if (!p || !p.date) return null;
        let date = outcomeDate(p, d.outcome) || eventDate(p, d.events);
        if (!date && d.key === 'lost') {
          const o = (p.outcomes || []).find(x => x && x.outcomeType === 'lost') || {};
          date = o.lastContactDate || o.eventDate || p.lastFollowupDate;
        }
        if (!date) return null;
        const m = C.monthsBetween ? C.monthsBetween(p.date, date) : null;
        return m != null && m >= 0 ? m : null;
      }).filter(v => v != null);
      return { key: d.key, label: d.label, n: ids.length, dated: times.length, medianMonths: median(times), ids };
    });
  }
  function followupBuckets(patients, today) {
    const defs = [
      { key: 'lt1', label: '<1年', min: 0, max: 12, color: COLOR.gray },
      { key: '1_3', label: '1–3年', min: 12, max: 36, color: COLOR.blue },
      { key: '3_5', label: '3–5年', min: 36, max: 60, color: COLOR.teal },
      { key: 'ge5', label: '≥5年', min: 60, max: Infinity, color: COLOR.purple },
      { key: 'unknown', label: '随访未知', min: null, max: null, color: COLOR.lightGray }
    ];
    return defs.map(d => {
      const ids = (patients || []).filter(p => {
        const m = followupMonths(p, today);
        if (m == null) return d.key === 'unknown';
        return d.key !== 'unknown' && m >= d.min && m < d.max;
      }).map(p => p.id);
      return { key: d.key, label: d.label, color: d.color, n: ids.length, ids };
    });
  }

  function postopPrimary(p) {
    return ((p && p.pathologyReports) || []).find(x => x && x.isPrimary && ['RP', 'TURP'].includes(x.specimenType)) || null;
  }
  function pathologyRows(patients) {
    const defs = [
      { key: 'isup4', label: 'ISUP ≥4', eligible: p => isupOfPatient(p) != null, hit: p => (isupOfPatient(p) || 0) >= 4 },
      { key: 'pt34', label: 'pT3–4', eligible: p => !!postopPrimary(p) && !!postopPrimary(p).ptnm, hit: p => {
        const t = String((postopPrimary(p) || {}).ptnm || '').match(/pT(\d)/i);
        return t && Number(t[1]) >= 3;
      } },
      { key: 'pn1', label: 'pN1', eligible: p => !!postopPrimary(p) && postopPrimary(p).lnExamined != null, hit: p => Number((postopPrimary(p) || {}).lnPositive || 0) > 0 },
      { key: 'margin', label: '切缘阳性/近', eligible: p => !!postopPrimary(p) && postopPrimary(p).marginStatus && postopPrimary(p).marginStatus !== 'unknown', hit: p => ['positive', 'close'].includes((postopPrimary(p) || {}).marginStatus) },
      { key: 'ece', label: 'ECE 阳性', eligible: p => !!postopPrimary(p) && postopPrimary(p).ece != null, hit: p => !!(postopPrimary(p) || {}).ece },
      { key: 'svi', label: 'SVI 阳性', eligible: p => !!postopPrimary(p) && postopPrimary(p).svi != null, hit: p => !!(postopPrimary(p) || {}).svi },
      { key: 'cores50', label: '穿刺阳性 ≥50%', eligible: p => {
        const b = C.pickBiopsyPathology ? C.pickBiopsyPathology(p) : null;
        return !!(b && b.coresTotal != null && b.coresPositive != null);
      }, hit: p => {
        const b = C.pickBiopsyPathology ? C.pickBiopsyPathology(p) : null;
        if (!b || !b.coresTotal) return false;
        return (b.coresPositive || 0) / b.coresTotal >= 0.5;
      } },
      { key: 'idcp', label: 'IDC-P', eligible: p => ((p.pathologyReports || []).some(x => x.idcP != null)), hit: p => (p.pathologyReports || []).some(x => !!x.idcP) },
      { key: 'cribriform', label: '筛状结构', eligible: p => ((p.pathologyReports || []).some(x => x.cribriform != null)), hit: p => (p.pathologyReports || []).some(x => !!x.cribriform) },
      { key: 'nepc', label: 'NEPC', eligible: p => ((p.pathologyReports || []).some(x => x.nepc != null)), hit: p => (p.pathologyReports || []).some(x => !!x.nepc) }
    ];
    return defs.map(d => {
      const eligible = (patients || []).filter(d.eligible).map(p => p.id);
      const ids = (patients || []).filter(p => d.eligible(p) && d.hit(p)).map(p => p.id);
      return { key: d.key, label: d.label, n: ids.length, eligible: eligible.length, ids };
    });
  }

  function exposureRows(patients) {
    const defs = [
      { key: 'surgery', label: '根治性手术', test: p => treatmentExposure(p).surgery },
      { key: 'rt', label: '放疗', test: p => treatmentExposure(p).rt },
      { key: 'adt', label: 'ADT', test: p => treatmentExposure(p).adt },
      { key: 'arpi', label: 'ARPI', test: p => treatmentExposure(p).arpi },
      { key: 'chemo', label: '化疗', test: p => treatmentExposure(p).chemo },
      { key: 'parp', label: 'PARP/核素/试验', test: p => { const e = treatmentExposure(p); return e.parp || e.trial; } }
    ];
    return defs.map(d => {
      const ids = (patients || []).filter(d.test).map(p => p.id);
      return { key: d.key, label: d.label, n: ids.length, ids };
    });
  }

  function molecularRows(patients) {
    const defs = [
      { key: 'tissue', label: '组织样本', test: p => ((p.research || {}).tissueCount || 0) > 0 },
      { key: 'blood', label: '血液/ctDNA', test: p => { const r = p.research || {}; return (r.bloodCount || 0) + (r.ctdnaCount || 0) > 0; } },
      { key: 'tumorCell', label: '肿瘤细胞含量', test: p => ((p.research || {}).tumorCellCount || 0) > 0 },
      { key: 'biobank', label: '生物样本库编号', test: p => ((p.research || {}).biobankCount || 0) > 0 },
      { key: 'paired', label: '样本-分子配对', test: p => { const r = p.research || {}; return (r.pairedGenomicCount || 0) + (r.pairedIhcCount || 0) > 0; } },
      { key: 'ihc', label: 'IHC 检测', test: p => ((p.research || {}).ihcCount || 0) > 0 },
      { key: 'genomic', label: 'NGS/基因检测', test: p => ((p.research || {}).genomicCount || 0) > 0 },
      { key: 'hrr', label: 'HRR 致病/可能致病', test: p => (p.research || {}).hrrStatus === 'pathogenic' },
      { key: 'msi', label: 'MSI-H', test: p => (p.research || {}).msiStatus === 'MSI-H' },
      { key: 'pten', label: 'PTEN 缺失', test: p => !!(p.research || {}).ptenLoss },
      { key: 'erg', label: 'ERG 阳性', test: p => !!(p.research || {}).ergPositive },
      { key: 'ar', label: 'AR 阳性', test: p => !!(p.research || {}).arPositive },
      { key: 'psma', label: 'PSMA 阳性', test: p => !!(p.research || {}).psmaPositive },
      { key: 'ne', label: 'NE 标志物阳性', test: p => !!(p.research || {}).nePositive }
    ];
    return defs.map(d => {
      const ids = (patients || []).filter(d.test).map(p => p.id);
      return { key: d.key, label: d.label, n: ids.length, ids };
    });
  }

  function readiness(p, today) {
    const r = p.research || {};
    const b = C.pickBiopsyPathology ? C.pickBiopsyPathology(p) : null;
    const rp = postopPrimary(p);
    const b0 = diagnosticPsa(p);
    const baseline = !!(p.age != null && p.date && b0 && (p.race || p.ethnicity) && p.familyHistory != null);
    let pathology = false;
    if (b && b.gleasonPrimary != null && b.gleasonSecondary != null && b.coresTotal != null && b.coresPositive != null && (p.clinicalStage || p.pathologicStage)) {
      pathology = true;
      if (rp) {
        pathology = !!(rp.ptnm && rp.marginStatus && rp.marginStatus !== 'unknown' &&
          rp.ece != null && rp.svi != null && rp.lnExamined != null);
      }
    }
    const first = firstLine(p);
    const treatment = !!(first && first.setting && first.regimen && first.startDate);
    const end = lastContact(p, today);
    const followup = !!(end && p.date && end >= p.date && (p.followupStatus || '在访'));
    const sample = (r.specimenCount || 0) > 0 && (r.timepointCount || 0) > 0;
    const molecular = (r.genomicCount || 0) > 0 || (r.ihcCount || 0) > 0;
    return [
      { key: 'baseline', label: '基线', ready: baseline },
      { key: 'pathology', label: '病理', ready: pathology },
      { key: 'treatment', label: '治疗', ready: treatment },
      { key: 'followup', label: '随访/结局', ready: followup },
      { key: 'sample', label: '样本', ready: sample },
      { key: 'molecular', label: '分子', ready: molecular }
    ];
  }

  function readinessRows(patients, today) {
    const layerDefs = [
      { key: 'baseline', label: '基线', hint: '年龄、诊断日期、诊断 PSA、种族/民族、结构化家族史' },
      { key: 'pathology', label: '病理', hint: 'primary 活检 Gleason/ISUP/针数 + cTNM；RP/TURP 另需 pTNM/切缘/ECE/SVI/LN' },
      { key: 'treatment', label: '治疗', hint: '至少一条结构化治疗线含情境/方案/开始日期' },
      { key: 'followup', label: '随访/结局', hint: '诊断日期 + 末次接触/随访状态' },
      { key: 'sample', label: '样本', hint: '至少一条样本含类型/采样日期/采样时点' },
      { key: 'molecular', label: '分子', hint: '至少一条 IHC 或 NGS/基因检测结果' }
    ];
    return layerDefs.map(d => {
      const ready = [];
      const ids = [];
      (patients || []).forEach(p => {
        const layer = readiness(p, today).find(x => x.key === d.key);
        if (layer && layer.ready) ready.push(p.id); else ids.push(p.id);
      });
      return { key: d.key, label: d.label, hint: d.hint, n: ready.length, total: (patients || []).length, ids };
    });
  }

  function buildOverview(patients, opts) {
    const list = patients || [];
    const today = (opts && opts.today) || localToday();
    const cache = new Map();
    const aOf = p => {
      if (cache.has(p.id)) return cache.get(p.id);
      const a = (opts && opts.assess) ? opts.assess(p) : (C.assess ? C.assess(p, today) : {});
      cache.set(p.id, a);
      return a;
    };
    const ages = list.map(p => num(p.age)).filter(v => v != null);
    const psas = list.map(p => { const x = diagnosticPsa(p); return x ? num(x.val) : null; }).filter(v => v != null);
    const fus = list.map(p => followupMonths(p, today)).filter(v => v != null);
    const endpoints = endpointRows(list, aOf);
    const readyAll = list.filter(p => readiness(p, today).every(x => x.ready));
    const pies = {
      treatment: bucketize(list, p => firstLineGroup(p), PIE.treatment),
      disease: bucketize(list, p => diseaseGroup(aOf(p)), PIE.disease),
      gleason: bucketize(list, p => {
        const g = gleasonOf(p);
        return GLEASONS.includes(g) ? g : 'unknown';
      }, GLEASONS.map((g, i) => ({ key: g, label: g, color: [COLOR.blue, COLOR.green, COLOR.amber, COLOR.purple, COLOR.orange, COLOR.teal, COLOR.gray, COLOR.brown, COLOR.red][i] }))
        .concat([{ key: 'unknown', label: '未录', color: COLOR.lightGray }])),
      warning: bucketize(list, p => warningGroup(aOf(p)), PIE.warning),
      risk: bucketize(list, p => riskGroup(aOf(p)), PIE.risk),
      mstage: bucketize(list, p => mStageGroup(p), PIE.mstage),
      cstage: bucketize(list, p => cStageGroup(p), PIE.cstage),
      isup: bucketize(list, p => {
        const v = isupOfPatient(p);
        return v == null ? 'unknown' : String(v);
      }, PIE.isup),
      age: bucketize(list, p => ageGroup(p), PIE.age),
      lines: bucketize(list, p => lineCountGroup(p), PIE.lines)
    };
    const followup = followupBuckets(list, today);
    return {
      n: list.length,
      cutoff: today,
      kpis: {
        total: list.length,
        medianAge: median(ages),
        ageIqr: iqr(ages),
        medianPsa: median(psas),
        psaIqr: iqr(psas),
        medianFollowup: median(fus),
        followupIqr: iqr(fus),
        bcr: (endpoints.find(x => x.key === 'bcr') || {}).n || 0,
        crpc: (endpoints.find(x => x.key === 'crpc') || {}).n || 0,
        met: (endpoints.find(x => x.key === 'met') || {}).n || 0,
        readyAll: readyAll.length
      },
      pies,
      research: {
        endpoints,
        followup,
        pathology: pathologyRows(list),
        exposures: exposureRows(list),
        molecular: molecularRows(list),
        readiness: readinessRows(list, today)
      }
    };
  }

  return {
    COLOR, PIE, GLEASONS,
    median, quantile, iqr, pct,
    diagnosticPsa, lastContact, followupMonths,
    classifyTreatment, firstLine, firstLineGroup, treatmentExposure, lineCountGroup,
    gleasonOf, isupOfPatient, cStageGroup, mStageGroup, ageGroup, riskGroup, diseaseGroup, warningGroup,
    endpointRows, followupBuckets, pathologyRows, exposureRows, molecularRows,
    readiness, readinessRows, buildOverview
  };
});

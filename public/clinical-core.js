/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * 前列腺随访 2.0 · 临床判定核心
 * ---------------------------------------------------------
 * 纯函数模块，不依赖 DOM / fetch / 数据库。
 * 浏览器：外链 /clinical-core.js → window.ClinicalCore
 * Node 测试：vm.runInNewContext 读取本文件，取 module.exports
 *
 * 设计原则：
 *   1. 只读患者事实（PSA/睾酮/分期/事件/用药），不写库。
 *   2. 所有“状态/预警/随访到期”都由 assess() 一次算清，
 *      页面每次 renderAll 重算，事件改期后不会留下陈旧状态。
 *   3. 指南口径写在函数注释里，避免界面和算法各说各话。
 * ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClinicalCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NGDL_PER_NMOL = 28.84;   /* 1 nmol/L = 28.84 ng/dl；50 ng/dl≈1.734 nmol/L */
  const CASTRATE_NGDL = 50;
  const DEEP_CASTRATE_NGDL = 20;

  /* ---------- 日期与展示 ---------- */
  /* 默认“今天”用本地日历日：toISOString() 是 UTC，东八区凌晨 0–8 点
     会得到昨天，随访到期/去势时效判断会整体错一天。 */
  function localToday() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function addMonths(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function monthsBetween(a, b) {
    const ta = Date.parse(a + 'T00:00:00Z');
    const tb = Date.parse(b + 'T00:00:00Z');
    if (isNaN(ta) || isNaN(tb)) return null;
    return (tb - ta) / (30.44 * 86400000);
  }

  function daysBetween(a, b) {
    const ta = Date.parse(a + 'T00:00:00Z');
    const tb = Date.parse(b + 'T00:00:00Z');
    if (isNaN(ta) || isNaN(tb)) return null;
    return Math.round((tb - ta) / 86400000);
  }

  /* PSA 展示：低于检测下限显示 <下限值，不把 <0.03 显示成 0.03 */
  function fmtPsa(x) {
    if (x && x.belowLod) return '<' + (x.lod != null ? x.lod : x.val);
    return String(x ? x.val : '');
  }

  /* ---------- 分期 / ISUP ---------- */
  function isupOf(g) {
    const m = String(g || '').match(/^(\d)\+(\d)=(\d+)$/);
    if (!m) return null;
    const a = +m[1], b = +m[2], total = +m[3];
    if (total <= 6) return 1;
    if (total === 7) return a === 3 ? 2 : 3;
    if (total === 8) return 4;
    if (total >= 9) return 5;
    return null;
  }

  /* 把 "cT2aN0M0" / "pT3bN1M1c" / "T2aN0M0" 拆成四段；
     拆不出则原样留在 rest，避免旧数据/手填写法被静默丢掉。
     N 允许缺省：审阅验收病例里有 cT1cM1b 这种写法；缺 N 时 n=''，
     cscoStrata 会先按 M1 判转移，不会误入局限风险。 */
  function parseStage(s) {
    const m = String(s || '').trim().match(/^([cp])?(T[\w]*?)(N(?:\d[a-c]?|x))?(M(?:\d[\w]*|x))?$/i);
    if (m) return { pre: (m[1] || '').toLowerCase(), t: m[2], n: m[3] || '', m: m[4] || '', rest: '' };
    return { pre: '', t: '', n: '', m: '', rest: String(s || '').trim() };
  }

  /* 临床分期 cTNM 与病理分期 pTNM 分开读取；旧 stage 作为兼容回退。 */
  function clinicalStageOf(p) {
    if (p && typeof p.clinicalStage === 'string' && p.clinicalStage.trim()) return p.clinicalStage.trim();
    const legacy = String((p && p.stage) || '').trim();
    return legacy && !/^p/i.test(legacy) ? legacy : '';
  }
  function pathologicStageOf(p) {
    if (p && typeof p.pathologicStage === 'string' && p.pathologicStage.trim()) return p.pathologicStage.trim();
    const legacy = String((p && p.stage) || '').trim();
    return legacy && /^p/i.test(legacy) ? legacy : '';
  }
  /* 转移证据：分期字符串之外，影像/结局同样是 M1 的充分证据。
     转移是不可逆的，历史影像也计入；取最近一条作为来源，部位取并集，
     亚型取最高级别（M1c > M1b > M1a > M1 未细分），不允许被更低的 stage 降级。 */
  function splitSites(v) {
    if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean);
    return String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  }
  function mRank(m) {
    const s = String(m || '').toUpperCase();
    if (s === 'M1C') return 4;
    if (s === 'M1B') return 3;
    if (s === 'M1A') return 2;
    if (s === 'M1') return 1;
    return 0;
  }
  function mLabel(m) {
    const s = String(m || '').toUpperCase();
    if (s === 'M1A') return 'M1a';
    if (s === 'M1B') return 'M1b';
    if (s === 'M1C') return 'M1c';
    if (s === 'M1') return 'M1（未细分）';
    return '';
  }
  function subtypeFromSites(sites) {
    const list = (sites || []).map(x => String(x || '').toLowerCase());
    if (list.includes('visceral')) return 'M1C';
    if (list.includes('bone')) return 'M1B';
    if (list.includes('lymph_node')) return 'M1A';
    return 'M1';
  }
  function stageMSubtype(p) {
    const cm = (parseStage(clinicalStageOf(p)).m || '').toUpperCase();
    const pm = (parseStage(pathologicStageOf(p)).m || '').toUpperCase();
    const list = [cm, pm].filter(m => m.startsWith('M1'));
    list.sort((a, b) => mRank(b) - mRank(a));
    return list[0] || '';
  }
  function metastasisEvidence(p) {
    const found = [];
    ((p && p.outcomes) || []).forEach(o => {
      if (o && (o.outcomeType === 'metastasis' || o.type === 'metastasis')) {
        found.push({
          date: o.eventDate || o.date || '',
          sites: splitSites(o.metastaticSites),
          lesionCount: o.lesionCount,
          sourceType: 'outcome'
        });
      }
    });
    ((p && p.imagingStudies) || []).forEach(img => {
      if (!img) return;
      const sites = splitSites(img.metastaticSites);
      if (sites.length) {
        found.push({
          date: img.studyDate || '',
          sites,
          lesionCount: img.lesionCount,
          sourceType: 'imaging'
        });
      }
    });
    ((p && p.events) || []).forEach(e => {
      if (e && (e.type === '转移确认' || e.type === '转移灶局部治疗')) {
        found.push({ date: e.date || '', sites: [], lesionCount: null, sourceType: 'event' });
      }
    });
    if (!found.length) {
      return { m1: false, subtype: null, date: null, sites: [], sourceType: null, lesionCount: null };
    }
    found.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const sites = [];
    found.forEach(x => x.sites.forEach(s => { if (!sites.includes(s)) sites.push(s); }));
    const best = found[0];
    const count = found.map(x => x.lesionCount).find(x => x != null);
    return {
      m1: true,
      subtype: subtypeFromSites(sites),
      date: best.date || null,
      sites,
      sourceType: best.sourceType,
      lesionCount: count == null ? null : count
    };
  }
  function isM1(p) {
    return !!(stageMSubtype(p) || metastasisEvidence(p).m1);
  }

  /* M 分期汇总：M0 / M1 / 未评估-Mx */
  function mStageSummaryOf(p) {
    const s = mStageOf(p);
    if (s === 'M1' || /^M1[abc]$/.test(s)) return 'M1';
    if (s === 'M0') return 'M0';
    return '未评估/Mx';
  }

  /* M 分期明细：M0 / M1a / M1b / M1c / M1（未细分）/ 未评估-Mx */
  function mStageOf(p) {
    const st = stageMSubtype(p);
    const ev = metastasisEvidence(p);
    const candidates = [st, ev.m1 ? ev.subtype : ''].filter(Boolean);
    candidates.sort((a, b) => mRank(b) - mRank(a));
    if (candidates.length) return mLabel(candidates[0]);
    const cm = (parseStage(clinicalStageOf(p)).m || '').toUpperCase();
    const pm = (parseStage(pathologicStageOf(p)).m || '').toUpperCase();
    if (cm === 'M0' || pm === 'M0') return 'M0';
    return '未评估/Mx';
  }

  /* ---------- 睾酮单位 ---------- */
  function toNgdl(value, unit) {
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    if (unit === 'nmol/L') return Math.round(v * NGDL_PER_NMOL * 100) / 100;
    return Math.round(v * 100) / 100;
  }

  function fromNgdl(value, unit) {
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    if (unit === 'nmol/L') return Math.round(v / NGDL_PER_NMOL * 100) / 100;
    return Math.round(v * 100) / 100;
  }

  /* ---------- 治疗情境与 PSA 序列 ---------- */
  /* 当前生效治疗线：优先取今天仍在用、开始日期最晚的一条；
     没有生效线时退回最近一条历史线，便于查看停药后的 PSA 序列。 */
  function activeTreatmentLine(p, today) {
    const todayIso = today || localToday();
    const lines = (p && p.treatmentLines ? p.treatmentLines.slice() : [])
      .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)) || (b.lineNo || 0) - (a.lineNo || 0));
    const active = lines.filter(l => l.startDate && l.startDate <= todayIso && (!l.endDate || l.endDate >= todayIso));
    return active[0] || lines[0] || null;
  }

  /* 手术是客观历史，不应因为后来加了 ADT/ARPI 而被当前治疗线覆盖。
     BCR/临床治愈判定必须独立找到“做过根治术”这件事。 */
  function isSurgeryText(text) {
    const s = String(text || '');
    if (!s) return false;
    if (/去势/.test(s) && !/根治|RP|前列腺切除/i.test(s)) return false;
    /* TURP/电切是姑息性经尿道切除，不是根治术：
       术后 6–12 周 PSA 窗口与 BCR 判定只适用于根治性切除，
       把 TURP 当根治术会造出错误的 persistence/复发结论。 */
    if (/TURP|电切/i.test(s) && !/根治/i.test(s)) return false;
    return /前列腺癌根治术|根治性前列腺切除术|根治性手术|根治术|前列腺切除|\bRP\b|手术/i.test(s);
  }
  function surgeryContext(p) {
    const events = (p && p.events ? p.events : []).slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const ev = events.find(e => e && (e.isSurgery || isSurgeryText(e.type)));
    const lines = (p && p.treatmentLines ? p.treatmentLines.slice() : [])
      .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
    const line = lines.find(l => {
      const t = [l.setting, l.regimen].concat((l.agents || []).map(a => a.drug || '')).join(' ');
      return isSurgeryText(t);
    });
    const since = (ev && ev.date) || (p && p.surgDate) || (line && line.startDate) || null;
    if (!ev && !line && !(p && p.surgDate) && !isSurgeryText(p && p.treatment)) return null;
    return { kind: 'surgery', since, event: ev || null, line: line || null };
  }

  function treatmentContext(p, today) {
    const line = activeTreatmentLine(p, today);
    if (line) {
      const t = [line.setting, line.regimen]
        .concat((line.agents || []).map(a => a.drug || '')).join(' ');
      const since = line.startDate || null;
      if (isSurgeryText(t)) return { kind: 'surgery', since, line };
      if (/放疗|EBRT|SBRT/.test(t)) return { kind: 'rt', since, line };
      if (/nmCRPC|mCRPC|mHSPC|ADT|内分泌|去势|戈舍瑞林|亮丙瑞林|曲普瑞林|地加瑞克|瑞卢戈利|比卡鲁胺|氟他胺|尼鲁米特|阿比特龙|阿帕他胺|恩扎卢胺|达罗他胺|瑞维鲁胺/i.test(t)) {
        return { kind: 'adt', since, line };
      }
      if (/主动监测/.test(t)) return { kind: 'as', since: null, line };
      if (/观察等待|观察/.test(t)) return { kind: 'ww', since: null, line };
      return { kind: 'other', since, line };
    }
    /* 旧数据兼容：没有治疗线时继续读首选治疗。 */
    const t = p.treatment || '';
    if (isSurgeryText(t)) return { kind: 'surgery', since: p.surgDate || null };
    if (t.includes('放疗')) return { kind: 'rt', since: p.rtEndDate || null };
    if (t.includes('内分泌')) return { kind: 'adt', since: p.adtStartDate || null };
    if (t.includes('主动监测')) return { kind: 'as', since: null };
    if (t.includes('观察')) return { kind: 'ww', since: null };
    /* P1-01：只录“用药”没录治疗线时，ADT/ARPI 仍然是一个治疗情境，
       否则疾病状态和随访计划都会退回“待评估”。 */
    const todayIso = today || localToday();
    const meds = (p.medications || [])
      .filter(m => m && ['adt', 'arpi', 'endocrine'].includes(m.category) &&
        m.startDate && m.startDate <= todayIso && (!m.endDate || m.endDate >= todayIso))
      .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
    if (meds.length) return { kind: 'adt', since: meds[0].startDate, medication: meds[0], source: 'medication' };
    return { kind: 'other', since: null };
  }

  /* 严格晚于治疗日：治疗当天通常是治疗前最后一次 PSA */
  function postSeq(p, today) {
    const ctx = treatmentContext(p, today);
    const all = (p.psa || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id || 0) - (b.id || 0));
    if (!ctx.since) return { ctx, seq: all };
    return { ctx, seq: all.filter(x => x.date > ctx.since) };
  }

  function linReg(pts) {
    const n = pts.length;
    if (n < 3) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    pts.forEach(([x, y]) => { sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; });
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const slope = (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    const denY = n * syy - sy * sy;
    const r2 = denY ? Math.pow(n * sxy - sx * sy, 2) / (den * denY) : 1;
    return { slope, intercept, r2 };
  }

  function psadtMonths(seq) {
    const pts = (seq || []).filter(x => Number(x.val) > 0);
    if (pts.length < 3) return null;
    const t0 = pts[0].date;
    const span = monthsBetween(t0, pts[pts.length - 1].date);
    if (span == null || span < 3) return null;
    const reg = linReg(pts.map(x => [monthsBetween(t0, x.date), Math.log(Number(x.val))]));
    if (!reg || reg.slope <= 0 || reg.r2 < 0.7) return null;
    return 0.693 / reg.slope;
  }

  function psavPerYear(seq) {
    const pts = (seq || []).slice();
    if (pts.length < 3) return null;
    const t0 = pts[0].date;
    const span = monthsBetween(t0, pts[pts.length - 1].date);
    if (span == null || span < 6) return null;
    const reg = linReg(pts.map(x => [monthsBetween(t0, x.date) / 12, Number(x.val)]));
    return reg ? reg.slope : null;
  }

  /* ---------- CSCO 5.2 风险分层 ----------
     N1/M1 先单列，不进入局限低/中/高/极高危。
     临床风险固定读：临床 cTNM + 活检 ISUP/Gleason + 初始 PSA + 穿刺阳性针数。
     RP/TURP 的 Gleason 只用于术后复发风险，不能替代临床风险分层。 */
  function byDateDesc(a, b) {
    return String(b.reportDate || b.studyDate || b.startDate || '').localeCompare(
      String(a.reportDate || a.studyDate || a.startDate || '')
    );
  }
  function gleasonOfReport(x) {
    if (!x || x.gleasonPrimary == null || x.gleasonSecondary == null) return '';
    return x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + (x.gleasonPrimary + x.gleasonSecondary);
  }
  function pickBiopsyPathology(p) {
    /* 只有医生明确勾选“主要病理”的活检才能进入临床风险。
       非主要报告只是补充记录，不能静默改写主档 Gleason（审计 P0-01/P2-01）。 */
    return ((p && p.pathologyReports) || []).find(x =>
      x && x.isPrimary && x.specimenType === 'biopsy' &&
      x.gleasonPrimary != null && x.gleasonSecondary != null) || null;
  }
  function pickPostopPathology(p) {
    const arr = ((p && p.pathologyReports) || []).filter(x =>
      x && (x.specimenType === 'RP' || x.specimenType === 'TURP'));
    if (!arr.length) return null;
    return arr.find(x => !!x.isPrimary) || arr.slice().sort(byDateDesc)[0];
  }

  function cscoStrata(p) {
    /* 风险分层固定读临床分期；病理分期不能代替 cTNM。 */
    const st = parseStage(clinicalStageOf(p));
    const tRaw = (st.t || '').toUpperCase();
    const n = (st.n || '').toUpperCase();
    const m = (st.m || '').toUpperCase();
    const biopsy = pickBiopsyPathology(p);
    const clinicalGleason = biopsy ? gleasonOfReport(biopsy) : '';
    const isup = isupOf(clinicalGleason);
    const initial = (p && p.psa && p.psa.length)
      ? (p.psa.find(x => x.isInitial) || p.psa[0])
      : null;
    const psa0 = initial ? Number(initial.val) : null;
    const tNum = parseFloat(tRaw.replace('T', ''));
    const coresTotal = biopsy && biopsy.coresTotal != null ? Number(biopsy.coresTotal) : null;
    const coresPositive = biopsy && biopsy.coresPositive != null ? Number(biopsy.coresPositive) : null;
    const coresPct = (coresTotal && coresPositive != null)
      ? (biopsy.coresPositivePct != null ? Number(biopsy.coresPositivePct) / 100 : coresPositive / coresTotal)
      : null;
    const basis = '临床 cTNM + ' + (biopsy ? ('主要活检 ISUP/Gleason（活检病理 #' + (biopsy.id != null ? biopsy.id : '?') + '）') : '无主要活检病理（不使用档案/RP Gleason）') +
      ' + 初始 PSA' + (coresPct != null ? ' + 穿刺阳性针数' : '');
    const source = {
      clinicalStage: 'cTNM',
      gleason: biopsy ? 'biopsy' : 'none',
      biopsyId: biopsy ? (biopsy.id != null ? biopsy.id : null) : null,
      psa: initial && initial.isInitial ? 'initial' : 'first-psa'
    };

    if (isM1(p)) {
      const ev = metastasisEvidence(p);
      return {
        strata: '转移',
        why: 'M1 远处转移（' + (ev.sourceType === 'imaging' ? '影像' : ev.sourceType === 'outcome' ? '转移确认结局' : '分期/事件') +
          (ev.date ? ' ' + ev.date : '') + (ev.sites.length ? '，部位 ' + ev.sites.join('/') : '') +
          '）；不适用局限风险分层，按转移性疾病路径管理（NCCN 将 Regional/Metastatic 单列）',
        source, basis
      };
    }
    if (n === 'N1') {
      return {
        strata: '区域',
        why: 'N1 区域淋巴结转移，不适用局限风险分层；按区域性疾病路径管理（临床风险仍以 cTNM 为准）',
        source, basis
      };
    }
    if (!tRaw) {
      return {
        strata: '需临床分期',
        why: '当前无临床分期 cTNM；局限风险分层不能用病理分期代替（指南 5.2）',
        source, basis
      };
    }
    if (!biopsy) {
      return {
        strata: '需活检确认',
        why: '当前没有勾选“主要病理”的活检报告。临床风险分层必须用活检 ISUP/Gleason，不能拿档案手工值或 RP/TURP 分级代替；请补录或把一份活检设为主要病理。',
        source, basis
      };
    }
    if (!tRaw || isup === null || psa0 === null || !Number.isFinite(psa0)) {
      return {
        strata: '数据不足',
        why: '分期/ISUP/初始PSA 不全，无法按指南 5.2 分层' +
          (biopsy ? '' : '；当前无活检 Gleason，不能用 RP/TURP 病理替代临床风险分级'),
        source, basis
      };
    }
    if (!n || n === 'NX' || !m || m === 'MX') {
      return {
        strata: '分期不足',
        why: '需 cN0M0 才能做局限风险分层；当前 N/M 缺失或为 Nx/Mx',
        source, basis
      };
    }
    const pNote = st.pre === 'p' ? '。注意：当前为病理分期 pTNM，临床风险分层应以 cTNM 为准' : '';
    const t34 = !isNaN(tNum) && tNum >= 3;
    const t2bc = tRaw === 'T2B' || tRaw === 'T2C';
    const veryHigh = [t34, isup >= 4, psa0 >= 40].filter(Boolean).length >= 2;
    if (veryHigh) {
      return {
        strata: '极高危',
        why: 'cT3-4 / ISUP4-5 / PSA≥40 中至少具备两项（p88）' + pNote,
        source, basis
      };
    }
    if (t34 || isup >= 4 || psa0 > 20) {
      return {
        strata: '高危',
        why: 'cT3~cT4、ISUP 组别 4/5、PSA>20 之一（p88）' + pNote,
        source, basis
      };
    }
    const irf = [t2bc, isup === 2 || isup === 3, psa0 >= 10 && psa0 <= 20].filter(Boolean).length;
    const coresNote = coresPct == null
      ? '；穿刺阳性针数未录，预后良好/不良暂按 IRF 个数与 ISUP 判定'
      : '；穿刺阳性针数 ' + (coresPositive != null ? coresPositive : '?') + '/' + (coresTotal != null ? coresTotal : '?') +
        '（' + Math.round(coresPct * 1000) / 10 + '%）' + (coresPct >= 0.5 ? '，≥50% → 预后不良' : '，<50%');
    if (irf >= 1) {
      const good = irf === 1 && isup <= 2 && (coresPct == null || coresPct < 0.5);
      const bad = irf >= 2 || isup === 3 || (coresPct != null && coresPct >= 0.5);
      return {
        strata: bad ? '中危(预后不良)' : (good ? '中危(预后良好)' : '中危'),
        why: '至少 1 个中危风险因素（cT2b-2c / ISUP2-3 / PSA10~20），未含高危特征（p88）' +
          coresNote + '。风险依据：' + basis + pNote,
        source, basis
      };
    }
    if (tNum <= 2 && isup === 1 && psa0 < 10) {
      return {
        strata: '低危',
        why: 'cT1-2 且 ISUP 组别 1 且 PSA<10（p88）。风险依据：' + basis + pNote,
        source, basis
      };
    }
    return {
      strata: '数据不足',
      why: '各分层条件均不满足，请核对录入' + pNote,
      source, basis
    };
  }

  /* ---------- 术后临床治愈（6 周 PSA ≤0.03） ---------- */
  /* ---------- 术后临床治愈 / 术后 BCR ----------
     NCCN 2027 PROS-9：persistence 用术后 6–12 周（42–90 天）PSA 判断。
     窗口内有多次检测时取最后一次（最接近 12 周）；术后 6 周内的 PSA
     只作“待复查”，不单独定义 persistence。 */
  const RP_BCR_MIN_DAYS = 42;
  const RP_BCR_MAX_DAYS = 90;
  function rpWindow(ctx, seq) {
    const after = (seq || []).filter(x => x.date >= ctx.since);
    const inWindow = after.filter(x => {
      const d = daysBetween(ctx.since, x.date);
      return d != null && d >= RP_BCR_MIN_DAYS && d <= RP_BCR_MAX_DAYS;
    });
    /* persistence 看窗口内最后一次；判断后续上升时要从窗口内第一次“不可测”起算，
       否则 0.05→0.08 都在窗口内时会被最后一次 0.08 掩盖掉上升。 */
    const last = inWindow.length ? inWindow[inWindow.length - 1] : null;
    const firstUndetectable = inWindow.find(x => !!x.belowLod || Number(x.val) < 0.1) || null;
    return { after, inWindow, last, firstUndetectable };
  }

  function clinicalCure(p, ctx, seq) {
    if (ctx.kind !== 'surgery' || !ctx.since) return null;
    const w = rpWindow(ctx, seq);
    if (!w.last) {
      const early = w.after.find(x => {
        const d = daysBetween(ctx.since, x.date);
        return d != null && d < RP_BCR_MIN_DAYS;
      });
      return {
        state: '未记录',
        note: early
          ? '术后 ' + early.date + ' PSA 早于 6 周，不能作为临床治愈判据；需 6–12 周复查（p112/p206）'
          : '术后 6–12 周内无 PSA 记录，无法判定临床治愈（p112/p206）'
      };
    }
    const x = w.last;
    const cured = x.belowLod || Number(x.val) <= 0.03;
    return cured
      ? { state: '已达临床治愈', note: x.date + ' PSA ' + fmtPsa(x) + ' ≤0.03，符合术后 6 周检测不到/0.03 以下（p112）' }
      : { state: '未达临床治愈', note: x.date + ' PSA ' + fmtPsa(x) + ' >0.03，属生化复发独立危险因素，需密切追踪（p112）' };
  }

  /* ---------- 去势状态：由最新睾酮计算 ---------- */
  function castrationState(p, today) {
    const list = (p && p.testo ? p.testo.slice() : [])
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id || 0) - (b.id || 0));
    const last = list[list.length - 1];
    if (last && Number.isFinite(Number(last.val))) {
      const val = Number(last.val);
      const ageDays = daysBetween(last.date, today);
      const fresh = ageDays != null && ageDays <= 120;
      return {
        status: val < CASTRATE_NGDL ? 'castrate' : 'noncastrate',
        verified: fresh,
        value: val,
        unit: last.unit || 'ng/dl',
        enteredVal: last.enteredVal != null ? last.enteredVal : val,
        date: last.date,
        ageDays,
        source: 'testosterone',
        detail: '最新睾酮 ' + last.date + ' ' + val + ' ng/dl' +
          (fresh ? '（≤120 天，已核实）' : '（超过 120 天，建议复测）')
      };
    }
    if (p && p.castration === true) {
      return { status: 'castrate', verified: false, source: 'manual', detail: '去势状态为手工标记「是」，无睾酮记录，未核实' };
    }
    if (p && p.castration === false) {
      return { status: 'noncastrate', verified: false, source: 'manual', detail: '去势状态为手工标记「否」，无睾酮记录，未核实' };
    }
    return { status: 'unknown', verified: false, source: 'none', detail: '无睾酮记录，无法确认去势水平' };
  }

  /* ---------- 术后 BCR：NCCN 2027 persistence / recurrence ----------
     术后 6–12 周最后一次 PSA：
       不可测（<LOD 或 <0.1）→ undetectable
       ≥0.1 → persistent（持续可测，不是 recurrence）
       无窗口 PSA → indeterminate（不拿术后 7 天 0.2 判 persistence）
     已不可测后：
       任一次 >0.1 → recurrence
       或连续两次上升且末值 ≥0.05 → recurrence
       仅一次上升且末值 ≥0.05 → pending（不是“持续不可测”） */
  function rpBcr(p, ctx, seq) {
    if (ctx.kind !== 'surgery') return { state: 'none', detail: '' };
    if (!ctx.since) return { state: 'indeterminate', detail: '缺少根治术日期，无法按术后 6–12 周窗口判定' };
    const w = rpWindow(ctx, seq);
    if (!w.after.length) return { state: 'indeterminate', detail: '术后尚无 PSA 记录；需在术后 6–12 周（42–90 天）窗口复查，不能以术前值判断' };
    if (!w.last) {
      const early = w.after.find(x => {
        const d = daysBetween(ctx.since, x.date);
        return d != null && d < RP_BCR_MIN_DAYS;
      });
      /* 如果窗口已过、后续有多次复查，不能因为“没卡在 42–90 天”就永久判待复查。
         后续一直不可测 → 按未达复发随访，但标记 missingWindow 提醒补窗口；
         后续出现 ≥0.1 → 仍无法区分 persistence/recurrence，保持 indeterminate。 */
      const later = w.after.filter(x => {
        const d = daysBetween(ctx.since, x.date);
        return d != null && d > RP_BCR_MAX_DAYS;
      });
      if (later.length) {
        const allUndetectable = later.every(x => !!x.belowLod || Number(x.val) < 0.1);
        const last = later[later.length - 1];
        if (allUndetectable) {
          return {
            state: 'undetectable',
            missingWindow: true,
            detail: '未按术后 6–12 周窗口复查；后续 ' + last.date + ' PSA ' + fmtPsa(last) + ' 不可测，暂按未达复发随访，建议补一次窗口/近期 PSA'
          };
        }
        return {
          state: 'indeterminate',
          missingWindow: true,
          detail: '缺少术后 6–12 周窗口 PSA，且后续出现 ≥0.1；无法可靠区分 persistence 与 recurrence，请结合影像/临床判断'
        };
      }
      return {
        state: 'indeterminate',
        detail: early
          ? '术后 ' + early.date + ' PSA ' + fmtPsa(early) + ' 早于 6 周，不能定义 persistence；需 6–12 周复查'
          : '缺少术后 6–12 周 PSA，无法区分 persistence 与 recurrence'
      };
    }
    const undetectable = x => !!x.belowLod || Number(x.val) < 0.1;
    if (!undetectable(w.last)) {
      return {
        state: 'persistent',
        detail: '术后 6–12 周 ' + w.last.date + ' PSA ' + fmtPsa(w.last) + ' ≥0.1，属术后持续可测（persistence），不是 recurrence；按 CSCO 连续两次≥0.1 会判复发，本系统优先标记 persistence'
      };
    }
    const baseline = w.firstUndetectable || w.last;
    const later = w.after.filter(x => x.date > baseline.date);
    if (!later.length) {
      return { state: 'undetectable', detail: '术后 6–12 周 ' + baseline.date + ' PSA ' + fmtPsa(baseline) + ' 不可测，暂无后续复查' };
    }
    const over = later.find(x => Number(x.val) > 0.1);
    if (over) {
      return { state: 'recurrence', detail: '术后曾不可测，' + over.date + ' PSA ' + fmtPsa(over) + ' >0.1，符合 recurrence（NCCN 2027）' };
    }
    const points = [baseline].concat(later);
    let risingPairs = 0;
    let lastPair = null;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (Number(b.val) > Number(a.val)) {
        risingPairs += 1;
        lastPair = [a, b];
      } else {
        risingPairs = 0;
        lastPair = null;
      }
    }
    if (risingPairs >= 2 && lastPair && Number(lastPair[1].val) >= 0.05) {
      return {
        state: 'recurrence',
        detail: '术后曾不可测，' + lastPair[0].date + '→' + lastPair[1].date + ' PSA ' +
          fmtPsa(lastPair[0]) + '→' + fmtPsa(lastPair[1]) + ' 连续上升，符合 recurrence（NCCN 2027）'
      };
    }
    if (risingPairs >= 1 && lastPair) {
      return {
        state: 'pending',
        detail: '术后曾不可测，' + lastPair[0].date + '→' + lastPair[1].date + ' PSA ' +
          fmtPsa(lastPair[0]) + '→' + fmtPsa(lastPair[1]) + ' 轻度上升，尚需下一次复查确认'
      };
    }
    const last = later[later.length - 1];
    return { state: 'undetectable', detail: '术后 PSA 持续不可测（最近 ' + last.date + ' ' + fmtPsa(last) + '）' };
  }

  /* ---------- 放疗后 BCR：Phoenix nadir+2 ---------- */
  function rtBcr(seq) {
    if (!seq || !seq.length) return { state: 'none', nadir: null, detail: '' };
    const nadir = Math.min.apply(null, seq.map(x => Number(x.val)));
    const last = Number(seq[seq.length - 1].val);
    if (last >= nadir + 2) {
      return { state: 'recurrence', nadir, detail: '最新 ' + last + ' 较最低值 ' + nadir + ' 升高 ≥2 ng/ml（p118 Phoenix 标准）' };
    }
    const prev = seq.length > 1 ? Number(seq[seq.length - 2].val) : null;
    if (prev != null && last > prev && last > nadir) {
      return { state: 'pending', nadir, detail: '最新 ' + last + ' 较前次 ' + prev + ' 上升但未达 nadir+2（' + (nadir + 2).toFixed(2) + '），需继续复查' };
    }
    return { state: 'none', nadir, detail: '距 nadir+2（' + (nadir + 2).toFixed(2) + '）尚差 ' + Math.max(0, nadir + 2 - last).toFixed(2) };
  }

  /* ---------- nmCRPC ----------
     必须先确认去势水平；无近期睾酮或睾酮未达去势，不能确诊。 */
  function nmCrpc(p, seq, castration) {
    if (isM1(p)) return null;
    if (!castration || castration.status === 'unknown') {
      return { state: 'indeterminate', confirmed: false, detail: '无睾酮记录，无法确认去势水平，不能诊断 nmCRPC' };
    }
    /* 未核实（手工标记/超过 120 天）一律“无法判定”，不能当阴性。
       否则旧库 castration_status=0 的历史默认值会把患者误判成“未去势”。 */
    if (!castration.verified) {
      return { state: 'indeterminate', confirmed: false, detail: castration.detail + '；需近期睾酮确认去势水平后再判 nmCRPC' };
    }
    if (castration.status === 'noncastrate') {
      return { state: 'not_castrate', confirmed: false, detail: '最新睾酮 ' + castration.detail + '，未达去势水平，不能诊断 nmCRPC' };
    }
    for (let i = 2; i < (seq || []).length; i++) {
      const a = seq[i - 2], b = seq[i - 1], c = seq[i];
      const d1 = daysBetween(a.date, b.date), d2 = daysBetween(b.date, c.date);
      if (d1 != null && d2 != null && d1 >= 7 && d2 >= 7 &&
          Number(b.val) > Number(a.val) && Number(c.val) > Number(b.val) &&
          Number(a.val) > 0 && Number(c.val) > Number(a.val) * 1.5 &&
          Number(c.val) >= 2) {
        return { state: 'confirmed', confirmed: true, detail: a.date + '→' + c.date + ' 间隔≥1 周连续 2 次上升、较基础值升高>50% 且 PSA≥2 ng/ml（p154；PCWG3 绝对值门槛）' };
      }
    }
    return { state: 'none', confirmed: false, detail: '去势状态下 PSA 未达进展标准（需连续 2 次间隔≥1 周上升、较基础值升高>50% 且 PSA≥2 ng/ml）' };
  }

  /* ---------- mCRPC PSA 进展（附录 11.3） ---------- */
  function mCrpcProgress(p, seq, castration) {
    if (!isM1(p)) return null;
    if (!castration || castration.status === 'unknown') {
      return { state: 'indeterminate', confirmed: false, detail: 'M1 但无睾酮记录，无法确认去势水平，不能诊断 mCRPC' };
    }
    if (!castration.verified) {
      return { state: 'indeterminate', confirmed: false, detail: 'M1 但' + castration.detail + '；需近期睾酮确认去势水平' };
    }
    if (castration.status === 'noncastrate') {
      return { state: 'not_castrate', confirmed: false, detail: 'M1 但最新睾酮未达去势水平，不能诊断 mCRPC' };
    }
    if (!seq || seq.length < 2) return { state: 'none', confirmed: false, detail: '' };
    const nadir = Math.min.apply(null, seq.map(x => Number(x.val)));
    const last = seq[seq.length - 1], prevLast = seq[seq.length - 2];
    const rise25 = nadir > 0 ? Number(last.val) >= nadir * 1.25 : Number(last.val) >= nadir + 2;
    if (rise25 && Number(last.val) - nadir >= 2 && Number(last.val) > Number(prevLast.val) &&
        (daysBetween(prevLast.date, last.date) || 0) >= 21) {
      return { state: 'confirmed', confirmed: true, detail: 'PSA 较最低值 ' + nadir + ' 升高≥25% 且绝对差≥2 ng/ml，间隔≥3 周确认（p215）' };
    }
    return { state: 'none', confirmed: false, detail: '' };
  }

  /* ---------- 高危复发风险（术后/放疗后随访强度） ----------
     这里用 RP/TURP 的 ISUP 与 pT 分期；临床 CSCO 风险仍由 cscoStrata 使用活检。
     pN1 的随访强度按科室决定暂不纳入（保持现状）。 */
  function highRecurrenceRisk(p, strataStr, bcrConfirmed) {
    const rp = pickPostopPathology(p);
    const st = parseStage((rp && rp.ptnm) || pathologicStageOf(p) || clinicalStageOf(p));
    const isup = (rp && rp.isup != null) ? rp.isup : isupOf(p && p.gleason);
    const tNum = parseFloat(String(st.t || '').replace(/T/i, ''));
    return !!bcrConfirmed || ['高危', '极高危', '区域', '转移'].includes(strataStr) ||
      isup >= 4 || (!isNaN(tNum) && tNum >= 3);
  }

  /* ---------- 转移负荷（CHAARTED 高/低瘤负荷） ---------- */
  function tumorBurden(p) {
    const count = p && p.metCount != null ? Number(p.metCount) : null;
    const visceral = p ? p.visceralMet : null;
    const extra = p ? p.metExtraPelvis : null;
    if (visceral === true) {
      return { level: 'high', label: '高瘤负荷', basis: '内脏转移（CHAARTED 高瘤负荷）' };
    }
    if (count != null && count >= 4) {
      if (extra === true) return { level: 'high', label: '高瘤负荷', basis: '≥4 处转移且至少 1 处位于盆腔/脊柱外（CHAARTED）' };
      if (extra == null) return { level: 'unknown', label: '负荷未评估', basis: '转移灶≥4 处，但缺“是否位于盆腔/脊柱外”，无法判高/低瘤负荷' };
    }
    if (count != null && count >= 0) {
      return { level: 'low', label: '低瘤负荷', basis: count + ' 处转移' + (extra === false ? '，均位于盆腔/脊柱内' : '') };
    }
    /* oligo_type 统一存英文 code（none/oligo/oligo_sync/oligo_meta/widespread/unknown）。
       旧数据里的中文值由 server.js 启动迁移转换；这里只认 code。 */
    if (p && p.oligoType === 'widespread') {
      return { level: 'high', label: '高瘤负荷', basis: '寡转移/瘤负荷分层为广泛转移' };
    }
    if (p && (p.oligoType === 'oligo' || p.oligoType === 'oligo_sync' || p.oligoType === 'oligo_meta')) {
      return { level: 'low', label: '寡转移', basis: '寡转移状态' };
    }
    if (p && p.oligoType === 'none') return { level: 'none', label: '无转移', basis: '寡转移状态' };
    return { level: 'unknown', label: '负荷未评估', basis: '缺转移灶数量/部位，无法判高/低瘤负荷' };
  }

  /* ---------- 事件与最近接触 ---------- */
  function hasEvent(p, type) {
    return (p && p.events ? p.events : []).some(e => e && e.type === type);
  }

  function hasMetEvent(p) {
    return hasEvent(p, '转移确认') || hasEvent(p, '转移灶局部治疗');
  }

  function lastPsaDate(p) {
    const list = (p && p.psa ? p.psa : []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return list.length ? list[list.length - 1].date : null;
  }

  function lastTestoDate(p) {
    const list = (p && p.testo ? p.testo : []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return list.length ? list[list.length - 1].date : null;
  }

  function eventDateByTypes(p, types) {
    const evs = (p && p.events ? p.events : []).filter(e => e && types.some(t => e.type === t || String(e.type || '').includes(t)));
    return evs.length ? evs.map(e => e.date).sort().pop() : null;
  }

  /* 结构化监测记录里某个项目最近一次日期；用于 DEXA/FRAX 等随访锚点。 */
  function clinicalRecordDate(p, items) {
    const rows = (p && p.clinicalRecords ? p.clinicalRecords : [])
      .filter(r => items.some(x => r.category && (r.item === x || String(r.item || '').includes(x))));
    return rows.length ? rows.map(r => r.date).sort().pop() : null;
  }

  function lastContact(p) {
    const dates = [];
    if (p.lastFollowupDate) dates.push(p.lastFollowupDate);
    (p.psa || []).forEach(x => dates.push(x.date));
    (p.testo || []).forEach(x => dates.push(x.date));
    (p.events || []).forEach(x => dates.push(x.date));
    (p.medications || []).forEach(x => { if (x.startDate) dates.push(x.startDate); if (x.endDate) dates.push(x.endDate); });
    const valid = dates.filter(Boolean).sort();
    return valid.length ? valid[valid.length - 1] : null;
  }

  function needsCastration(p) {
    const t = (p && p.treatment) || '';
    if (t.includes('内分泌') || t.includes('去势')) return true;
    if (p.castration === true) return true;
    if (isM1(p)) return true;
    if ((p.medications || []).some(m => ['adt', 'arpi', 'endocrine'].includes(m.category))) return true;
    if ((p.treatmentLines || []).some(l => /ADT|内分泌|去势|mHSPC|nmCRPC|mCRPC/.test(String(l.setting || '') + ' ' + String(l.regimen || '')))) return true;
    if ((p.events || []).some(e => /ADT启动|新型内分泌治疗|手术去势|去势抵抗确认/.test(String(e.type || '')))) return true;
    return false;
  }

  /* 每个随访项目各自的上次完成日期 */
  /* 治疗后的随访项目只认治疗开始后的记录：
     术前 DRE/影像不是术后随访基线，不能拿来算“下次随访”到期日。 */
  function eventDateByTypesAfter(p, types, since) {
    const evs = (p && p.events ? p.events : []).filter(e => e && types.some(t => e.type === t || String(e.type || '').includes(t)));
    const filtered = since ? evs.filter(e => e.date >= since) : evs;
    return filtered.length ? filtered.map(e => e.date).sort().pop() : null;
  }

  function itemLastDone(p, item, ctx) {
    if (item.includes('PSA')) return lastPsaDate(p);
    if (item.includes('睾酮')) return lastTestoDate(p);
    if (item.includes('DEXA') || item.includes('骨密度')) {
      return clinicalRecordDate(p, ['DEXA_T', 'DEXA', '骨密度']) ||
        eventDateByTypes(p, ['骨密度检测(DEXA)', '骨密度']) || null;
    }
    if (item.includes('FRAX')) {
      return clinicalRecordDate(p, ['FRAX_HIP', 'FRAX_MAJOR', 'FRAX']) ||
        eventDateByTypes(p, ['FRAX骨折风险评估', 'FRAX']) || null;
    }
    if (item.includes('mpMRI')) {
      return eventDateByTypesAfter(p, ['多参数磁共振(mpMRI)', 'mpMRI'], ctx.since) || ctx.since || p.date;
    }
    if (item.includes('影像')) {
      return eventDateByTypesAfter(p, ['影像学复查', 'PSMA PET-CT', '骨扫描(ECT)', '多参数磁共振(mpMRI)', 'CT', 'MRI'], ctx.since) || ctx.since || p.date;
    }
    if (item.includes('DRE')) {
      return eventDateByTypesAfter(p, ['直肠指检(DRE)', '随访DRE'], ctx.since) || ctx.since || p.date;
    }
    if (item.includes('活检') || item.includes('穿刺')) {
      return eventDateByTypesAfter(p, ['前列腺穿刺活检病理报告', '前列腺穿刺活检', '前列腺瘤床穿刺活检', '重复穿刺活检'], ctx.since) || ctx.since || p.date;
    }
    if (item.includes('化验') || item.includes('肌酐') || item.includes('血红蛋白') || item.includes('肝功能') || item.includes('代谢') || item.includes('心脑血管')) {
      const codes = [];
      if (item.includes('肌酐')) codes.push('CREAT');
      if (item.includes('血红蛋白')) codes.push('HB');
      if (item.includes('肝功能')) codes.push('ALT', 'AST', 'ALP', 'TBIL');
      const labDates = ((p && p.labValues) || [])
        .filter(x => x && x.date && (!codes.length || codes.includes(x.itemCode)))
        .map(x => x.date).sort();
      if (labDates.length) return labDates[labDates.length - 1];
      return eventDateByTypes(p, ['化验/监测', '肌酐/血红蛋白/肝功能', '代谢并发症监测', '心脑血管疾病监测']) || ctx.since || p.date;
    }
    return lastContact(p) || ctx.since || p.date;
  }

  /* ---------- 随访计划：按项目锚定上次完成日期 ---------- */
  function cscoFollowupPlan(p, ctx, bcr, today, surgeryCtx, bcrEvent) {
    const out = [];
    const lines = (p && p.treatmentLines) || [];
    const meds = (p && p.medications) || [];
    const hasTreatment = !!(p && (p.treatment || lines.length ||
      meds.some(m => m && ['adt', 'arpi', 'endocrine'].includes(m.category))));
    if (!hasTreatment) return { intervals: out, overdue: null, missing: [] };
    const fs = p.followupStatus || '在访';
    if (fs === '死亡' || fs === '失访') return { intervals: out, overdue: null, missing: [] };
    const bcrConfirmed = !!(bcrEvent || (bcr && (bcr.state === 'recurrence' || bcr.state === 'persistent')));
    const bcrPending = !!(bcr && bcr.state === 'pending');
    const treatDate = ctx.since || p.date;
    const yearsSince = treatDate ? monthsBetween(treatDate, today) / 12 : null;
    const adtMonths = ctx.since ? monthsBetween(ctx.since, today) : null;
    const testoEvery = adtMonths != null && adtMonths < 6 ? 1 : (adtMonths != null && adtMonths > 36 ? 6 : 3);
    const add = (item, every, basis, opts) => out.push(Object.assign({
      item, every, basis, baseline: !!(opts && opts.baseline)
    }, opts || {}));
    const addPsa = (every, basis) => {
      const existing = out.find(o => o.item === '血清 PSA');
      if (existing) {
        existing.every = Math.min(existing.every, every);
        existing.basis = basis;
      } else {
        add('血清 PSA', every, basis);
      }
    };

    if (isM1(p)) {
      add('血清 PSA', 3, 'M1 系统治疗：起始 6~7 个月密切监测，PSA<0.2 且稳定后每 3~6 个月（第 10 章注释 l，p208）');
      add('影像学复查（CT/骨扫描/PSMA）', 9, 'mHSPC 每 6~12 个月一次影像随访；M1 即便 PSA 低也须按周期常规影像（7.2 注释 e p138；第 10 章注释 l p208）');
      add('血清睾酮', testoEvery, 'ADT 期间睾酮监测：前 6 个月每月，之后每 3 个月（睾酮共识 2025；第 10 章 p203；8.1 p154）');
      add('骨密度(DEXA)', 12, 'ADT/M1 患者基线 DEXA，之后每 1~2 年（NCCN PROS-B；第 10 章注释 j p207）', { baseline: true });
      add('FRAX骨折风险评估', 12, 'ADT/M1 患者基线 FRAX，之后每年评估（NCCN PROS-B；第 10 章注释 j p207）', { baseline: true });
      add('肌酐/血红蛋白/肝功能/代谢与心脑血管监测', 6, '综合治疗后 I 级推荐（第 10 章，p203 注释 g/i/k）');
    } else if (ctx.kind === 'as') {
      add('血清 PSA', 6, '主动监测：每 6 个月测 PSA（5.4 注释，p95）');
      add('DRE', 12, '主动监测：每 12 个月查 DRE（p95）');
      add('mpMRI', 12, '主动监测：每 12 个月应考虑 mpMRI（p95）');
      add('重复穿刺活检', 30, '主动监测：每 2~3 年重复活检（p95）');
    } else if (ctx.kind === 'surgery' || ctx.kind === 'rt') {
      const high = highRecurrenceRisk(p, cscoStrata(p).strata, bcrConfirmed || bcrPending);
      const hasLaterPsa = !!(ctx.since && (p.psa || []).some(x => {
        const d = daysBetween(ctx.since, x.date);
        return d != null && d > RP_BCR_MAX_DAYS;
      }));
      const noWindowPsa = ctx.kind === 'surgery' && bcr && bcr.state === 'indeterminate' && !hasLaterPsa;
      if (noWindowPsa && ctx.since) {
        const start = addDays(ctx.since, RP_BCR_MIN_DAYS);
        const end = addDays(ctx.since, RP_BCR_MAX_DAYS);
        add('术后 6–12 周 PSA', 3,
          '术后 6–12 周（42–90 天）PSA 是 persistence 的唯一判据；应于 ' + start + '～' + end + ' 完成，不能拿术前 PSA 代替',
          { anchor: ctx.since, fixedDue: start, windowEnd: end });
      } else if (high && yearsSince != null && yearsSince <= 5) {
        add('血清 PSA', 3, '高复发风险：术后/放疗后前 5 年内每 3 个月（第 10 章，p203/p207）');
      } else if (yearsSince != null && yearsSince > 5) {
        add('血清 PSA', 12, '初始治疗 5 年以后每年查一次 PSA（5.5 注释 g，p99）');
      } else {
        add('血清 PSA', 6, '治愈性治疗后每 3~6 个月，反应良好且 PSA<0.1 时可 3~6 个月（第 10 章，p203/p207）');
      }
      add('DRE', 12, '治愈性治疗后 II 级推荐至少每年 1 次（第 10 章，p203/p206）');
      add('影像学复查（CT/骨扫描/PSMA）', 12, '治愈性治疗后 II 级推荐至少每年 1 次；低危 M0 无症状者可个体化省略（第 10 章，p203/p206/p208）');
      if (needsCastration(p)) add('血清睾酮', testoEvery, 'ADT 期间睾酮监测：前 6 个月每月，之后每 3 个月（睾酮共识 2025；第 10 章 p203；8.1 p154）');
    } else if (ctx.kind === 'adt') {
      add('血清 PSA', 3, '综合治疗后随访至少 3~6 个月（第 10 章，p203）');
      add('血清睾酮', testoEvery, 'ADT 期间睾酮监测：前 6 个月每月，之后每 3 个月（睾酮共识 2025；第 10 章 p203；8.1 p154）');
      add('骨密度(DEXA)', 12, 'ADT 患者基线 DEXA，之后每 1~2 年（NCCN PROS-B；第 10 章注释 j p207）', { baseline: true });
      add('FRAX骨折风险评估', 12, 'ADT 患者基线 FRAX，之后每年评估（NCCN PROS-B；第 10 章注释 j p207）', { baseline: true });
      add('肌酐/血红蛋白/肝功能/代谢与心脑血管监测', 6, '综合治疗后 I 级推荐（第 10 章，p203 注释 g/i/k）');
      const setting = String((ctx.line && ctx.line.setting) || '') + ' ' + String((ctx.line && ctx.line.regimen) || '');
      const isNmCrpcLine = /nmCRPC/i.test(setting);
      /* 注意 nmCRPC 字符串里包含 mCRPC，不能用裸 /mCRPC/ 判断。 */
      const isMCrpcLine = /(^|[^n])mCRPC/i.test(setting);
      if (isNmCrpcLine || isMCrpcLine) {
        add('影像学复查（CT/骨扫描/PSMA）', isMCrpcLine ? 6 : 9,
          'nmCRPC/mCRPC 需按期影像评估转移与进展；不能只查 PSA（NCCN 2027；第 10 章）');
      }
    } else {
      add('血清 PSA', 6, '观察等待/未定治疗：参照治愈性治疗后 3~6 个月的下限执行，请结合临床');
    }

    /* P0-03：即使当前是辅助 ADT，术后 6–12 周 PSA 窗口也必须在计划里，
       不能因为治疗情境变成 adt 就把窗口漏掉。 */
    if (surgeryCtx && ctx.kind !== 'surgery' && bcr && bcr.state === 'indeterminate' && surgeryCtx.since) {
      const start = addDays(surgeryCtx.since, RP_BCR_MIN_DAYS);
      const end = addDays(surgeryCtx.since, RP_BCR_MAX_DAYS);
      add('术后 6–12 周 PSA', 3,
        '术后 6–12 周（42–90 天）PSA 是 persistence 的唯一判据；应于 ' + start + '～' + end + ' 完成，不能拿术前 PSA 代替',
        { anchor: surgeryCtx.since, fixedDue: start, windowEnd: end });
    }

    /* P0-02：术后 BCR 与当前 ADT/RT 并存时，随访计划合并而不是二选一。 */
    if (bcrConfirmed) {
      addPsa(3, '术后生化复发：PSA 每 3 个月，并按 PSADT/影像评估挽救治疗（NCCN 2027 PROS-9）');
      if (surgeryCtx && !out.some(o => /影像学复查/.test(o.item))) {
        add('影像学复查（CT/骨扫描/PSMA）', 12, '术后 BCR 应结合 PSMA PET/CT 或常规影像排除远处转移（NCCN 2027）');
      }
    }

    out.forEach(o => {
      o.lastDone = o.anchor || itemLastDone(p, o.item, ctx);
      o.due = o.fixedDue || (o.lastDone ? addMonths(o.lastDone, o.every) : null);
      o.missingBaseline = !o.lastDone && !!o.baseline;
      o.over = o.windowEnd ? today > o.windowEnd : !!(o.due && today > o.due);
    });
    const missing = out.filter(o => o.missingBaseline);
    const overdueItems = out.filter(o => o.over).sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')));
    return {
      intervals: out,
      overdue: overdueItems.length
        ? { item: overdueItems[0].item, due: overdueItems[0].due, lastDone: overdueItems[0].lastDone, count: overdueItems.length, items: overdueItems }
        : null,
      missing
    };
  }

  /* ---------- 疾病状态（自动） ---------- */
  function deriveDiseaseStatus(p, facts) {
    const fs = p.followupStatus || '在访';
    if (fs === '死亡') return { code: 'death', label: '死亡', evidence: '随访终止状态为「死亡」' };
    if (fs === '失访') return { code: 'lost', label: '失访', evidence: '随访终止状态为「失访」' };

    const lines = p.treatmentLines || [];
    const meds = p.medications || [];
    const missing = [];
    if (!clinicalStageOf(p) && !pathologicStageOf(p)) missing.push('分期');
    if (!p.gleason && !pickBiopsyPathology(p)) missing.push('Gleason');
    if (!p.treatment && !lines.length &&
        !meds.some(m => m && ['adt', 'arpi', 'endocrine'].includes(m.category))) missing.push('治疗方式');
    const incomplete = missing.length > 0;

    /* P1-07：去势抵抗是历史状态，不能因为换了一条新治疗线、
       PSA 暂时稳定就退回“转移”。事件/结局/治疗线情境任一成立即保持。 */
    const crpcEvent = hasEvent(p, '去势抵抗确认');
    const crpcOutcome = (p.outcomes || []).some(o => o && o.outcomeType === 'CRPC');
    const crpcLine = lines.some(l => l && /nmCRPC|mCRPC|\bCRPC\b/i.test(String(l.setting || '')));
    if (crpcEvent || crpcOutcome || crpcLine ||
        (facts.crpc && facts.crpc.state === 'confirmed') ||
        (facts.mprog && facts.mprog.state === 'confirmed')) {
      return {
        code: 'crpc',
        label: '去势抵抗',
        evidence: crpcEvent ? '存在「去势抵抗确认」事件'
          : crpcOutcome ? '存在去势抵抗（CRPC）结局记录'
          : crpcLine ? '存在 nmCRPC/mCRPC 治疗线'
          : ((facts.mprog && facts.mprog.confirmed) ? facts.mprog.detail : (facts.crpc ? facts.crpc.detail : '去势抵抗成立'))
      };
    }
    if (isM1(p) || hasMetEvent(p)) {
      const ev = metastasisEvidence(p);
      const src = ev.sourceType === 'imaging' ? ('影像' + (ev.date ? ' ' + ev.date : ''))
        : ev.sourceType === 'outcome' ? ('转移确认结局' + (ev.date ? ' ' + ev.date : ''))
        : '分期/事件';
      return {
        code: 'metastasis',
        label: '转移',
        evidence: ev.m1
          ? ('转移证据：' + src + (ev.sites.length ? '，部位 ' + ev.sites.join('/') : ''))
          : '存在「转移确认」或「转移灶局部治疗」事件'
      };
    }
    /* 医生已明确记录「生化复发确认」时，事件优先于“术后待复查”的自动提示。 */
    if (hasEvent(p, '生化复发确认')) {
      return { code: 'bcr', label: '生化复发', evidence: '存在「生化复发确认」事件' };
    }
    /* P0-03：术后还没查 6–12 周 PSA 时，是“尚未判定”，绝不能显示绿色稳定。 */
    if (facts.surgeryCtx && facts.bcr && facts.bcr.state === 'indeterminate') {
      return {
        code: 'postop_pending',
        label: '术后待复查',
        evidence: facts.bcr.detail || '术后 6–12 周 PSA 未查，无法判定 persistence/recurrence'
      };
    }
    if (incomplete) {
      return { code: 'pending', label: '待评估', evidence: '资料不完整：缺少 ' + missing.join('、') };
    }
    if (!(p.psa || []).length) {
      return { code: 'pending', label: '待评估', evidence: '无 PSA 记录，无法判定疾病状态' };
    }
    if (facts.bcr && facts.bcr.state === 'persistent') {
      return { code: 'persistent', label: '术后持续可测', evidence: facts.bcr.detail };
    }
    if ((facts.bcr && facts.bcr.state === 'recurrence') || hasEvent(p, '生化复发确认')) {
      return {
        code: 'bcr',
        label: '生化复发',
        evidence: hasEvent(p, '生化复发确认') ? '存在「生化复发确认」事件' : facts.bcr.detail
      };
    }
    const last = (p.psa || [])[(p.psa || []).length - 1];
    return {
      code: 'stable',
      label: '稳定',
      evidence: '已治疗，未达生化复发/去势抵抗/转移标准；最新 PSA ' + (last ? (fmtPsa(last) + ' ng/ml（' + last.date + '）') : '-')
    };
  }

  /* ---------- 预警 ---------- */
  function warningOf(p, facts, disease) {
    if (disease.code === 'death' || disease.code === 'lost') {
      const noDeathDate = disease.code === 'death' && !(p.outcomes || []).some(o => o && o.outcomeType === 'death');
      return {
        color: 'gray',
        label: '已终止随访',
        note: disease.evidence + (noDeathDate ? '；缺死亡结局/死亡日期，请补录' : '') + '；不再生成随访计划'
      };
    }
    if (disease.code === 'crpc') {
      return { color: 'red', label: '紧急预警', note: '去势抵抗：' + disease.evidence + '。建议按 nmCRPC/mCRPC 路径评估影像与下一步治疗' };
    }
    if (disease.code === 'metastasis') {
      return { color: 'red', label: '紧急预警', note: '转移：' + disease.evidence + '。建议 MDT 多学科会诊，并结合转移负荷制定系统治疗' };
    }
    if (disease.code === 'persistent') {
      return { color: 'red', label: '紧急预警', note: '术后持续可测（persistence）：' + disease.evidence + '。需评估影像与挽救治疗，不等同于 recurrence' };
    }
    if (disease.code === 'bcr') {
      return { color: 'red', label: '紧急预警', note: '生化复发：' + disease.evidence + '。建议 PSADT、PSMA PET/CT 评估，无远处转移证据者考虑挽救性治疗' };
    }
    if (disease.code === 'postop_pending') {
      return {
        color: 'yellow',
        label: '术后待复查',
        note: disease.evidence + '；术后 6–12 周 PSA 是 persistence 的唯一判据，请按窗口复查，不能拿术前 PSA 判稳定'
      };
    }
    if (disease.code === 'pending') {
      return { color: 'pending', label: '待评估', note: disease.evidence + '，暂不生成风险结论与随访计划。请在「档案」页补录后重新评估' };
    }

    const issues = [];
    if (facts.bcr && facts.bcr.missingWindow) issues.push('术后 6–12 周 PSA 窗口缺失：' + facts.bcr.detail);
    if (facts.bcr && facts.bcr.state === 'pending') issues.push('生化复发待确认：' + facts.bcr.detail);
    if (facts.crpc && facts.crpc.state === 'indeterminate') issues.push('CRPC 无法判定：' + facts.crpc.detail);
    if (facts.mprog && facts.mprog.state === 'indeterminate') issues.push('mCRPC 无法判定：' + facts.mprog.detail);
    if (facts.crpc && facts.crpc.state === 'not_castrate') issues.push('睾酮未达去势水平，不能诊断 nmCRPC');
    if (facts.mprog && facts.mprog.state === 'not_castrate') issues.push('睾酮未达去势水平，不能诊断 mCRPC');
    if (facts.cure && facts.cure.state === '未达临床治愈') issues.push(facts.cure.note);
    if (facts.asProgress) issues.push(facts.asProgress);
    const overduePsa = facts.plan && facts.plan.overdue
      ? (facts.plan.overdue.items || [facts.plan.overdue]).find(o => /PSA|睾酮/.test(o.item))
      : null;
    if (overduePsa) {
      issues.push('PSA/睾酮随访已到期：' + overduePsa.item + ' 应于 ' + overduePsa.due + ' 前完成（上次 ' + (overduePsa.lastDone || '未记录') + '）');
    }
    if (facts.plan && facts.plan.missing && facts.plan.missing.length) {
      issues.push('基线未做：' + facts.plan.missing.map(o => o.item).join('、') + '；不阻断治疗，建议尽快补做');
    }
    if (needsCastration(p) && facts.castration.source === 'testosterone' &&
        facts.castration.status === 'noncastrate' && facts.castration.verified) {
      issues.push('睾酮未达去势水平（最近 ' + facts.castration.date + ' ' + facts.castration.value + ' ng/dl），请复核 ADT/ARPI 方案或依从性');
    }
    if (p.legacyStatus && p.legacyStatus !== disease.label) {
      issues.push('旧版手填状态为「' + p.legacyStatus + '」，与当前自动状态「' + disease.label + '」不一致，旧状态已停用');
    }
    if (issues.length) return { color: 'yellow', label: '需关注', note: issues.join('；') };
    return { color: 'green', label: '稳定', note: '未达复发/去势抵抗/转移标准；按随访计划复查（第 10 章，p203/p207-208）' };
  }

  /* ---------- 数据质量 ---------- */
  function dataIssuesOf(p, facts, disease) {
    const out = [];
    const biopsy = pickBiopsyPathology(p);
    const ev = metastasisEvidence(p);
    if (!clinicalStageOf(p) && !pathologicStageOf(p)) out.push('未录分期');
    if (!p.gleason && !biopsy) out.push('未录主要活检 Gleason，无法做临床风险分层');
    const meds = p.medications || [];
    if (!p.treatment && !(p.treatmentLines || []).length &&
        !meds.some(m => m && ['adt', 'arpi', 'endocrine'].includes(m.category))) out.push('未选治疗方式');
    if (facts.surgeryCtx && facts.bcr && facts.bcr.state === 'indeterminate') {
      out.push('术后 6–12 周 PSA 未查/无法判定：' + (facts.bcr.detail || '请按手术日期补查'));
    }
    if (!biopsy && !isM1(p) && !hasMetEvent(p)) {
      out.push('无主要活检病理；临床风险分层暂不出结论（不能用档案/RP 手工 Gleason 代替）');
    }
    if (isM1(p) && (p.metCount == null || p.visceralMet == null)) {
      out.push('转移负荷字段不完整（转移灶数量/内脏转移），无法判高/低瘤负荷');
    }
    if (mStageOf(p) === 'M1（未细分）') out.push('M1 未细分，建议补录 M1a/M1b/M1c');
    if (ev.m1 && !/^M1/i.test((parseStage(clinicalStageOf(p)).m || ''))) {
      out.push('影像/结局已示转移（' + (ev.date || '日期未录') + (ev.sites.length ? '，' + ev.sites.join('/') : '') +
        '），cTNM 仍非 M1；系统已按 M1 判定，建议同步 cTNM 或核对来源');
    }
    if ((p.imagingStudies || []).some(x => Number(x.lesionCount) > 0 && !splitSites(x.metastaticSites).length)) {
      out.push('影像病灶数>0 但转移部位未录，M1 亚型可能无法细分');
    }
    if (!clinicalStageOf(p) && pathologicStageOf(p)) out.push('仅有病理分期 pTNM，需补临床分期 cTNM 才能做局限风险分层');
    if (clinicalStageOf(p) && /^p/i.test(clinicalStageOf(p))) out.push('临床分期字段里是 p 前缀，请改为 cTNM');
    if (needsCastration(p) && facts.castration.source === 'none') out.push('ADT/ARPI/M1 患者无睾酮记录，无法确认去势水平');
    if (facts.castration.source === 'manual') out.push('去势状态为手工标记，未经睾酮验证');
    if (facts.castration.source === 'testosterone' && !facts.castration.verified) out.push('最近一次睾酮已超过 120 天，建议复测');
    if (p.castration === false && !(p.testo || []).length) out.push('旧版去势状态为「否」，可能为历史默认值，请确认');
    if (needsCastration(p) && facts.castration.source === 'testosterone' &&
        facts.castration.status === 'noncastrate' && facts.castration.verified) out.push('睾酮未达去势水平');
    if (facts.plan && facts.plan.missing && facts.plan.missing.length) {
      out.push('基线未做：' + facts.plan.missing.map(o => o.item).join('、') + '（允许先治疗，建议补做）');
    }
    if (p.followupStatus === '死亡' && !(p.outcomes || []).some(o => o && o.outcomeType === 'death')) {
      out.push('死亡状态缺死亡结局/死亡日期，请补录');
    }
    if (!biopsy && p.gleasonSource && String(p.gleasonSource).startsWith('pathology:')) {
      out.push('主档 Gleason 来源未识别为活检，请核对是否为 RP/TURP 分级');
    }
    if (p.legacyStatus && p.legacyStatus !== disease.label) out.push('旧版手填状态「' + p.legacyStatus + '」与自动状态不一致，已停用');
    return out;
  }

  /* ---------- 总评估 ---------- */
  function assess(p, today) {
    const todayIso = today || localToday();
    const ctxSeq = postSeq(p, todayIso);
    const ctx = ctxSeq.ctx, seq = ctxSeq.seq;
    const allPsa = (p.psa || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id || 0) - (b.id || 0));
    const surgeryCtx = surgeryContext(p);
    const bcrSeq = surgeryCtx && surgeryCtx.since ? allPsa.filter(x => x.date >= surgeryCtx.since) : seq;
    const strata = cscoStrata(p);
    const castration = castrationState(p, todayIso);
    /* P0-02：BCR/临床治愈必须以“手术历史”判定，不能看当前最新一条治疗线。 */
    const bcr = surgeryCtx
      ? rpBcr(p, surgeryCtx, allPsa)
      : (ctx.kind === 'rt' ? rtBcr(seq) : { state: 'none', detail: '' });
    const bcrEvent = hasEvent(p, '生化复发确认');
    const bcrConfirmed = bcr.state === 'recurrence' || bcr.state === 'persistent' || bcrEvent;
    const cure = surgeryCtx ? clinicalCure(p, surgeryCtx, allPsa) : null;
    /* CRPC 判定用哪个 PSA 序列：
       有睾酮记录（去势状态可算）时用全序列——去势抵抗的进展常发生在
       上一线治疗期间，若锚定在最新治疗线开始日，换线前的连续上升会被
       整段排除，自动判定永远出不来；无睾酮记录时仍按治疗情境序列，
       避免把 ADT 前的基线 PSA 误当去势期进展。 */
    const crpcSeq = (castration && castration.source === 'testosterone') ? allPsa : seq;
    const crpc = needsCastration(p) ? nmCrpc(p, crpcSeq, castration) : null;
    const mprog = isM1(p) ? mCrpcProgress(p, crpcSeq, castration) : null;
    const metricSeq = surgeryCtx ? bcrSeq : seq;
    const psadt = psadtMonths(metricSeq);
    const psav = psavPerYear(metricSeq);
    const nadir = metricSeq.length ? Math.min.apply(null, metricSeq.map(x => Number(x.val))) : null;
    const plan = cscoFollowupPlan(p, ctx, bcr, todayIso, surgeryCtx, bcrEvent);

    let asProgress = null;
    if ((ctx.kind === 'as' || ctx.kind === 'ww') && seq.length > 2) {
      const n = seq.length;
      if (Number(seq[n - 1].val) > Number(seq[n - 2].val) && Number(seq[n - 2].val) > Number(seq[n - 3].val)) {
        asProgress = ctx.kind === 'as'
          ? '主动监测中 PSA 连续进展：指南要求重复穿刺活检明确组织学改变后再开始积极治疗（5.3 注释 a，p91）'
          : '观察等待中 PSA 连续进展：请重新评估预期寿命与症状，考虑转为积极治疗（5.3，p90-92）';
      }
    }

    const facts = {
      ctx, seq, strata, castration, bcr, bcrEvent, bcrConfirmed, cure, crpc, mprog, surgeryCtx,
      psadt, psav, nadir, plan, asProgress,
      metastasis: metastasisEvidence(p)
    };
    facts.disease = deriveDiseaseStatus(p, facts);
    facts.warning = warningOf(p, facts, facts.disease);
    facts.dataIssues = dataIssuesOf(p, facts, facts.disease);
    return facts;
  }

  return {
    NGDL_PER_NMOL, CASTRATE_NGDL, DEEP_CASTRATE_NGDL,
    addMonths, addDays, monthsBetween, daysBetween, fmtPsa,
    isupOf, parseStage, clinicalStageOf, pathologicStageOf, isM1, mStageSummaryOf, mStageOf,
    metastasisEvidence, pickBiopsyPathology, pickPostopPathology,
    toNgdl, fromNgdl,
    activeTreatmentLine, treatmentContext, surgeryContext, isSurgeryText, postSeq, linReg, psadtMonths, psavPerYear,
    cscoStrata, clinicalCure, castrationState, rpBcr, rtBcr, nmCrpc, mCrpcProgress,
    highRecurrenceRisk, tumorBurden, hasEvent, hasMetEvent, lastPsaDate, lastTestoDate,
    eventDateByTypes, eventDateByTypesAfter, clinicalRecordDate, lastContact, needsCastration, itemLastDone,
    cscoFollowupPlan, deriveDiseaseStatus, warningOf, dataIssuesOf, assess
  };
});

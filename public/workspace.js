/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * 患者工作台 2.0（读优先）
 * ---------------------------------------------------------
 * 目标：把“表单堆”换成“先看结论、再看记录、按需登记”。
 * 依赖 index.html 里的全局：patients/selectedId/api/toast/renderEdit/
 * ClinicalCore/RecordCore/makeChart/openSummary 等。
 * 本工作台是唯一患者编辑界面；旧版表单工作台已整体删除。
 * ========================================================= */
(function () {
  'use strict';

  const S = {
    tab: 'overview',
    episodeId: null,
    scenario: '',
    catalog: null,
    catalogPromise: null,
    pid: null,
    loading: false
  };

  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const arr = v => Array.isArray(v) ? v : [];
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  const fmt = v => (v == null || v === '') ? '—' : String(v);
  const pct = v => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(1) + '%';
  const wsl = (kind, v) => (window.WsLabels ? WsLabels.label(kind, v) : v) || '';

  function getPatient(id) {
    return (typeof patients !== 'undefined' ? patients : []).find(x => x.id === id) || null;
  }
  function assessOf(p) {
    try {
      if (window.ClinicalCore && ClinicalCore.assess) return ClinicalCore.assess(p);
    } catch (e) {}
    return {
      disease: { code: 'pending', label: '待评估', evidence: '资料不足' },
      warning: { color: 'pending', label: '待评估', note: '' },
      strata: { label: '待评估', why: '' },
      castration: { status: 'unknown', label: '未评估', detail: '' },
      plan: { intervals: [], missing: [], overdue: null }
    };
  }
  function riskColorSafe(c) {
    try { return riskColor(c || 'pending'); } catch (e) { return '#7f8c8d'; }
  }
  function riskLabelSafe(a) {
    try { return riskStrataLabel(a); } catch (e) { return (a && a.strata && a.strata.label) || '待评估'; }
  }
  function isupSafe(g) {
    try { return isupOf(g); } catch (e) { return null; }
  }
  function stageText(p) {
    try { return stageSummary(p) || '分期未录'; } catch (e) { return p.clinicalStage || p.pathologicStage || '分期未录'; }
  }

  async function loadCatalog() {
    if (S.catalog) return S.catalog;
    if (S.catalogPromise) return S.catalogPromise;
    S.catalogPromise = api('/api/catalog').then(c => { S.catalog = c; return c; }).catch(e => {
      S.catalogPromise = null; throw e;
    });
    return S.catalogPromise;
  }
  async function loadWorkspace(p) {
    if (p.workspace) return p.workspace;
    const w = await api('/api/patients/' + p.id + '/workspace');
    p.workspace = w;
    return w;
  }

  function episodeById(w, id) {
    return arr(w.episodes).find(e => Number(e.id) === Number(id)) || null;
  }
  function templateOf(w, ep) {
    if (!ep) return null;
    if (ep.template) return ep.template;
    if (S.catalog && S.catalog.followupTemplates) return S.catalog.followupTemplates.find(t => t.code === ep.templateCode) || null;
    return null;
  }
  function activeEpisodes(w) {
    return arr(w.episodes).filter(e => e.status === 'active').slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  }
  function currentEpisode(w) {
    const a = activeEpisodes(w);
    return a.length ? a[a.length - 1] : (arr(w.episodes).slice(-1)[0] || null);
  }
  /* 随访对象：在程段优先；全部结束（如 RP 已完成）时用最近完成的段，
     否则“术后随访”会被误判成“没有治疗段”。 */
  function followupEpisodes(w) {
    const all = arr(w.episodes);
    const active = all.filter(e => e.status === 'active');
    if (active.length) return active;
    return all.filter(e => e.status === 'completed');
  }
  function psaOfDate(p, date) {
    const rows = arr(p.psa).filter(x => x.date === date);
    return rows.length ? rows[rows.length - 1] : null;
  }
  function psaText(x) {
    if (!x) return '—';
    const v = x.belowLod ? ('<' + (x.lod != null ? x.lod : x.val)) : x.val;
    return v + '';
  }
  function aeFor(w, rowId, term) {
    return arr(w.adverseEvents).find(a => Number(a.episodeRowId) === Number(rowId) && a.termCode === term) || null;
  }
  function gradeClass(g) {
    if (g == null) return 'g-none';
    if (g === 0) return 'g0';
    return 'g' + Math.min(5, Number(g));
  }
  function responseClass(v) {
    return ({ CR: 'r-cr', PR: 'r-pr', SD: 'r-sd', PD: 'r-pd', NE: 'r-ne', NA: 'r-na' })[v] || 'r-na';
  }
  function badge(text, cls) { return '<span class="ws2-badge ' + (cls || '') + '">' + esc(text) + '</span>'; }


  /* 当前状态卡片的语义色：绿=达标/稳定，黄=需关注，红=异常/进展，灰=未评估/终止。 */
  function toneDisease(a) {
    const code = (a && a.disease && a.disease.code) || '';
    if (code === 'stable') return 'ok';
    if (code === 'postop_pending' || code === 'pending') return code === 'pending' ? 'muted' : 'warn';
    if (['bcr', 'persistent', 'crpc', 'metastasis'].includes(code)) return 'danger';
    return 'muted';
  }
  function toneRisk(a) {
    const s = (a && a.strata && a.strata.strata) || '';
    if (s === '低危') return 'ok';
    if (s.indexOf('中危') === 0) return 'warn';
    if (/^(高危|极高危|区域|转移)$/.test(s)) return 'danger';
    return 'muted';
  }
  function toneCastration(a) {
    const s = (a && a.castration && a.castration.status) || 'unknown';
    if (s === 'castrate') return 'ok';
    if (s === 'noncastrate') return 'danger';
    return 'muted';
  }
  function toneFollowup(p) {
    const s = (p && p.followupStatus) || '在访';
    if (s === '在访') return 'ok';
    return 'muted';
  }

  function headerHtml(p, a, w) {
    const ep = currentEpisode(w);
    const disease = (a.disease && a.disease.label) || p.diseaseCategory || '待评估';
    const risk = riskLabelSafe(a);
    const epText = ep ? (ep.label || ep.templateCode) : '未建治疗段';
    const alert = (a.warning && a.warning.label) || '待评估';
    const warnTone = (a.warning && a.warning.color) || 'pending';
    return '<div class="ws2-head">' +
      '<div class="ws2-head-main">' +
        '<div class="ws2-name">' + esc(p.name) + ' <span>' + esc(p.id) + '</span></div>' +
        '<div class="ws2-chips">' +
          badge(p.age + ' 岁') + badge(stageText(p)) + badge('活检 Gleason ' + (() => { try { const x = ClinicalCore.pickBiopsyPathology(p); return x && x.gleasonTotal != null ? (x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal) : '未录'; } catch (e) { return '未录'; } })()) +
          badge('活检 ISUP ' + (() => { try { const x = ClinicalCore.pickBiopsyPathology(p); return x && x.isup != null ? x.isup : '—'; } catch (e) { return '—'; } })()) +
          badge('风险：' + risk, 'chip-' + toneRisk(a)) +
          badge('疾病：' + disease + (p.diseaseCategory ? ' · ' + p.diseaseCategory : ''), 'chip-' + toneDisease(a)) +
          badge('随访：' + (p.followupStatus || '在访'), 'chip-' + toneFollowup(p)) +
          badge(epText) +
          '<span class="ws2-badge ws2-warn tone-' + warnTone + '"><i></i>' + esc(alert) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ws2-head-actions">' +
        '<button class="btn btn-primary btn-sm" type="button" onclick="Workspace.openVisit()">＋ 登记本次就诊</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openTreatment()">启动/换线</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="openSummary(\'' + esc(p.id) + '\')">临床摘要</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openAi()">AI 登记</button>' +
      '</div>' +
    '</div>';
  }

  function pathHtml(p, a, w) {
    const has = {
      screen: arr(p.psa).length > 0 || p.dreResult,
      dx: arr(p.pathologyReports).length > 0 || !!p.clinicalStage,
      risk: !!p.clinicalStage || !!p.gleason,
      treat: arr(w.episodes).length > 0,
      follow: arr(w.visits).length > 0 || arr(w.rows).length > 0,
      progress: arr(p.outcomes).some(o => ['BCR', 'CRPC', 'metastasis'].includes(o.outcomeType)) ||
        ['nmCRPC', 'mCRPC', 'mHSPC'].includes(p.diseaseCategory || '')
    };
    const order = [['screen', '筛查/疑诊'], ['dx', '诊断与分期'], ['risk', '风险分层'], ['treat', '治疗'], ['follow', '随访'], ['progress', '复发/进展']];
    let current = 0;
    order.forEach(([k], i) => { if (has[k]) current = i; });
    return '<div class="ws2-path">' + order.map(([k, label], i) =>
      '<span class="ws2-path-node' + (i === current ? ' active' : '') + (has[k] ? ' done' : '') + '">' +
        '<i>' + (has[k] ? '●' : '○') + '</i>' + esc(label) + '</span>'
    ).join('<span class="ws2-path-arrow">→</span>') + '</div>';
  }

  function alertsHtml(p, a, w) {
    const out = [];
    if (!arr(w.episodes).length) out.push(['red', '尚未建立治疗段', '先建档/治疗段，随访与疗效才有落点', 'Workspace.openTreatment()']);
    if (!arr(w.visits).length) out.push(['yellow', '尚无结构化就诊', '历史 PSA/影像仍在“检查检验/全部记录”中，可从这里开始记第一次', 'Workspace.openVisit()']);
    arr(w.grade2plus).slice(0, 3).forEach(x => out.push(['red', '≥2 级毒性：' + (x.termLabel || x.termCode) + ' G' + x.grade, (x.visitDate || x.onsetDate || '') + ' · 尚未恢复', 'Workspace.openAEById(' + x.id + ')']));
    if (a.plan && a.plan.overdue) out.push(['yellow', '随访到期：' + (a.plan.overdue.item || ''), '应于 ' + (a.plan.overdue.due || '—') + ' 前完成', 'Workspace.openVisit()']);
    if (a.plan && arr(a.plan.missing).length) out.push(['yellow', '基线未做：' + a.plan.missing.map(x => x.item).join('、'), '允许先治疗，建议补做', 'Workspace.tab(\'checks\',\'ws2ContentTop\')']);
    if (a.disease && a.disease.code === 'pending') out.push(['yellow', '资料不完整：' + ((a.disease.evidence || '').slice(0, 60)), '补齐后自动评估', 'Workspace.openProfileEditor()']);
    if (!out.length) out.push(['green', '暂无紧急待办', '按随访计划继续', 'Workspace.openVisit()']);
    return '<div class="ws2-alerts">' + out.map(([c, t, d, fn]) =>
      '<div class="ws2-alert ' + c + '"><b>' + esc(t) + '</b><span>' + esc(d) + '</span>' +
      '<button type="button" class="ws2-link" onclick="' + fn + '">处理 →</button></div>').join('') + '</div>';
  }

  function summaryText(p, a, w) {
    const ep = currentEpisode(w);
    const parts = [];
    parts.push((p.age || '—') + ' 岁' + (p.birth ? '' : '') + '，' + (p.date || '诊断日期未录') + ' 诊断前列腺癌');
    parts.push(stageText(p) + '，Gleason ' + (p.gleason || '未录') + '（ISUP ' + (isupSafe(p.gleason) || '—') + '），CSCO ' + riskLabelSafe(a));
    const sur = arr(w.surgeryRecords)[0];
    if (sur) parts.push((sur.surgeryDate || '') + ' 行' + (sur.procedure || '手术') + (sur.approach ? '（' + sur.approach + '）' : '') + (sur.nerveSparing && sur.nerveSparing !== 'none' ? '，神经保留：' + sur.nerveSparing : ''));
    if (ep) parts.push('当前治疗段：' + (ep.label || ep.templateCode) + '（' + (ep.startDate || '') + (ep.endDate ? '→' + ep.endDate : '→至今') + '）');
    const latestPsa = arr(p.psa).slice(-1)[0];
    if (latestPsa) parts.push('最近 PSA ' + psaText(latestPsa) + ' ng/mL（' + latestPsa.date + '）');
    const latestTesto = arr(p.testo).slice(-1)[0];
    if (latestTesto) parts.push('睾酮 ' + (latestTesto.enteredVal != null ? latestTesto.enteredVal : latestTesto.val) + ' ' + (latestTesto.unit || 'ng/dl'));
    if (a.plan && a.plan.overdue) parts.push('随访到期：' + a.plan.overdue.item);
    else if (a.plan && arr(a.plan.intervals).length) {
      const next = a.plan.intervals.filter(x => x.due).sort((x, y) => String(x.due).localeCompare(String(y.due)))[0];
      if (next) parts.push('下次随访 ' + next.due);
    }
    return parts.join('；') + '。';
  }

  function summaryHtml(p, a, w) {
    const ep = currentEpisode(w);
    const sur = arr(w.surgeryRecords)[0];
    const latestPsa = arr(p.psa).slice(-1)[0];
    const latestTesto = arr(p.testo).slice(-1)[0];
    const sep = '<span class="ws2-sum-sep">·</span>';
    const split = '<span class="ws2-sum-sep">；</span>';
    let h = '<span class="ws2-sum-muted">' + esc(p.age || '—') + ' 岁</span>' + sep +
      '<span class="ws2-sum-muted">' + esc(p.date || '诊断日期未录') + ' 诊断前列腺癌</span>' + split +
      '<span class="ws2-sum-chip">' + esc(stageText(p)) + '</span>' + sep +
      '<span class="ws2-sum-chip">Gleason ' + esc(p.gleason || '未录') + '（ISUP ' + esc(isupSafe(p.gleason) || '—') + '）</span>' + sep +
      '<span class="ws2-sum-chip ws2-sum-risk ' + toneRisk(a) + '">CSCO ' + esc(riskLabelSafe(a)) + '</span>' + split;
    if (sur) {
      h += '<span>' + esc(sur.surgeryDate || '') + ' 行 <b class="ws2-sum-strong">' + esc(sur.procedure || '手术') + '</b>' +
        (sur.approach ? '（' + esc(wsl('surgeryApproach', sur.approach)) + '）' : '') +
        (sur.nerveSparing && sur.nerveSparing !== 'none' ? '，神经保留：' + esc(wsl('nerveSparing', sur.nerveSparing)) : '') + '</span>' + split;
    }
    if (ep) {
      h += '<span class="ws2-sum-muted">当前治疗段：</span><b class="ws2-sum-strong">' + esc(ep.label || ep.templateCode) + '</b>' +
        '<span class="ws2-sum-muted">（' + esc(ep.startDate || '') + (ep.endDate ? '→' + esc(ep.endDate) : '→至今') + '）</span>' + split;
    }
    if (latestPsa) {
      h += '<span>最近 <b class="ws2-sum-lab">PSA ' + esc(psaText(latestPsa)) + ' ng/mL</b>' +
        '<span class="ws2-sum-muted">（' + esc(latestPsa.date) + '）</span></span>' + split;
    }
    if (latestTesto) {
      h += '<span><b class="ws2-sum-lab">睾酮 ' + esc(latestTesto.enteredVal != null ? latestTesto.enteredVal : latestTesto.val) + ' ' + esc(latestTesto.unit || 'ng/dl') + '</b></span>' + split;
    }
    if (a.plan && a.plan.overdue) {
      h += '<span class="ws2-sum-chip ws2-sum-due">随访到期：' + esc(a.plan.overdue.item || '') + '</span>';
    } else {
      const next = a.plan && arr(a.plan.intervals).filter(x => x.due).sort((x, y) => String(x.due).localeCompare(String(y.due)))[0];
      if (next) h += '<span class="ws2-sum-muted">下次随访</span> <b class="ws2-sum-strong">' + esc(next.due) + '</b><span class="ws2-sum-muted">（' + esc(next.item) + '）</span>';
    }
    return h + '<span class="ws2-sum-muted">。</span>';
  }

  function episodeCardHtml(p, w, ep, compact) {
    const t = templateOf(w, ep);
    const rows = arr(w.rows).filter(r => Number(r.episodeId) === Number(ep.id));
    const sur = arr(w.surgeryRecords).find(x => Number(x.episodeId) === Number(ep.id));
    const cycles = arr(w.chemoCycles).filter(x => Number(x.episodeId) === Number(ep.id));
    const admins = arr(w.administrations).filter(x => Number(x.episodeId) === Number(ep.id));
    const statusClass = ep.status === 'active' ? 'active' : ep.status === 'completed' ? 'done' : 'stopped';
    const impl = [];
    if (sur) {
      impl.push('手术 ' + (sur.surgeryDate || '') + ' · ' + (sur.procedure || '') + (sur.approach ? ' · ' + wsl('surgeryApproach', sur.approach) : ''));
      if (sur.nerveSparing && sur.nerveSparing !== 'none') impl.push('神经保留：' + wsl('nerveSparing', sur.nerveSparing));
      if (sur.lnDissection && sur.lnDissection !== 'none') impl.push('淋巴结清扫：' + wsl('lnDissection', sur.lnDissection) +
        (sur.lnExaminedLeft != null ? '（左 ' + (sur.lnPositiveLeft || 0) + '/' + sur.lnExaminedLeft + '，右 ' + (sur.lnPositiveRight || 0) + '/' + (sur.lnExaminedRight || 0) + '）' : ''));
      if (sur.catheterDays != null) impl.push('尿管 ' + sur.catheterDays + 'd');
      if (sur.drainDays != null) impl.push('引流 ' + sur.drainDays + 'd');
      if (arr(sur.complications).length) impl.push('并发症：' + arr(sur.complications).map(c => typeof c === 'string' ? wsl('complication', c) : (c.label || wsl('complication', c.code) || '')).filter(Boolean).join('、'));
    }
    if (ep.templateCode === 'RT') {
      const rt = arr(p.radiationRecords).find(x => x.startDate === ep.startDate) || arr(p.radiationRecords).slice(-1)[0];
      if (rt) impl.push('放疗 ' + (rt.rtType || '') + (rt.doseGy != null ? ' ' + rt.doseGy + 'Gy' : '') + (rt.fractions ? '/' + rt.fractions + 'f' : '') + (rt.target ? ' · ' + rt.target : ''));
    }
    if (ep.templateCode === 'CHEMO' && cycles.length) impl.push('化疗 ' + cycles.length + ' 周期 · 最近 ' + cycles[cycles.length - 1].cycleDate);
    if (admins.length) impl.push('给药 ' + admins.length + ' 次 · 最近 ' + admins[admins.length - 1].adminDate);
    if (!impl.length) impl.push('实施细节待补录');
    return '<div class="ws2-episode ' + statusClass + '"' + (compact ? '' : ' id="ws2EpisodeCard"') + '>' +
      '<div class="ws2-ep-head"><div><b>' + esc(ep.label || ep.templateCode) + '</b>' +
        '<span class="ws2-muted">' + esc(ep.startDate || '') + (ep.endDate ? ' → ' + esc(ep.endDate) : ' → 至今') + ' · ' + esc(wsl('episodeStatus', ep.status)) +
        (ep.intent ? ' · ' + esc(wsl('intent', ep.intent)) : '') + (ep.recommendationLevel ? ' · ' + esc(ep.recommendationLevel) : '') + '</span></div>' +
        '<div class="ws2-ep-actions"><button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openEpisodeEdit(' + ep.id + ')">编辑段</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openVisit(' + ep.id + ')">＋ 记录随访</button></div></div>' +
      (compact ? '' :
        '<div class="ws2-layer"><div class="ws2-layer-h">① 实施记录 <span>' +
          (ep.templateCode === 'RP' ? '<button type="button" class="ws2-link" onclick="Workspace.openSurgery(' + ep.id + ')">补/编辑手术实施</button>' : '') +
          (ep.templateCode === 'RT' ? '<button type="button" class="ws2-link" onclick="Workspace.openVisit()">在就诊卡中录入放疗</button>' : '') +
          (ep.templateCode === 'CHEMO' ? '<button type="button" class="ws2-link" onclick="Workspace.openChemo(' + ep.id + ')">＋ 记录周期</button>' : '') +
          (ep.templateCode === 'ADT' || ep.templateCode === 'SYSTEMIC' ? '<button type="button" class="ws2-link" onclick="Workspace.openAdministration(' + ep.id + ')">＋ 记录给药</button>' : '') +
          '</span></div><div class="ws2-layer-b">' + impl.map(x => '<span>' + esc(x) + '</span>').join('') + '</div></div>' +
        '<div class="ws2-layer"><div class="ws2-layer-h">② 评分卡 <span>只查不填</span></div><div class="ws2-layer-b">' +
          (t ? arr(t.aeTerms).map(code => {
            const term = (S.catalog && S.catalog.toxicityTerms || []).find(x => x.code === code);
            return term ? '<button type="button" class="ws2-term" title="' + esc((term.definitions || []).map(d => 'G' + d.grade + ' ' + d.text).join('\n')) + '" onclick="Workspace.openToxicityInfo(\'' + esc(code) + '\')">' + esc(term.label) + ' 0–' + term.maxGrade + '</button>' : '';
          }).join('') : '<span>无专用评分卡</span>') +
          '<button type="button" class="ws2-term" onclick="Workspace.openResponseInfo()">疗效 CR/PR/SD/PD（按 PSA/影像）</button></div></div>') +
      (compact ? '' : '<div class="ws2-layer"><div class="ws2-layer-h">③ 连续随访表 <span>' + rows.length + ' 行</span></div>' + visitTableHtml(p, w, ep, rows) + '</div>') +
      /* 化疗周期：总览（compact）折叠省空间；随访记录册是逐周期核对的工作台，
         必须始终展开完整表格，不再套折叠。 */
      (ep.templateCode === 'CHEMO' && cycles.length
        ? (compact
            ? chemoLayerHtml(cycles, ep.id)
            : '<div class="ws2-layer"><div class="ws2-layer-h">化疗周期 <span>' + cycles.length + '</span></div>' + chemoTableHtml(cycles) + '</div>')
        : '') +
      /* 总览（compact）只给一行给药摘要：次数/最近/下次到期是时间轴没有的“执行与到期”信息；
         完整给药日志表只在随访记录册展示，避免与用药时间轴在总览重复。 */
      (compact
        ? (admins.length ? '<div class="ws2-layer"><div class="ws2-layer-b"><span>给药 ' + admins.length + ' 次 · 最近 ' + esc(admins[admins.length - 1].adminDate) +
            (admins[admins.length - 1].nextDueDate ? ' · 下次到期 ' + esc(admins[admins.length - 1].nextDueDate) : '') +
            '（完整日志见随访记录册）</span></div></div>' : '')
        : (admins.length ? '<div class="ws2-layer"><div class="ws2-layer-h">给药日志 <span>' + admins.length + '</span></div>' + adminTableHtml(admins) + '</div>' : '')) +
    '</div>';
  }

  function visitTableHtml(p, w, ep, rows) {
    const t = templateOf(w, ep) || { aeTerms: [] };
    const terms = arr(t.aeTerms).map(code => (S.catalog && S.catalog.toxicityTerms || []).find(x => x.code === code)).filter(Boolean);
    if (!rows.length) return '<div class="ws2-empty">本段还没有随访行。点“记录随访”开始；历史 PSA 可在“检查检验”查看。</div>';
    return '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr>' +
      '<th>次</th><th>日期</th><th>PSA</th><th>疗效</th>' +
      terms.map(x => '<th>' + esc(x.label) + '</th>').join('') +
      '<th>小结</th><th></th></tr></thead><tbody>' +
      rows.slice().sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate)) || (a.visitNo || 0) - (b.visitNo || 0)).map(r => {
        const psa = psaOfDate(p, r.visitDate);
        return '<tr>' +
          '<td>' + fmt(r.visitNo) + '</td><td>' + esc(r.visitDate || '—') + '</td><td>' + esc(psaText(psa)) + '</td>' +
          '<td><span class="ws2-resp ' + responseClass(r.overallResponse) + '">' + esc(wsl('response', r.overallResponse || 'NA')) + '</span><i class="ws2-muted">' + esc(r.responseBasis || '') + '</i></td>' +
          terms.map(term => {
            const ae = aeFor(w, r.id, term.code);
            const g = ae ? ae.grade : null;
            return '<td><button type="button" class="ws2-grade ' + gradeClass(g) + '" onclick="Workspace.openAE(' + r.id + ',\'' + term.code + '\')" title="点击记录分级">' + (g == null ? '—' : g) + '</button></td>';
          }).join('') +
          '<td class="ws2-sum">' + esc(r.summary || r.notes || '—') + '</td>' +
          '<td><button class="ws2-link" type="button" onclick="Workspace.openVisitDetail(' + r.id + ')">详情</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function chemoTableHtml(cycles) {
    /* 减量/延迟非零的格子加高亮：与折叠标题上的「减量 n 次 / 延迟 n 次」呼应，
       展开后能直接定位到是哪几个周期出了问题。 */
    const warn = (v) => Number(v) > 0 ? ' class="cx-num-warn"' : '';
    return '<div class="ws2-table-wrap cx-chemo-tbl"><table class="ws2-table">' +
      /* 列宽写内联：外部主题在窄屏会重置 col 的 class 宽度，导致七等分 */
      '<colgroup><col style="width:56px"><col style="width:100px"><col>' +
      '<col style="width:66px"><col style="width:66px"><col style="width:66px"><col style="width:100px"></colgroup>' +
      '<thead><tr><th>周期</th><th>日期</th><th>方案</th><th>减量%</th><th>延迟d</th><th>ECOG</th><th>下次</th></tr></thead><tbody>' +
      cycles.map(c => '<tr><td>C' + c.cycleNo + '</td><td>' + esc(c.cycleDate) + '</td><td>' + esc(c.regimen || '—') + '</td>' +
        '<td' + warn(c.doseReductionPct) + '>' + fmt(c.doseReductionPct) + '</td>' +
        '<td' + warn(c.delayDays) + '>' + fmt(c.delayDays) + '</td>' +
        '<td>' + fmt(c.ecog) + '</td><td>' + fmt(c.nextCycleDate) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }
  function adminTableHtml(admins) {
    return '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>次数</th><th>日期</th><th>药物</th><th>剂量</th><th>下次</th></tr></thead><tbody>' +
      admins.map((a, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(a.adminDate) + '</td><td>' + esc(a.drug) + '</td><td>' + esc(a.dose || '—') + '</td><td>' + fmt(a.nextDueDate) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  /* 化疗周期默认折叠：10 个周期的表格占掉近一屏，把后面的给药日志推得很远。
     折叠标题保留「周期数 / 起止 / 减量 / 延迟」摘要，收起时也能掌握执行情况；
     需要逐周期核对时再展开。展开状态按治疗段记忆，切页签回来不会被强制收起。 */
  const chemoOpen = {};
  function chemoLayerHtml(cycles, episodeId) {
    const first = cycles[0], last = cycles[cycles.length - 1];
    const reduced = cycles.filter(c => Number(c.doseReductionPct) > 0).length;
    const delayed = cycles.filter(c => Number(c.delayDays) > 0).length;
    const bits = ['<b>' + cycles.length + '</b> 周期', esc(first.cycleDate) + ' → ' + esc(last.cycleDate)];
    if (reduced) bits.push('<i class="cx-chemo-warn">减量 ' + reduced + ' 次</i>');
    if (delayed) bits.push('<i class="cx-chemo-warn">延迟 ' + delayed + ' 次</i>');
    if (!reduced && !delayed) bits.push('<i class="cx-chemo-ok">无减量/延迟</i>');
    /* 用治疗段 id 作键：周期数相同的两个化疗段不会互相串展开状态 */
    const key = String(episodeId || first.episodeId || first.episode_id || first.id || cycles.length);
    return '<details class="ws2-layer cx-chemo-fold"' + (chemoOpen[key] ? ' open' : '') +
      ' data-chemo-key="' + esc(key) + '">' +
      '<summary><span class="cx-fold-t">化疗周期</span>' +
      '<span class="cx-fold-meta">' + bits.join('<em>·</em>') + '</span>' +
      '<span class="cx-fold-cue"></span></summary>' +
      '<div class="cx-fold-body">' + chemoTableHtml(cycles) + '</div></details>';
  }
  /* 事件委托：卡片由 innerHTML 重建，逐个绑定监听会随重渲染丢失。 */
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.classList || !d.classList.contains('cx-chemo-fold')) return;
    const k = d.getAttribute('data-chemo-key');
    if (k) chemoOpen[k] = d.open;
  }, true);
  /* 总览的治疗段卡片整体可点击跳转。折叠区必须自己吃掉点击与 Enter/空格，
     否则会连带触发外层跳转，医生一点就被弹到随访记录册、看不到展开效果。 */
  ['click', 'keydown'].forEach((type) => {
    document.addEventListener(type, (e) => {
      const fold = e.target && e.target.closest && e.target.closest('.cx-chemo-fold');
      if (!fold) return;
      if (type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.stopPropagation();
    }, false);
  });

  function tabHtml() {
    const tabs = [['overview', '总览'], ['record', '随访记录册'], ['diagnosis', '诊断'], ['treatment', '治疗与用药'],
      ['checks', '检查检验'], ['baseline', '基线档案'], ['research', '科研数据'], ['records', '全部记录']];
    return '<div class="ws2-tabs">' + tabs.map(([k, label]) =>
      '<button type="button" class="ws2-tab' + (S.tab === k ? ' active' : '') + '" onclick="Workspace.tab(\'' + k + '\')">' + label + '</button>').join('') + '</div>';
  }

  function renderOverview(p, a, w) {
    const eps = arr(w.episodes);
    const recent = arr(w.visits).slice(0, 5);
    const chart = (typeof makeChart === 'function' && arr(p.psa).length > 1) ? makeChart(arr(p.psa), 'green') : '<div class="ws2-empty">PSA 记录不足，暂不绘制曲线。</div>';
    const testoArrSorted = arr(p.testo).slice().sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const latestTesto = testoArrSorted.length ? testoArrSorted[testoArrSorted.length - 1] : null;
    const testoChart = (typeof makeTestoChart === 'function')
      ? makeTestoChart(testoArrSorted)
      : '<div class="ws2-empty">睾酮曲线模块未加载。</div>';
    return '<div class="ws2-grid2">' +
      '<section class="ws2-card"><div class="ws2-card-h">当前状态</div><div class="ws2-status-grid">' +
        '<div class="tone-' + toneDisease(a) + '"><b>疾病</b><span>' + esc((a.disease && a.disease.label) || '待评估') + (p.diseaseCategory ? ' · ' + esc(p.diseaseCategory) : '') + '</span><i>' + esc((a.disease && a.disease.evidence) || '') + '</i></div>' +
        '<div class="tone-' + toneRisk(a) + '"><b>风险</b><span>' + esc(riskLabelSafe(a)) + '</span><i>' + esc((a.strata && a.strata.why) || '') + '</i></div>' +
        '<div class="tone-' + toneCastration(a) + '"><b>去势</b><span>' + esc((a.castration && a.castration.label) || (p.castration == null ? '未评估' : (p.castration ? '是' : '否'))) + '</span><i>' + esc((a.castration && a.castration.detail) || '') + '</i></div>' +
        '<div class="tone-' + toneFollowup(p) + '"><b>随访</b><span>' + esc(p.followupStatus || '在访') + '</span><i>末次 ' + esc(p.lastFollowupDate || '—') + '</i></div>' +
      '</div><div class="ws2-tone-legend"><i class="ok"></i>稳定/达标 <i class="warn"></i>需关注 <i class="danger"></i>异常/进展 <i class="muted"></i>未评估/终止</div></section>' +
      '<section class="ws2-card ws2-summary-card"><div class="ws2-card-h">一句话摘要 <span>确定性模板 · 非 AI 生成</span></div>' +
        '<div class="ws2-summary">' + summaryHtml(p, a, w) + '</div>' +
        '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openVisit()">登记本次就诊 →</button><button class="ws2-link" type="button" onclick="Workspace.openProfileEditor()">补档案 →</button></div></section>' +
      '</div>' +
      '<section class="ws2-card"><div class="ws2-card-h">治疗段 <span>共 ' + eps.length + ' 段 · 点击进入随访记录册</span></div>' +
        /* 卡片整体点击进随访记录册，但折叠区（化疗周期）与表格内部除外：
           点折叠标题要就地展开，不能把医生弹走；表格内文字要能选中复制。 */
        (eps.length ? eps.map(ep => '<div class="ws2-episode-link" role="button" tabindex="0" title="点击进入随访记录册（化疗周期标题除外）" onclick="if(!event.target.closest(\'button,details,summary,table,a,input,select\'))Workspace.openEpisodeRecord(' + ep.id + ')" onkeydown="if((event.key===\'Enter\'||event.key===\' \')&&!event.target.closest(\'details,summary\')){event.preventDefault();Workspace.openEpisodeRecord(' + ep.id + ')}">' + episodeCardHtml(p, w, ep, true) + '</div>').join('') : '<div class="ws2-empty">尚未建立治疗段。点右上角“启动/换线”或“登记本次就诊”。</div>') +
      '</section>' +
      /* 用药时间轴在总览同步展示一份，方便不切页查看；「治疗与用药」页原位保留。 */
      '<section class="ws2-card"><div class="ws2-card-h">用药时间轴 <span>按治疗大类</span></div>' +
        (typeof renderMedTimeline === 'function' ? renderMedTimeline(p, { title: '' }) : '<div class="ws2-empty">用药时间轴模块未加载。</div>') +
      '</section>' +
      (typeof renderTimelineBox === 'function'
        ? renderTimelineBox(arr(p.events), 'ov', { title: '诊疗时间轴', emptyText: '暂无诊疗事件记录' })
        : '') +
      '<div class="ws2-grid2">' +
        '<section class="ws2-card"><div class="ws2-card-h">PSA 曲线 <span>ng/mL</span></div>' + chart + '<button class="ws2-link" type="button" onclick="Workspace.tab(\'checks\',\'ws2PsaCard\')">查看/录入 PSA →</button></section>' +
        '<section class="ws2-card"><div class="ws2-card-h">睾酮曲线 <span>ng/dL · 虚线为去势 50 / 深度降酮 20</span></div>' +
          (latestTesto ? '<div class="ws2-muted" style="margin-bottom:4px">最近：' + esc(latestTesto.unit === 'nmol/L' ? (latestTesto.enteredVal + ' nmol/L') : (latestTesto.val + ' ng/dL')) + '（' + esc(latestTesto.date) + '）</div>' : '') +
          testoChart +
          '<button class="ws2-link" type="button" onclick="Workspace.tab(\'checks\',\'ws2TestoCard\')">查看/录入睾酮 →</button></section>' +
      '</div>' +
      '<section class="ws2-card"><div class="ws2-card-h">最近就诊</div>' +
        (recent.length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>日期</th><th>类型</th><th>小结</th><th></th></tr></thead><tbody>' +
          recent.map(v => '<tr><td>' + esc(v.visitDate) + '</td><td>' + esc(wsl('visitType', v.visitType)) + '</td><td class="ws2-sum">' + esc(v.summary || v.nextPlan || '—') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openVisitDetailById(' + v.id + ')">详情</button></td></tr>').join('') +
          '</tbody></table></div>' : '<div class="ws2-empty">暂无结构化就诊。历史事件仍在“全部记录”。</div>') +
      '</section>' +
      '<section class="ws2-card"><div class="ws2-card-h">指南路径</div>' +
        '<p class="ws2-muted">当前场景：' + esc(scenarioLabel(p, w)) + '。完整 286 节点在“治疗与用药 → 全部方案/指南原图”中查看。</p>' +
        '<div class="ws2-actions" style="margin-top:10px"><button class="btn btn-primary btn-sm" type="button" onclick="Workspace.openTreatmentGuide()">查看当前场景的指南选项 →</button></div></section>' +
        '<section class="ws2-card"><div class="ws2-card-h">患者资料打印</div>' +
        '<p class="ws2-muted">打印该患者的全部随访信息：基本信息、诊断与风险、治疗线/用药、就诊、PSA/睾酮/化验、病理/影像/放疗、结局、AE、合并症、科研数据。</p>' +
        '<div class="ws2-actions"><button class="btn btn-primary btn-sm" type="button" onclick="Workspace.printPatient()">打印患者全部随访信息</button></div></section>' +
      (typeof renderCscoPanel === 'function' ? renderCscoPanel(p, (typeof cscoAssessment === 'function' ? cscoAssessment(p) : a)) : '');
  }

  /* 患者级资料/报告：不属于某个病程事件的出院小结/报告图片。
     旧版表单工作台删除后，这里是唯一上传入口。 */
  function renderReportsCard(p) {
    const rows = arr(p.reports);
    return '<section class="ws2-card"><div class="ws2-card-h">资料 / 报告 <span>' + rows.length + ' 份 · 患者级文件</span></div>' +
      '<p class="ws2-muted">存放不属于某个具体病程事件的报告/出院小结图片；事件相关照片请在病程事件里上传。</p>' +
      (rows.length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>上传日期</th><th>文件</th><th></th></tr></thead><tbody>' +
        rows.map(x => '<tr><td>' + esc(x.date || '—') + '</td><td>' + esc(x.name || '未命名') + '</td><td>' +
          '<button class="ws2-link" type="button" onclick="openReport(\'' + esc(x.url) + '\')">查看</button> ' +
          '<button class="ws2-link" type="button" onclick="Workspace.deleteReport(' + x.id + ')">删除</button></td></tr>').join('') +
        '</tbody></table></div>' : '<div class="ws2-empty">暂无患者级资料。</div>') +
      '<div class="ws2-actions" style="align-items:center;gap:8px;flex-wrap:wrap">' +
        '<input id="ws-report-files" type="file" accept="image/*" multiple style="font-size:12px">' +
        '<button class="btn btn-primary btn-sm" type="button" onclick="Workspace.uploadReports(this)">＋ 上传资料</button></div></section>';
  }
  async function uploadReports(btn) {
    const p = getPatient(selectedId);
    if (!p) return;
    const el = $('ws-report-files');
    const files = Array.from((el && el.files) || []);
    if (!files.length) return toast('⚠ 请选择图片');
    const fd = new FormData();
    files.forEach(f => fd.append('reports', f));
    if (typeof setBusyButton === 'function') setBusyButton(btn, true, '上传中…');
    try {
      await api('/api/patients/' + p.id + '/reports', { method: 'POST', body: fd });
      await refresh(p);
      toast('✅ 资料已上传');
    } catch (e) { toast('⚠ ' + e.message); }
    finally { if (typeof setBusyButton === 'function') setBusyButton(btn, false); }
  }
  async function deleteReport(id) {
    if (!confirm('删除这份患者级资料？')) return;
    const p = getPatient(selectedId);
    try {
      await api('/api/reports/' + id, { method: 'DELETE' });
      if (p) await refresh(p);
      toast('已删除资料');
    } catch (e) { toast('⚠ ' + e.message); }
  }

  function followupPlanHtml(p, a) {
    const plan = a && a.plan;
    const items = arr(plan && plan.intervals);
    if (!items.length) return '';
    const rows = items.map(it => {
      const state = it.missingBaseline ? 'missing' : it.over ? 'over' : it.due ? 'scheduled' : 'pending';
      const stateText = it.missingBaseline ? '缺基线' : it.over ? '已到期' : it.due ? '待完成' : '待补计划';
      const dateBits = [];
      if (it.lastDone) dateBits.push('上次 <b>' + esc(it.lastDone) + '</b>');
      if (it.due) dateBits.push('下次 <b class="' + (it.over ? 'over' : '') + '">' + esc(it.due) + '</b>');
      if (!dateBits.length) dateBits.push('尚无记录');
      return '<div class="ws2-plan-item ' + state + '">' +
        '<div class="ws2-plan-h"><b>' + esc(it.item) + '</b><span class="ws2-plan-state ' + state + '">' + stateText + '</span></div>' +
        '<div class="ws2-plan-dates">' + dateBits.join('<i>·</i>') + '</div>' +
        '<div class="ws2-plan-basis">' + esc(it.basis || '') + '</div></div>';
    }).join('');
    return '<section class="ws2-card"><div class="ws2-card-h">随访计划 <span>' + items.length + ' 项 · 依据指南与当前治疗段自动生成 · 状态只表示完成情况，不参与风险分层</span></div>' +
      '<div class="ws2-plan-legend"><span class="ws2-plan-legend-t">状态：</span><span class="ws2-plan-state over">已到期</span><span class="ws2-plan-state missing">缺基线</span><span class="ws2-plan-state scheduled">待完成/计划中</span><span class="ws2-plan-legend-note">仅表示完成情况，不代表肿瘤风险</span></div>' +
      '<div class="ws2-plan-grid">' + rows + '</div>' +
      '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openVisit()">＋ 记录本次就诊/完成项目</button>' +
      '<button class="ws2-link" type="button" onclick="Workspace.tab(\'checks\',\'ws2ContentTop\')">查看检查检验 →</button></div></section>';
  }

  function renderRecord(p, a, w) {
    const eps = arr(w.episodes);
    if (!eps.length) return '<div class="ws2-card"><div class="ws2-card-h">随访记录册</div><div class="ws2-empty">尚未建立治疗段。先点“启动/换线”建立 RP/RT/ADT/化疗/AS 等段。</div></div>';
    let ep = episodeById(w, S.episodeId) || currentEpisode(w) || eps[0];
    if (ep) S.episodeId = ep.id;
    const chips = eps.map(x => '<button type="button" class="ws2-epchip' + (Number(x.id) === Number(ep.id) ? ' active' : '') + '" data-status="' + esc(x.status || '') + '" onclick="Workspace.episode(' + x.id + ')">' + esc(x.label || x.templateCode) + '</button>').join('');
    return followupPlanHtml(p, a) + '<div class="ws2-card"><div class="ws2-card-h">治疗段 <span>记录册骨架：① 实施 → ② 评分卡 → ③ 随访表</span></div>' +
      '<div class="ws2-epchips">' + chips + '<button class="ws2-epchip add" type="button" onclick="Workspace.openTreatment()">＋ 新增治疗段</button></div>' +
      '<div class="ws2-gantt">' + ganttHtml(eps) + '</div>' +
      episodeCardHtml(p, w, ep, false) +
      '<div class="ws2-print-row"><button class="btn btn-outline btn-sm" type="button" onclick="Workspace.printEpisode(' + ep.id + ')">打印本段随访表</button> ' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="Workspace.backfillVisits()">从历史记录生成就诊</button></div>' +
      '</div>';
  }

  function ganttHtml(eps) {
    const DAY = 86400000;
    const todayMs = Date.parse(today() + 'T00:00:00Z');
    const ordered = eps.slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || Number(a.id) - Number(b.id));
    const items = ordered.map((e, i) => {
      const start = Date.parse(e.startDate + 'T00:00:00Z');
      let end = Date.parse((e.endDate || today()) + 'T00:00:00Z');
      /* 已完成的治疗段没填结束日期时，不能默认画到今天：
         主动监测→手术等序贯治疗会把上一段拖到手术后，视觉上像同时进行。
         有下一段开始日时，以它为结束；没有才回退到今天。 */
      if (!e.endDate && e.status === 'completed') {
        const next = ordered[i + 1];
        const nextStart = next ? Date.parse(next.startDate + 'T00:00:00Z') : null;
        if (nextStart && nextStart >= start) end = nextStart;
        else end = todayMs;
      }
      if (!Number.isFinite(end) || end < start) end = start;
      return { e, start, end, oneDay: (end - start) < DAY };
    });
    const min = Math.min(...items.map(x => x.start));
    const max = Math.max(...items.map(x => x.end), min + DAY);
    const span = Math.max(DAY, max - min);
    const years = [];
    const y0 = new Date(min).getUTCFullYear(), y1 = new Date(max).getUTCFullYear();
    for (let y = y0; y <= y1; y++) {
      const t = Date.UTC(y, 0, 1);
      if (t >= min && t <= max) years.push({ y, left: ((t - min) / span * 100) });
    }
    if (!years.length || years[0].left > 0.1) years.unshift({ y: y0, left: 0 });
    const axis = '<div class="ws2-gantt-axis"><span></span><div class="ws2-gantt-axis-track">' +
      years.map(x => '<b style="left:' + x.left.toFixed(2) + '%">' + x.y + '</b>').join('') + '</div></div>';
    const rows = items.map(({ e, start, end, oneDay }) => {
      const left = ((start - min) / span * 100).toFixed(2);
      const width = Math.max(0.8, ((end - start) / span * 100)).toFixed(2);
      const fmt = ms => new Date(ms).toISOString().slice(0, 10);
      const label = esc(e.label || e.templateCode);
      const tip = fmt(start) + ' → ' + fmt(end) + (oneDay ? '（单日操作）' : '');
      if (oneDay) {
        return '<div class="ws2-gantt-row" title="' + esc(tip) + '"><span>' + label + '</span>' +
          '<div class="ws2-gantt-track"><i class="ws2-gantt-milestone ' + (e.status || '') + '" style="left:' + left + '%"></i></div></div>';
      }
      return '<div class="ws2-gantt-row" title="' + esc(tip) + '"><span>' + label + '</span>' +
        '<div class="ws2-gantt-track"><i class="' + (e.status || '') + '" style="left:' + left + '%;width:' + width + '%"></i></div></div>';
    }).join('');
    return axis + rows;
  }

  function renderDiagnosis(p, a, w) {
    const paths = arr(p.pathologyReports);
    const imgs = arr(p.imagingStudies);
    return '<div class="ws2-grid2">' +
      '<section class="ws2-card"><div class="ws2-card-h">诊断与分期</div><div class="ws2-kv">' +
        kv('临床分期', p.clinicalStage || '—') + kv('病理分期', p.pathologicStage || '—') +
        kv('活检 Gleason', (window.ClinicalCore && ClinicalCore.pickBiopsyPathology ? (() => { const x = ClinicalCore.pickBiopsyPathology(p); return x && x.gleasonTotal != null ? (x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal + ' / GG' + (x.isup || '—')) : (p.gleasonSource === 'biopsy' ? (p.gleason || '—') : '未录'); })() : (p.gleason || '—'))) +
        kv('RP 病理 Gleason', (window.ClinicalCore && ClinicalCore.pickPostopPathology ? (() => { const x = ClinicalCore.pickPostopPathology(p); return x && x.gleasonTotal != null ? (x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal + ' / GG' + (x.isup || '—')) : '未手术/未录'; })() : '—')) +
        kv('CSCO 风险', riskLabelSafe(a) + ((a.strata && a.strata.why) ? '（依据：' + a.strata.why + '）' : '')) +
        kv('疾病状态', (a.disease && a.disease.label) || '待评估') + kv('四分类分期', p.diseaseCategory || '未判定（需医生确认）') +
        kv('瘤负荷', (() => { try { const b = ClinicalCore.tumorBurden(p); return b.label + (b.basis ? '（' + b.basis + '）' : ''); } catch (e) { return '未评估'; } })()) + kv('DRE', p.dreResult === 'abnormal' ? '异常' : p.dreResult === 'normal' ? '正常' : '未做/未记录') +
      '</div><div class="ws2-actions"><button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openProfileEditor()">编辑诊断/分期</button><button class="ws2-link" type="button" onclick="Workspace.openVisit()">＋ 病理 / 影像 / 结局</button></div></section>' +
      '<section class="ws2-card"><div class="ws2-card-h">病理报告 <span>' + paths.length + '</span></div>' +
        (paths.length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>日期</th><th>标本</th><th>主要</th><th>Gleason/ISUP</th><th>pTNM</th><th>切缘</th><th>淋巴结</th><th></th></tr></thead><tbody>' +
          paths.map(x => '<tr><td>' + esc(x.reportDate) + '</td><td>' + esc(wsl('specimenType', x.specimenType)) + '</td><td>' + (x.isPrimary ? '<b style="color:#2f8f74">主要</b>' : '—') + '</td><td>' + esc((x.gleasonPrimary != null ? x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal : '—') + ' / GG' + (x.isup || '—')) + '</td><td>' + esc(x.ptnm || '—') + '</td><td>' + esc(x.marginStatus ? wsl('marginStatus', x.marginStatus) : '—') + '</td><td>' + fmt(x.lnPositive) + '/' + fmt(x.lnExamined) + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openStructuredEditor(\'pathology\',' + x.id + ')">编辑</button></td></tr>').join('') +
          '</tbody></table></div>' : '<div class="ws2-empty">暂无病理。点“＋ 病理/影像/结局”或登记本次就诊时新增。</div>') +
      '</section></div>' +
      (paths.length ? '<section class="ws2-card"><div class="ws2-card-h">病理详情 <span>IDC-P / 筛状 / DAC / NEPC / PNI / 针数</span></div>' +
        paths.map(x => '<details class="ws2-path-detail"><summary>' + esc(x.reportDate) + ' · ' + esc(wsl('specimenType', x.specimenType)) + ' · ' +
          esc(x.gleasonPrimary != null ? (x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal) : 'Gleason 未录') + ' · GG' + esc(x.isup || '—') + '</summary>' +
          '<div class="ws2-kv">' +
            kv('穿刺针数/阳性', (x.coresTotal != null ? (x.coresPositive || 0) + '/' + x.coresTotal + (x.coresPositivePct != null ? '（' + x.coresPositivePct + '%）' : '') : '不适用')) +
            kv('单针最大癌占比', x.coresMaxCancerPct != null ? x.coresMaxCancerPct + '%' : '—') +
            kv('组织学类型', x.histologyType ? wsl('histologyType', x.histologyType) : '—') + kv('pTNM', x.ptnm || '—') +
            kv('切缘', (x.marginStatus ? wsl('marginStatus', x.marginStatus) : '—') + (x.marginSite ? ' · ' + x.marginSite : '')) +
            kv('ECE/SVI', (x.ece == null ? '未评估' : (x.ece ? '有' : '无')) + ' / ' + (x.svi == null ? '未评估' : (x.svi ? '有' : '无'))) +
            kv('IDC-P/筛状', (x.idcP == null ? '未评估' : (x.idcP ? '有' : '无')) + ' / ' + (x.cribriform == null ? '未评估' : (x.cribriform ? '有' : '无'))) +
            kv('DAC/NEPC', (x.dac == null ? '未评估' : (x.dac ? '有' : '无')) + ' / ' + (x.nepc == null ? '未评估' : (x.nepc ? '有' : '无'))) +
            kv('PNI/肿瘤体积', (x.pni == null ? '未评估' : (x.pni ? '有' : '无')) + ' / ' + (x.tumorVolumePct != null ? x.tumorVolumePct + '%' : '—')) +
            kv('淋巴结阳性/送检', (x.lnPositive == null ? '—' : x.lnPositive) + '/' + (x.lnExamined == null ? '—' : x.lnExamined)) +
          '</div>' +
          (x.notes ? '<p class="ws2-muted">备注：' + esc(x.notes) + '</p>' : '') +
        '</details>').join('') + '</section>' : '') +
      '<section class="ws2-card"><div class="ws2-card-h">结局与转归 <span>' + arr(p.outcomes).length + '</span></div>' +
        (arr(p.outcomes).length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>类型</th><th>日期</th><th>亚型/部位</th><th>依据</th><th>备注</th><th></th></tr></thead><tbody>' +
          arr(p.outcomes).slice().sort((x, y) => String(y.eventDate).localeCompare(String(x.eventDate))).map(o => '<tr><td>' + esc(wsl('outcomeType', o.outcomeType)) + '</td><td>' + esc(o.eventDate) + '</td><td>' + esc(o.subtype || o.metastaticSites || o.deathCause || o.lostReason || '—') + '</td><td>' + esc(o.basis || '—') + '</td><td class="ws2-sum">' + esc(o.note || '—') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openStructuredEditor(\'outcome\',' + o.id + ')">编辑</button> <button class="ws2-link" type="button" onclick="Workspace.deleteRecord(\'outcome\',' + o.id + ')">删除</button></td></tr>').join('') +
          '</tbody></table></div>' : '<div class="ws2-empty">暂无结局记录；点“＋ 病理/影像/结局”在就诊卡中新增。</div>') +
      '</section>' +
      '<section class="ws2-card"><div class="ws2-card-h">影像与分期证据 <span>' + imgs.length + '</span></div>' +
        (imgs.length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>日期</th><th>模态</th><th>PI-RADS/PSMA</th><th>病灶/部位</th><th>RECIST</th><th>比较</th><th></th></tr></thead><tbody>' +
          imgs.slice().reverse().slice(0, 20).map(x => '<tr><td>' + esc(x.studyDate) + '</td><td>' + esc(wsl('imagingModality', x.modality)) + '</td><td>' + esc([x.pirads != null ? 'PI-RADS ' + x.pirads : '', x.psmaPositive ? 'PSMA+' : '', x.miTnm || ''].filter(Boolean).join(' · ') || '—') + '</td><td>' + esc([x.lesionCount != null ? x.lesionCount + ' 灶' : '', x.metastaticSites || '', x.indexLocation || ''].filter(Boolean).join(' · ') || '—') + '</td><td>' + esc(x.recist || '—') + '</td><td>' + esc(x.comparison ? wsl('comparison', x.comparison) : '—') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openStructuredEditor(\'imaging\',' + x.id + ')">编辑</button></td></tr>').join('') +
          '</tbody></table></div>' : '<div class="ws2-empty">暂无影像记录。</div>') +
      '</section>' +
      '<div class="ws2-grid2">' +
        '<section class="ws2-card"><div class="ws2-card-h">基因 / 遗传咨询</div>' +
          (arr(p.genomicTests).length ? arr(p.genomicTests).map(x => '<div class="ws2-line"><b>' + esc(x.testType === 'germline' ? '胚系' : '体系') + '</b> ' + esc(x.testDate) + ' · ' + esc(x.genes || '—') + ' · HRR ' + esc(x.hrrStatus ? wsl('hrr', x.hrrStatus) : '未评估') + ' · MSI ' + esc(x.msiStatus ? wsl('msi', x.msiStatus) : '未评估') + (x.counselingStatus ? ' · 咨询 ' + esc(wsl('counselingStatus', x.counselingStatus)) : '') + '</div>').join('') : '<div class="ws2-empty">暂无基因检测；高危/转移/IDC-P/DAC/家族史建议检测。</div>') +
        '</section>' +
        '<section class="ws2-card"><div class="ws2-card-h">疾病状态历史</div>' +
          (arr(w.diseaseStates).length ? w.diseaseStates.map(s => '<div class="ws2-line"><b>' + esc(s.stateCode) + '</b> ' + esc(s.sinceDate) + ' · ' + esc(wsl('diseaseStateStatus', s.status)) + (s.isCurrent ? ' · 当前' : '') + '<div class="ws2-muted">' + esc(s.basis || '') + '</div></div>').join('') : '<div class="ws2-empty">尚无医生确认的状态快照；自动评估仍在总览显示。</div>') +
        '</section>' +
      '</div>';
  }
  function kv(k, v) { return '<div><b>' + esc(k) + '</b><span>' + esc(v) + '</span></div>'; }

  function scenarioFor(p, w, a) {
    const dc = p.diseaseCategory || '';
    const lines = arr(p.treatmentLines);
    if (dc === 'mCRPC') {
      const arpi = lines.some(l => /阿比特龙|恩扎|阿帕|达罗|瑞维|氘恩扎/i.test(String(l.regimen || '')));
      const chemo = lines.some(l => /多西|卡巴|化疗/i.test(String(l.regimen || '')));
      if (arpi && chemo) return 'mCRPC_2L_arpi_chemo_fail';
      if (arpi) return 'mCRPC_2L_arpi_fail';
      return 'mCRPC_1L';
    }
    if (dc === 'nmCRPC') return 'nmCRPC';
    if (dc === 'mHSPC') {
      /* 只信 ClinicalCore 的 CHAARTED 判断：≥4 处骨转移但缺“是否盆腔/脊柱外”时是 unknown，
         不能在这里用 metCount>=4 私自升级成高瘤负荷。 */
      const burden = (window.ClinicalCore && ClinicalCore.tumorBurden) ? ClinicalCore.tumorBurden(p) : null;
      if (burden && burden.level === 'high') return 'mHSPC_high';
      if (burden && burden.level === 'unknown') return 'mHSPC_burden_unknown';
      return p.oligoType === 'oligo_meta' ? 'mHSPC_meta_low' : 'mHSPC_sync_low';
    }
    const bcr = arr(p.outcomes).find(o => o.outcomeType === 'BCR');
    if (bcr) {
      const hasMet = arr(p.outcomes).some(o => o.outcomeType === 'metastasis') ||
        (window.ClinicalCore && ClinicalCore.metastasisEvidence ? ClinicalCore.metastasisEvidence(p) : false);
      const hasRp = arr(p.pathologyReports).some(x => ['RP', 'tissue_RP'].includes(x.specimenType) || !!x.ptnm) ||
        !!(w && arr(w.surgeryRecords).length) || !!p.pathologicStage;
      const hasRt = arr(p.radiationRecords).length > 0;
      if (hasRp) return hasMet ? 'bcr_post_rp_met' : 'bcr_post_rp_no_met';
      if (hasRt) {
        const psadt = (window.ClinicalCore && ClinicalCore.psadtMonths) ? ClinicalCore.psadtMonths(arr(p.psa)) : null;
        if (psadt == null) return 'bcr_post_rt_psadt_unknown';
        return psadt <= 9 ? 'bcr_post_rt_psadt_low' : 'bcr_post_rt_psadt_high';
      }
      return hasMet ? 'bcr_post_rp_met' : 'bcr_post_rp_no_met';
    }
    /* RP 术后未复发：进入术后风险/辅助治疗节点，不直接套用局限期高危。 */
    const postop = (window.ClinicalCore && ClinicalCore.pickPostopPathology) ? ClinicalCore.pickPostopPathology(p) : null;
    if (postop) {
      const pn1 = Number(postop.lnPositive || 0) > 0 || /pN1/i.test(String(postop.ptnm || ''));
      const highRisk = /pN1/i.test(String(postop.ptnm || '')) && (Number(postop.lnPositive || 0) >= 3 || postop.marginStatus === 'positive');
      if (pn1) return highRisk ? 'post_op_pN1_high' : 'post_op_pN1_low';
      const adverse = postop.marginStatus === 'positive' || postop.ece === true || postop.svi === true;
      return adverse ? 'post_op_pN0_adverse' : 'post_op_pN0_no_adverse';
    }
    const riskLabel = (a.strata && a.strata.strata) || '';
    if (riskLabel === '低危') return 'localized_low';
    if (riskLabel === '中危(预后良好)') return 'localized_favorable_intermediate';
    if (riskLabel === '中危(预后不良)' || riskLabel === '中危') return 'localized_unfavorable_intermediate';
    if (riskLabel === '极高危') return 'localized_very_high';
    if (riskLabel === '高危') return 'localized_high';
    if (riskLabel === '区域') return 'cN1';
    if (riskLabel === '转移') return 'mHSPC_high';
    return 'localized_low';
  }

  function scenarioLabel(p, w) {
    const a = assessOf(p);
    const key = S.scenario || scenarioFor(p, w, a);
    const sc = (S.catalog && S.catalog.scenarios || []).find(x => x.key === key);
    return sc ? sc.label : key;
  }

  function renderTreatment(p, a, w) {
    const key = S.scenario || scenarioFor(p, w, a);
    S.scenario = key;
    const scenarios = (S.catalog && S.catalog.scenarios || []).map(sc =>
      '<option value="' + esc(sc.key) + '"' + (sc.key === key ? ' selected' : '') + '>' + esc(sc.label) + '</option>').join('');
    const wanted = key === 'localized_very_high' ? ['localized_very_high', 'localized_high'] : [key];
    const options = (S.catalog && S.catalog.treatmentOptions || []).filter(x => wanted.includes(x.scenario));
    const lines = arr(p.treatmentLines);
    return '<section class="ws2-card" id="ws2GuidelineCard"><div class="ws2-card-h">指南方案库 <span>当前场景：' + esc(scenarioLabel(p, w)) + '</span></div>' +
      '<div class="ws2-scenario-row"><label>切换场景（查看全部 286 节点落点）</label><select onchange="Workspace.setScenario(this.value)">' + scenarios + '</select>' +
      '<button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openTreatment()">＋ 自定义治疗段</button></div>' +
      (key === 'mHSPC_burden_unknown' ? '<div class="ws2-empty" style="border-color:#d8b36a;background:#fffaf0;color:#7a5a1f">当前 mHSPC 的瘤负荷未评估：请先补转移灶数量、是否位于盆腔/脊柱外、有无内脏转移；系统不会默认按高瘤负荷处理。</div><div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openProfileEditor()">补瘤负荷 →</button></div>' : '') + '<div class="ws2-option-grid">' + (options.length ? options.map(op => optionCardHtml(op)).join('') : (key === 'mHSPC_burden_unknown' ? '<div class="ws2-empty">补完负荷后再选择方案。</div>' : '<div class="ws2-empty">该场景暂无目录选项；可自定义治疗段或查看全部方案。</div>')) + '</div>' +
      '<p class="ws2-muted">选项来自 CSCO 2026 图一/图二；级别、前置条件、监测与出处随卡片显示。选择后进入治疗段向导，医生可偏离指南并填写原因。</p>' +
      '</section>' +
      '<section class="ws2-card"><div class="ws2-card-h">治疗线与治疗段 <span>' + lines.length + ' 线 / ' + arr(w.episodes).length + ' 段</span></div>' +
        (lines.length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>线</th><th>情境</th><th>方案</th><th>起止</th><th>停药/疗效</th><th></th></tr></thead><tbody>' +
          lines.map(l => '<tr><td>' + fmt(l.lineNo) + '</td><td>' + esc(l.setting) + '</td><td>' + esc(l.regimen) + '</td><td>' + esc(l.startDate) + ' → ' + esc(l.endDate || '至今') + '</td><td>' + esc([l.stopReasonCode ? wsl('stopReason', l.stopReasonCode) : '', l.responseCode ? wsl('response', l.responseCode) : ''].filter(Boolean).join(' · ') || '—') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openTreatmentLineEditor(' + l.id + ')">编辑</button></td></tr>').join('') +
          '</tbody></table></div>' : '<div class="ws2-empty">暂无治疗线。点“＋ 新增治疗线”或从上方方案库选择。</div>') +
        '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openTreatmentLineEditor()">＋ 新增治疗线</button> <button class="ws2-link" type="button" onclick="Workspace.openMedicationEditor()">＋ 新增用药</button></div>' +
      '</section>' +
      '<section class="ws2-card"><div class="ws2-card-h">放疗记录 <span>' + arr(p.radiationRecords).length + '</span></div>' +
        (arr(p.radiationRecords).length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>类型</th><th>起止</th><th>剂量/分割</th><th>靶区</th><th>联合 ADT</th><th>备注</th><th></th></tr></thead><tbody>' +
          arr(p.radiationRecords).map(r => '<tr><td>' + esc(wsl('rtType', r.rtType)) + '</td><td>' + esc(r.startDate) + ' → ' + esc(r.endDate || '—') + '</td><td>' + esc([r.doseGy != null ? r.doseGy + 'Gy' : '', r.fractions ? r.fractions + 'f' : ''].filter(Boolean).join('/') || '—') + '</td><td>' + esc(r.target ? wsl('rtTarget', r.target) : '—') + '</td><td>' + (r.concurrentAdt ? '是' : '否') + '</td><td class="ws2-sum">' + esc(r.notes || '—') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openStructuredEditor(\'radiation\',' + r.id + ')">编辑</button></td></tr>').join('') +
          '</tbody></table></div>' : '<div class="ws2-empty">暂无放疗记录；点“在就诊卡中录入放疗”新增。</div>') +
        '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openVisit()">在就诊卡中录入放疗 →</button></div></section>' +
      '<section class="ws2-card"><div class="ws2-card-h">用药时间轴 <span>按治疗大类</span></div>' +
        (typeof renderMedTimeline === 'function' ? renderMedTimeline(p, { title: '' }) : '<div class="ws2-empty">用药时间轴模块未加载。</div>') +
      '</section>' +
      '<section class="ws2-card"><div class="ws2-card-h">用药（当前与历史） <span>' + arr(p.medications).length + '</span></div>' +
        (arr(p.medications).length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>类别</th><th>药物</th><th>剂量/频次</th><th>起止</th><th>状态</th><th></th></tr></thead><tbody>' +
          p.medications.slice().sort((a,b)=>String(b.startDate).localeCompare(String(a.startDate))).map(m => '<tr><td>' + esc(wsl('medCategory', m.category)) + '</td><td>' + esc(m.drug) + '</td><td>' + esc([m.dose, m.schedule].filter(Boolean).join(' ') || '—') + '</td><td>' + esc(m.startDate) + ' → ' + esc(m.endDate || '至今') + '</td><td>' + (m.endDate && m.endDate < today() ? '已结束' : '当前') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openMedicationEditor(' + m.id + ')">编辑</button></td></tr>').join('') +
          '</tbody></table></div>' : '<div class="ws2-empty">暂无用药记录。</div>') +
      '</section>';
  }
  function optionCardHtml(op) {
    const level = op.level || '';
    const cls = /^I\b/.test(level) ? 'lv1' : /^II\b/.test(level) ? 'lv2' : 'lv3';
    return '<div class="ws2-option ' + cls + '">' +
      '<div class="ws2-option-h"><b>' + esc(op.label) + '</b><span>' + esc(level) + '</span></div>' +
      '<div class="ws2-option-meta">' + esc(op.source || '') + (op.availability === 'unavailable_cn' ? ' · 国内未上市' : '') + '</div>' +
      (arr(op.prerequisites).length ? '<div class="ws2-option-pre">前置：' + esc(op.prerequisites.join('；')) + '</div>' : '') +
      (op.monitoring ? '<div class="ws2-option-mon">监测：' + esc(op.monitoring) + '</div>' : '') +
      '<button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openTreatment(\'' + esc(op.id) + '\')">选择此方案</button>' +
    '</div>';
  }

  function renderChecks(p, w) {
    const psa = arr(p.psa).slice().reverse();
    const testo = arr(p.testo).slice().reverse();
    const labs = arr(p.labValues).slice().reverse();
    const imgs = arr(p.imagingStudies).slice().reverse();
    return '<div class="ws2-grid2">' +
      '<section class="ws2-card" id="ws2PsaCard"><div class="ws2-card-h">PSA <span>' + psa.length + ' 条' + (() => { try { const x = ClinicalCore.psadtMonths(arr(p.psa)); return x != null ? ' · PSADT ' + Number(x).toFixed(1) + ' 月' : ''; } catch (e) { return ''; } })() + '</span></div>' +
        (psa.length ? '<div class="ws2-table-wrap ws2-maxh"><table class="ws2-table"><thead><tr><th>日期</th><th>值</th><th>标记</th><th></th></tr></thead><tbody>' +
          psa.map(x => '<tr><td>' + esc(x.date) + '</td><td><b>' + esc(psaText(x)) + '</b> ng/mL</td><td>' + (x.isInitial ? '初始' : '') + (x.belowLod ? ' · 低于下限' : '') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openPsaEditor(' + x.id + ')">编辑</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="ws2-empty">暂无 PSA。</div>') +
        '<button class="ws2-link" type="button" onclick="Workspace.openPsaEditor()">＋ 新增 / 编辑 PSA →</button></section>' +
      '<section class="ws2-card" id="ws2TestoCard"><div class="ws2-card-h">睾酮 <span>' + testo.length + ' 条' + (() => { try { const c = ClinicalCore.castrationState(p); return c && c.label ? ' · ' + c.label : ''; } catch (e) { return ''; } })() + '</span></div>' +
        (testo.length ? '<div class="ws2-table-wrap ws2-maxh"><table class="ws2-table"><thead><tr><th>日期</th><th>值</th><th>方法/实验室</th><th></th></tr></thead><tbody>' +
          testo.map(x => '<tr><td>' + esc(x.date) + '</td><td><b>' + esc(x.enteredVal != null ? x.enteredVal : x.val) + '</b> ' + esc(x.unit || 'ng/dl') + '</td><td>' + esc([x.assayMethod, x.lab].filter(Boolean).join(' · ') || '—') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openTestoEditor(' + x.id + ')">编辑</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="ws2-empty">暂无睾酮。</div>') +
        '<button class="ws2-link" type="button" onclick="Workspace.openTestoEditor()">＋ 新增 / 编辑睾酮 →</button></section></div>' +
      '<div class="ws2-grid2">' +
        '<section class="ws2-card"><div class="ws2-card-h">化验 <span>' + labs.length + ' 条</span></div>' +
          (labs.length ? '<div class="ws2-table-wrap ws2-maxh"><table class="ws2-table"><thead><tr><th>日期</th><th>项目</th><th>值</th><th>单位</th><th></th></tr></thead><tbody>' +
            labs.slice(0, 60).map(x => '<tr><td>' + esc(x.date) + '</td><td>' + esc(x.item || x.itemCode) + '</td><td>' + fmt(x.value) + '</td><td>' + esc(x.unit || '') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openLabEditor(' + x.id + ')">编辑</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="ws2-empty">暂无结构化化验。旧“化验/监测”事件仍在全部记录。</div>') +
          '<button class="ws2-link" type="button" onclick="Workspace.openLabEditor()">＋ 新增化验 →</button></section>' +
        '<section class="ws2-card"><div class="ws2-card-h">影像 <span>' + imgs.length + ' 次</span></div>' +
          (imgs.length ? '<div class="ws2-table-wrap ws2-maxh"><table class="ws2-table"><thead><tr><th>日期</th><th>模态</th><th>关键结果</th></tr></thead><tbody>' +
            imgs.slice(0, 30).map(x => '<tr><td>' + esc(x.studyDate) + '</td><td>' + esc(wsl('imagingModality', x.modality)) + '</td><td>' + esc([x.pirads != null ? 'PI-RADS ' + x.pirads : '', x.metastaticSites || '', x.recist || '', x.miTnm || ''].filter(Boolean).join(' · ') || '—') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="ws2-empty">暂无影像。</div>') +
          '<button class="ws2-link" type="button" onclick="Workspace.openVisit()">在就诊卡中录入影像/病程 →</button></section>' +
      '</div>' +
      '<section class="ws2-card"><div class="ws2-card-h">功能与监测（DEXA/FRAX/IPSS/IIEF-5/EPIC-26/疼痛）</div>' +
        (arr(p.clinicalRecords).length ? '<div class="ws2-table-wrap ws2-maxh"><table class="ws2-table"><thead><tr><th>日期</th><th>分类</th><th>项目</th><th>值</th><th>状态</th><th></th></tr></thead><tbody>' +
          arr(p.clinicalRecords).slice().reverse().slice(0, 40).map(x => '<tr><td>' + esc(x.date) + '</td><td>' + esc(wsl('clinicalCategory', x.category)) + '</td><td>' + esc(x.item) + '</td><td>' + fmt(x.val) + ' ' + esc(x.unit || '') + '</td><td>' + esc(wsl('clinicalStatus', x.status)) + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openClinicalEditor(' + x.id + ')">编辑</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="ws2-empty">暂无功能/监测记录；点“＋ 新增评估/监测”录入。</div>') +
        '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openClinicalEditor()">＋ 新增评估/监测</button></div></section>';
  }

  function renderBaseline(p, w) {
    const comorbs = arr(w.comorbidities);
    const byCode = {};
    comorbs.forEach(x => { byCode[x.diseaseCode] = x; });
    const catalog = (S.catalog && S.catalog.comorbidities) || [];
    return '<div class="ws2-grid2">' +
      '<section class="ws2-card"><div class="ws2-card-h">基线</div><div class="ws2-kv">' +
        kv('主要症状', p.mainSymptom || '—') + kv('症状病程(月)', p.symptomDurationMonths == null ? '—' : p.symptomDurationMonths) +
        kv('基线疼痛 NRS', p.baselinePainNrs == null ? '—' : p.baselinePainNrs) + kv('DRE', p.dreResult === 'abnormal' ? '异常' : p.dreResult === 'normal' ? '正常' : '未做/未记录') +
        kv('DRE 描述', p.dreNote || '—') + kv('ECOG', p.ecog == null ? '未评估' : p.ecog) + kv('BMI', p.bmi == null ? '—' : p.bmi) +
        kv('吸烟', p.smoking || '—') + kv('家族史', p.familyHistory == null ? '未评估' : (p.familyHistory ? '有' : '无')) +
        kv('籍贯', p.birthplace || '—') + kv('住院号', p.admissionNoMasked || '—') +
      '</div><div class="ws2-actions"><button class="btn btn-primary btn-sm" type="button" onclick="Workspace.openBaseline()">补基线信息</button>' +
        '<button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openProfileEditor()">完整档案</button></div></section>' +
      '<section class="ws2-card"><div class="ws2-card-h">合并症 <span>记录册 p2 · 实拍 21 项 · 点击录入</span></div>' +
        '<div class="ws2-comorb">' + catalog.map(c => {
          const x = byCode[c.code];
          return '<button type="button" class="ws2-comorb-item ' + (x ? x.status : 'unknown') + '" onclick="Workspace.openComorbidity(\'' + esc(c.code) + '\')">' + esc(c.label) + (x ? ' · ' + esc(wsl('comorbidityStatus', x.status)) : ' · 未评估') + '</button>';
        }).join('') + '</div>' +
        '<p class="ws2-muted">记录册原文写“18 个具名合并症”，p2 实拍页实际列出 21 个勾选项；目录按实拍页列全。未评估不等于阴性。</p>' +
      '</section></div>' +
      '<section class="ws2-card"><div class="ws2-card-h">疾病状态 <span>' + arr(w.diseaseStates).length + '</span></div>' +
        (arr(w.diseaseStates).length ? arr(w.diseaseStates).map(x => '<div class="ws2-line"><b>' + esc(x.stateCode) + ' · ' + esc(x.stateLabel) + '</b> ' + esc(x.sinceDate) + (x.isCurrent ? ' · 当前' : '') + ' · ' + esc(x.basis || '—') + '</div>').join('') : '<div class="ws2-empty">暂无状态快照。</div>') +
        '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openDiseaseStateEditor()">＋ 新增疾病状态</button></div></section>' +
      '<section class="ws2-card"><div class="ws2-card-h">科研与合规</div><div class="ws2-kv">' +
        kv('知情同意', p.researchConsent == null ? '未记录' : (p.researchConsent ? '已签' : '未签')) + kv('同意日期', p.researchConsentDate || '—') +
        kv('数据共享', p.dataSharing == null ? '未记录' : (p.dataSharing ? '已授权' : '未授权')) + kv('共享范围', p.dataSharingScope || '—') +
      '</div><div class="ws2-actions"><button class="btn btn-outline btn-sm" type="button" onclick="Workspace.openConsentEditor()">修改科研与合规</button></div></section>';
  }

  function renderResearch(p, w) {
    return '<div class="ws2-grid2">' +
      '<section class="ws2-card"><div class="ws2-card-h">样本库 <span>' + arr(p.specimens).length + '</span></div>' +
        (arr(p.specimens).length ? arr(p.specimens).map(x => '<div class="ws2-line"><b>' + esc(wsl('sample', x.sampleType)) + '</b> ' + esc(x.collectionDate) + ' · 肿瘤细胞 ' + fmt(x.tumorCellPct) + '% · 库号 ' + esc(x.biobankId || '—') + ' <button class="ws2-link" type="button" onclick="Workspace.openSpecimenEditor(' + x.id + ')">编辑</button></div>').join('') : '<div class="ws2-empty">暂无样本。</div>') + '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openSpecimenEditor()">＋ 新增样本</button></div>' +
      '</section>' +
      '<section class="ws2-card"><div class="ws2-card-h">IHC <span>' + arr(p.ihcResults).length + '</span></div>' +
        (arr(p.ihcResults).length ? arr(p.ihcResults).map(x => '<div class="ws2-line"><b>' + esc(x.marker) + '</b> ' + esc(wsl('ihcResult', x.result)) + ' · ' + fmt(x.percent) + '% · ' + esc(wsl('ihcIntensity', x.intensity)) + ' <button class="ws2-link" type="button" onclick="Workspace.openIhcEditor(' + x.id + ')">编辑</button></div>').join('') : '<div class="ws2-empty">暂无 IHC。</div>') + '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openIhcEditor()">＋ 新增 IHC</button></div>' +
      '</section></div>' +
      '<section class="ws2-card"><div class="ws2-card-h">基因组 <span>' + arr(p.genomicTests).length + '</span></div>' +
        (arr(p.genomicTests).length ? arr(p.genomicTests).map(x => '<div class="ws2-line"><b>' + esc(x.testType === 'germline' ? '胚系' : '体系') + '</b> ' + esc(x.testDate) + ' · ' + esc(x.genes || '—') + ' · HRR ' + esc(x.hrrStatus ? wsl('hrr', x.hrrStatus) : '未评估') + ' · MSI ' + esc(x.msiStatus ? wsl('msi', x.msiStatus) : '未评估') + ' · TMB ' + fmt(x.tmbValue) + ' <button class="ws2-link" type="button" onclick="Workspace.openGenomicEditor(' + x.id + ')">编辑</button></div>').join('') : '<div class="ws2-empty">暂无基因组检测。</div>') + '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openGenomicEditor()">＋ 新增基因检测</button></div>' +
        '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openProfileEditor()">编辑患者档案 →</button></div></section>' +
      renderReportsCard(p);
  }

  function renderRecords(p, w) {
    const events = arr(p.events).slice().reverse().slice(0, 100);
    return '<section class="ws2-card"><div class="ws2-card-h">结构化就诊 <span>' + w.visitCount + '</span></div>' +
      (arr(w.visits).length ? '<div class="ws2-table-wrap"><table class="ws2-table"><thead><tr><th>日期</th><th>类型</th><th>科室</th><th>小结</th><th></th></tr></thead><tbody>' +
        w.visits.map(v => '<tr><td>' + esc(v.visitDate) + '</td><td>' + esc(wsl('visitType', v.visitType)) + '</td><td>' + esc(v.department || '—') + '</td><td class="ws2-sum">' + esc(v.summary || v.nextPlan || '—') + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openVisitDetailById(' + v.id + ')">详情</button></td></tr>').join('') +
        '</tbody></table></div>' : '<div class="ws2-empty">暂无结构化就诊。</div>') +
      '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openVisit()">＋ 新增就诊</button><button class="ws2-link" type="button" onclick="Workspace.openEventEditor()">＋ 新增病程事件</button></div></section>' +
      '<section class="ws2-card"><div class="ws2-card-h">原始事件 <span>最近 ' + events.length + ' 条</span></div>' +
        (events.length ? '<div class="ws2-table-wrap ws2-maxh"><table class="ws2-table"><thead><tr><th>日期</th><th>类型</th><th>备注</th><th></th></tr></thead><tbody>' +
          events.map(e => '<tr><td>' + esc(e.date) + '</td><td>' + esc(e.type) + '</td><td class="ws2-sum">' + esc((e.notes || (e.details ? '结构化记录' : '')) + '').slice(0, 120) + '</td><td><button class="ws2-link" type="button" onclick="Workspace.openEventEditor(' + e.id + ')">编辑</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="ws2-empty">暂无事件。</div>') +
      '</section>' +
      (typeof guidedDiaryHtml === 'function' ? guidedDiaryHtml(p) : '');
  }

  function renderContent(p, a, w) {
    switch (S.tab) {
      case 'record': return renderRecord(p, a, w);
      case 'diagnosis': return renderDiagnosis(p, a, w);
      case 'treatment': return renderTreatment(p, a, w);
      case 'checks': return renderChecks(p, w);
      case 'baseline': return renderBaseline(p, w);
      case 'research': return renderResearch(p, w);
      case 'records': return renderRecords(p, w);
      default: return renderOverview(p, a, w);
    }
  }

  function render(p) {
    const el = $('edit-content');
    if (!el) return;
    if (!p) { el.innerHTML = '<div class="empty-hint">← 请选择患者</div>'; return; }
    if (typeof selectedId !== 'undefined' && selectedId && p.id !== selectedId) return;
    if (S.pid !== p.id) { S.pid = p.id; S.tab = 'overview'; S.episodeId = null; S.scenario = ''; }
    if (!p.workspace) {
      el.innerHTML = '<div class="ws2-loading">正在加载患者工作台…</div>';
      loadWorkspace(p).then(() => render(p)).catch(e => { el.innerHTML = '<div class="ws2-error">加载失败：' + esc(e.message) + '</div>'; });
      return;
    }
    if (!S.catalog) {
      el.innerHTML = '<div class="ws2-loading">正在加载指南目录…</div>';
      loadCatalog().then(() => render(p)).catch(e => { el.innerHTML = '<div class="ws2-error">指南目录加载失败：' + esc(e.message) + '</div>'; });
      return;
    }
    const w = p.workspace;
    const a = assessOf(p);
    const title = $('edit-title');
    if (title) {
      title.innerHTML = headerHtml(p, a, w);
      const tone = (a.warning && a.warning.color) || 'pending';
      ['red', 'yellow', 'green', 'gray', 'pending'].forEach(t => title.classList.remove('tone-' + t));
      title.classList.add('tone-' + tone);
      title.dataset.tone = tone;
    }
    el.innerHTML = '<div class="ws2">' + pathHtml(p, a, w) + alertsHtml(p, a, w) + tabHtml() + '<div class="ws2-content">' + renderContent(p, a, w) + '</div></div>';
    const tl = $('ws2');
    if (tl) tl.scrollTop = 0;
    if (S.tab === 'overview' && typeof initTlViewport === 'function') {
      requestAnimationFrame(() => { try { initTlViewport('ov'); } catch (e) {} });
    }
  }

  async function refresh(p) {
    p._detailLoaded = false;
    p.workspace = null;
    delete p.workspace;
    const np = await loadPatientDetail(p.id);
    render(np);
  }

  function scrollWorkspaceTarget(targetId) {
    const el = document.getElementById(targetId || 'ws2ContentTop');
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - 92;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }
  function tab(name, targetId) {
    S.tab = name;
    const p = getPatient(selectedId);
    if (p) render(p);
    requestAnimationFrame(() => scrollWorkspaceTarget(targetId || 'ws2ContentTop'));
  }
  function openTreatmentGuide() {
    tab('treatment', 'ws2GuidelineCard');
  }
  function episode(id) {
    S.episodeId = Number(id);
    const p = getPatient(selectedId);
    if (p) render(p);
    requestAnimationFrame(() => scrollWorkspaceTarget('ws2EpisodeCard'));
  }
  function openEpisodeRecord(id) {
    S.tab = 'record';
    S.episodeId = Number(id);
    const p = getPatient(selectedId);
    if (!p) return;
    render(p);
    requestAnimationFrame(() => scrollWorkspaceTarget('ws2EpisodeCard'));
  }
  function setScenario(key) { S.scenario = key; const p = getPatient(selectedId); if (p) render(p); }

  /* ---------------- 模态框基础 ---------------- */
  function modal(title, body, onOk, okText) {
    closeModal();
    const host = document.createElement('div');
    host.id = 'ws2Modal';
    host.className = 'ws2-modal-mask';
    host.innerHTML = '<div class="ws2-modal" role="dialog" aria-modal="true">' +
      '<div class="ws2-modal-h"><b>' + esc(title) + '</b><button type="button" class="ws2-modal-x" onclick="Workspace.closeModal()">✕</button></div>' +
      '<div class="ws2-modal-b">' + body + '</div>' +
      '<div class="ws2-modal-f"><button class="btn btn-outline btn-sm" type="button" onclick="Workspace.closeModal()">取消</button>' +
      (onOk ? '<button class="btn btn-primary btn-sm" type="button" id="ws2-modal-ok">' + esc(okText || '保存') + '</button>' : '') + '</div></div>';
    document.body.appendChild(host);
    if (onOk) $('ws2-modal-ok').onclick = onOk;
    return host;
  }
  function closeModal() {
    closeSubModal();
    const el = $('ws2Modal');
    if (el) el.remove();
  }

  function termSelect(term, selected, idPrefix) {
    const max = term.maxGrade == null ? 5 : term.maxGrade;
    let opts = '<option value="">未评估</option>';
    for (let i = 0; i <= max; i++) opts += '<option value="' + i + '"' + (selected != null && Number(selected) === i ? ' selected' : '') + '>' + i + '</option>';
    return '<select data-ae="' + esc(term.code) + '" data-prefix="' + esc(idPrefix) + '">' + opts + '</select>';
  }


  /* ---------------- 就诊内的附加记录（复用旧版引导登记的结构化表单） ---------------- */
  function subModal(title, body, onOk, okText) {
    closeSubModal();
    const host = document.createElement('div');
    host.id = 'ws2SubModal';
    host.className = 'ws2-modal-mask ws2-submask';
    host.innerHTML = '<div class="ws2-modal ws2-submodal" role="dialog" aria-modal="true">' +
      '<div class="ws2-modal-h"><b>' + esc(title) + '</b><button type="button" class="ws2-modal-x" onclick="Workspace.closeSubModal()">✕</button></div>' +
      '<div class="ws2-modal-b">' + body + '</div>' +
      '<div class="ws2-modal-f"><button class="btn btn-outline btn-sm" type="button" onclick="Workspace.closeSubModal()">' + (onOk ? '取消' : '关闭') + '</button>' +
      (onOk ? '<button class="btn btn-primary btn-sm" type="button" id="ws2-sub-ok">' + esc(okText || '保存这一项') + '</button>' : '') + '</div></div>';
    document.body.appendChild(host);
    if (onOk) $('ws2-sub-ok').onclick = onOk;
    return host;
  }
  function closeSubModal() {
    const el = $('ws2SubModal');
    if (el) el.remove();
  }

  function visitItemSummary(it) {
    if (!it) return '';
    if (it.type === 'PSA检测') return 'PSA ' + (it.psaVal || '') + ' ng/mL';
    if (it.type === '睾酮检测') return '睾酮 ' + (it.testoVal || '') + ' ' + (it.testoUnit || 'ng/dl');
    if (it.type === '疾病阶段判定') return (typeof DISEASE_CATEGORY_LABEL !== 'undefined' && DISEASE_CATEGORY_LABEL[it.diseaseCategory]) || it.diseaseCategory || '未选择阶段';
    if (it.type === '临床分期评估') return it.stage || '';
    const kind = typeof structuredKindOfType === 'function' ? structuredKindOfType(it.type) : '';
    if (kind && typeof RecordCore !== 'undefined') {
      try {
        if (kind === 'pathology') return RecordCore.pathologySummary(it.data || {});
        if (kind === 'imaging') return RecordCore.imagingSummary(it.data || {});
        if (kind === 'radiation') return [it.data && it.data.rtType, it.data && it.data.startDate, it.data && it.data.doseGy != null ? it.data.doseGy + 'Gy' : ''].filter(Boolean).join(' · ');
        if (kind === 'outcome') return [it.data && it.data.outcomeType, it.data && it.data.eventDate].filter(Boolean).join(' · ');
      } catch (e) {}
    }
    return it.notes || '已添加';
  }

  function renderVisitItems() {
    const box = $('wv-extra-list');
    if (!box) return;
    const items = S.visitItems || [];
    box.innerHTML = items.length ? items.map((it, i) =>
      '<div class="ws2-visit-item"><div class="ws2-visit-item-main"><b>' + esc(it.type) + '</b><span>' + esc(visitItemSummary(it)) + '</span></div>' +
      '<button class="ws2-mini-btn" type="button" onclick="Workspace.editVisitItem(' + i + ')">编辑</button>' +
      '<button class="ws2-mini-btn danger" type="button" onclick="Workspace.removeVisitItem(' + i + ')">移除</button></div>'
    ).join('') : '<div class="ws2-empty">还没有添加记录。</div>';
  }


  /* ---------------- 新版工作台原生编辑卡：不再跳旧版 ---------------- */
  function openProfileEditor() {
    const p = getPatient(selectedId);
    if (!p) return;
    const opt = (v, cur) => '<option value="' + esc(v) + '"' + (String(cur || '') === String(v) ? ' selected' : '') + '>' + esc(v || '—') + '</option>';
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>姓名</label><input id="wp-name" value="' + esc(p.name) + '"></div>' +
      '<div class="ws2-form-row"><label>出生日期</label><input id="wp-birth" type="date" value="' + esc(p.birth || '') + '"></div>' +
      '<div class="ws2-form-row"><label>诊断日期</label><input id="wp-date" type="date" value="' + esc(p.date || '') + '"></div>' +
      '<div class="ws2-form-row"><label>Gleason</label><input id="wp-gleason" value="' + esc(p.gleason || '') + '" placeholder="4+3=7"></div>' +
      '<div class="ws2-form-row"><label>临床分期</label><input id="wp-cstage" value="' + esc(p.clinicalStage || '') + '" placeholder="cT3aN0M0"></div>' +
      '<div class="ws2-form-row"><label>病理分期</label><input id="wp-pstage" value="' + esc(p.pathologicStage || '') + '" placeholder="pT3aN0M0"></div>' +
      '<div class="ws2-form-row"><label>首选治疗（旧版摘要）</label><select id="wp-treatment"><option value="">—</option>' +
        ['根治性手术','放疗','内分泌治疗','主动监测','观察等待'].map(x => '<option value="' + x + '"' + (p.treatment === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>随访状态</label><select id="wp-followup">' + ['在访','失访','死亡'].map(x => '<option value="' + x + '"' + ((p.followupStatus || '在访') === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>疾病阶段</label><select id="wp-dc"><option value="">未判定</option>' +
        [['nmHSPC','nmHSPC'],['mHSPC','mHSPC'],['nmCRPC','nmCRPC'],['mCRPC','mCRPC']].map(x => '<option value="' + x[0] + '"' + (p.diseaseCategory === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>末次随访</label><input id="wp-lastfu" type="date" value="' + esc(p.lastFollowupDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>随访方式</label><select id="wp-fumode"><option value="">—</option>' +
        [['clinic','门诊'],['phone','电话'],['external','线上/外院'],['hospital','住院'],['other','其他']].map(x => '<option value="' + x[0] + '"' + (p.lastFollowupMode === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>ECOG</label><select id="wp-ecog"><option value="">未评估</option>' + ['0','1','2','3','4'].map(x => '<option value="' + x + '"' + (String(p.ecog == null ? '' : p.ecog) === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>BMI</label><input id="wp-bmi" type="number" step="0.1" min="5" max="80" value="' + (p.bmi == null ? '' : esc(p.bmi)) + '"></div>' +
      '<div class="ws2-form-row"><label>吸烟</label><select id="wp-smoke"><option value="">—</option>' +
        [['never','从不'],['former','既往'],['current','目前'],['unknown','不详']].map(x => '<option value="' + x[0] + '"' + (p.smoking === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>家族史</label><select id="wp-family"><option value="">未评估</option><option value="1"' + (p.familyHistory ? ' selected' : '') + '>有</option><option value="0"' + (p.familyHistory === false ? ' selected' : '') + '>无</option></select></div>' +
      '<div class="ws2-form-row"><label>DRE</label><select id="wp-dre"><option value="">未做</option><option value="normal"' + (p.dreResult === 'normal' ? ' selected' : '') + '>正常</option><option value="abnormal"' + (p.dreResult === 'abnormal' ? ' selected' : '') + '>异常</option></select></div>' +
      '<div class="ws2-form-row"><label>DRE 描述</label><input id="wp-dre-note" value="' + esc(p.dreNote || '') + '"></div>' +
      '<div class="ws2-form-row"><label>主要症状</label><input id="wp-symptom" value="' + esc(p.mainSymptom || '') + '"></div>' +
      '<div class="ws2-form-row"><label>症状病程(月)</label><input id="wp-duration" type="number" min="0" value="' + (p.symptomDurationMonths == null ? '' : esc(p.symptomDurationMonths)) + '"></div>' +
      '<div class="ws2-form-row"><label>基线疼痛 NRS</label><input id="wp-pain" type="number" min="0" max="10" value="' + (p.baselinePainNrs == null ? '' : esc(p.baselinePainNrs)) + '"></div>' +
      '<div class="ws2-form-row"><label>合并用药</label><input id="wp-comeds" value="' + esc(p.concomitantMeds || '') + '"></div>' +
      '<div class="ws2-form-row"><label>家族史详情</label><input id="wp-family-detail" value="' + esc(p.familyHistoryDetail || '') + '"></div>' +
      '<div class="ws2-form-row"><label>去势状态</label><select id="wp-cast"><option value=""' + (p.castration == null ? ' selected' : '') + '>未评估</option><option value="1"' + (p.castration ? ' selected' : '') + '>是</option><option value="0"' + (p.castration === false ? ' selected' : '') + '>否</option></select></div>' +
      '<div class="ws2-form-row"><label>瘤负荷</label><select id="wp-oligo"><option value="">未评估</option>' +
        [['none','无转移'],['oligo','寡转移'],['oligo_sync','同时性寡转移'],['oligo_meta','异时性寡转移'],['widespread','广泛转移'],['unknown','未知']].map(x => '<option value="' + x[0] + '"' + (p.oligoType === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>转移灶数</label><input id="wp-met-count" type="number" min="0" value="' + (p.metCount == null ? '' : esc(p.metCount)) + '"></div>' +
      '<div class="ws2-form-row"><label>盆腔外转移</label><select id="wp-met-extra"><option value=""' + (p.metExtraPelvis == null ? ' selected' : '') + '>未评估</option><option value="1"' + (p.metExtraPelvis ? ' selected' : '') + '>有</option><option value="0"' + (p.metExtraPelvis === false ? ' selected' : '') + '>无</option></select></div>' +
      '<div class="ws2-form-row"><label>内脏转移</label><select id="wp-visceral"><option value=""' + (p.visceralMet == null ? ' selected' : '') + '>未评估</option><option value="1"' + (p.visceralMet ? ' selected' : '') + '>有</option><option value="0"' + (p.visceralMet === false ? ' selected' : '') + '>无</option></select></div>' +
      '<div class="ws2-form-row"><label>放疗结束</label><input id="wp-rt-end" type="date" value="' + esc(p.rtEndDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>ADT 开始</label><input id="wp-adt-start" type="date" value="' + esc(p.adtStartDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>籍贯</label><input id="wp-birthplace" value="' + esc(p.birthplace || '') + '"></div>' +
      '<div class="ws2-form-row"><label>住院号</label><input id="wp-admission" value="' + esc(p.admissionNo || '') + '"></div>' +
      '<div class="ws2-form-row"><label>民族</label><input id="wp-ethnicity" value="' + esc(p.ethnicity || '') + '"></div>' +
      '<div class="ws2-form-row"><label>知情同意</label><select id="wp-consent"><option value=""' + (p.researchConsent == null ? ' selected' : '') + '>未记录</option><option value="1"' + (p.researchConsent ? ' selected' : '') + '>已签</option><option value="0"' + (p.researchConsent === false ? ' selected' : '') + '>未签</option></select></div>' +
      '<div class="ws2-form-row"><label>同意日期</label><input id="wp-consent-date" type="date" value="' + esc(p.researchConsentDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>数据共享</label><select id="wp-share"><option value=""' + (p.dataSharing == null ? ' selected' : '') + '>未记录</option><option value="1"' + (p.dataSharing ? ' selected' : '') + '>已授权</option><option value="0"' + (p.dataSharing === false ? ' selected' : '') + '>未授权</option></select></div>' +
      '<div class="ws2-form-row"><label>共享范围</label><input id="wp-share-scope" value="' + esc(p.dataSharingScope || '') + '"></div>' +
      '</div><p class="ws2-muted">档案修改会同步主档；结构化病理/影像请用各卡片的新增按钮，不会覆盖已有记录。</p>';
    modal('编辑患者档案', body, async () => {
      const num = v => v === '' ? null : Number(v);
      const payload = {
        name: $('wp-name').value, birth: $('wp-birth').value || null, date: $('wp-date').value || null,
        gleason: $('wp-gleason').value, clinicalStage: $('wp-cstage').value, pathologicStage: $('wp-pstage').value,
        treatment: $('wp-treatment').value, followupStatus: $('wp-followup').value,
        diseaseCategory: $('wp-dc').value, lastFollowupDate: $('wp-lastfu').value || null,
        lastFollowupMode: $('wp-fumode').value, ecog: num($('wp-ecog').value), bmi: num($('wp-bmi').value),
        smoking: $('wp-smoke').value, familyHistory: $('wp-family').value === '' ? null : Number($('wp-family').value),
        dreResult: $('wp-dre').value, dreNote: $('wp-dre-note').value,
        mainSymptom: $('wp-symptom').value, symptomDurationMonths: num($('wp-duration').value),
        baselinePainNrs: num($('wp-pain').value), concomitantMeds: $('wp-comeds').value,
        researchConsent: $('wp-consent').value === '' ? null : $('wp-consent').value === '1',
        researchConsentDate: $('wp-consent-date').value || null,
        dataSharing: $('wp-share').value === '' ? null : $('wp-share').value === '1',
        dataSharingScope: $('wp-share-scope').value,
        familyHistoryDetail: $('wp-family-detail').value,
        castration: $('wp-cast').value === '' ? null : $('wp-cast').value === '1',
        oligoType: $('wp-oligo').value,
        metCount: $('wp-met-count').value === '' ? null : Number($('wp-met-count').value),
        metExtraPelvis: $('wp-met-extra').value === '' ? null : $('wp-met-extra').value === '1',
        visceralMet: $('wp-visceral').value === '' ? null : $('wp-visceral').value === '1',
        rtEndDate: $('wp-rt-end').value || null,
        adtStartDate: $('wp-adt-start').value || null,
        birthplace: $('wp-birthplace').value,
        admissionNo: $('wp-admission').value,
        ethnicity: $('wp-ethnicity').value
      };
      try {
        await api('/api/patients/' + p.id, { method: 'PUT', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 患者档案已更新'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存档案');
  }

  /* 原生结构化编辑：复用引导登记的结构化字段，但直接改子表，
     不再要求去旧版事件编辑器。 */
  function structuredTypeFor(kind, rec) {
    const ev = rec && rec.eventId ? arr(getPatient(selectedId) && getPatient(selectedId).events).find(e => Number(e.id) === Number(rec.eventId)) : null;
    if (ev && structuredKindOfType(ev.type) === kind) return ev.type;
    if (kind === 'pathology') return rec && (rec.specimenType === 'RP' || rec.specimenType === 'TURP') ? '手术病理报告' : '前列腺穿刺活检病理报告';
    if (kind === 'imaging') return '多参数磁共振(mpMRI)';
    if (kind === 'radiation') return '外照射放疗(EBRT)';
    if (kind === 'outcome') return rec && rec.outcomeType === 'metastasis' ? '转移确认' : '生化复发确认';
    return '';
  }

  function openStructuredEditor(kind, id) {
    const p = getPatient(selectedId); if (!p) return;
    const map = {
      pathology: { list: 'pathologyReports', title: '病理', url: '/pathology/', rec: null },
      imaging: { list: 'imagingStudies', title: '影像', url: '/imaging/', rec: null },
      radiation: { list: 'radiationRecords', title: '放疗', url: '/radiation/', rec: null },
      outcome: { list: 'outcomes', title: '结局', url: '/outcomes/', rec: null }
    };
    const cfg = map[kind]; if (!cfg) return;
    const rec = arr(p[cfg.list]).find(x => Number(x.id) === Number(id)) || {};
    if (!rec.id) return toast('⚠ 未找到该记录');
    const type = structuredTypeFor(kind, rec);
    if (!type) return toast('⚠ 未找到可用的结构化类型');
    const prefix = 'wse' + Date.now().toString(36);
    const date = kind === 'pathology' ? rec.reportDate : kind === 'imaging' ? rec.studyDate : kind === 'radiation' ? rec.startDate : rec.eventDate;
    const data = Object.assign({}, rec);
    const body = '<div class="ws2-form-row"><label>记录日期</label><input id="tl-' + prefix + '-date" type="date" value="' + esc(date || today()) + '"></div>' +
      '<div class="ws2-structured-form">' + structuredFormFields(prefix, type, data) + '</div>' +
      '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteStructured(\'' + kind + '\',' + rec.id + ')">删除这条' + cfg.title + '</button>' +
      '<p class="ws2-muted">修改会同步父事件日期与类型；删除会同时删除对应时间轴事件。</p>';
    modal('编辑' + cfg.title + ' · ' + (rec.reportDate || rec.studyDate || rec.startDate || rec.eventDate || ''), body, async () => {
      try {
        const d = collectStructured(prefix, type);
        if (!d) throw new Error('结构化表单读取失败');
        await api('/api/patients/' + p.id + cfg.url + rec.id, { method: 'PUT', body: JSON.stringify({ eventType: type, data: d }) });
        closeModal(); toast('✅ ' + cfg.title + '已更新'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存' + cfg.title);
  }

  async function deleteStructured(kind, id) {
    const p = getPatient(selectedId); if (!p) return;
    const urls = { pathology: '/pathology/', imaging: '/imaging/', radiation: '/radiation/', outcome: '/outcomes/' };
    if (!urls[kind]) return;
    if (!confirm('确定删除？对应时间轴事件也会一起删除。')) return;
    try {
      await api('/api/patients/' + p.id + urls[kind] + id, { method: 'DELETE' });
      closeModal(); toast('✅ 已删除'); await refresh(p);
    } catch (e) { toast('⚠ ' + e.message); }
  }

  function openPsaEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.psa || []).find(x => Number(x.id) === Number(id)) || {};
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>日期 *</label><input id="wps-date" type="date" value="' + esc(cur.date || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>PSA ng/mL *</label><input id="wps-val" type="number" step="0.001" min="0" value="' + (cur.val == null ? '' : esc(cur.val)) + '"></div>' +
      '<div class="ws2-form-row"><label>低于检测下限</label><select id="wps-below"><option value="0"' + (!cur.belowLod ? ' selected' : '') + '>否</option><option value="1"' + (cur.belowLod ? ' selected' : '') + '>是</option></select></div>' +
      '<div class="ws2-form-row"><label>下限值</label><input id="wps-lod" type="number" step="0.001" value="' + (cur.lod == null ? '' : esc(cur.lod)) + '"></div>' +
      '<div class="ws2-form-row"><label>游离 PSA</label><input id="wps-free" type="number" step="0.001" value="' + (cur.freeVal == null ? '' : esc(cur.freeVal)) + '"></div>' +
      '<div class="ws2-form-row"><label>游离低于下限</label><select id="wps-freebelow"><option value="0"' + (!cur.freeBelowLod ? ' selected' : '') + '>否</option><option value="1"' + (cur.freeBelowLod ? ' selected' : '') + '>是</option></select></div>' +
      '<div class="ws2-form-row"><label>游离下限值</label><input id="wps-freelod" type="number" step="0.001" value="' + (cur.freeLod == null ? '' : esc(cur.freeLod)) + '"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'psa\',' + cur.id + ')">删除这条 PSA</button>' : '') +
      '<p class="ws2-muted">低于检测下限时数值填下限值；修改会重算初始 PSA 顺序。</p>';
    modal(cur.id ? '编辑 PSA' : '新增 PSA', body, async () => {
      const payload = { date: $('wps-date').value, val: Number($('wps-val').value), belowLod: $('wps-below').value === '1',
        lod: $('wps-lod').value === '' ? null : Number($('wps-lod').value),
        freeVal: $('wps-free').value === '' ? null : Number($('wps-free').value),
        freeBelowLod: $('wps-freebelow').value === '1',
        freeLod: $('wps-freelod').value === '' ? null : Number($('wps-freelod').value) };
      try {
        await api('/api/patients/' + p.id + '/psa' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ PSA 已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存 PSA');
  }

  function openTestoEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.testo || []).find(x => Number(x.id) === Number(id)) || {};
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>日期 *</label><input id="wts-date" type="date" value="' + esc(cur.date || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>睾酮值 *</label><input id="wts-val" type="number" step="0.01" min="0" value="' + (cur.enteredVal != null ? esc(cur.enteredVal) : (cur.val == null ? '' : esc(cur.val))) + '"></div>' +
      '<div class="ws2-form-row"><label>单位</label><select id="wts-unit"><option value="ng/dl"' + ((cur.unit || 'ng/dl') === 'ng/dl' ? ' selected' : '') + '>ng/dl</option><option value="nmol/L"' + (cur.unit === 'nmol/L' ? ' selected' : '') + '>nmol/L</option></select></div>' +
      '<div class="ws2-form-row"><label>检测方法</label><select id="wts-assay"><option value="">—</option>' + ['RIA','CLIA','LC-MS/MS','其他'].map(x => '<option value="' + x + '"' + (cur.assayMethod === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>实验室</label><input id="wts-lab" value="' + esc(cur.lab || '') + '"></div>' +
      '<div class="ws2-form-row"><label>采血时间</label><input id="wts-time" value="' + esc(cur.sampleTime || '') + '" placeholder="08:15"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'testo\',' + cur.id + ')">删除这条睾酮</button>' : '');
    modal(cur.id ? '编辑睾酮' : '新增睾酮', body, async () => {
      const payload = { date: $('wts-date').value, val: Number($('wts-val').value), unit: $('wts-unit').value,
        assayMethod: $('wts-assay').value, lab: $('wts-lab').value, sampleTime: $('wts-time').value };
      try {
        await api('/api/patients/' + p.id + '/testo' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 睾酮已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存睾酮');
  }

  function openLabEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.labValues || []).find(x => Number(x.id) === Number(id)) || {};
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>日期 *</label><input id="wlb-date" type="date" value="' + esc(cur.date || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>项目代码</label><input id="wlb-code" value="' + esc(cur.itemCode || '') + '" placeholder="HB / CREAT"></div>' +
      '<div class="ws2-form-row"><label>项目名</label><input id="wlb-item" value="' + esc(cur.item || '') + '" placeholder="血红蛋白"></div>' +
      '<div class="ws2-form-row"><label>结果</label><input id="wlb-val" type="number" step="0.01" value="' + (cur.value == null ? '' : esc(cur.value)) + '"></div>' +
      '<div class="ws2-form-row"><label>单位</label><input id="wlb-unit" value="' + esc(cur.unit || '') + '"></div>' +
      '<div class="ws2-form-row"><label>参考范围</label><input id="wlb-ref" value="' + esc(cur.refRange || '') + '"></div>' +
      '<div class="ws2-form-row"><label>异常标记</label><input id="wlb-flag" value="' + esc(cur.flag || '') + '"></div>' +
      '<div class="ws2-form-row"><label>备注</label><input id="wlb-note" value="' + esc(cur.note || '') + '"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'lab\',' + cur.id + ')">删除这条化验</button>' : '');
    modal(cur.id ? '编辑化验' : '新增化验', body, async () => {
      const payload = { date: $('wlb-date').value, itemCode: $('wlb-code').value, item: $('wlb-item').value,
        value: $('wlb-val').value === '' ? null : Number($('wlb-val').value), unit: $('wlb-unit').value,
        refRange: $('wlb-ref').value, flag: $('wlb-flag').value, note: $('wlb-note').value };
      try {
        await api('/api/patients/' + p.id + '/lab-values' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 化验已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存化验');
  }

  function openClinicalEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.clinicalRecords || []).find(x => Number(x.id) === Number(id)) || {};
    const cats = [['bone','骨健康'],['cardio','心血管代谢'],['qol','生活质量'],['monitor','药物监测']];
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>日期 *</label><input id="wcl-date" type="date" value="' + esc(cur.date || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>分类</label><select id="wcl-cat">' + cats.map(x => '<option value="' + x[0] + '"' + ((cur.category || 'bone') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>项目代码/名称</label><input id="wcl-item" value="' + esc(cur.item || '') + '" placeholder="DEXA_T / IPSS / NRS"></div>' +
      '<div class="ws2-form-row"><label>结果</label><input id="wcl-val" type="number" step="0.01" value="' + (cur.val == null ? '' : esc(cur.val)) + '"></div>' +
      '<div class="ws2-form-row"><label>单位</label><input id="wcl-unit" value="' + esc(cur.unit || '') + '"></div>' +
      '<div class="ws2-form-row"><label>状态</label><select id="wcl-status">' + ['','未做','已完成','异常'].map(x => '<option value="' + x + '"' + (cur.status === x ? ' selected' : '') + '>' + (x || '—') + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>备注</label><input id="wcl-note" value="' + esc(cur.note || '') + '"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'clinical\',' + cur.id + ')">删除这条监测</button>' : '');
    modal(cur.id ? '编辑监测/评估' : '新增监测/评估', body, async () => {
      const payload = { date: $('wcl-date').value, category: $('wcl-cat').value, item: $('wcl-item').value,
        value: $('wcl-val').value === '' ? null : Number($('wcl-val').value), unit: $('wcl-unit').value,
        status: $('wcl-status').value, note: $('wcl-note').value };
      try {
        await api('/api/patients/' + p.id + '/clinical-records' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 监测/评估已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存监测');
  }

  function openTreatmentLineEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.treatmentLines || []).find(x => Number(x.id) === Number(id)) || {};
    const settings = ['新辅助','辅助','挽救','mHSPC','nmCRPC','mCRPC','局限治疗','主动监测','观察等待','其他'];
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>线数 *</label><input id="wtl-no" type="number" min="1" max="99" value="' + (cur.lineNo || (p.treatmentLines || []).length + 1) + '"></div>' +
      '<div class="ws2-form-row"><label>情境</label><select id="wtl-setting">' + settings.map(x => '<option value="' + x + '"' + (cur.setting === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>方案名 *</label><input id="wtl-regimen" value="' + esc(cur.regimen || '') + '"></div>' +
      '<div class="ws2-form-row"><label>开始 *</label><input id="wtl-start" type="date" value="' + esc(cur.startDate || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>结束</label><input id="wtl-end" type="date" value="' + esc(cur.endDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>停药原因</label><select id="wtl-stop"><option value="">未填</option>' + WsLabels.options('stopReason', cur.stopReasonCode) + '</select></div>' +
      '<div class="ws2-form-row"><label>疗效</label><select id="wtl-response"><option value="">未评估</option>' + WsLabels.options('response', cur.responseCode) + '</select></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>药物（药名|剂量|频次，多条用顿号）</label><input id="wtl-agents" value="' + esc((cur.agents || []).map(a => [a.drug, a.dose, a.schedule].filter(Boolean).join('|')).join('、')) + '" placeholder="戈舍瑞林|3.6mg|q4w、阿帕他胺|240mg|qd"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'line\',' + cur.id + ')">删除这条治疗线</button>' : '');
    modal(cur.id ? '编辑治疗线' : '新增治疗线', body, async () => {
      const agents = $('wtl-agents').value.split(/[、,，]+/).map(s => s.trim()).filter(Boolean).map(part => { const [drug, dose, schedule] = part.split('|').map(x => (x || '').trim()); return { drug, dose, schedule }; }).filter(a => a.drug);
      const payload = { lineNo: Number($('wtl-no').value), setting: $('wtl-setting').value, regimen: $('wtl-regimen').value,
        startDate: $('wtl-start').value, endDate: $('wtl-end').value || null,
        stopReason: $('wtl-stop').value, stopReasonCode: $('wtl-stop').value,
        response: $('wtl-response').value, responseCode: $('wtl-response').value, agents };
      try {
        await api('/api/patients/' + p.id + '/treatment-lines' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 治疗线已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存治疗线');
  }

  function openMedicationEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.medications || []).find(x => Number(x.id) === Number(id)) || {};
    const cats = [['adt','去势/ADT'],['endocrine','内分泌'],['arpi','ARPI'],['chemo','化疗'],['parpi','PARP/靶向'],['nuc','核素/免疫'],['bone','骨保护'],['support','支持'],['other','其他']];
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>药物 *</label><input id="wm-drug" value="' + esc(cur.drug || '') + '"></div>' +
      '<div class="ws2-form-row"><label>分类</label><select id="wm-cat">' + cats.map(x => '<option value="' + x[0] + '"' + ((cur.category || 'adt') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>开始 *</label><input id="wm-start" type="date" value="' + esc(cur.startDate || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>结束</label><input id="wm-end" type="date" value="' + esc(cur.endDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>剂量</label><input id="wm-dose" value="' + esc(cur.dose || '') + '"></div>' +
      '<div class="ws2-form-row"><label>频次</label><input id="wm-schedule" value="' + esc(cur.schedule || '') + '"></div>' +
      '<div class="ws2-form-row"><label>关联治疗线</label><select id="wm-line"><option value="">—</option>' + (p.treatmentLines || []).map(l => '<option value="' + l.id + '"' + (Number(cur.lineId) === Number(l.id) ? ' selected' : '') + '>第' + l.lineNo + '线 · ' + esc(l.regimen) + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>备注</label><input id="wm-notes" value="' + esc(cur.notes || '') + '"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'med\',' + cur.id + ')">删除这条用药</button>' : '');
    modal(cur.id ? '编辑用药' : '新增用药', body, async () => {
      const payload = { drug: $('wm-drug').value, category: $('wm-cat').value, startDate: $('wm-start').value,
        endDate: $('wm-end').value || null, dose: $('wm-dose').value, schedule: $('wm-schedule').value,
        lineId: $('wm-line').value || null, notes: $('wm-notes').value };
      try {
        await api('/api/patients/' + p.id + '/medications' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 用药已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存用药');
  }

  function openEventEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.events || []).find(x => Number(x.id) === Number(id)) || {};
    const curKind = cur.id && typeof structuredKindOfType === 'function' ? structuredKindOfType(cur.type) : '';
    if (curKind) {
      const list = { pathology: 'pathologyReports', imaging: 'imagingStudies', radiation: 'radiationRecords', outcome: 'outcomes' }[curKind];
      const rec = list ? arr(p[list]).find(x => Number(x.eventId) === Number(cur.id)) : null;
      const body = '<div class="ws2-empty">这是一条结构化记录（' + esc(cur.type) + '），不能在这里只改父事件，否则会和病理/影像/结局子表不一致。</div>' +
        '<div class="ws2-actions">' + (rec ? '<button class="btn btn-primary btn-sm" type="button" onclick="Workspace.closeModal();Workspace.openStructuredEditor(\'' + curKind + '\',' + rec.id + ')">打开结构化编辑 →</button>' : '<div class="ws2-empty">找不到对应子记录，请联系管理员。</div>') + '</div>';
      modal('结构化事件不能直接编辑', body, null);
      return;
    }
    const types = (typeof EVENT_PRESETS !== 'undefined' ? EVENT_PRESETS.flatMap(g => g.items) : []);
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>日期 *</label><input id="wev-date" type="date" value="' + esc(cur.date || today()) + '"></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>活动类型 *</label><input id="wev-type" list="wev-types" value="' + esc(cur.type || '') + '"><datalist id="wev-types">' + types.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist></div>' +
      '<div class="ws2-form-row"><label>Gleason</label><input id="wev-gleason" value="' + esc(cur.gleason || '') + '"></div>' +
      '<div class="ws2-form-row"><label>分期</label><input id="wev-stage" value="' + esc(cur.stage || '') + '"></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>备注</label><textarea id="wev-notes" rows="3">' + esc(cur.notes || '') + '</textarea></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'event\',' + cur.id + ')">删除这条事件</button>' : '') +
      '<p class="ws2-muted">结构化病理/影像/放疗/结局请用对应卡片或“登记本次就诊”的结构化表单，不要在这里重复建父事件。</p>';
    modal(cur.id ? '编辑病程事件' : '新增病程事件', body, async () => {
      const evType = $('wev-type').value;
      if (typeof structuredKindOfType === 'function' && structuredKindOfType(evType)) {
        return toast('⚠ 结构化类型请从「登记本次就诊」或对应卡片的“新增”进入，不能只建空事件');
      }
      const payload = { date: $('wev-date').value, type: evType, gleason: $('wev-gleason').value,
        stage: $('wev-stage').value, notes: $('wev-notes').value };
      try {
        await api('/api/patients/' + p.id + '/events' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 事件已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存事件');
  }

  async function deleteRecord(kind, id) {
    const p = getPatient(selectedId); if (!p) return;
    const map = { psa: '/psa/', testo: '/testo/', lab: '/lab-values/', clinical: '/clinical-records/',
      line: '/treatment-lines/', med: '/medications/', event: '/events/', outcome: '/outcomes/', specimen: '/specimens/',
      ihc: '/ihc-results/', genomic: '/genomic-tests/' };
    const url = map[kind]; if (!url) return;
    if (!confirm('确定删除这条记录？')) return;
    try { await api('/api/patients/' + p.id + url + id, { method: 'DELETE' }); closeModal(); toast('✅ 已删除'); await refresh(p); }
    catch (e) { toast('⚠ ' + e.message); }
  }

  function openSpecimenEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.specimens || []).find(x => Number(x.id) === Number(id)) || {};
    const types = [['tissue_biopsy','穿刺组织'],['tissue_RP','RP组织'],['tissue_TURP','TURP组织'],['tissue_metastasis','转移灶组织'],['blood','血液'],['urine','尿液'],['ctDNA','ctDNA'],['other','其他']];
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>类型 *</label><select id="wsp-type">' + types.map(x => '<option value="' + x[0] + '"' + (cur.sampleType === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>采样日期 *</label><input id="wsp-date" type="date" value="' + esc(cur.collectionDate || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>时点</label><input id="wsp-timepoint" value="' + esc(cur.timepoint || '') + '" placeholder="baseline/progression"></div>' +
      '<div class="ws2-form-row"><label>治疗状态</label><input id="wsp-tx" value="' + esc(cur.treatmentStatus || '') + '"></div>' +
      '<div class="ws2-form-row"><label>肿瘤细胞%</label><input id="wsp-tumor" type="number" min="0" max="100" value="' + (cur.tumorCellPct == null ? '' : esc(cur.tumorCellPct)) + '"></div>' +
      '<div class="ws2-form-row"><label>核酸质量</label><input id="wsp-quality" value="' + esc(cur.nucleicQuality || '') + '"></div>' +
      '<div class="ws2-form-row"><label>库号</label><input id="wsp-library" value="' + esc(cur.libraryId || '') + '"></div>' +
      '<div class="ws2-form-row"><label>生物样本库号</label><input id="wsp-biobank" value="' + esc(cur.biobankId || '') + '"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'specimen\',' + cur.id + ')">删除这条样本</button>' : '');
    modal(cur.id ? '编辑样本' : '新增样本', body, async () => {
      const payload = { sampleType: $('wsp-type').value, collectionDate: $('wsp-date').value, timepoint: $('wsp-timepoint').value,
        treatmentStatus: $('wsp-tx').value, tumorCellPct: $('wsp-tumor').value === '' ? null : Number($('wsp-tumor').value),
        nucleicQuality: $('wsp-quality').value, libraryId: $('wsp-library').value, biobankId: $('wsp-biobank').value };
      try {
        await api('/api/patients/' + p.id + '/specimens' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 样本已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存样本');
  }

  /* 枚举下拉：选项来自 RecordCore 规范词表（与服务端校验同源）。
     历史数据若含词表外的旧值，原样保留为一个可选项，避免一编辑就把旧值清掉。 */
  function enumSelect(id, list, cur) {
    const v = cur == null ? '' : String(cur);
    const known = list.some(x => String(x.v) === v);
    const extra = (v !== '' && !known) ? '<option value="' + esc(v) + '" selected>' + esc(v) + '（旧值）</option>' : '';
    return '<select id="' + id + '">' + extra + list.map(x =>
      '<option value="' + esc(x.v) + '"' + (String(x.v) === v ? ' selected' : '') + '>' + esc(x.l) + '</option>').join('') + '</select>';
  }

  function openIhcEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.ihcResults || []).find(x => Number(x.id) === Number(id)) || {};
    const markers = ['PTEN','ERG','AR','PSMA','KI67','SYN','CGA','CD56','P53','RB1','MSH2','MSH6','PMS2','MLH1','PDL1'];
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>标志物</label><select id="wih-marker">' + markers.map(x => '<option value="' + x + '"' + (cur.marker === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>结果</label>' + enumSelect('wih-result', RecordCore.IHC_RESULTS, cur.result) + '</div>' +
      '<div class="ws2-form-row"><label>阳性%</label><input id="wih-pct" type="number" min="0" max="100" value="' + (cur.percent == null ? '' : esc(cur.percent)) + '"></div>' +
      '<div class="ws2-form-row"><label>强度</label>' + enumSelect('wih-intensity', RecordCore.IHC_INTENSITY, cur.intensity) + '</div>' +
      '<div class="ws2-form-row"><label>日期</label><input id="wih-date" type="date" value="' + esc(cur.testDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>实验室</label><input id="wih-lab" value="' + esc(cur.lab || '') + '"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'ihc\',' + cur.id + ')">删除这条 IHC</button>' : '');
    modal(cur.id ? '编辑 IHC' : '新增 IHC', body, async () => {
      const payload = { marker: $('wih-marker').value, result: $('wih-result').value, percent: $('wih-pct').value === '' ? null : Number($('wih-pct').value),
        intensity: $('wih-intensity').value, testDate: $('wih-date').value || null, lab: $('wih-lab').value };
      try {
        await api('/api/patients/' + p.id + '/ihc-results' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ IHC 已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存 IHC');
  }

  function openGenomicEditor(id) {
    const p = getPatient(selectedId); if (!p) return;
    const cur = (p.genomicTests || []).find(x => Number(x.id) === Number(id)) || {};
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>类型</label><select id="wge-type"><option value="germline"' + (cur.testType === 'germline' ? ' selected' : '') + '>胚系</option><option value="somatic"' + (cur.testType === 'somatic' ? ' selected' : '') + '>体系</option></select></div>' +
      '<div class="ws2-form-row"><label>日期</label><input id="wge-date" type="date" value="' + esc(cur.testDate || today()) + '"></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>基因</label><input id="wge-genes" value="' + esc(cur.genes || '') + '" placeholder="BRCA2/ATM/HRR panel"></div>' +
      '<div class="ws2-form-row"><label>HRR</label>' + enumSelect('wge-hrr', RecordCore.HRR_STATUS, cur.hrrStatus) + '</div>' +
      '<div class="ws2-form-row"><label>MSI</label>' + enumSelect('wge-msi', RecordCore.MSI_STATUS, cur.msiStatus) + '</div>' +
      '<div class="ws2-form-row"><label>TMB</label><input id="wge-tmb" type="number" step="0.1" value="' + (cur.tmbValue == null ? '' : esc(cur.tmbValue)) + '"></div>' +
      '<div class="ws2-form-row"><label>实验室</label><input id="wge-lab" value="' + esc(cur.lab || '') + '"></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>结果摘要</label><input id="wge-summary" value="' + esc(cur.resultSummary || '') + '"></div>' +
      '</div>' + (cur.id ? '<button type="button" class="btn btn-danger btn-sm" onclick="Workspace.deleteRecord(\'genomic\',' + cur.id + ')">删除这条基因检测</button>' : '');
    modal(cur.id ? '编辑基因检测' : '新增基因检测', body, async () => {
      const payload = { testType: $('wge-type').value, testDate: $('wge-date').value, genes: $('wge-genes').value,
        hrrStatus: $('wge-hrr').value, msiStatus: $('wge-msi').value,
        tmbValue: $('wge-tmb').value === '' ? null : Number($('wge-tmb').value),
        lab: $('wge-lab').value, resultSummary: $('wge-summary').value };
      try {
        await api('/api/patients/' + p.id + '/genomic-tests' + (cur.id ? '/' + cur.id : ''), { method: cur.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 基因检测已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存基因检测');
  }

  function openConsentEditor() {
    const p = getPatient(selectedId); if (!p) return;
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>知情同意</label><select id="wco-consent"><option value=""' + (p.researchConsent == null ? ' selected' : '') + '>未记录</option><option value="1"' + (p.researchConsent ? ' selected' : '') + '>已签</option><option value="0"' + (p.researchConsent === false ? ' selected' : '') + '>未签</option></select></div>' +
      '<div class="ws2-form-row"><label>同意日期</label><input id="wco-consent-date" type="date" value="' + esc(p.researchConsentDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>同意书版本</label><input id="wco-version" value="' + esc(p.researchConsentVersion || '') + '" placeholder="如 V2.0 / 2026-01"></div>' +
      '<div class="ws2-form-row"><label>数据共享</label><select id="wco-share"><option value=""' + (p.dataSharing == null ? ' selected' : '') + '>未记录</option><option value="1"' + (p.dataSharing ? ' selected' : '') + '>已授权</option><option value="0"' + (p.dataSharing === false ? ' selected' : '') + '>未授权</option></select></div>' +
      '<div class="ws2-form-row"><label>共享日期</label><input id="wco-share-date" type="date" value="' + esc(p.dataSharingDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>共享范围</label><select id="wco-scope"><option value="">未记录</option>' +
        ['去标识科研','去标识科研 + 合作研究','仅本院科研','其他'].map(x => '<option value="' + x + '"' + (p.dataSharingScope === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '</div><p class="ws2-muted">知情同意与数据共享属于科研合规字段，修改会写入审计日志；请以纸质/电子知情同意书为准。</p>';
    modal('修改科研与合规', body, async () => {
      try {
        await api('/api/patients/' + p.id, { method: 'PUT', body: JSON.stringify({
          researchConsent: $('wco-consent').value === '' ? null : $('wco-consent').value === '1',
          researchConsentDate: $('wco-consent-date').value || null,
          researchConsentVersion: $('wco-version').value,
          dataSharing: $('wco-share').value === '' ? null : $('wco-share').value === '1',
          dataSharingDate: $('wco-share-date').value || null,
          dataSharingScope: $('wco-scope').value
        }) });
        closeModal(); toast('✅ 科研与合规信息已更新'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存');
  }

  function openDiseaseStateEditor() {
    const p = getPatient(selectedId); if (!p) return;
    const states = (S.catalog && S.catalog.states && S.catalog.states.length) ? S.catalog.states : [
      { code:'S0', label:'已建档' }, { code:'S1', label:'疑癌待查' }, { code:'S2', label:'待诊断' },
      { code:'S3', label:'已确诊待治疗' }, { code:'S4', label:'治疗中' }, { code:'S5', label:'随访中' },
      { code:'S6', label:'可疑复发' }, { code:'S7', label:'复发/进展' }, { code:'S8', label:'终止' }
    ];
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>状态 *</label><select id="wds-code">' + states.map(x => '<option value="' + esc(x.code) + '">' + esc(x.code + ' · ' + x.label) + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>日期 *</label><input id="wds-date" type="date" value="' + today() + '"></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>依据</label><input id="wds-basis" placeholder="例如：治疗结束进入随访 / PSA 进展 / 影像转移"></div>' +
      '</div><p class="ws2-muted">新增状态会把之前的当前状态置为历史；状态码来自指南状态机。</p>';
    modal('新增疾病状态', body, async () => {
      try {
        await api('/api/patients/' + p.id + '/disease-states', { method: 'POST', body: JSON.stringify({
          stateCode: $('wds-code').value, sinceDate: $('wds-date').value,
          basis: $('wds-basis').value, status: 'confirmed'
        }) });
        closeModal(); toast('✅ 疾病状态已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存状态');
  }

  function openAi() {
    const p = getPatient(selectedId); if (!p) return;
    if (!window.AiUI || typeof AiUI.renderAiPane !== 'function') return toast('⚠ AI 登记模块未加载');
    modal('AI 登记', AiUI.renderAiPane(p), null);
  }

  function openVisitItemPicker(cat) {
    const p = getPatient(selectedId);
    if (!p) return;
    S.pickCat = cat || S.pickCat || 'exam';
    let avail = { exam: { ok: true, why: '' }, dx: { ok: true, why: '' }, treat: { ok: true, why: '' }, fu: { ok: true, why: '' } };
    try { if (typeof guidedAvailability === 'function') avail = guidedAvailability(p); } catch (e) {}
    const cats = [['exam', '检查'], ['dx', '诊断'], ['treat', '治疗'], ['fu', '随访']];
    const types = (typeof guidedCatItems === 'function') ? guidedCatItems(S.pickCat) : [];
    const list = types.length ? types.map((t, i) =>
      '<button type="button" onclick="Workspace.openVisitItemEditor(' + i + ')">' + esc(t) + '</button>').join('') :
      '<div class="ws2-empty">该类别暂无可用项目</div>';
    const a = avail[S.pickCat] || { ok: true, why: '' };
    subModal((cats.find(x => x[0] === S.pickCat) || ['', ''])[1] + ' · 选择项目',
      (a.ok ? '' : '<div class="ws2-empty" style="margin-bottom:6px">' + esc(a.why) + '</div>') +
      '<div class="ws2-visit-pick-list">' + list + '</div>' +
      '<p class="ws2-muted">选择项目后填写结构化字段；保存本次就诊时统一入库并挂到本次就诊。</p>', null);
  }

  function openVisitItemEditor(idx) {
    const types = (typeof guidedCatItems === 'function') ? guidedCatItems(S.pickCat) : [];
    const type = types[idx];
    if (!type) return;
    const data = {};
    /* 第一条病理自动设为主要诊断病理；否则风险分层会找不到活检依据。
       医生仍可在病理表单里改成“否”。 */
    try {
      const p = getPatient(selectedId);
      const kind = typeof structuredKindOfType === 'function' ? structuredKindOfType(type) : '';
      if (p && kind === 'pathology' && !arr(p.pathologyReports).some(x => x.isPrimary)) data.isPrimary = 1;
    } catch (e) {}
    S.itemEdit = { type: type, editIndex: -1, data, files: [] };
    drawVisitItemEditor();
  }

  function editVisitItem(i) {
    const it = (S.visitItems || [])[i];
    if (!it) return;
    S.itemEdit = { type: it.type, editIndex: i, data: Object.assign({}, it.data || {}), files: it.files || [], notes: it.notes || '', psaVal: it.psaVal, testoVal: it.testoVal, testoUnit: it.testoUnit, stage: it.stage, diseaseCategory: it.diseaseCategory };
    drawVisitItemEditor();
  }

  function removeVisitItem(i) {
    (S.visitItems || []).splice(i, 1);
    renderVisitItems();
  }

  function drawVisitItemEditor() {
    const it = S.itemEdit;
    if (!it) return;
    const p = getPatient(selectedId);
    const date = ($('wv-date') && $('wv-date').value) || today();
    const pre = 'vwi' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    it.pre = pre;
    const type = it.type;
    let fields = '';
    if (type === 'PSA检测') {
      fields = '<div class="ws2-form-row"><label>PSA 值 ng/mL *</label><input id="' + pre + '-psa" type="number" step="0.001" min="0" value="' + esc(it.psaVal || '') + '"></div>';
    } else if (type === '睾酮检测') {
      fields = '<div class="ws2-form-row"><label>睾酮值 *</label><input id="' + pre + '-testo" type="number" step="0.01" min="0" value="' + esc(it.testoVal || '') + '">' +
        '<select id="' + pre + '-testo-unit"><option value="ng/dl"' + ((it.testoUnit || 'ng/dl') === 'ng/dl' ? ' selected' : '') + '>ng/dl</option><option value="nmol/L"' + (it.testoUnit === 'nmol/L' ? ' selected' : '') + '>nmol/L</option></select></div>';
    } else if (type === '疾病阶段判定') {
      fields = '<div class="ws2-form-row"><label>疾病阶段 *</label><select id="' + pre + '-cat"><option value="">请选择</option>' +
        (typeof DISEASE_CATEGORIES !== 'undefined' ? DISEASE_CATEGORIES.map(x => '<option value="' + x.v + '"' + (it.diseaseCategory === x.v ? ' selected' : '') + '>' + x.l + ' · ' + x.d + '</option>').join('') : '') + '</select></div>';
    } else if (type === '临床分期评估') {
      let st = { pre: 'c', t: '', n: '', m: '' };
      try { if (typeof parseStage === 'function') st = Object.assign(st, parseStage(it.stage || '')); } catch (e) {}
      fields = '<div class="ws2-form-row"><label>cTNM</label><div style="display:flex;gap:5px;flex-wrap:wrap">' +
        '<select id="' + pre + '-spre">' + tlOpts(TL_STAGE_PRE, st.pre) + '</select>' +
        '<select id="' + pre + '-st">' + tlOpts(TL_T, st.t) + '</select>' +
        '<select id="' + pre + '-sn">' + tlOpts(TL_N, st.n) + '</select>' +
        '<select id="' + pre + '-sm">' + tlOpts(TL_M, st.m) + '</select></div></div>';
    } else if (typeof structuredKindOfType === 'function' && structuredKindOfType(type) && typeof structuredFormFields === 'function') {
      fields = '<div class="ws2-structured-form">' + structuredFormFields(pre, type, it.data || {}) + '</div>';
    }
    const body = '<div class="ws2-visit-editor">' +
      '<input type="hidden" id="tl-' + pre + '-date" value="' + esc(date) + '">' +
      '<p class="ws2-muted" style="margin:0 0 7px">日期：' + esc(date) + '（随本次就诊日期） · ' + esc(type) + '</p>' +
      fields +
      '<div class="ws2-form-row"><label>备注</label><input id="' + pre + '-notes" type="text" maxlength="500" value="' + esc(it.notes || '') + '" placeholder="可留空"></div>' +
      '<div class="ws2-form-row"><label>附加照片（可多选）</label><input id="' + pre + '-photos" type="file" accept="image/*" multiple></div>' +
      (it.files && it.files.length ? '<p class="ws2-muted">已保留 ' + it.files.length + ' 张待上传照片</p>' : '') +
      '</div>';
    subModal('添加记录 · ' + type, body, saveVisitItem, '加入本次就诊');
  }

  function saveVisitItem() {
    const it = S.itemEdit;
    if (!it) return;
    const pre = it.pre;
    const notes = ($(pre + '-notes') && $(pre + '-notes').value) || '';
    if (it.type === '化验/监测' && !notes.trim()) return toast('⚠ 化验/监测请在备注中填写项目、数值和单位');
    let item = { type: it.type, notes: notes, data: it.data || {}, files: it.files || [] };
    const kind = typeof structuredKindOfType === 'function' ? structuredKindOfType(it.type) : '';
    if (it.type === 'PSA检测') {
      const v = ($(pre + '-psa') || {}).value;
      if (v === '' || v == null || !Number.isFinite(Number(v))) return toast('⚠ 请填写 PSA 数值');
      item.psaVal = v;
    } else if (it.type === '睾酮检测') {
      const v = ($(pre + '-testo') || {}).value;
      if (v === '' || v == null || !Number.isFinite(Number(v))) return toast('⚠ 请填写睾酮数值');
      item.testoVal = v;
      item.testoUnit = ($(pre + '-testo-unit') || {}).value || 'ng/dl';
    } else if (it.type === '疾病阶段判定') {
      const v = ($(pre + '-cat') || {}).value;
      if (!v) return toast('⚠ 请选择疾病阶段');
      item.diseaseCategory = v;
    } else if (it.type === '临床分期评估') {
      const p1 = ($(pre + '-spre') || {}).value || 'c';
      const t = ($(pre + '-st') || {}).value || '';
      const n = ($(pre + '-sn') || {}).value || '';
      const m = ($(pre + '-sm') || {}).value || '';
      if (!t || !n || !m) return toast('⚠ 请完整选择 T/N/M，避免生成不完整分期');
      item.stage = p1 + t + n + m;
    } else if (kind && typeof collectStructured === 'function') {
      item.data = collectStructured(pre, it.type) || {};
    }
    const filesEl = $(pre + '-photos');
    const picked = filesEl && filesEl.files ? Array.from(filesEl.files) : [];
    if (picked.length) item.files = picked;
    item.summary = visitItemSummary(item);
    if (it.editIndex >= 0) S.visitItems[it.editIndex] = item;
    else S.visitItems.push(item);
    S.itemEdit = null;
    closeSubModal();
    renderVisitItems();
    toast('✅ 已加入本次就诊，保存就诊时统一入库');
  }

  function openVisit(presetEpisodeId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return toast('⚠ 患者资料未加载');
    const w = p.workspace;
    const eps = followupEpisodes(w);
    S.visitItems = [];
    S.pickCat = 'exam';
    S.itemEdit = null;
    const chosen = presetEpisodeId ? eps.filter(e => Number(e.id) === Number(presetEpisodeId)) : eps;
    const epCards = eps.map(e => {
      const t = templateOf(w, e) || { aeTerms: [] };
      const terms = arr(t.aeTerms).map(code => (S.catalog.toxicityTerms || []).find(x => x.code === code)).filter(Boolean);
      const checked = chosen.some(x => Number(x.id) === Number(e.id));
      return '<div class="ws2-visit-ep' + (checked ? ' on' : '') + '" data-ep="' + e.id + '">' +
        '<label class="ws2-visit-ep-h"><input type="checkbox" class="ws2-ep-check" value="' + e.id + '"' + (checked ? ' checked' : '') + '>' +
        '<b>' + esc(e.label || e.templateCode) + '</b><span>' + esc(e.startDate || '') + ' · ' + esc(wsl('episodeStatus', e.status)) + '</span></label>' +
        '<div class="ws2-visit-ep-body">' +
          '<div class="ws2-form-row"><label>总体疗效</label><select data-row="response" data-ep="' + e.id + '">' +
            ['NA','CR','PR','SD','PD','NE'].map(x => '<option value="' + x + '"' + (x === 'NA' ? ' selected' : '') + '>' + x + '</option>').join('') + '</select>' +
            '<label>依据</label><select data-row="basis" data-ep="' + e.id + '">' +
            ['none','psa','imaging','clinical','combined'].map(x => '<option value="' + x + '"' + (x === 'none' ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
          (terms.length ? '<div class="ws2-ae-grid">' + terms.map(term => '<div class="ws2-ae-item"><span>' + esc(term.label) + ' <i>0–' + term.maxGrade + '</i></span>' + termSelect(term, null, e.id) + '</div>').join('') + '</div>' : '') +
        '</div></div>';
    }).join('');
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>就诊日期 *</label><input type="date" id="wv-date" value="' + today() + '"></div>' +
      '</div>' +
      '<div class="ws2-visit-entry-grid">' +
        '<button class="ws2-visit-entry" type="button" onclick="Workspace.openVisitItemPicker(\'exam\')"><b>检查</b><span>PSA、影像、病理</span></button>' +
        '<button class="ws2-visit-entry" type="button" onclick="Workspace.openVisitItemPicker(\'dx\')"><b>诊断</b><span>分期、阶段、MDT</span></button>' +
        '<button class="ws2-visit-entry" type="button" onclick="Workspace.openVisitItemPicker(\'treat\')"><b>治疗</b><span>手术、放疗、用药</span></button>' +
        '<button class="ws2-visit-entry" type="button" onclick="Workspace.openVisitItemPicker(\'fu\')"><b>随访</b><span>复查、结局</span></button>' +
      '</div>' +
      '<div id="wv-extra-list" class="ws2-visit-items"></div>' +
      '<div class="ws2-card-h" style="margin-top:10px">本次覆盖的治疗段</div>' +
      (eps.length ? epCards : '<div class="ws2-empty">尚未建立治疗段。也可以先只登记检查/诊断，之后再建立治疗段。</div>') +
      '<div class="ws2-form-row"><label>小结</label><textarea id="wv-summary" rows="2" placeholder="本次复诊结论/计划"></textarea></div>' +
      '<div class="ws2-form-row"><label>下次随访</label><input type="date" id="wv-next"></div>' +
      '<p class="ws2-muted">一次保存生成：1 次就诊 + 每个勾选段 1 行 + 所有附加记录；毒性填 0 表示“评估为无”，留空表示“未评估”。</p>';
    modal('登记本次就诊', body, async () => {
      const date = $('wv-date').value;
      if (!date) return toast('⚠ 请填写就诊日期');
      const episodes = [];
      document.querySelectorAll('.ws2-ep-check:checked').forEach(cb => {
        const eid = Number(cb.value);
        const resp = document.querySelector('[data-row="response"][data-ep="' + eid + '"]');
        const basis = document.querySelector('[data-row="basis"][data-ep="' + eid + '"]');
        const aes = [];
        document.querySelectorAll('[data-ae][data-prefix="' + eid + '"]').forEach(sel => {
          if (sel.value === '') return;
          aes.push({ termCode: sel.getAttribute('data-ae'), grade: Number(sel.value), recoveryStatus: 'unknown' });
        });
        episodes.push({ episodeId: eid, overallResponse: resp ? resp.value : 'NA', responseBasis: basis ? basis.value : 'none', adverseEvents: aes });
      });
      const extra = (S.visitItems || []).slice();
      if (!episodes.length && !extra.length) {
        return toast('⚠ 至少填写一项：治疗段疗效/毒性，或从“添加记录”加入 PSA/睾酮/影像/病理等');
      }
      const payload = {
        visitDate: date, visitType: 'outpatient',
        summary: $('wv-summary').value, nextVisitDate: $('wv-next').value || null, episodes
      };
      extra.forEach(it => {
        if (it.type === 'PSA检测' && it.psaVal !== '') (payload.psa = payload.psa || []).push({ val: Number(it.psaVal) });
        if (it.type === '睾酮检测' && it.testoVal !== '') (payload.testo = payload.testo || []).push({ val: Number(it.testoVal), unit: it.testoUnit || 'ng/dl' });
      });
      let visitId = null;
      try {
        const visitRes = await api('/api/patients/' + p.id + '/visits', { method: 'POST', body: JSON.stringify(payload) });
        visitId = visitRes.visitId;
      } catch (e) { return toast('⚠ ' + e.message); }
      /* 就诊先落库，再把附加记录逐条挂到 visit 上；单条失败不回滚整次就诊，但会把错误列出来。 */
      const errors = [];
      let savedExtra = 0;
      for (const it of extra) {
        if (it.type === 'PSA检测' || it.type === '睾酮检测') { savedExtra++; continue; }
        try {
          if (it.type === '疾病阶段判定') {
            if (!it.diseaseCategory) throw new Error('未选择疾病阶段');
            await api('/api/patients/' + p.id, { method: 'PUT', body: JSON.stringify({ diseaseCategory: it.diseaseCategory }) });
            savedExtra++;
            continue;
          }
          const kind = typeof structuredKindOfType === 'function' ? structuredKindOfType(it.type) : '';
          let structured = null;
          if (kind) {
            const data = Object.assign({}, it.data || {});
            if (kind === 'pathology') data.reportDate = date;
            if (kind === 'imaging') data.studyDate = date;
            if (kind === 'radiation') data.startDate = date;
            if (kind === 'outcome') data.eventDate = date;
            structured = { kind: kind, data: data };
          }
          const r = await api('/api/patients/' + p.id + '/events', {
            method: 'POST',
            body: JSON.stringify({ date: date, type: it.type, stage: it.stage || '', notes: it.notes || '', structured: structured, visitId: visitId, guidedBatch: 'v' + visitId })
          });
          if (it.type === '临床分期评估' && it.stage && r && r.newEventId) {
            await api('/api/patients/' + p.id + '/events/' + r.newEventId + '/apply-staging', { method: 'POST', body: '{}' });
          }
          if (r && r.newEventId && it.files && it.files.length && typeof tlUploadImgs === 'function') {
            await tlUploadImgs(p.id, r.newEventId, it.files.map(f => f && f.file ? f : { file: f }));
          }
          savedExtra++;
        } catch (e) {
          errors.push(it.type + '：' + e.message);
        }
      }
      if (extra.length && typeof guidedDiaryAppend === 'function') {
        guidedDiaryAppend(p.id, [{ at: new Date().toISOString(), date: date, cat: 'visit', items: extra.map(it => ({ item: it.type, summary: visitItemSummary(it) })) }]);
      }
      closeModal();
      toast('✅ 本次就诊已保存' + (savedExtra ? '，附加记录 ' + savedExtra + ' 条' : '') + (errors.length ? '；失败 ' + errors.length + ' 条' : ''));
      if (errors.length) alert('以下附加记录未保存：\n' + errors.join('\n'));
      await refresh(p);
    }, '保存本次就诊');
    renderVisitItems();
  }


  function attachHtml(p, v, row) {
    const imgs = arr(p.imagingStudies).filter(x => !x.visitId).slice(-5);
    const paths = arr(p.pathologyReports).filter(x => !x.visitId).slice(-3);
    if (!imgs.length && !paths.length) return '';
    return '<div class="ws2-card-h" style="margin-top:10px">关联本次检查</div>' +
      imgs.map(x => '<div class="ws2-line">影像 ' + esc(x.studyDate) + ' · ' + esc(wsl('imagingModality', x.modality)) + (x.pirads ? ' · PI-RADS ' + x.pirads : '') +
        ' <button class="ws2-link" type="button" onclick="Workspace.attach(' + v.id + ',\'imaging\',' + x.id + ')">挂到本次</button></div>').join('') +
      paths.map(x => '<div class="ws2-line">病理 ' + esc(x.reportDate) + ' · ' + esc(wsl('specimenType', x.specimenType)) +
        ' <button class="ws2-link" type="button" onclick="Workspace.attach(' + v.id + ',\'pathology\',' + x.id + ')">挂到本次</button></div>').join('');
  }
  async function attach(vid, type, id) {
    const p = getPatient(selectedId);
    if (!p) return;
    try {
      await api('/api/patients/' + p.id + '/visits/' + vid + '/attach', { method: 'POST', body: JSON.stringify({ type, id }) });
      closeModal(); toast('✅ 已关联到本次就诊'); await refresh(p);
    } catch (e) { toast('⚠ ' + e.message); }
  }

  function linkedVisitHtml(p, visitId) {
    const evs = arr(p.events).filter(e => Number(e.visitId) === Number(visitId));
    const imgs = arr(p.imagingStudies).filter(x => Number(x.visitId) === Number(visitId));
    const paths = arr(p.pathologyReports).filter(x => Number(x.visitId) === Number(visitId));
    const rts = arr(p.radiationRecords).filter(x => Number(x.visitId) === Number(visitId));
    const outs = arr(p.outcomes).filter(x => Number(x.visitId) === Number(visitId));
    const lines = [];
    const structuredEventIds = new Set([...imgs, ...paths, ...rts, ...outs].map(x => Number(x.eventId)).filter(Boolean));
    evs.forEach(e => {
      if (structuredEventIds.has(Number(e.id))) return;
      lines.push('事件：' + esc(e.type) + ' · ' + esc(e.date) + (e.notes ? ' · ' + esc(e.notes) : ''));
    });
    imgs.forEach(x => lines.push('影像：' + esc(x.studyDate) + ' · ' + esc(wsl('imagingModality', x.modality)) + (x.pirads ? ' · PI-RADS ' + x.pirads : '')));
    paths.forEach(x => lines.push('病理：' + esc(x.reportDate) + ' · ' + esc(wsl('specimenType', x.specimenType))));
    rts.forEach(x => lines.push('放疗：' + esc(x.startDate) + ' · ' + esc(wsl('rtType', x.rtType))));
    outs.forEach(x => lines.push('结局：' + esc(wsl('outcomeType', x.outcomeType)) + ' · ' + esc(x.eventDate)));
    const uniq = [...new Set(lines)];
    return '<div class="ws2-card-h" style="margin-top:10px">本次关联记录 <span>' + uniq.length + '</span></div>' +
      (uniq.length ? uniq.map(x => '<div class="ws2-line">' + x + '</div>').join('') : '<div class="ws2-empty">本次还没有附加检查/诊断/治疗/随访记录。</div>');
  }

  function openVisitEditById(visitId) {
    const p = getPatient(selectedId); if (!p) return;
    const v = arr(p.workspace && p.workspace.visits).find(x => Number(x.id) === Number(visitId));
    if (!v) return toast('⚠ 未找到该就诊');
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>就诊日期 *</label><input id="wve-date" type="date" value="' + esc(v.visitDate) + '"></div>' +
      '<div class="ws2-form-row"><label>类型</label><select id="wve-type">' + [['outpatient','门诊'],['inpatient','住院'],['phone','电话'],['external','外院'],['mdt','MDT'],['chemo','化疗'],['other','其他']].map(x => '<option value="' + x[0] + '"' + (v.visitType === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>小结</label><textarea id="wve-summary" rows="2">' + esc(v.summary || '') + '</textarea></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>下次计划</label><input id="wve-plan" value="' + esc(v.nextPlan || '') + '"></div>' +
      '<div class="ws2-form-row"><label>下次随访</label><input id="wve-next" type="date" value="' + esc(v.nextVisitDate || '') + '"></div>' +
      '</div>';
    modal('编辑就诊', body, async () => {
      try {
        await api('/api/patients/' + p.id + '/visits/' + v.id, { method: 'PUT', body: JSON.stringify({
          visitDate: $('wve-date').value, visitType: $('wve-type').value,
          summary: $('wve-summary').value, nextPlan: $('wve-plan').value,
          nextVisitDate: $('wve-next').value || null, status: 'final'
        }) });
        closeModal(); toast('✅ 就诊已更新'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存就诊');
  }

  function openVisitSummary(v) {
    const p = getPatient(selectedId);
    if (!p || !v) return;
    const body = '<div class="ws2-kv">' + kv('日期', v.visitDate) + kv('类型', wsl('visitType', v.visitType)) + kv('科室', v.department || '—') +
      kv('医生', v.physician || '—') + kv('小结', v.summary || '—') + kv('下次随访', v.nextVisitDate || '—') + '</div>' +
      linkedVisitHtml(p, v.id) + attachHtml(p, v) + '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openVisitEditById(' + v.id + ')">编辑本次就诊</button></div>';
    modal('就诊详情', body, null);
  }

  function openVisitDetailById(visitId) {
    const p = getPatient(selectedId);
    if (!p) return;
    const v = arr(p.workspace && p.workspace.visits).find(x => Number(x.id) === Number(visitId));
    if (!v) return toast('⚠ 就诊不在最近列表中，请到“全部记录”查看');
    const row = arr(p.workspace.rows).find(r => Number(r.visitId) === Number(visitId));
    if (row) return openVisitDetail(row.id);
    openVisitSummary(v);
  }
  function openVisitDetail(rowId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const row = arr(p.workspace.rows).find(r => Number(r.id) === Number(rowId));
    if (!row) return toast('⚠ 未找到该就诊行');
    const v = arr(p.workspace.visits).find(x => Number(x.id) === Number(row.visitId)) || { visitDate: row.visitDate, visitType: '—', summary: '' };
    const ep = episodeById(p.workspace, row.episodeId) || {};
    const aes = arr(p.workspace.adverseEvents).filter(a => Number(a.episodeRowId) === Number(row.id));
    const body = '<div class="ws2-kv">' + kv('日期', v.visitDate || row.visitDate) + kv('治疗段', ep.label || ep.templateCode) +
      kv('第几次', row.visitNo) + kv('总体疗效', wsl('response', row.overallResponse) + ' / ' + row.responseBasis) +
      kv('PSA', psaText(psaOfDate(p, v.visitDate || row.visitDate))) + kv('小结', v.summary || row.summary || '—') + '</div>' +
      '<div class="ws2-card-h" style="margin-top:10px">毒性</div>' +
      (aes.length ? aes.map(a => '<div class="ws2-line"><b>' + esc(a.termLabel) + '</b> G' + (a.grade == null ? '未评估' : a.grade) + ' · ' + esc(wsl('aeRecovery', a.recoveryStatus)) + (a.auxMeds ? ' · ' + esc(a.auxMeds) : '') + '</div>').join('') : '<div class="ws2-empty">未记录</div>') +
      linkedVisitHtml(p, v.id || row.visitId) +
      '<div class="ws2-actions"><button class="ws2-link" type="button" onclick="Workspace.openVisitEditById(' + (v.id || row.visitId) + ')">编辑本次就诊</button></div>' +
      attachHtml(p, v, row);
    modal('就诊详情', body, null);
  }

  function openToxicityInfo(termCode) {
    const term = (S.catalog && S.catalog.toxicityTerms || []).find(x => x.code === termCode);
    if (!term) return toast('⚠ 未找到该毒性评分卡');
    const body = '<p class="ws2-muted">' + esc(term.label) + ' · 最高 G' + term.maxGrade +
      (term.functional ? '（功能性毒性封顶 G3）' : '') + ' · 只查不填</p>' +
      '<div class="ws2-defs">' + arr(term.definitions).map(d => '<div><b>G' + d.grade + '</b> ' + esc(d.text) + '</div>').join('') + '</div>' +
      '<p class="ws2-muted">实际分级请到“登记本次就诊”或随访行中录入；未评估不等于 0。</p>';
    modal('评分卡 · ' + term.label, body, null);
  }

  function openResponseInfo() {
    const body = '<p class="ws2-muted">总体疗效按 PSA、影像和临床综合判断；记录时请选择依据。</p>' +
      '<div class="ws2-defs">' +
      '<div><b>CR</b> 完全缓解：PSA 降至检测下限/影像病灶消失，无新发病灶</div>' +
      '<div><b>PR</b> 部分缓解：PSA 明显下降或影像病灶缩小，未达 CR</div>' +
      '<div><b>SD</b> 稳定：未达 PR，也未达 PD</div>' +
      '<div><b>PD</b> 进展：PSA 进展（PCWG3/合适标准）或影像/临床进展</div>' +
      '<div><b>NE</b> 不可评估：缺少 PSA/影像或随访不足</div>' +
      '<div><b>NA</b> 未评估：本次未做疗效判断</div>' +
      '</div><p class="ws2-muted">具体判断以当前治疗段、PSA 序列和影像为准；本卡只解释术语。</p>';
    modal('疗效评估说明', body, null);
  }

  function openAE(rowId, termCode) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const row = arr(p.workspace.rows).find(r => Number(r.id) === Number(rowId));
    const ep = row ? episodeById(p.workspace, row.episodeId) : null;
    const t = ep ? templateOf(p.workspace, ep) : null;
    const term = (S.catalog.toxicityTerms || []).find(x => x.code === termCode);
    if (!term) return;
    const existing = aeFor(p.workspace, rowId, termCode);
    const body = '<p class="ws2-muted">' + esc(term.label) + ' 分级定义（记录册评分卡）</p>' +
      '<div class="ws2-defs">' + (term.definitions || []).map(d => '<div><b>G' + d.grade + '</b> ' + esc(d.text) + '</div>').join('') + '</div>' +
      '<div class="ws2-form-row"><label>分级</label><select id="ae-grade">' + '<option value="">未评估</option>' +
        Array.from({ length: (term.maxGrade || 5) + 1 }, (_, i) => '<option value="' + i + '"' + (existing && existing.grade === i ? ' selected' : '') + '>' + i + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>辅助用药/处理</label><input id="ae-aux" value="' + esc(existing ? existing.auxMeds : '') + '"></div>' +
      '<div class="ws2-form-row"><label>恢复情况</label><select id="ae-recovery">' + '<option value="">未评估</option>' + WsLabels.options('aeRecovery', existing && existing.recoveryStatus) + '</select></div>';
    modal('记录毒性 · ' + term.label, body, async () => {
      const grade = $('ae-grade').value;
      try {
        await api('/api/patients/' + p.id + '/adverse-events', { method: 'POST', body: JSON.stringify({
          visitId: row.visitId, episodeRowId: row.id, episodeId: row.episodeId, termCode,
          grade: grade === '' ? null : Number(grade), auxMeds: $('ae-aux').value, recoveryStatus: $('ae-recovery').value
        }) });
        closeModal(); toast('✅ 毒性分级已保存');
        await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存分级');
  }
  function openAEById(id) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const ae = arr(p.workspace.adverseEvents).find(x => Number(x.id) === Number(id));
    if (!ae) return;
    if (ae.episodeRowId) return openAE(ae.episodeRowId, ae.termCode);
    tab('record');
  }




  function openEpisodeEdit(episodeId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const ep = episodeById(p.workspace, episodeId);
    if (!ep) return;
    const body = '<div class="ws2-kv">' + kv('治疗段', ep.label || ep.templateCode) + kv('开始', ep.startDate) + '</div>' +
      '<div class="ws2-form-row"><label>状态</label><select id="we-status">' +
        WsLabels.options('episodeStatus', ep.status) + '</select></div>' +
      '<div class="ws2-form-row"><label>结束日期</label><input id="we-end" type="date" value="' + esc(ep.endDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>停药原因</label><select id="we-stop">' +
        '<option value="">未填</option>' + WsLabels.options('stopReason', ep.stopReasonCode) + '</select></div>' +
      '<div class="ws2-form-row"><label>备注</label><input id="we-notes" value="' + esc(ep.notes || '') + '"></div>' +
      '<p class="ws2-muted">结束/停药后旧段保留；新线请用“启动/换线”新建段。多段可以并存。</p>';
    modal('编辑治疗段', body, async () => {
      try {
        await api('/api/patients/' + p.id + '/episodes/' + episodeId, { method: 'PUT', body: JSON.stringify({
          status: $('we-status').value, endDate: $('we-end').value || null,
          stopReasonCode: $('we-stop').value, notes: $('we-notes').value
        }) });
        closeModal(); toast('✅ 治疗段已更新'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存');
  }

  function openSurgery(episodeId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const ep = episodeById(p.workspace, episodeId);
    if (!ep) return;
    const cur = arr(p.workspace.surgeryRecords).find(x => Number(x.episodeId) === Number(episodeId)) || {};
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>手术日期 *</label><input id="ws-date" type="date" value="' + esc(cur.surgeryDate || ep.startDate || today()) + '"></div>' +
      '<div class="ws2-form-row"><label>术者</label><input id="ws-surgeon" value="' + esc(cur.surgeon || '') + '"></div>' +
      '<div class="ws2-form-row"><label>术式</label><select id="ws-procedure">' + ['RP','TURP','激光/剜除','局灶治疗','挽救性RP','其他'].map(x => '<option value="' + x + '"' + ((cur.procedure || 'RP') === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>入路</label><select id="ws-approach">' + [['robot','机器人辅助'],['lap','腹腔镜'],['open','开放'],['other','其他']].map(x => '<option value="' + x[0] + '"' + ((cur.approach || 'robot') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>神经保留</label><select id="ws-nerve">' + [['none','未保留'],['left','保留左侧'],['right','保留右侧'],['bilateral','双侧保留']].map(x => '<option value="' + x[0] + '"' + ((cur.nerveSparing || 'none') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>淋巴结清扫</label><select id="ws-ln">' + [['none','未清扫'],['standard','标准'],['extended','扩大']].map(x => '<option value="' + x[0] + '"' + ((cur.lnDissection || 'none') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>左送检/阳性</label><input id="ws-le" type="number" min="0" value="' + (cur.lnExaminedLeft == null ? '' : cur.lnExaminedLeft) + '"><input id="ws-lp" type="number" min="0" value="' + (cur.lnPositiveLeft == null ? '' : cur.lnPositiveLeft) + '"></div>' +
      '<div class="ws2-form-row"><label>右送检/阳性</label><input id="ws-re" type="number" min="0" value="' + (cur.lnExaminedRight == null ? '' : cur.lnExaminedRight) + '"><input id="ws-rp" type="number" min="0" value="' + (cur.lnPositiveRight == null ? '' : cur.lnPositiveRight) + '"></div>' +
      '<div class="ws2-form-row"><label>尿管(天)</label><input id="ws-cath" type="number" min="0" value="' + (cur.catheterDays == null ? '' : cur.catheterDays) + '"><label>引流(天)</label><input id="ws-drain" type="number" min="0" value="' + (cur.drainDays == null ? '' : cur.drainDays) + '"></div>' +
      '<div class="ws2-form-row"><label>并发症</label><input id="ws-comp" value="' + esc(arr(cur.complications).map(c => typeof c === 'string' ? wsl('complication', c) : (c.label || wsl('complication', c.code) || '')).filter(Boolean).join('、')) + '" placeholder="无/直肠损伤/血管损伤/淋巴漏"></div>' +
      '<div class="ws2-form-row"><label>处理结果</label><input id="ws-comp-mgmt" value="' + esc(cur.complicationManagement || '') + '"></div>' +
      '<div class="ws2-form-row"><label>出血(ml)</label><input id="ws-blood" type="number" min="0" value="' + (cur.bloodLossMl == null ? '' : cur.bloodLossMl) + '"><label>住院(天)</label><input id="ws-hosp" type="number" min="0" value="' + (cur.hospitalDays == null ? '' : cur.hospitalDays) + '"></div>' +
      '</div><p class="ws2-muted">记录册 p3：术式/入路/神经保留/左右淋巴结/导管/引流/围手术期并发症。pN 分期仍以病理报告为准。</p>';
    modal('手术实施 · ' + (ep.label || ep.templateCode), body, async () => {
      const payload = {
        episodeId,
        surgeryDate: $('ws-date').value,
        surgeon: $('ws-surgeon').value,
        procedure: $('ws-procedure').value,
        approach: $('ws-approach').value,
        nerveSparing: $('ws-nerve').value,
        lnDissection: $('ws-ln').value,
        lnExaminedLeft: $('ws-le').value === '' ? null : Number($('ws-le').value),
        lnPositiveLeft: $('ws-lp').value === '' ? null : Number($('ws-lp').value),
        lnExaminedRight: $('ws-re').value === '' ? null : Number($('ws-re').value),
        lnPositiveRight: $('ws-rp').value === '' ? null : Number($('ws-rp').value),
        catheterDays: $('ws-cath').value === '' ? null : Number($('ws-cath').value),
        drainDays: $('ws-drain').value === '' ? null : Number($('ws-drain').value),
        complications: $('ws-comp').value.split(/[、,，\s]+/).filter(Boolean),
        complicationManagement: $('ws-comp-mgmt').value,
        bloodLossMl: $('ws-blood').value === '' ? null : Number($('ws-blood').value),
        hospitalDays: $('ws-hosp').value === '' ? null : Number($('ws-hosp').value)
      };
      try {
        await api('/api/patients/' + p.id + '/surgery', { method: 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 手术实施已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存实施');
  }

  function openChemo(episodeId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const ep = episodeById(p.workspace, episodeId);
    if (!ep) return;
    const t = templateOf(p.workspace, ep) || { aeTerms: [] };
    const terms = arr(t.aeTerms).map(code => (S.catalog.toxicityTerms || []).find(x => x.code === code)).filter(Boolean);
    const cycles = arr(p.workspace.chemoCycles).filter(x => Number(x.episodeId) === Number(episodeId));
    const nextNo = cycles.reduce((m, x) => Math.max(m, x.cycleNo || 0), 0) + 1;
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>周期 *</label><input id="wc-no" type="number" min="1" value="' + nextNo + '"></div>' +
      '<div class="ws2-form-row"><label>日期 *</label><input id="wc-date" type="date" value="' + today() + '"></div>' +
      '<div class="ws2-form-row"><label>方案</label><input id="wc-regimen" value="' + esc(ep.label || '多西他赛') + '"></div>' +
      '<div class="ws2-form-row"><label>BSA(m²)</label><input id="wc-bsa" type="number" step="0.01" min="0.5" max="3"></div>' +
      '<div class="ws2-form-row"><label>减量%</label><input id="wc-reduction" type="number" min="0" max="100" step="1"></div>' +
      '<div class="ws2-form-row"><label>延迟(天)</label><input id="wc-delay" type="number" min="0" step="1"></div>' +
      '<div class="ws2-form-row"><label>延迟原因</label><input id="wc-reason"></div>' +
      '<div class="ws2-form-row"><label>G-CSF</label><select id="wc-gcsf"><option value="0">未用</option><option value="1">使用</option></select></div>' +
      '<div class="ws2-form-row"><label>ECOG</label><select id="wc-ecog">' + ['','0','1','2','3','4'].map(x => '<option value="' + x + '">' + (x || '未评估') + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>下次周期</label><input id="wc-next" type="date"></div></div>' +
      '<div class="ws2-card-h" style="margin-top:10px">本次副作用（record book p55）</div>' +
      '<div class="ws2-ae-grid">' + terms.map(term => '<div class="ws2-ae-item"><span>' + esc(term.label) + ' <i>0–' + term.maxGrade + '</i></span>' + termSelect(term, null, 'chemo') + '</div>').join('') + '</div>' +
      '<p class="ws2-muted">血常规（含 ANC）/肝肾功能可在“检查检验”录入；骨髓抑制分级会按 ANC/Hb/PLT 计算。</p>';
    modal('记录化疗周期 C' + nextNo, body, async () => {
      const aes = [];
      document.querySelectorAll('[data-ae][data-prefix="chemo"]').forEach(sel => {
        if (sel.value === '') return;
        aes.push({ termCode: sel.getAttribute('data-ae'), grade: Number(sel.value), recoveryStatus: 'unknown' });
      });
      try {
        await api('/api/patients/' + p.id + '/episodes/' + episodeId + '/chemo-cycles', { method: 'POST', body: JSON.stringify({
          cycleNo: Number($('wc-no').value), cycleDate: $('wc-date').value, regimen: $('wc-regimen').value,
          bsa: $('wc-bsa').value === '' ? null : Number($('wc-bsa').value),
          doseReductionPct: $('wc-reduction').value === '' ? null : Number($('wc-reduction').value),
          delayDays: $('wc-delay').value === '' ? null : Number($('wc-delay').value),
          delayReason: $('wc-reason').value, gcsf: $('wc-gcsf').value === '1',
          ecog: $('wc-ecog').value === '' ? null : Number($('wc-ecog').value),
          nextCycleDate: $('wc-next').value || null, adverseEvents: aes
        }) });
        closeModal(); toast('✅ 化疗周期已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存周期');
  }

  function openAdministration(episodeId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const body = '<div class="ws2-form-row"><label>给药日期 *</label><input id="wa-date" type="date" value="' + today() + '"></div>' +
      '<div class="ws2-form-row"><label>药物 *</label><input id="wa-drug" value="戈舍瑞林"></div>' +
      '<div class="ws2-form-row"><label>剂量</label><input id="wa-dose" placeholder="3.6mg"></div>' +
      '<div class="ws2-form-row"><label>途径/部位</label><input id="wa-route" placeholder="皮下/腹壁"><input id="wa-site" placeholder=""></div>' +
      '<div class="ws2-form-row"><label>下次到期</label><input id="wa-next" type="date"></div>' +
      '<div class="ws2-form-row"><label>备注</label><input id="wa-notes"></div>';
    modal('记录给药', body, async () => {
      try {
        await api('/api/patients/' + p.id + '/medication-administrations', { method: 'POST', body: JSON.stringify({
          episodeId, adminDate: $('wa-date').value, drug: $('wa-drug').value, dose: $('wa-dose').value,
          route: $('wa-route').value, site: $('wa-site').value, nextDueDate: $('wa-next').value || null, notes: $('wa-notes').value
        }) });
        closeModal(); toast('✅ 给药记录已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存给药');
  }

  function openBaseline() {
    const p = getPatient(selectedId);
    if (!p) return;
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>主要症状</label><input id="wb-symptom" value="' + esc(p.mainSymptom || '') + '" placeholder="如：排尿困难/骨痛/体检发现PSA升高"></div>' +
      '<div class="ws2-form-row"><label>症状病程(月)</label><input id="wb-duration" type="number" min="0" max="600" step="1" value="' + (p.symptomDurationMonths == null ? '' : esc(p.symptomDurationMonths)) + '"></div>' +
      '<div class="ws2-form-row"><label>基线疼痛 NRS</label><input id="wb-pain" type="number" min="0" max="10" step="1" value="' + (p.baselinePainNrs == null ? '' : esc(p.baselinePainNrs)) + '"></div>' +
      '<div class="ws2-form-row"><label>籍贯</label><input id="wb-birthplace" value="' + esc(p.birthplace || '') + '"></div>' +
      '<div class="ws2-form-row"><label>住院号</label><input id="wb-admission" value="" placeholder="' + (p.hasAdmissionNo ? '已存：' + esc(p.admissionNoMasked) + '（留空不修改）' : '用于回连 HIS，可选') + '"></div>' +
      '<div class="ws2-form-row"><label>DRE</label><select id="wb-dre">' +
        [['','未做/未记录'],['normal','正常（未触及结节）'],['abnormal','异常（可疑结节）']].map(x => '<option value="' + x[0] + '"' + ((p.dreResult || '') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>DRE 描述</label><input id="wb-dre-note" value="' + esc(p.dreNote || '') + '"></div>' +
      '<div class="ws2-form-row"><label>ECOG</label><select id="wb-ecog">' + ['','0','1','2','3','4'].map(x => '<option value="' + x + '"' + (String(p.ecog == null ? '' : p.ecog) === x ? ' selected' : '') + '>' + (x || '未评估') + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>BMI</label><input id="wb-bmi" type="number" step="0.1" min="5" max="80" value="' + (p.bmi == null ? '' : esc(p.bmi)) + '"></div>' +
      '<div class="ws2-form-row"><label>吸烟</label><select id="wb-smoking">' +
        [['','—'],['never','从不'],['former','已戒烟'],['current','目前吸烟'],['unknown','不详']].map(x => '<option value="' + x[0] + '"' + ((p.smoking || '') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>家族史</label><select id="wb-family">' +
        [['','未评估'],['1','有'],['0','无']].map(x => '<option value="' + x[0] + '"' + ((p.familyHistory == null ? '' : (p.familyHistory ? '1' : '0')) === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>家族史详情</label><input id="wb-family-detail" value="' + esc(p.familyHistoryDetail || '') + '" placeholder="关系/发病年龄/已知基因"></div>' +
      '</div><p class="ws2-muted">记录册 p1/p2 基线：主要症状、DRE、ECOG、BMI、吸烟、家族史、籍贯、住院号。住院号仅掩码显示。</p>';
    modal('补基线信息', body, async () => {
      const payload = {
        mainSymptom: $('wb-symptom').value,
        symptomDurationMonths: $('wb-duration').value === '' ? null : Number($('wb-duration').value),
        baselinePainNrs: $('wb-pain').value === '' ? null : Number($('wb-pain').value),
        birthplace: $('wb-birthplace').value,
        dreResult: $('wb-dre').value, dreNote: $('wb-dre-note').value,
        ecog: $('wb-ecog').value === '' ? null : Number($('wb-ecog').value),
        bmi: $('wb-bmi').value === '' ? null : Number($('wb-bmi').value),
        smoking: $('wb-smoking').value,
        familyHistory: $('wb-family').value === '' ? null : Number($('wb-family').value),
        familyHistoryDetail: $('wb-family-detail').value
      };
      if ($('wb-admission').value.trim()) payload.admissionNo = $('wb-admission').value.trim();
      try {
        await api('/api/patients/' + p.id, { method: 'PUT', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 基线信息已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存基线');
  }

  function openComorbidity(code) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const cat = (S.catalog.comorbidities || []).find(x => x.code === code);
    if (!cat) return;
    const cur = arr(p.workspace.comorbidities).find(x => x.diseaseCode === code) || {};
    const body = '<div class="ws2-kv">' + kv('合并症', cat.label) + kv('系统', cat.system) + '</div>' +
      '<div class="ws2-form-row"><label>状态</label><select id="wc-status">' +
        ['unknown','active','history','negative'].map(x => '<option value="' + x + '"' + ((cur.status || 'unknown') === x ? ' selected' : '') + '>' + ({unknown:'未评估',active:'活动/现患',history:'既往',negative:'明确无'})[x] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>严重度</label><input id="wc-severity" value="' + esc(cur.severity || '') + '" placeholder="轻/中/重"></div>' +
      '<div class="ws2-form-row"><label>诊断日期</label><input id="wc-date" type="date" value="' + esc(cur.diagnosedDate || '') + '"></div>' +
      '<div class="ws2-form-row"><label>备注</label><input id="wc-notes" value="' + esc(cur.notes || '') + '"></div>';
    modal('合并症 · ' + cat.label, body, async () => {
      try {
        await api('/api/patients/' + p.id + '/comorbidities', { method: 'POST', body: JSON.stringify({
          diseaseCode: code, status: $('wc-status').value, severity: $('wc-severity').value,
          diagnosedDate: $('wc-date').value || null, notes: $('wc-notes').value
        }) });
        closeModal(); toast('✅ 合并症已保存'); await refresh(p);
      } catch (e) { toast('⚠ ' + e.message); }
    }, '保存合并症');
  }

  function openTreatment(optionId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return toast('⚠ 患者资料未加载');
    const op = optionId && S.catalog ? (S.catalog.treatmentOptions || []).find(x => x.id === optionId) : null;
    let template = 'SYSTEMIC', epType = 'systemic';
    if (op) {
      if (arr(op.components).some(c => c.type === 'chemo')) { template = 'CHEMO'; epType = 'chemo'; }
      else if (arr(op.components).some(c => c.type === 'surgery')) { template = 'RP'; epType = 'surgery'; }
      else if (arr(op.components).some(c => c.type === 'rt')) { template = 'RT'; epType = 'radiotherapy'; }
      else if (arr(op.components).some(c => c.type === 'adt') && arr(op.components).length === 1) { template = 'ADT'; epType = 'endocrine'; }
      else if (arr(op.components).some(c => c.type === 'surveillance')) { template = 'AS'; epType = 'surveillance'; }
    }
    const templates = (S.catalog && S.catalog.followupTemplates) || [];
    const lines = arr(p.treatmentLines);
    const suggestedLine = lines.reduce((m, l) => Math.max(m, Number(l.lineNo) || 0), 0) + 1;
    const setting = (p.diseaseCategory && ['mHSPC', 'nmCRPC', 'mCRPC'].includes(p.diseaseCategory))
      ? p.diseaseCategory : (op && op.scenario && /post_op/.test(op.scenario) ? '辅助' : '局限治疗');
    const typeLabels = [['surgery','手术'],['radiotherapy','放疗'],['endocrine','内分泌治疗'],['systemic','系统治疗'],['chemo','化疗'],['surveillance','主动监测/观察'],['other','其他']];
    const intentLabels = [['radical','根治'],['adjuvant','辅助'],['salvage','挽救'],['palliative','姑息'],['neoadjuvant','新辅助'],['active_surveillance','主动监测'],['watchful_waiting','观察等待']];
    const comps = arr(op && op.components).map(c => {
      const drug = c.drug || c.label || (arr(c.choices).length ? c.choices[0] : '');
      return { type: c.type || 'other', drug, dose: c.dose || '', schedule: c.schedule || '' };
    });
    const compHtml = comps.length ? comps.map((c, i) =>
      '<div class="ws2-form-row" data-comp-row="' + i + '"><label>药物组成 ' + (i + 1) + '</label>' +
        '<input data-comp-drug="' + i + '" value="' + esc(c.drug) + '" placeholder="药名">' +
        '<input data-comp-dose="' + i + '" value="' + esc(c.dose) + '" placeholder="剂量">' +
        '<input data-comp-schedule="' + i + '" value="' + esc(c.schedule) + '" placeholder="频次">' +
        '<input type="hidden" data-comp-type="' + i + '" value="' + esc(c.type) + '"></div>').join('') : '';
    const body = '<div class="ws2-form-grid">' +
      '<div class="ws2-form-row"><label>治疗段模板 *</label><select id="wt-template">' + templates.map(t => '<option value="' + t.code + '"' + (t.code === template ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>类型</label><select id="wt-type">' + typeLabels.map(x => '<option value="' + x[0] + '"' + (x[0] === epType ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>意图</label><select id="wt-intent">' + intentLabels.map(x => '<option value="' + x[0] + '"' + (x[0] === (op && /挽救/.test(op.label) ? 'salvage' : 'radical') ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>治疗线数 *</label><input id="wt-line" type="number" min="1" max="99" value="' + suggestedLine + '"></div>' +
      '<div class="ws2-form-row"><label>情境</label><select id="wt-setting">' + ['新辅助','辅助','挽救','mHSPC','nmCRPC','mCRPC','局限治疗','主动监测','观察等待','其他'].map(x => '<option value="' + x + '"' + (x === setting ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div class="ws2-form-row"><label>开始日期 *</label><input type="date" id="wt-start" value="' + today() + '"></div>' +
      '<div class="ws2-form-row"><label>结束日期</label><input type="date" id="wt-end"></div>' +
      '<div class="ws2-form-row" style="grid-column:1/-1"><label>方案名 *</label><input id="wt-regimen" value="' + esc(op ? op.label : '') + '"></div></div>' +
      '<div class="ws2-form-row"><label>名称</label><input id="wt-label" value="' + esc(op ? op.label : '') + '"></div>' +
      compHtml +
      (op ? '<div class="ws2-option-pre">指南选项：' + esc(op.label) + ' · ' + esc(op.level) + ' · ' + esc(op.source || '') +
        (arr(op.components).length ? '<br>组成：' + esc(op.components.map(c => c.drug || c.drugClass || c.label || c.type).join(' + ')) : '') + '</div>' : '') +
      '<div class="ws2-form-row"><label>偏离指南原因（可选）</label><input id="wt-deviation" placeholder="如：患者拒绝/药物不可及"></div>' +
      '<p class="ws2-muted">保存会一次建立：治疗线 + 治疗段 + 组成药物。手术/放疗/化疗的实施细节可在治疗段卡继续补录。</p>';
    modal(op ? '选择指南方案并建立治疗' : '新增治疗', body, async () => {
      const tcode = $('wt-template').value;
      const t = templates.find(x => x.code === tcode);
      const components = [...document.querySelectorAll('[data-comp-drug]')].map(inp => {
        const i = inp.getAttribute('data-comp-drug');
        const ht = (document.querySelector('[data-comp-type="' + i + '"]') || {}).value;
        const tt = { endocrine: 'adt', chemo: 'chemo', radiotherapy: 'rt', surgery: 'surgery' }[$('wt-type').value] || 'other';
        return { type: ht || tt, drug: inp.value,
          dose: (document.querySelector('[data-comp-dose="' + i + '"]') || {}).value || '',
          schedule: (document.querySelector('[data-comp-schedule="' + i + '"]') || {}).value || '' };
      }).filter(x => x.drug.trim());
      const payload = {
        episodeType: $('wt-type').value, templateCode: tcode, intent: $('wt-intent').value,
        lineNo: Number($('wt-line').value), setting: $('wt-setting').value,
        regimen: $('wt-regimen').value || (t && t.label) || '未命名方案',
        startDate: $('wt-start').value, endDate: $('wt-end').value || null,
        label: $('wt-label').value || (t && t.label), status: $('wt-end').value ? 'completed' : 'active',
        stopReasonCode: $('wt-end').value ? 'completed' : '',
        guidelineScenario: op ? op.scenario : (S.scenario || ''),
        guidelineOptionId: op ? op.id : '',
        recommendationLevel: op ? op.level : '',
        guidelineRef: op ? op.source : '',
        deviationReason: $('wt-deviation') ? $('wt-deviation').value : '',
        agents: components.map(c => ({ drug: c.drug, dose: c.dose, schedule: c.schedule })),
        components
      };
      try {
        await api('/api/patients/' + p.id + '/treatment-plans', { method: 'POST', body: JSON.stringify(payload) });
        closeModal(); toast('✅ 治疗线、治疗段和药物已建立');
        await refresh(p);
        tab('treatment');
      } catch (e) { toast('⚠ ' + e.message); }
    }, '建立治疗');
  }

  async function backfillVisits() {
    const p = getPatient(selectedId);
    if (!p) return;
    if (!confirm('把历史事件/检查按日期聚合成就诊，并按治疗段生成随访行？\n\n只建容器和绑定已有记录，不伪造疗效/毒性；已有日期的就诊会跳过。')) return;
    try {
      const r = await api('/api/patients/' + p.id + '/visits/backfill', { method: 'POST', body: '{}' });
      toast('✅ 历史回填：新增就诊 ' + r.createdVisits + ' 次、随访行 ' + r.createdRows + ' 行、绑定记录 ' + r.linked + ' 条');
      await refresh(p);
      tab('record');
    } catch (e) { toast('⚠ ' + e.message); }
  }

  function printPatient() {
    const p = getPatient(selectedId);
    if (!p) return toast('⚠ 患者资料未加载');
    const a = assessOf(p);
    const w = p.workspace || {};
    const H = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tbl = (title, cols, rows) => {
      if (!rows || !rows.length) return '';
      return '<h2>' + H(title) + '</h2><table><thead><tr>' + cols.map(c => '<th>' + H(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + H(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    };
    const kvBlock = (title, pairs) => {
      const rows = pairs.filter(x => x && (x[1] !== '' && x[1] != null));
      if (!rows.length) return '';
      return '<h2>' + H(title) + '</h2><div class="kv">' + rows.map(x => '<div><b>' + H(x[0]) + '</b>' + H(x[1]) + '</div>').join('') + '</div>';
    };
    const eps = arr(w.episodes);
    const lines = arr(p.treatmentLines);
    const psa = arr(p.psa).slice().sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const testo = arr(p.testo).slice().sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const visits = arr(w.visits).slice().sort((x, y) => String(x.visitDate).localeCompare(String(y.visitDate)));
    const rows = arr(w.rows);
    const surgeries = arr(w.surgeryRecords);
    const cycles = arr(w.chemoCycles);
    const admins = arr(w.administrations);
    const aes = arr(w.adverseEvents);
    const comorbs = arr(w.comorbidities);
    const states = arr(w.diseaseStates);
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>患者随访信息 · ' + H(p.name) + ' ' + H(p.id) + '</title><style>' +
      'body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#172b33;margin:24px;font-size:12px;line-height:1.55}' +
      'h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 5px;padding-bottom:3px;border-bottom:1px solid #a9c3bd;color:#24515e}' +
      '.meta{color:#60747b;font-size:11px;margin-bottom:8px}.kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 18px}.kv div{padding:2px 0}.kv b{display:inline-block;min-width:78px;color:#60747b;font-weight:500}' +
      'table{width:100%;border-collapse:collapse;font-size:10.5px;margin:3px 0 8px}th,td{border:1px solid #cbdad6;padding:3px 4px;vertical-align:top;text-align:left}th{background:#eef6f3;color:#315b5b}' +
      '@page{size:A4;margin:12mm}@media print{body{margin:0}h2{page-break-after:avoid}table{page-break-inside:auto}tr{page-break-inside:avoid}}' +
      '</style></head><body>' +
      '<h1>' + H(p.name) + ' · ' + H(p.id) + ' · 患者全部随访信息</h1>' +
      '<div class="meta">打印日期 ' + H(today()) + ' · 出生 ' + H(p.birth || '—') + ' · 年龄 ' + H(p.age) + ' 岁 · 诊断 ' + H(p.date || '—') + '</div>' +
      kvBlock('基本信息', [
        ['姓名', p.name], ['患者编号', p.id], ['出生日期', p.birth], ['年龄', p.age + ' 岁'],
        ['诊断日期', p.date], ['随访状态', p.followupStatus || '在访'], ['末次随访', p.lastFollowupDate],
        ['随访方式', wsl('followupMode', p.lastFollowupMode)], ['ECOG', p.ecog], ['BMI', p.bmi],
        ['主要症状', p.mainSymptom], ['症状病程(月)', p.symptomDurationMonths], ['基线疼痛 NRS', p.baselinePainNrs],
        ['DRE', p.dreResult === 'abnormal' ? '异常' : p.dreResult === 'normal' ? '正常' : '未做/未记录'],
        ['DRE 描述', p.dreNote], ['吸烟', p.smoking], ['家族史', p.familyHistory == null ? '未评估' : (p.familyHistory ? '有' : '无')],
        ['家族史详情', p.familyHistoryDetail], ['籍贯', p.birthplace], ['住院号', p.admissionNoMasked || (p.hasAdmissionNo ? '已存' : '')],
        ['知情同意', p.researchConsent == null ? '未记录' : (p.researchConsent ? '已签' : '未签')],
        ['同意日期', p.researchConsentDate], ['数据共享', p.dataSharing == null ? '未记录' : (p.dataSharing ? '已授权' : '未授权')]
      ]) +
      kvBlock('诊断、分期与风险', [
        ['临床分期', p.clinicalStage], ['病理分期', p.pathologicStage], ['疾病阶段', p.diseaseCategory],
        ['活检 Gleason', (() => { try { const x = ClinicalCore.pickBiopsyPathology(p); return x && x.gleasonTotal != null ? (x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal + ' / GG' + (x.isup || '—')) : '未录'; } catch (e) { return '未录'; } })()],
        ['RP 病理 Gleason', (() => { try { const x = ClinicalCore.pickPostopPathology(p); return x && x.gleasonTotal != null ? (x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal + ' / GG' + (x.isup || '—')) : '未手术/未录'; } catch (e) { return '—'; } })()],
        ['风险分层', riskLabelSafe(a)], ['风险依据', (a.strata && a.strata.why) || ''],
        ['当前疾病状态', (a.disease && a.disease.label) || '待评估'], ['状态依据', (a.disease && a.disease.evidence) || ''],
        ['去势状态', (a.castration && a.castration.label) || '未评估'], ['瘤负荷', (() => { try { const b = ClinicalCore.tumorBurden(p); return b.label + (b.basis ? '（' + b.basis + '）' : ''); } catch (e) { return '未评估'; } })()]
      ]) +
      tbl('治疗段', ['治疗段', '开始', '结束', '状态', '意图', '指南依据'], eps.map(e => [
        e.label || e.templateCode, e.startDate || '', e.endDate || '至今', wsl('episodeStatus', e.status),
        wsl('intent', e.intent), [e.recommendationLevel, e.guidelineRef].filter(Boolean).join(' · ')
      ])) +
      tbl('治疗线', ['线', '情境', '方案', '开始', '结束', '停药原因', '疗效', '药物'], lines.map(l => [
        l.lineNo, l.setting, l.regimen, l.startDate || '', l.endDate || '至今',
        wsl('stopReason', l.stopReasonCode), wsl('response', l.responseCode),
        arr(l.agents).map(x => [x.drug, x.dose, x.schedule].filter(Boolean).join(' ')).join('；')
      ])) +
      tbl('用药记录', ['分类', '药物', '开始', '结束', '剂量', '频次', '备注'], arr(p.medications).map(m => [
        wsl('medCategory', m.category), m.drug, m.startDate || '', m.endDate || '至今', m.dose, m.schedule, m.notes
      ])) +
      tbl('手术记录', ['日期', '术式', '入路', '神经保留', '淋巴结清扫', '尿管(天)', '引流(天)', '并发症', '处理'], surgeries.map(x => [
        x.surgeryDate || '', x.procedure || '', wsl('surgeryApproach', x.approach), wsl('nerveSparing', x.nerveSparing),
        wsl('lnDissection', x.lnDissection), x.catheterDays, x.drainDays,
        arr(x.complications).map(c => typeof c === 'string' ? wsl('complication', c) : (c.label || wsl('complication', c.code))).filter(Boolean).join('、'),
        x.complicationManagement || ''
      ])) +
      tbl('放疗记录', ['类型', '开始', '结束', '剂量(Gy)', '分割', '靶区', '联合ADT', '备注'], arr(p.radiationRecords).map(r => [
        wsl('rtType', r.rtType), r.startDate, r.endDate, r.doseGy, r.fractions, wsl('rtTarget', r.target),
        r.concurrentAdt ? '是' : '否', r.notes
      ])) +
      tbl('化疗周期', ['周期', '日期', '方案', '剂量', 'ANC', '血小板', '减量', '延迟', 'G-CSF'], cycles.map(c => [
        c.cycleNo, c.cycleDate, c.regimen, c.dose, c.anc, c.platelet, c.doseReduction, c.delayReason, c.gcsf ? '是' : '否'
      ])) +
      tbl('给药记录', ['日期', '药物', '剂量', '途径', '部位', '下次到期', '备注'], admins.map(x => [
        x.adminDate, x.drug, x.dose, x.route, x.site, x.nextDueDate, x.notes
      ])) +
      tbl('就诊记录', ['日期', '类型', '科室', '小结', '下次计划', '下次随访'], visits.map(v => [
        v.visitDate, wsl('visitType', v.visitType), v.department, v.summary, v.nextPlan, v.nextVisitDate
      ])) +
      tbl('随访行 / 疗效与毒性', ['就诊日期', '段', '次', '总体疗效', '依据', 'PSA反应', '影像反应', '临床反应', '小结'], rows.map(r => {
        const ep = eps.find(e => Number(e.id) === Number(r.episodeId));
        return [r.visitDate, ep ? (ep.label || ep.templateCode) : '', r.visitNo, wsl('response', r.overallResponse), r.responseBasis,
          wsl('response', r.psaResponse), wsl('response', r.imagingResponse), wsl('response', r.clinicalResponse), r.summary || r.notes];
      })) +
      tbl('不良事件', ['日期', '毒性', '分级', '恢复', '处理', '备注'], aes.map(x => [
        x.onsetDate || x.visitDate || '', x.termLabel || x.termCode, x.grade == null ? '未评估' : ('G' + x.grade),
        wsl('aeRecovery', x.recoveryStatus), x.auxMeds, x.notes
      ])) +
      tbl('PSA', ['日期', 'PSA ng/mL', '标记', '游离 PSA', 'f/t'], psa.map(x => [
        x.date, x.belowLod ? '<' + (x.lod != null ? x.lod : x.val) : x.val,
        [x.isInitial ? '初始' : '', x.belowLod ? '低于下限' : ''].filter(Boolean).join(' · '),
        x.freeVal == null ? '' : (x.freeBelowLod ? '<' + (x.freeLod || x.freeVal) : x.freeVal), x.freeRatio == null ? '' : x.freeRatio
      ])) +
      tbl('睾酮', ['日期', '录入值', '单位', '规范 ng/dL', '方法', '实验室', '采血时间'], testo.map(x => [
        x.date, x.enteredVal == null ? x.val : x.enteredVal, x.unit || 'ng/dl', x.val, x.assayMethod, x.lab, x.sampleTime
      ])) +
      tbl('化验', ['日期', '项目', '结果', '单位', '参考范围', '异常', '备注'], arr(p.labValues).map(x => [
        x.date, x.item || x.itemCode, x.value, x.unit, x.refRange, x.flag, x.note
      ])) +
      tbl('功能与监测', ['日期', '分类', '项目', '结果', '单位', '状态', '备注'], arr(p.clinicalRecords).map(x => [
        x.date, wsl('clinicalCategory', x.category), x.item, x.val, x.unit, wsl('clinicalStatus', x.status), x.note
      ])) +
      tbl('病理', ['日期', '标本', '主要', 'Gleason/ISUP', 'pTNM', '切缘', '淋巴结', 'IDC-P/筛状', 'DAC/NEPC', '备注'], arr(p.pathologyReports).map(x => [
        x.reportDate, wsl('specimenType', x.specimenType), x.isPrimary ? '是' : '否',
        x.gleasonTotal != null ? (x.gleasonPrimary + '+' + x.gleasonSecondary + '=' + x.gleasonTotal + ' / GG' + (x.isup || '—')) : '',
        x.ptnm, wsl('marginStatus', x.marginStatus), (x.lnPositive == null ? '' : x.lnPositive) + '/' + (x.lnExamined == null ? '' : x.lnExamined),
        [x.idcP == null ? '' : (x.idcP ? 'IDC-P+' : 'IDC-P-'), x.cribriform == null ? '' : (x.cribriform ? '筛状+' : '筛状-')].join(' '),
        [x.dac == null ? '' : (x.dac ? 'DAC+' : 'DAC-'), x.nepc == null ? '' : (x.nepc ? 'NEPC+' : 'NEPC-')].join(' '),
        x.notes
      ])) +
      tbl('影像', ['日期', '模态', '部位/病灶', 'PI-RADS', 'PSMA', 'RECIST', '比较', '备注'], arr(p.imagingStudies).map(x => [
        x.studyDate, wsl('imagingModality', x.modality), [x.metastaticSites, x.indexLocation, x.lesionCount != null ? x.lesionCount + '灶' : ''].filter(Boolean).join(' · '),
        x.pirads == null ? '' : x.pirads, x.psmaPositive == null ? '' : (x.psmaPositive ? '阳性' : '阴性') + (x.psmaSuvmax != null ? ' SUVmax ' + x.psmaSuvmax : ''),
        x.recist, wsl('comparison', x.comparison), x.notes
      ])) +
      tbl('结局与转归', ['类型', '日期', '亚型/部位', '依据', '备注'], arr(p.outcomes).map(o => [
        wsl('outcomeType', o.outcomeType), o.eventDate, o.subtype || o.metastaticSites || o.deathCause || o.lostReason,
        o.basis, o.note
      ])) +
      tbl('合并症', ['合并症', '状态', '严重度', '诊断日期', '备注'], comorbs.map(x => [
        x.diseaseLabel || x.diseaseCode, wsl('comorbidityStatus', x.status), x.severity, x.diagnosedDate, x.notes
      ])) +
      tbl('疾病状态历史', ['状态', '日期', '依据', '当前'], states.map(x => [
        x.stateCode + (x.stateLabel ? ' · ' + x.stateLabel : ''), x.sinceDate, x.basis, x.isCurrent ? '是' : '否'
      ])) +
      tbl('科研样本', ['类型', '采样日期', '时点', '治疗状态', '肿瘤细胞%', '库号', '备注'], arr(p.specimens).map(x => [
        wsl('sample', x.sampleType), x.collectionDate, x.timepoint, x.treatmentStatus, x.tumorCellPct, x.biobankId, x.notes
      ])) +
      tbl('IHC', ['标志物', '结果', '阳性%', '强度', '日期', '实验室'], arr(p.ihcResults).map(x => [
        x.marker, wsl('ihcResult', x.result), x.percent, wsl('ihcIntensity', x.intensity), x.testDate, x.lab
      ])) +
      tbl('基因检测', ['类型', '日期', '基因', 'HRR', 'MSI', 'TMB', '实验室', '摘要'], arr(p.genomicTests).map(x => [
        x.testType === 'germline' ? '胚系' : '体系', x.testDate, x.genes, wsl('hrr', x.hrrStatus), wsl('msi', x.msiStatus),
        x.tmbValue, x.lab, x.resultSummary
      ])) +
      tbl('原始事件', ['日期', '类型', '备注'], arr(p.events).slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).map(e => [e.date, e.type, e.notes])) +
      '<p class="meta">说明：空白/“未评估”表示没有记录，不等于阴性；分级 G0 表示评估为无，G1–G5 按评分卡。此打印件仅供临床随访使用。</p>' +
      '</body></html>';
    const win = window.open('', '_blank');
    if (!win) return toast('⚠ 浏览器拦截了打印窗口');
    win.document.write(html); win.document.close(); win.focus(); setTimeout(() => win.print(), 300);
  }

  function printEpisode(episodeId) {
    const p = getPatient(selectedId);
    if (!p || !p.workspace) return;
    const ep = episodeById(p.workspace, episodeId);
    if (!ep) return;
    const rows = arr(p.workspace.rows).filter(r => Number(r.episodeId) === Number(ep.id));
    const t = templateOf(p.workspace, ep) || { aeTerms: [] };
    const terms = arr(t.aeTerms).map(code => (S.catalog.toxicityTerms || []).find(x => x.code === code)).filter(Boolean);
    const html = '<html><head><meta charset="utf-8"><title>随访表 ' + esc(p.name) + '</title>' +
      '<style>body{font-family:"PingFang SC",sans-serif;padding:20px;color:#222}h1{font-size:16px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #999;padding:4px;text-align:left}th{background:#eee}.muted{color:#666;font-size:11px}</style></head><body>' +
      '<h1>' + esc(p.name) + ' ' + esc(p.id) + ' · ' + esc(ep.label || ep.templateCode) + '</h1>' +
      '<div class="muted">' + esc(ep.startDate) + ' → ' + esc(ep.endDate || '至今') + ' · ' + esc(wsl('intent', ep.intent)) + ' · 打印 ' + today() + '</div>' +
      '<table><thead><tr><th>次</th><th>日期</th><th>PSA</th><th>疗效</th>' + terms.map(x => '<th>' + esc(x.label) + '</th>').join('') + '<th>小结</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + fmt(r.visitNo) + '</td><td>' + esc(r.visitDate) + '</td><td>' + esc(psaText(psaOfDate(p, r.visitDate))) + '</td><td>' + esc(wsl('response', r.overallResponse)) + '</td>' +
        terms.map(term => { const ae = aeFor(p.workspace, r.id, term.code); return '<td>' + (ae && ae.grade != null ? ae.grade : '未评估') + '</td>'; }).join('') +
        '<td>' + esc(r.summary || r.notes || '') + '</td></tr>').join('') +
      '</tbody></table><p class="muted">未评估≠0；空白不再表示“正常”。分级定义见系统评分卡。</p></body></html>';
    const win = window.open('', '_blank');
    if (!win) return toast('⚠ 浏览器拦截了打印窗口');
    win.document.write(html); win.document.close(); win.focus(); setTimeout(() => win.print(), 300);
  }

  window.Workspace = {
    render, tab, openTreatmentGuide, episode, openEpisodeRecord, setScenario,
    uploadReports, deleteReport,
    openVisit, openVisitDetail, openVisitDetailById, openVisitEditById, attach, openAE, openAEById,
    openVisitItemPicker, openVisitItemEditor, editVisitItem, removeVisitItem, closeSubModal,
    openProfileEditor, openPsaEditor, openTestoEditor, openLabEditor, openClinicalEditor,
    openStructuredEditor, deleteStructured, openToxicityInfo, openResponseInfo,
    openTreatmentLineEditor, openMedicationEditor, openEventEditor, deleteRecord,
    openSpecimenEditor, openIhcEditor, openGenomicEditor, openDiseaseStateEditor, openConsentEditor, openAi,
    openTreatment, openBaseline, openComorbidity, openSurgery, openChemo, openAdministration, openEpisodeEdit, backfillVisits, printEpisode, printPatient, closeModal,
    state: S,
    loadCatalog
  };
})();

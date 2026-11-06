/* =========================================================
 * 前列腺随访 2.0 · 结构化专病数据核心
 * ---------------------------------------------------------
 * 纯函数模块，不依赖 DOM / fetch / 数据库。
 * 浏览器：外链 /record-core.js → window.RecordCore
 * Node 测试：vm.runInNewContext 读取本文件，取 module.exports
 *
 * 职责：
 *   1. 统一结构化字段的枚举/标签，避免前后端各写一套中文。
 *   2. 把病理/影像/放疗/结局/样本/IHC/基因组记录压缩成一行摘要。
 *   3. 校验表单（前端即时提示；服务端仍做最终校验）。
 *   4. 计算“核心字段完整度”，供详情页和工作台使用。
 *
 * 注意：这里不重新实现 CSCO 风险/BCR/CRPC 判定逻辑，那些仍在
 * clinical-core.js；本模块只做结构化数据的展示与校验。
 * ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecordCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- 枚举 ---------- */
  const SPECIMEN_TYPES = [
    { v: 'biopsy', l: '穿刺活检' },
    { v: 'RP', l: '根治性前列腺切除' },
    { v: 'TURP', l: '前列腺电切' },
    { v: 'metastasis', l: '转移灶活检' },
    { v: 'review', l: '病理会诊/复核' },
    { v: 'unknown', l: '未注明' }
  ];
  const MARGIN_STATUS = [
    { v: 'negative', l: '阴性' },
    { v: 'positive', l: '阳性' },
    { v: 'close', l: '近切缘' },
    { v: 'unknown', l: '未评估' }
  ];
  const IMAGING_MODALITIES = [
    { v: 'mpMRI', l: 'mpMRI' },
    { v: 'CT', l: 'CT' },
    { v: 'MRI', l: 'MRI' },
    { v: 'PSMA_PET', l: 'PSMA PET-CT' },
    { v: 'PSMA_PET_MRI', l: 'PSMA PET-MRI' },
    { v: 'bone_scan', l: '骨扫描' },
    { v: 'choline_pet', l: '胆碱 PET' },
    { v: 'other', l: '其他影像' }
  ];
  /* 与旧片比较：CSCO 6.1 / 8.2.1 的“新发/进展/稳定”；improved 用于治疗有效 */
  const IMAGING_COMPARISON = [
    { v: '', l: '未比较' },
    { v: 'new', l: '新发' },
    { v: 'progress', l: '进展' },
    { v: 'stable', l: '稳定' },
    { v: 'improved', l: '好转' },
    { v: 'mixed', l: '混合反应' },
    { v: 'na', l: '无可比旧片' }
  ];
  const PSMA_RADS = [
    { v: '', l: '未分级' }, { v: '1', l: '1 良性' }, { v: '2', l: '2 可能良性' },
    { v: '3', l: '3 不确定' }, { v: '4', l: '4 可能恶性' }, { v: '5', l: '5 恶性' }
  ];
  /* 组织学类型：腺泡腺癌之外的类型直接改变治疗强度（CSCO 第9章） */
  const HISTOLOGY_TYPES = [
    { v: '', l: '未注明' },
    { v: 'acinar', l: '腺泡腺癌' },
    { v: 'ductal', l: '导管腺癌' },
    { v: 'idc_p', l: '导管内癌 IDC-P' },
    { v: 'neuroendocrine', l: '神经内分泌癌' },
    { v: 'adenosquamous', l: '腺鳞癌' },
    { v: 'mucinous', l: '黏液腺癌' },
    { v: 'signet', l: '印戒细胞癌' },
    { v: 'other', l: '其他' }
  ];
  const BIOPSY_ROUTES = [
    { v: '', l: '未注明' }, { v: 'transrectal', l: '经直肠' },
    { v: 'transperineal', l: '经会阴' }, { v: 'unknown', l: '不详' }
  ];
  const BIOPSY_GUIDANCE = [
    { v: '', l: '未注明' }, { v: 'us', l: '超声引导' },
    { v: 'mri_fusion', l: 'MRI 融合' }, { v: 'mri_cognitive', l: 'MRI 认知融合' },
    { v: 'template', l: '模板/饱和' }, { v: 'unknown', l: '不详' }
  ];
  const MET_SITES = [
    { v: 'bone', l: '骨' },
    { v: 'lymph_node', l: '淋巴结' },
    { v: 'visceral', l: '内脏' },
    { v: 'other', l: '其他' }
  ];
  const RECIST = [
    { v: '', l: '未评估' }, { v: 'CR', l: 'CR' }, { v: 'PR', l: 'PR' },
    { v: 'SD', l: 'SD' }, { v: 'PD', l: 'PD' }, { v: 'NE', l: 'NE' }
  ];
  const PCWG = [
    { v: '', l: '未评估' }, { v: 'PSA_response', l: 'PSA 反应' },
    { v: 'PSA_progression', l: 'PSA 进展' }, { v: 'bone_response', l: '骨扫描反应' },
    { v: 'bone_progression', l: '骨扫描进展' }, { v: 'NE', l: '不可评估' }
  ];
  const RT_TYPES = [
    { v: 'EBRT', l: '外照射 EBRT' }, { v: 'SBRT', l: 'SBRT' },
    { v: 'brachy', l: '近距离放疗' }, { v: 'other', l: '其他' }
  ];
  const RT_TARGETS = [
    { v: 'prostate', l: '前列腺' }, { v: 'pelvis', l: '盆腔' },
    { v: 'prostate_pelvis', l: '前列腺+盆腔' }, { v: 'metastasis', l: '转移灶' },
    { v: 'other', l: '其他' }
  ];
  const OUTCOME_TYPES = [
    { v: 'BCR', l: '生化复发' }, { v: 'CRPC', l: '去势抵抗' },
    { v: 'metastasis', l: '转移' }, { v: 'death', l: '死亡' }, { v: 'lost', l: '失访' }
  ];
  const BCR_SUBTYPES = [
    { v: 'persistence', l: '术后持续可测' }, { v: 'recurrence', l: '复发' }
  ];
  const CRPC_SUBTYPES = [
    { v: 'nmCRPC', l: 'nmCRPC' }, { v: 'mCRPC', l: 'mCRPC' }
  ];
  const DEATH_CAUSES = [
    { v: 'prostate_cancer', l: '前列腺癌' }, { v: 'other', l: '其他原因' },
    { v: 'unknown', l: '不明' }
  ];
  const SAMPLE_TYPES = [
    { v: 'tissue_biopsy', l: '穿刺组织' }, { v: 'tissue_RP', l: 'RP 组织' },
    { v: 'tissue_TURP', l: 'TURP 组织' }, { v: 'tissue_metastasis', l: '转移灶组织' },
    { v: 'blood', l: '血液' }, { v: 'urine', l: '尿液' },
    { v: 'ctDNA', l: 'ctDNA' }, { v: 'other', l: '其他' }
  ];
  const TIMEPOINTS = [
    { v: 'diagnosis', l: '诊断时' }, { v: 'preop', l: '术前' },
    { v: 'postop', l: '术后' }, { v: 'BCR', l: '生化复发时' },
    { v: 'metastasis', l: '转移时' }, { v: 'progression', l: '进展时' },
    { v: 'other', l: '其他' }
  ];
  const TREATMENT_STATUS = [
    { v: 'naive', l: '未治疗' }, { v: 'ADT', l: 'ADT' }, { v: 'ARPI', l: 'ARPI' },
    { v: 'chemo', l: '化疗' }, { v: 'PARP', l: 'PARP' }, { v: 'RT', l: '放疗' },
    { v: 'other', l: '其他' }
  ];
  const STORAGE = [
    { v: 'FFPE', l: 'FFPE' }, { v: 'fresh_frozen', l: '新鲜冷冻' },
    { v: 'RNAlater', l: 'RNAlater' }, { v: 'other', l: '其他' }
  ];
  const IHC_MARKERS = [
    'PTEN', 'ERG', 'AR', 'PSMA', 'KI67', 'SYN', 'CGA', 'CD56',
    'P53', 'RB1', 'MSH2', 'MSH6', 'PMS2', 'MLH1', 'PDL1'
  ];
  const IHC_RESULTS = [
    { v: 'positive', l: '阳性' }, { v: 'negative', l: '阴性' },
    { v: 'lost', l: '缺失' }, { v: 'retained', l: '保留' },
    { v: 'equivocal', l: '不确定' }, { v: 'not_done', l: '未做' }
  ];
  /* P2-16：IHC 染色强度；历史值可能是 weak/moderate/strong，也可能是 1+/2+/3+ */
  const IHC_INTENSITY = [
    { v: '', l: '未填' }, { v: 'weak', l: '弱' }, { v: 'moderate', l: '中' },
    { v: 'strong', l: '强' }, { v: '1+', l: '1+' }, { v: '2+', l: '2+' },
    { v: '3+', l: '3+' }, { v: 'unknown', l: '未知' }
  ];
  /* P2-16：分子状态；不强制，允许空白。 */
  const MOLECULAR_STATUS = [
    { v: '', l: '未填' }, { v: 'mutated', l: '突变' }, { v: 'wildtype', l: '野生型' },
    { v: 'loss', l: '缺失' }, { v: 'retained', l: '保留' },
    { v: 'amplified', l: '扩增' }, { v: 'deleted', l: '缺失/删除' },
    { v: 'unknown', l: '未知' }
  ];
  const GENES = ['BRCA1', 'BRCA2', 'ATM', 'PALB2', 'CHEK2', 'CDK12', 'FANCA', 'MSH2', 'MSH6', 'PMS2', 'MLH1'];
  const HRR_STATUS = [
    { v: '', l: '未评估' }, { v: 'pathogenic', l: '致病/可能致病' },
    { v: 'VUS', l: '意义未明' }, { v: 'negative', l: '阴性' }, { v: 'unknown', l: '未知' }
  ];
  const MSI_STATUS = [
    { v: '', l: '未评估' }, { v: 'MSI-H', l: 'MSI-H' },
    { v: 'MSS', l: 'MSS' }, { v: 'unknown', l: '未知' }
  ];
  const TRI = [{ v: '', l: '未评估' }, { v: '0', l: '否' }, { v: '1', l: '是' }];

  const values = list => list.map(x => x.v);
  const labelOf = (list, v) => (list.find(x => x.v === v) || {}).l || v || '';

  /* ---------- 基础工具 ---------- */
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isDate(v) {
    const s = String(v || '');
    if (!DATE_RE.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function clean(v, max) {
    return String(v == null ? '' : v).trim().slice(0, max || 200);
  }
  function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function intOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  }
  function tri(v) {
    if (v === '' || v === null || v === undefined) return null;
    if (v === true || v === 1 || v === '1') return 1;
    if (v === false || v === 0 || v === '0') return 0;
    return null;
  }
  function listText(v) {
    if (Array.isArray(v)) return v.map(x => clean(x, 30)).filter(Boolean).join(',');
    return clean(v, 120);
  }
  function listArr(v) {
    if (Array.isArray(v)) return v.map(x => clean(x, 30)).filter(Boolean);
    return String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  }
  function enumOk(list, v) { return list.includes(String(v || '')); }
  /* 转移部位别名归一化：中文/大小写统一成标准 code，未知值报错而不是静默丢掉。 */
  function normalizeMetSites(v) {
    const alias = {
      bone: 'bone', '骨': 'bone', '骨骼': 'bone', '骨转移': 'bone',
      lymph_node: 'lymph_node', '淋巴结': 'lymph_node', '淋巴': 'lymph_node', '淋巴结转移': 'lymph_node',
      visceral: 'visceral', '内脏': 'visceral', '肝': 'visceral', '肺': 'visceral', '内脏转移': 'visceral',
      other: 'other', '其他': 'other'
    };
    const raw = listArr(v);
    const out = [];
    for (const x of raw) {
      const code = alias[x] || alias[String(x).toLowerCase()];
      if (!code || !enumOk(values(MET_SITES), code)) {
        return err('转移部位只接受 bone/lymph_node/visceral/other（或中文：骨/淋巴结/内脏/其他）');
      }
      if (!out.includes(code)) out.push(code);
    }
    return ok(out);
  }

  /* ---------- Gleason / ISUP ---------- */
  function parseGleason(g) {
    const m = String(g || '').match(/^(\d)\s*\+\s*(\d)(?:\s*=\s*(\d+))?$/);
    if (!m) return null;
    const primary = +m[1], secondary = +m[2];
    const total = m[3] ? +m[3] : primary + secondary;
    if (primary < 1 || primary > 5 || secondary < 1 || secondary > 5) return null;
    if (total !== primary + secondary) return null;
    return { primary, secondary, total };
  }
  function formatGleason(primary, secondary) {
    const p = intOrNull(primary), s = intOrNull(secondary);
    if (p == null || s == null) return '';
    return p + '+' + s + '=' + (p + s);
  }
  function isupFromGleason(g) {
    const m = String(g || '').match(/^(\d)\s*\+\s*(\d)/);
    if (m) {
      const a = +m[1], b = +m[2], total = a + b;
      if (total <= 6) return 1;
      if (total === 7) return a === 3 ? 2 : 3;
      if (total === 8) return 4;
      if (total >= 9) return 5;
      return null;
    }
    const n = Number(g);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  }
  function positiveCorePct(total, positive) {
    const t = intOrNull(total), p = intOrNull(positive);
    if (t == null || p == null || t <= 0) return null;
    return Math.round((p / t) * 1000) / 10;
  }

  /* ---------- 前列腺体积 / PSAD ----------
     椭球体积按临床惯用系数 0.52（π/6≈0.5236 取 0.52），三径单位 cm、体积 ml。
     体积与 PSAD 都是派生值：PSAD 不落库，按“检查日期之前最近一条 PSA”现算，
     这样医生事后更正 PSA，比值会同步更新，不会留下一个与记录矛盾的旧快照。 */
  const PROSTATE_VOLUME_FACTOR = 0.52;
  function prostateVolumeFromDims(transverse, ap, cranial) {
    const a = numOrNull(transverse), b = numOrNull(ap), c = numOrNull(cranial);
    if (a == null || b == null || c == null) return null;
    if (!(a > 0) || !(b > 0) || !(c > 0)) return null;
    return Math.round(PROSTATE_VOLUME_FACTOR * a * b * c * 10) / 10;
  }
  /* 最近的“既往” PSA：日期 <= 检查日；同日多条取最后录入的一条（数组按日期升序，稳定取后者）。
     低于检测下限的记录按其实测下限值参与计算，由调用方在展示时标注 "<LOD"。 */
  function nearestPsaBefore(psaList, date) {
    const d = String(date || '').slice(0, 10);
    if (!isDate(d)) return null;
    let best = null;
    (psaList || []).forEach((x, i) => {
      if (!x || !isDate(String(x.date || '').slice(0, 10))) return;
      if (String(x.date).slice(0, 10) > d) return;
      if (!best || String(x.date).slice(0, 10) >= String(best.rec.date).slice(0, 10)) {
        best = { rec: x, idx: i };
      }
    });
    return best ? best.rec : null;
  }
  function psadOf(psaList, studyDate, volumeMl) {
    const v = numOrNull(volumeMl);
    if (v == null || v <= 0) return null;
    const rec = nearestPsaBefore(psaList, studyDate);
    if (!rec) return null;
    const psa = numOrNull(rec.val != null ? rec.val : rec.value);
    if (psa == null) return null;
    return {
      psad: Math.round((psa / v) * 100) / 100,
      psa: psa,
      psaDate: String(rec.date).slice(0, 10),
      belowLod: !!rec.belowLod
    };
  }

  /* ---------- 记录选择 ---------- */
  function byDateDesc(a, b) {
    return String(b.reportDate || b.studyDate || b.testDate || b.startDate || b.eventDate || '')
      .localeCompare(String(a.reportDate || a.studyDate || a.testDate || a.startDate || a.eventDate || ''));
  }
  function primaryPathology(p) {
    const arr = (p && p.pathologyReports) || [];
    return arr.find(x => !!x.isPrimary) || arr.slice().sort(byDateDesc)[0] || null;
  }
  function latestImaging(p) {
    /* P2-05：详情摘要优先用医生标记的“本周期影像（isCurrent）”。
       后补的局部 mpMRI 不能盖住此前 PSMA 已证实的骨转移摘要。 */
    const arr = (p && p.imagingStudies) || [];
    return arr.find(x => !!x.isCurrent) || arr.slice().sort(byDateDesc)[0] || null;
  }
  function activeTreatmentLine(p, today) {
    const d = today || new Date().toISOString().slice(0, 10);
    const arr = ((p && p.treatmentLines) || []).slice().sort((a, b) =>
      (a.lineNo || 0) - (b.lineNo || 0) || String(a.startDate || '').localeCompare(String(b.startDate || '')));
    const active = arr.filter(x => x.startDate <= d && (!x.endDate || x.endDate >= d));
    return active[active.length - 1] || arr[arr.length - 1] || null;
  }
  function outcomeOf(p, type) {
    return ((p && p.outcomes) || []).find(x => x.outcomeType === type) || null;
  }
  function latestOutcome(p, type) {
    return ((p && p.outcomes) || [])
      .filter(x => !type || x.outcomeType === type)
      .slice().sort(byDateDesc)[0] || null;
  }

  /* ---------- 摘要 ---------- */
  function join(parts, sep) {
    return parts.filter(x => x !== '' && x !== null && x !== undefined).join(sep || ' · ');
  }
  function pathologySummary(rec) {
    if (!rec) return '';
    const parts = [];
    const g = formatGleason(rec.gleasonPrimary, rec.gleasonSecondary);
    if (g) parts.push('G ' + g);
    if (rec.isup) parts.push('ISUP ' + rec.isup);
    if (rec.histologyType && rec.histologyType !== 'acinar') parts.push(labelOf(HISTOLOGY_TYPES, rec.histologyType));
    if (rec.ptnm) parts.push(rec.ptnm);
    if (rec.marginStatus && rec.marginStatus !== 'unknown') parts.push('切缘' + labelOf(MARGIN_STATUS, rec.marginStatus) + (rec.marginSite ? '(' + rec.marginSite + ')' : ''));
    if (rec.ece != null) parts.push('ECE' + (rec.ece ? '+' : '-'));
    if (rec.svi != null) parts.push('SVI' + (rec.svi ? '+' : '-'));
    if (rec.lnExamined != null) parts.push('LN ' + (rec.lnPositive || 0) + '/' + rec.lnExamined);
    if (rec.nepc) parts.push('NEPC');
    if (rec.idcP) parts.push('IDC-P');
    if (rec.coresTotal != null) parts.push('穿刺 ' + (rec.coresPositive || 0) + '/' + rec.coresTotal);
    return join(parts, ' · ');
  }
  function imagingSummary(rec) {
    if (!rec) return '';
    const parts = [];
    if (rec.modality) parts.push(labelOf(IMAGING_MODALITIES, rec.modality));
    if (rec.pirads != null) parts.push('PI-RADS ' + rec.pirads);
    if (rec.indexLocation) parts.push(rec.indexLocation + (rec.indexSizeMm != null ? ' ' + rec.indexSizeMm + 'mm' : ''));
    if (rec.psmaPositive != null) parts.push('PSMA' + (rec.psmaPositive ? '+' : '-'));
    if (rec.psmaSuvmax != null) parts.push('SUVmax ' + rec.psmaSuvmax);
    if (rec.psmaLesionCount != null) parts.push('PSMA灶 ' + rec.psmaLesionCount);
    if (rec.miTnm) parts.push(rec.miTnm);
    if (rec.lesionCount != null) parts.push('病灶 ' + rec.lesionCount);
    if (rec.superscan) parts.push('超级骨显像');
    if (rec.lungNoduleCount != null || rec.lungNoduleMaxMm != null) {
      parts.push('肺结节 ' + (rec.lungNoduleCount != null ? rec.lungNoduleCount + ' 个' : '未计数') +
        (rec.lungNoduleMaxMm != null ? '（最大 ' + rec.lungNoduleMaxMm + 'mm）' : ''));
    }
    const sites = listArr(rec.metastaticSites).map(x => labelOf(MET_SITES, x));
    if (sites.length) parts.push(sites.join('/'));
    if (rec.recist) parts.push('RECIST ' + rec.recist);
    if (rec.comparison) parts.push(labelOf(IMAGING_COMPARISON, rec.comparison));
    if (rec.oligoStatus) parts.push(labelOf([{ v: 'none', l: '无转移' }, { v: 'oligo', l: '寡转移' }, { v: 'widespread', l: '广泛转移' }, { v: 'unknown', l: '负荷未评估' }], rec.oligoStatus));
    return join(parts, ' · ');
  }
  function treatmentSummary(line) {
    if (!line) return '';
    const parts = ['第' + line.lineNo + '线'];
    if (line.setting) parts.push(line.setting);
    if (line.regimen) parts.push(line.regimen);
    if (line.startDate) parts.push(line.startDate + '→' + (line.endDate || '至今'));
    if (line.responseCode || line.response) parts.push('疗效 ' + (line.responseCode || line.response));
    return join(parts, ' · ');
  }
  function outcomeSummary(rec) {
    if (!rec) return '';
    const parts = [labelOf(OUTCOME_TYPES, rec.outcomeType)];
    if (rec.eventDate) parts.push(rec.eventDate);
    if (rec.subtype) parts.push(labelOf(rec.outcomeType === 'BCR' ? BCR_SUBTYPES : CRPC_SUBTYPES, rec.subtype));
    if (rec.basis) parts.push('依据 ' + rec.basis);
    if (rec.psaValue != null) parts.push('PSA ' + rec.psaValue);
    const sites = listArr(rec.metastaticSites).map(x => labelOf(MET_SITES, x));
    if (sites.length) parts.push(sites.join('/'));
    if (rec.deathCause) parts.push(labelOf(DEATH_CAUSES, rec.deathCause));
    if (rec.lostReason) parts.push(rec.lostReason);
    return join(parts, ' · ');
  }
  function specimenSummary(rec) {
    if (!rec) return '';
    return join([
      labelOf(SAMPLE_TYPES, rec.sampleType),
      rec.collectionDate,
      labelOf(TIMEPOINTS, rec.timepoint),
      rec.tumorCellPct != null ? '肿瘤细胞 ' + rec.tumorCellPct + '%' : '',
      rec.biobankId ? '库号 ' + rec.biobankId : ''
    ], ' · ');
  }
  function genomicSummary(rec) {
    if (!rec) return '';
    return join([
      rec.testType === 'germline' ? '胚系' : (rec.testType === 'somatic' ? '体系' : ''),
      rec.testDate,
      rec.genes,
      rec.hrrStatus ? 'HRR ' + labelOf(HRR_STATUS, rec.hrrStatus) : '',
      rec.msiStatus ? rec.msiStatus : '',
      rec.tmbValue != null ? 'TMB ' + rec.tmbValue : ''
    ], ' · ');
  }
  function ihcSummary(rec) {
    if (!rec) return '';
    return join([
      rec.marker,
      labelOf(IHC_RESULTS, rec.result),
      rec.percent != null ? rec.percent + '%' : '',
      rec.intensity || ''
    ], ' · ');
  }

  /* ---------- 校验 ---------- */
  function err(message) { return { error: message, value: null }; }
  function ok(value) { return { error: null, value }; }

  function validatePathology(data) {
    const d = data || {};
    const specimenType = clean(d.specimenType, 20) || 'unknown';
    if (!enumOk(values(SPECIMEN_TYPES), specimenType)) return err('请选择有效的标本类型');
    const reportDate = clean(d.reportDate, 10);
    if (!isDate(reportDate)) return err('病理日期格式应为 YYYY-MM-DD');
    const gp = intOrNull(d.gleasonPrimary), gs = intOrNull(d.gleasonSecondary);
    if ((gp == null) !== (gs == null)) return err('Gleason 原发/次要分型必须同时填写或同时留空');
    if (gp != null && (gp < 1 || gp > 5 || gs < 1 || gs > 5)) return err('Gleason 分型必须为 1–5');
    const gleasonTotal = gp != null ? gp + gs : null;
    const isup = gleasonTotal != null ? isupFromGleason(gp + '+' + gs) : null;
    const coresTotal = intOrNull(d.coresTotal);
    const coresPositive = intOrNull(d.coresPositive);
    if (coresTotal != null && coresTotal < 0) return err('穿刺总针数不能为负');
    if (coresPositive != null && coresPositive < 0) return err('阳性针数不能为负');
    if (coresTotal != null && coresPositive != null && coresPositive > coresTotal) return err('阳性针数不能大于总针数');
    const coresPositivePct = positiveCorePct(coresTotal, coresPositive);
    const marginStatus = clean(d.marginStatus, 20) || 'unknown';
    if (!enumOk(values(MARGIN_STATUS), marginStatus)) return err('切缘状态不合法');
    const lnPositive = intOrNull(d.lnPositive);
    const lnExamined = intOrNull(d.lnExamined);
    if (lnPositive != null && lnPositive < 0) return err('淋巴结阳性数不能为负');
    if (lnExamined != null && lnExamined < 0) return err('淋巴结检查数不能为负');
    if (lnPositive != null && lnExamined != null && lnPositive > lnExamined) return err('淋巴结阳性数不能大于检查数');
    const pct = v => {
      const n = numOrNull(v);
      if (n == null) return null;
      return Math.max(0, Math.min(100, n));
    };
    const isBiopsy = specimenType === 'biopsy';
    const isResection = specimenType === 'RP' || specimenType === 'TURP';
    const histologyType = clean(d.histologyType, 20);
    if (histologyType && !enumOk(values(HISTOLOGY_TYPES), histologyType)) return err('组织学类型不合法');
    const biopsyRoute = clean(d.biopsyRoute, 20);
    if (biopsyRoute && !enumOk(values(BIOPSY_ROUTES), biopsyRoute)) return err('穿刺路径不合法');
    const biopsyGuidance = clean(d.biopsyGuidance, 20);
    if (biopsyGuidance && !enumOk(values(BIOPSY_GUIDANCE), biopsyGuidance)) return err('穿刺引导方式不合法');
    return ok({
      specimenType, reportDate,
      coresTotal: isBiopsy || specimenType === 'unknown' ? coresTotal : null,
      coresPositive: isBiopsy || specimenType === 'unknown' ? coresPositive : null,
      coresPositivePct: isBiopsy || specimenType === 'unknown' ? coresPositivePct : null,
      coresMaxCancerPct: isBiopsy ? pct(d.coresMaxCancerPct) : null,
      gleasonPrimary: gp, gleasonSecondary: gs, gleasonTotal, isup,
      ptnm: isResection ? clean(d.ptnm, 20) : '',
      marginStatus: isResection ? marginStatus : 'unknown',
      marginSite: isResection ? clean(d.marginSite, 80) : '',
      ece: isResection ? tri(d.ece) : null,
      svi: isResection ? tri(d.svi) : null,
      lnPositive: isResection ? lnPositive : null,
      lnExamined: isResection ? lnExamined : null,
      idcP: tri(d.idcP), cribriform: tri(d.cribriform), dac: tri(d.dac),
      nepc: tri(d.nepc), nepcDetail: clean(d.nepcDetail, 200), pni: tri(d.pni),
      tumorVolumePct: pct(d.tumorVolumePct), tumorCellPct: pct(d.tumorCellPct),
      histologyType, specimenSite: clean(d.specimenSite, 80),
      biopsyRoute: isBiopsy ? biopsyRoute : '',
      biopsyGuidance: isBiopsy ? biopsyGuidance : '',
      isPrimary: tri(d.isPrimary) === 1 ? 1 : 0,
      notes: clean(d.notes, 1000)
    });
  }

  function validateImaging(data) {
    const d = data || {};
    const modality = clean(d.modality, 20);
    if (!enumOk(values(IMAGING_MODALITIES), modality)) return err('请选择有效的影像模态');
    const studyDate = clean(d.studyDate, 10);
    if (!isDate(studyDate)) return err('影像日期格式应为 YYYY-MM-DD');
    const lesionCount = intOrNull(d.lesionCount);
    if (lesionCount != null && lesionCount < 0) return err('病灶数不能为负');
    const pirads = intOrNull(d.pirads);
    if (pirads != null && (pirads < 1 || pirads > 5)) return err('PI-RADS 必须为 1–5');
    const suv = numOrNull(d.psmaSuvmax);
    if (suv != null && suv < 0) return err('SUVmax 不能为负');
    const siteCheck = normalizeMetSites(d.metastaticSites);
    if (siteCheck.error) return err(siteCheck.error);
    const sites = siteCheck.value;
    const recist = clean(d.recist, 10);
    if (!enumOk(values(RECIST), recist)) return err('RECIST 取值不合法');
    const pcwg = clean(d.pcwg, 30);
    if (!enumOk(values(PCWG), pcwg)) return err('PCWG 取值不合法');
    const oligo = clean(d.oligoStatus, 20);
    if (oligo && !['none', 'oligo', 'widespread', 'unknown'].includes(oligo)) return err('寡转移状态不合法');
    const comparison = clean(d.comparison, 20);
    if (comparison && !enumOk(values(IMAGING_COMPARISON), comparison)) return err('与旧片比较的取值不合法');
    const psmaRads = clean(d.psmaRads, 10);
    if (psmaRads && !enumOk(values(PSMA_RADS), psmaRads)) return err('PSMA-RADS 必须为 1–5');
    const num = (v, label) => {
      const n = numOrNull(v);
      if (n != null && n < 0) throw new Error(label + '不能为负');
      return n;
    };
    let indexSizeMm, prostateVolumeMl, lnShortAxisMm, lungNoduleMaxMm;
    try {
      indexSizeMm = num(d.indexSizeMm, '主病灶最大径');
      prostateVolumeMl = num(d.prostateVolumeMl, '前列腺体积');
      lnShortAxisMm = num(d.lnShortAxisMm, '淋巴结短径');
      lungNoduleMaxMm = num(d.lungNoduleMaxMm, '肺结节最大径');
    } catch (e) { return err(e.message); }
    const lungNoduleCount = intOrNull(d.lungNoduleCount);
    if (lungNoduleCount != null && lungNoduleCount < 0) return err('肺结节数不能为负');
    /* 三径：要么全空、要么齐全；齐全时重算体积（与服务端同一公式） */
    const dimVals = [d.dimTransverseCm, d.dimApCm, d.dimCranialCm].map(v => numOrNull(v));
    const dimGiven = dimVals.filter(v => v != null).length;
    if (dimGiven > 0 && dimGiven < 3) return err('前列腺三径（横径/前后径/上下径）需同时填写，或全部留空');
    if (dimGiven === 3 && dimVals.some(v => !(v > 0) || v > 15)) return err('前列腺三径应在 0–15 cm 之间');
    const volumeFromDims = dimGiven === 3 ? prostateVolumeFromDims(dimVals[0], dimVals[1], dimVals[2]) : null;
    return ok({
      modality, studyDate, region: clean(d.region, 80),
      lesionCount, metastaticSites: sites.join(','),
      extraPelvic: tri(d.extraPelvic), newLesion: tri(d.newLesion),
      pirads, psmaPositive: tri(d.psmaPositive), psmaSuvmax: suv,
      psmaLesionCount: intOrNull(d.psmaLesionCount),
      recist, pcwg, flare: tri(d.flare), oligoStatus: oligo,
      technique: clean(d.technique, 120), indexLocation: clean(d.indexLocation, 120),
      indexSizeMm, ece: tri(d.ece), svi: tri(d.svi),
      prostateVolumeMl: volumeFromDims != null ? volumeFromDims : prostateVolumeMl,
      dimTransverseCm: dimVals[0], dimApCm: dimVals[1], dimCranialCm: dimVals[2],
      lnShortAxisMm, superscan: tri(d.superscan), lungNoduleCount, lungNoduleMaxMm,
      miTnm: clean(d.miTnm, 40), psmaRads,
      changedManagement: (modality === 'PSMA_PET' || modality === 'PSMA_PET_MRI') ? tri(d.changedManagement) : null,
      comparison,
      isCurrent: tri(d.isCurrent) === 1 ? 1 : 0,
      notes: clean(d.notes, 1000)
    });
  }

  function validateRadiation(data) {
    const d = data || {};
    const rtType = clean(d.rtType, 20);
    if (!enumOk(values(RT_TYPES), rtType)) return err('请选择有效的放疗类型');
    const startDate = clean(d.startDate, 10);
    if (!isDate(startDate)) return err('放疗开始日期格式应为 YYYY-MM-DD');
    const endDate = clean(d.endDate, 10);
    if (endDate && !isDate(endDate)) return err('放疗结束日期格式应为 YYYY-MM-DD');
    if (endDate && endDate < startDate) return err('放疗结束日期不能早于开始日期');
    const doseGy = numOrNull(d.doseGy);
    if (doseGy != null && doseGy <= 0) return err('放疗剂量必须大于 0');
    const fractions = intOrNull(d.fractions);
    if (fractions != null && fractions <= 0) return err('分割次数必须为正整数');
    const target = clean(d.target, 30);
    if (target && !enumOk(values(RT_TARGETS), target)) return err('放疗靶区不合法');
    const adtMonths = numOrNull(d.adtDurationMonths);
    if (adtMonths != null && adtMonths < 0) return err('ADT 时长不能为负');
    return ok({
      rtType, startDate, endDate, doseGy, fractions,
      target, concurrentAdt: tri(d.concurrentAdt), adtDurationMonths: adtMonths,
      technique: clean(d.technique, 80), toxicityGrade: clean(d.toxicityGrade, 20),
      isCurrent: tri(d.isCurrent) === 1 ? 1 : 0,
      notes: clean(d.notes, 1000)
    });
  }

  function validateOutcome(data) {
    const d = data || {};
    const outcomeType = clean(d.outcomeType, 20);
    if (!enumOk(values(OUTCOME_TYPES), outcomeType)) return err('请选择有效的结局类型');
    const eventDate = clean(d.eventDate, 10);
    if (!isDate(eventDate)) return err('结局日期格式应为 YYYY-MM-DD');
    const psaValue = numOrNull(d.psaValue);
    if (psaValue != null && psaValue < 0) return err('PSA 值不能为负');
    const lesionCount = intOrNull(d.lesionCount);
    if (lesionCount != null && lesionCount < 0) return err('病灶数不能为负');
    const lastContactDate = clean(d.lastContactDate, 10);
    if (lastContactDate && !isDate(lastContactDate)) return err('末次接触日期格式应为 YYYY-MM-DD');
    if (outcomeType === 'lost' && !lastContactDate) return err('失访结局必须填写末次接触日期（生存分析删失）');
    const subtype = clean(d.subtype, 30);
    if (outcomeType === 'BCR' && subtype && !enumOk(values(BCR_SUBTYPES), subtype)) return err('BCR 类型不合法');
    if (outcomeType === 'CRPC' && subtype && !enumOk(values(CRPC_SUBTYPES), subtype)) return err('CRPC 类型不合法');
    const deathCause = clean(d.deathCause, 30);
    if (outcomeType === 'death' && deathCause && !enumOk(values(DEATH_CAUSES), deathCause)) return err('死亡原因不合法');
    const outcomeSites = normalizeMetSites(d.metastaticSites);
    if (outcomeSites.error) return err(outcomeSites.error);
    return ok({
      outcomeType, eventDate, subtype,
      basis: clean(d.basis, 20), psaValue, imagingNegative: tri(d.imagingNegative),
      metastaticSites: outcomeSites.value.join(','),
      lesionCount,
      oligoStatus: clean(d.oligoStatus, 20),
      deathCause: outcomeType === 'death' ? deathCause : '',
      lostReason: outcomeType === 'lost' ? clean(d.lostReason, 200) : '',
      lastContactDate: outcomeType === 'lost' ? lastContactDate : '',
      note: clean(d.note, 1000)
    });
  }

  function validateSpecimen(data) {
    const d = data || {};
    const sampleType = clean(d.sampleType, 30);
    if (!enumOk(values(SAMPLE_TYPES), sampleType)) return err('请选择有效的样本类型');
    const collectionDate = clean(d.collectionDate, 10);
    if (!isDate(collectionDate)) return err('采样日期格式应为 YYYY-MM-DD');
    const timepoint = clean(d.timepoint, 20);
    if (timepoint && !enumOk(values(TIMEPOINTS), timepoint)) return err('采样时点不合法');
    const treatmentStatus = clean(d.treatmentStatus, 20);
    if (treatmentStatus && !enumOk(values(TREATMENT_STATUS), treatmentStatus)) return err('采样时治疗状态不合法');
    const storage = clean(d.storage, 20);
    if (storage && !enumOk(values(STORAGE), storage)) return err('保存方式不合法');
    const tumorCellPct = numOrNull(d.tumorCellPct);
    if (tumorCellPct != null && (tumorCellPct < 0 || tumorCellPct > 100)) return err('肿瘤细胞含量应为 0–100%');
    return ok({
      sampleType, collectionDate, timepoint, treatmentStatus, storage,
      tumorCellPct, nucleicQuality: clean(d.nucleicQuality, 60),
      libraryId: clean(d.libraryId, 60), biobankId: clean(d.biobankId, 60),
      notes: clean(d.notes, 1000)
    });
  }

  function validateGenomic(data) {
    const d = data || {};
    const testType = clean(d.testType, 20);
    if (!['germline', 'somatic'].includes(testType)) return err('检测类型只能是胚系或体系');
    const testDate = clean(d.testDate, 10);
    if (!isDate(testDate)) return err('检测日期格式应为 YYYY-MM-DD');
    const hrr = clean(d.hrrStatus, 30);
    if (hrr && !enumOk(values(HRR_STATUS), hrr)) return err('HRR 状态不合法');
    const msi = clean(d.msiStatus, 20);
    if (msi && !enumOk(values(MSI_STATUS), msi)) return err('MSI 状态不合法');
    const tmb = numOrNull(d.tmbValue);
    if (tmb != null && tmb < 0) return err('TMB 不能为负');
    return ok({
      testType, testDate, lab: clean(d.lab, 60), platform: clean(d.platform, 60),
      genes: listArr(d.genes).join(','),
      hrrStatus: hrr, msiStatus: msi, tmbValue: tmb,
      arStatus: clean(d.arStatus, 30), tp53Status: clean(d.tp53Status, 30),
      ptenStatus: clean(d.ptenStatus, 30), rb1Status: clean(d.rb1Status, 30),
      resultSummary: clean(d.resultSummary, 1000), notes: clean(d.notes, 1000)
    });
  }

  function validateIhc(data) {
    const d = data || {};
    const marker = clean(d.marker, 20);
    if (!IHC_MARKERS.includes(marker)) return err('请选择有效的 IHC 标志物');
    const result = clean(d.result, 20);
    if (!enumOk(values(IHC_RESULTS), result)) return err('IHC 结果不合法');
    const percent = numOrNull(d.percent);
    if (percent != null && (percent < 0 || percent > 100)) return err('IHC 阳性百分比应为 0–100%');
    const testDate = clean(d.testDate, 10);
    if (testDate && !isDate(testDate)) return err('IHC 检测日期格式应为 YYYY-MM-DD');
    return ok({
      marker, result, percent, intensity: clean(d.intensity, 20),
      testDate, lab: clean(d.lab, 60), notes: clean(d.notes, 1000)
    });
  }

  /* ---------- 核心字段完整度 ---------- */
  function completeness(p) {
    const missing = [];
    let total = 0, done = 0;
    const check = (key, label, ok, applicable) => {
      if (applicable === false) return;
      total++;
      if (ok) done++;
      else missing.push({ key, label });
    };
    const path = primaryPathology(p);
    const hasPath = !!(path || p.pathologicStage);
    const hasBiopsy = !!(path && path.specimenType === 'biopsy') || !!(p.pathologyReports || []).some(x => x.specimenType === 'biopsy');
    const hasResearch = !!((p.specimens || []).length || (p.genomicTests || []).length || (p.ihcResults || []).length);

    check('birth', '出生日期', !!p.birth);
    check('diagDate', '诊断日期', !!p.date);
    check('initialPsa', '诊断时 PSA', (p.psa || []).some(x => x.isInitial || x.is_initial) || !!(p.psa || []).length);
    check('clinicalStage', '临床分期 cTNM', !!(p.clinicalStage || '').trim());
    check('gleason', 'Gleason 原/次分型', !!parseGleason(p.gleason) || !!(path && path.gleasonPrimary != null));
    check('biopsyCores', '穿刺阳性针数/总针数', !!(path && path.coresTotal != null && path.coresPositive != null), hasBiopsy);
    check('specimenType', '病理标本类型', !!(path && path.specimenType), hasPath);
    check('margins', '切缘状态', !!(path && path.marginStatus && path.marginStatus !== 'unknown'), hasPath);
    check('ece', '包膜外侵犯 ECE', !!(path && path.ece != null), hasPath);
    check('svi', '精囊侵犯 SVI', !!(path && path.svi != null), hasPath);
    check('ln', '淋巴结阳性/总数', !!(path && path.lnExamined != null), hasPath && !!(path && ['RP', 'TURP'].includes(path.specimenType)));
    check('treatmentLine', '治疗线', (p.treatmentLines || []).length > 0 ||
      (p.medications || []).some(m => m && ['adt', 'arpi', 'endocrine'].includes(m.category)) || !!p.treatment);
    check('lastFollowup', '末次随访日期', !!(p.lastFollowupDate || p.last_followup_date));
    const surgDate = p.surgDate || ((p.events || []).find(e => e && e.isSurgery) || {}).date || null;
    const dayDiff = (a, b) => {
      const ta = Date.parse(a + 'T00:00:00Z'), tb = Date.parse(b + 'T00:00:00Z');
      return (isNaN(ta) || isNaN(tb)) ? null : Math.round((tb - ta) / 86400000);
    };
    const windowPsa = surgDate ? (p.psa || []).find(x => {
      const d = dayDiff(surgDate, x.date);
      return d != null && d >= 42 && d <= 90;
    }) : null;
    check('postopWindowPsa', '术后 6–12 周 PSA', !!windowPsa, !!surgDate && p.followupStatus !== '死亡' && p.followupStatus !== '失访');
    const terminal = p.followupStatus === '死亡' || p.followupStatus === '失访';
    check('outcome', '结局日期', terminal || (p.outcomes || []).length > 0 || !!(p.disease && p.disease.code && p.disease.code !== 'stable'), !!(p.outcomes || []).length || terminal);
    check('specimen', '科研样本', !!(p.specimens || []).length, hasResearch);
    check('tumorCell', '肿瘤细胞含量', !!(p.specimens || []).some(x => x.tumorCellPct != null), hasResearch);
    check('biobank', '生物样本库编号', !!(p.specimens || []).some(x => x.biobankId), hasResearch);
    check('ihc', 'IHC 结果', (p.ihcResults || []).length > 0, hasResearch);
    check('genomic', '胚系/体系检测', (p.genomicTests || []).length > 0, hasResearch);
    return { pct: total ? Math.round((done / total) * 100) : 0, done, total, missing };
  }

  return {
    SPECIMEN_TYPES, MARGIN_STATUS, IMAGING_MODALITIES, MET_SITES, RECIST, PCWG,
    IMAGING_COMPARISON, PSMA_RADS, HISTOLOGY_TYPES, BIOPSY_ROUTES, BIOPSY_GUIDANCE,
    RT_TYPES, RT_TARGETS, OUTCOME_TYPES, BCR_SUBTYPES, CRPC_SUBTYPES, DEATH_CAUSES,
    SAMPLE_TYPES, TIMEPOINTS, TREATMENT_STATUS, STORAGE, IHC_MARKERS, IHC_RESULTS,
    IHC_INTENSITY, MOLECULAR_STATUS,
    GENES, HRR_STATUS, MSI_STATUS, TRI,
    labelOf, isDate, parseGleason, formatGleason, isupFromGleason, positiveCorePct, normalizeMetSites,
    PROSTATE_VOLUME_FACTOR, prostateVolumeFromDims, nearestPsaBefore, psadOf,
    primaryPathology, latestImaging, activeTreatmentLine, outcomeOf, latestOutcome,
    pathologySummary, imagingSummary, treatmentSummary, outcomeSummary,
    specimenSummary, genomicSummary, ihcSummary,
    validatePathology, validateImaging, validateRadiation, validateOutcome,
    validateSpecimen, validateGenomic, validateIhc, completeness
  };
});

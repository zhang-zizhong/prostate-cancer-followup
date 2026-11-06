/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * AI 病历登记 — 后端主模块
 *
 * 职责：
 *   1. 建表（ai_intake_sessions / ai_intake_items）与启动恢复
 *   2. /api/ai-intake/* 接口
 *   3. 异步任务队列（并发限流 + 状态持久化）
 *   4. 三段式流水线编排（预处理 → 脱敏 → 结构化）
 *   5. AI 输出的 Schema 校验与风险标注
 *   6. 采纳入库（复用既有校验与镜像事件逻辑）
 *
 * 设计要点（对应技术文档第 8、9 节）：
 *   - 不复用 /api/backup/import：overwrite 会清空全库并删除 uploads 全部图片，
 *     merge 遇到已存在 id 直接跳过、无法给已建档患者追加一次 PSA 复查。
 *   - 采纳走既有单条写入逻辑（含 syncSurgDate、镜像事件、单位换算），
 *     保证不出现两套业务规则。
 *   - labs_records 已废弃：server.js:1026 的启动迁移会把该表数据合并进
 *     「化验/监测」事件备注并清空，因此 AI 抽到的化验项一律写成事件，
 *     绝不写 labs_records，否则服务重启即丢。
 *   - 三态字段（castration/metExtraPelvis/visceralMet/metCount/familyHistory
 *     /ecog/charlson/bmi）：null=未评估，false/0=明确阴性，语义不可互换。
 *     AI 输出 false 但 evidence 缺失时判为高风险，需医生显式确认。
 * ========================================================= */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import {
  PROMPT_VERSION, buildExtractPrompt, ALL_EVENT_TYPES, MIRROR_EVENT_TYPES,
  MED_CATEGORIES, DRUG_ALIAS, DRUG_CATEGORY, PROFILE_FIELDS, TRI_STATE_FIELDS,
  EXCLUDED_FIELDS, TESTO_NGDL_PER_NMOL,
  SMOKING_ENUM, FOLLOWUP_MODE_ENUM, OLIGO_CODES, OLIGO_ALIAS, OLIGO_TYPES
} from './ai-prompt.mjs';
import {
  aiEnabled, aiConfigured, aiStatus, redactText, extractStructured,
  modelSupportsJsonSchema, estimateImageTokens, MAX_IMAGES_PER_CALL
} from './ai-client.mjs';
import { resolveLabItem } from './lab-catalog.mjs';
import { templateByCode } from './guideline-catalog.mjs';
import {
  validateEpisodeInput, validateVisitInput, validateRowInput, validateAdverseEventInput,
  validateSurgeryInput, validateChemoCycleInput, validateComorbidityInput, validateDiseaseStateInput,
  todayIso
} from './visit-rules.mjs';

const MED_CATEGORY_KEYS = new Set(MED_CATEGORIES.map(c => c.key));

/* 三态字段分两类，审查逻辑不同（TRI_STATE_FIELDS 的并集）：
   · 布尔型：false/0 = 明确阴性，必须有原文证据，否则视为把「未提及」误判成「阴性」
   · 数值型：0 是合法值（metCount=0 零转移、ecog=0 体能完好、bmi 不可能为 0），
     只有 null/undefined/'' 才是「未评估」；但 0 仍需证据，因为模型常把
     材料没写转移灶数目直接输出 metCount=0，这等于伪造了一条「无转移」评估。 */
const BOOL_TRI_FIELDS = new Set(['castration', 'metExtraPelvis', 'visceralMet', 'familyHistory']);
const NUM_TRI_FIELDS = new Set(['ecog', 'charlson', 'bmi', 'metCount']);
const OLIGO_SET = new Set(OLIGO_CODES);

/* 主档字段 → 数据库列。审核卡“现有值 vs 材料值”和采纳写库共用这一份映射，
   避免两处各写一份、字段对不上。 */
const PROFILE_COLUMNS = {
  name: 'name', birth: 'birth_date', date: 'diag_date', gleason: 'gleason',
  clinicalStage: 'clinical_stage', pathologicStage: 'pathologic_stage',
  treatment: 'treatment', concomitantMeds: 'concomitant_meds',
  rtEndDate: 'rt_end_date', adtStartDate: 'adt_start_date',
  lastFollowupDate: 'last_followup_date', lastFollowupMode: 'last_followup_mode',
  metCount: 'met_count', oligoType: 'oligo_type',
  familyHistoryDetail: 'family_history_detail',
  ecog: 'ecog', charlson: 'charlson', bmi: 'bmi', smoking: 'smoking',
  castration: 'castration_status', metExtraPelvis: 'met_extra_pelvis',
  visceralMet: 'visceral_met', familyHistory: 'family_history',
  dreResult: 'dre_result', dreNote: 'dre_note', diseaseCategory: 'disease_category'
};
/* 身份字段即使材料里出现不同值，也不允许 AI 自动改名/改生日：
   先核对材料归属，再由医生手工修正。 */
const PROFILE_IDENTITY_FIELDS = new Set(['name', 'birth']);
const SMOKING_LABELS = { never: '从不吸烟', former: '既往吸烟', current: '现吸烟', unknown: '不详' };
const FOLLOWUP_MODE_LABELS = { clinic: '门诊', phone: '电话', external: '线上/外院', hospital: '住院', other: '其他' };
const OLIGO_LABELS = Object.fromEntries(OLIGO_TYPES.map(x => [x.v, x.l]));
/* 新版登记台的手工实体：治疗段/就诊/手术/化疗周期/给药/合并症/疾病状态/AE。
   AI 文本常写中文名；先把治疗段模板与毒性术语归一到服务端字典。 */
const EPISODE_TEMPLATE_ALIAS = {
  '手术': 'RP', '根治性手术': 'RP', '根治性前列腺切除术': 'RP', 'RP': 'RP',
  '放疗': 'RT', '放射治疗': 'RT', '外照射放疗': 'RT', 'EBRT': 'RT', 'RT': 'RT',
  '近距离放疗': 'RT', '粒子植入': 'RT',
  '内分泌治疗': 'ADT', 'ADT': 'ADT', '去势治疗': 'ADT',
  '系统治疗': 'SYSTEMIC', 'ARPI': 'SYSTEMIC', '新型内分泌': 'SYSTEMIC', 'SYSTEMIC': 'SYSTEMIC',
  '化疗': 'CHEMO', 'CHEMO': 'CHEMO', '多西他赛': 'CHEMO', '卡巴他赛': 'CHEMO',
  '主动监测': 'AS', 'AS': 'AS', '观察等待': 'WW', 'WW': 'WW', 'OTHER': '', 'other': ''
};
const EPISODE_TYPE_BY_TEMPLATE = { RP: 'surgery', RT: 'radiotherapy', ADT: 'endocrine', SYSTEMIC: 'systemic', CHEMO: 'chemo', AS: 'surveillance', WW: 'surveillance' };
const EPISODE_INTENT_BY_TEMPLATE = { RP: 'radical', RT: 'radical', ADT: 'palliative', SYSTEMIC: 'palliative', CHEMO: 'palliative', AS: 'active_surveillance', WW: 'watchful_waiting' };
const TOXICITY_ALIAS = {
  '尿失禁':'urinary_incontinence','勃起功能障碍':'erectile_dysfunction','性功能障碍':'erectile_dysfunction',
  '血尿':'hematuria','放射性直肠炎':'proctitis','直肠炎':'proctitis','潮热':'hot_flashes','骨痛':'bone_pain','疼痛':'bone_pain','pain':'bone_pain',
  '代谢综合征':'metabolic_syndrome','认知障碍':'cognitive_impairment','骨质疏松':'osteoporosis',
  '贫血':'anemia','疲乏':'fatigue','乏力':'fatigue','高血压':'hypertension','肝毒性':'liver_toxicity',
  '肝功能异常':'liver_toxicity','皮疹':'rash','恶心':'nausea','呕吐':'vomiting','腹泻':'diarrhea',
  '周围神经病变':'peripheral_neuropathy','神经毒性':'peripheral_neuropathy','骨髓抑制':'myelosuppression',
  '体液潴留':'fluid_retention','水肿':'fluid_retention','过敏反应':'allergy','过敏':'allergy'
};
function normEpisodeTemplate(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  const up = raw.toUpperCase();
  if (EPISODE_TEMPLATE_ALIAS[raw]) return EPISODE_TEMPLATE_ALIAS[raw];
  if (EPISODE_TEMPLATE_ALIAS[up]) return EPISODE_TEMPLATE_ALIAS[up];
  return up;
}
/* 合并症是 AI 抽取里最常见的“中文状态/别名”失败点：
   模型会输出「确诊」「现患」，而库内状态只接受 active/history/negative/unknown；
   肾病等词又可能被截断或不在 21 项词表里。这里先做展示层归一，
   不能因为一个状态词把整条合并症卡住。 */
function normComorbidityStatus(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^(active|确诊|现患|活动|有|阳性)$/.test(s) || /现患|确诊/.test(s)) return 'active';
  if (/^(history|既往|病史|曾患|已愈)$/.test(s) || /既往|病史/.test(s)) return 'history';
  if (/^(negative|无|阴性|排除|否认)$/.test(s) || /阴性|排除|否认/.test(s)) return 'negative';
  if (/^(unknown|未评估|不详|未记录)$/.test(s) || /未评估|不详/.test(s)) return 'unknown';
  return s || 'unknown';
}
function normComorbidityCode(code, label) {
  const raw = String(code == null ? '' : code).trim();
  const s = (raw + ' ' + String(label == null ? '' : label)).toLowerCase();
  if (/慢性肾|ckd|renal|kidney/.test(s)) return 'other';
  if (/高脂|hyperlipid/.test(s)) return 'hyperlipidemia';
  if (/心梗|myocardial/.test(s)) return 'myocardial_infarction';
  if (/心绞痛|冠心病|angina|coronary/.test(s)) return 'angina';
  if (/慢阻肺|copd/.test(s)) return 'copd';
  if (/哮喘|asthma/.test(s)) return 'asthma';
  if (/脑卒中|脑梗|post.?stroke/.test(s)) return 'post_stroke';
  if (/肝病|肝功能|liver/.test(s)) return 'liver_disease';
  if (/贫血|anemia/.test(s)) return 'anemia';
  if (/甲减|hypothyroid/.test(s)) return 'hypothyroidism';
  if (/甲亢|hyperthyroid/.test(s)) return 'hyperthyroidism';
  return raw;
}

function normToxicityCode(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  const low = raw.toLowerCase();
  if (TOXICITY_ALIAS[raw]) return TOXICITY_ALIAS[raw];
  if (TOXICITY_ALIAS[low]) return TOXICITY_ALIAS[low];
  return low;
}


/* 结构化 kind 与“活动事件类型”的映射。
   结构化子表必须挂在一条 timeline_events 上；AI 不再用 kind=event 重复写同一活动。 */
const STRUCTURED_KINDS = new Set(['pathology', 'imaging', 'radiation', 'outcome']);
const BIOPSY_EVENT_TYPE = '前列腺穿刺活检病理报告';
const PATHOLOGY_EVENT_BY_SPECIMEN = {
  biopsy: BIOPSY_EVENT_TYPE, RP: '手术病理报告', TURP: '前列腺电切病理报告',
  metastasis: '转移灶活检病理', review: '病理会诊/复核', unknown: BIOPSY_EVENT_TYPE
};
const IMAGING_EVENT_BY_MODALITY = {
  mpMRI: '多参数磁共振(mpMRI)', PSMA_PET: 'PSMA PET-CT', PSMA_PET_MRI: 'PSMA PET-MRI',
  bone_scan: '骨扫描(ECT)', CT: '影像学复查', MRI: '腹盆腔MRI',
  choline_pet: '胆碱PET-CT', other: '影像学复查'
};
/* 2026-10：胸部CT / 腹盆腔CT 的 modality 都是 CT，只靠 modality 无法还原事件类型。
   模型在 payload 里给 studyType，这里映射回"检查类型 + 对应事件类型"。 */
const STUDY_TYPE_INFO = {
  chest_ct: { modality: 'CT', event: '胸部CT' },
  abdomen_ct: { modality: 'CT', event: '腹盆腔CT' },
  abdomen_mri: { modality: 'MRI', event: '腹盆腔MRI' },
  psma_pet: { modality: 'PSMA_PET', event: 'PSMA PET-CT' },
  psma_pet_mri: { modality: 'PSMA_PET_MRI', event: 'PSMA PET-MRI' },
  choline_pet: { modality: 'choline_pet', event: '胆碱PET-CT' },
  mp_mri: { modality: 'mpMRI', event: '多参数磁共振(mpMRI)' },
  bone_scan: { modality: 'bone_scan', event: '骨扫描(ECT)' }
};
const RADIATION_EVENT_BY_TYPE = {
  EBRT: '外照射放疗(EBRT)', SBRT: '外照射放疗(EBRT)',
  brachy: '近距离放疗/粒子植入', other: '外照射放疗(EBRT)'
};
const OUTCOME_EVENT_BY_TYPE = {
  BCR: '生化复发确认', CRPC: '去势抵抗确认', metastasis: '转移确认',
  death: '终止随访/死亡', lost: '失访确认'
};
const STRUCTURED_EVENT_TYPES = new Set([
  ...Object.values(PATHOLOGY_EVENT_BY_SPECIMEN),
  ...Object.values(IMAGING_EVENT_BY_MODALITY),
  ...Object.values(RADIATION_EVENT_BY_TYPE),
  ...Object.values(OUTCOME_EVENT_BY_TYPE)
]);
const UNCERTAIN_RE = /考虑|可能|疑似|待排|不除外|怀疑|建议复查|待明确|倾向/;

function normOligo(v) {
  const raw = String(v == null ? '' : v).trim();
  if (OLIGO_SET.has(raw)) return raw;
  return OLIGO_ALIAS[raw] || OLIGO_ALIAS[raw.toLowerCase()] || '';
}
function hasUncertainty(text) {
  return UNCERTAIN_RE.test(String(text || ''));
}
/* 并发上限：不是为了省阿里云的钱（RPM 3000+ 够用），
   是为了守住 PM2 的 max_memory_restart=300M。
   base64 编码会让内存膨胀到文件的 4/3 倍，再 stringify 一份。 */
const MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENT || 2);

/* 任务最长存活时间：超过则判定为进程重启导致的僵尸任务。
   PM2 重启（内存触发或手动 deploy）会杀掉正在跑的后台任务，
   任务状态只存在内存里的话，医生会对着永远转圈的界面等下去。 */
const STALE_TASK_MS = Number(process.env.AI_STALE_TASK_MS || 10 * 60 * 1000);

/* 单会话 token 熔断：防止脚本 bug 或超大材料烧配额 */
const SESSION_TOKEN_BUDGET = Number(process.env.AI_SESSION_TOKEN_BUDGET || 100000);

const AI_STATUS = {
  QUEUED: 'queued',
  PREPROCESSING: 'preprocessing',
  REDACTING: 'redacting',
  EXTRACTING: 'extracting',
  PENDING: 'pending',        /* 等待医生审核 */
  ADOPTED: 'adopted',
  REJECTED: 'rejected',
  FAILED: 'failed'
};

/* ------------------------------------------------------------------ */
/* P2-19：模型 warning 清洗                                             */
/* ------------------------------------------------------------------ */

function containsExactDate(text, iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = m[1], mo = String(Number(m[2])), d = String(Number(m[3]));
  return String(text).includes(iso) || String(text).includes(y + '年' + mo + '月' + d + '日') ||
    String(text).includes(y + '/' + m[2] + '/' + m[3]);
}

/**
 * 把模型自由文本 warnings 变成可核验的提示：
 * - “日期仅精确到月”必须有真实近似日期；
 * - “自造词”必须真的有字典外事件；
 * - 同文去重，最多 8 条；
 * - 系统生成的 warning（离线/截断/JSON 修复）不强行归类，保留。
 */
export function sanitizeWarnings(rawWarnings, items, materialText) {
  const list = Array.isArray(rawWarnings) ? rawWarnings : [];
  const text = String(materialText || '');
  const approxDate = (items || []).some(it => {
    const p = (it && it.payload) || {};
    return ['date', 'startDate', 'endDate', 'reportDate', 'studyDate', 'eventDate', 'testDate', 'recDate']
      .some(k => typeof p[k] === 'string' && /^\d{4}-\d{2}-01$/.test(p[k]));
  });
  const customEvent = (items || []).some(it =>
    it && it.kind === 'event' && it.payload && it.payload.type && !ALL_EVENT_TYPES.includes(it.payload.type));
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    let msg = String(raw || '').trim();
    if (!msg) continue;
    let code = 'other';
    const pref = msg.match(/^\[(date_precision|custom_event|uncertainty|drug_alias|other)\]\s*/i);
    if (pref) { code = pref[1].toLowerCase(); msg = msg.slice(pref[0].length).trim(); }
    if (/日期仅精确到月|仅精确到月|只精确到月/.test(msg)) code = 'date_precision';
    if (/自造词/.test(msg)) code = 'custom_event';
    if (code === 'date_precision') {
      const dates = msg.match(/\d{4}-\d{2}-\d{2}/g) || [];
      if (dates.length) {
        /* 模型点名的日期若在原文中本来就是完整日期，就是误报。 */
        if (dates.every(d => containsExactDate(text, d))) continue;
      } else if (!approxDate) {
        continue;
      }
    }
    if (code === 'custom_event') {
      if (!customEvent) continue;
      if (/诊断建议|治疗建议|建议进一步|建议复查/.test(msg)) continue;
    }
    if (code === 'other' && /建议(复查|进一步|治疗|穿刺|活检)|^诊断建议|^治疗建议/.test(msg)) continue;
    const line = code === 'other' ? msg : '[' + code + '] ' + msg;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line.slice(0, 300));
  }
  return out.slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* 注册入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object} o
 * @param {object} o.app        Express 实例
 * @param {object} o.db         better-sqlite3 实例
 * @param {Function} o.auth     鉴权中间件；auth(true) 表示仅管理员
 * @param {string}  o.uploadDir 上传根目录
 * @param {object} o.h          从 server.js 注入的既有辅助函数（见下）
 */
export function registerAiIntake(o) {
  const { app, db, auth, uploadDir, h } = o;
  const {
    normDate, parsePsaValue, assertNotFuture, assertAliveForRecord,
    ensurePsaMirrorEvent, ensureTestoMirrorEvent,
    validateEventBody, validateMedicationBody, findMedicationConflict, syncSurgDate,
    validatePathologyBody, validateImagingBody, validateRadiationBody, validateOutcomeBody,
    savePathologyForEvent, saveImagingForEvent, saveRadiationForEvent, saveOutcomeForEvent,
    validateLabValueBody, validateClinicalRecordBody, rebuildLabEvent, syncLineMedications,
    validateTreatmentLineBody, insertTreatmentAgents, registerFileAsset,
    saveVisitRow, insertAdverseEvent, getVisitOf, getEpisodeOf,
    logAudit, getP, buildPatient, nextPatientId, requireOwn,
    canAccess, isAdmin, ageFromBirth, LAB_EVENT_TYPE, RP_EVENT_TYPE
  } = h;

  const aiDir = path.join(uploadDir, 'ai-intake');
  fs.mkdirSync(aiDir, { recursive: true });

  /* 主档字段的“现有值”展示与冲突判断。
     审核阶段必须让医生看到：档案现在是什么、材料提取的是什么；
     没有这段信息，医生会以为点“采纳”就会更新，实际被已有值保护规则跳过。 */
  function profileHasExisting(field, raw) {
    if (raw === null || raw === undefined) return false;
    if (BOOL_TRI_FIELDS.has(field) || NUM_TRI_FIELDS.has(field)) return true; /* 0 是合法临床值 */
    return raw !== '';
  }

  function profileDisplayValue(field, raw) {
    if (raw === null || raw === undefined || raw === '') return '';
    if (BOOL_TRI_FIELDS.has(field)) {
      return (raw === 1 || raw === '1' || raw === true) ? '是'
        : (raw === 0 || raw === '0' || raw === false) ? '否' : String(raw);
    }
    if (field === 'smoking') return SMOKING_LABELS[raw] || String(raw);
    if (field === 'lastFollowupMode') return FOLLOWUP_MODE_LABELS[raw] || String(raw);
    if (field === 'oligoType') return OLIGO_LABELS[raw] || String(raw);
    return String(raw);
  }

  function profileCanonicalValue(field, value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    if (BOOL_TRI_FIELDS.has(field)) {
      const s = String(value).trim().toLowerCase();
      if (['是', '有', 'yes', 'true', '1'].includes(s)) return '1';
      if (['否', '无', 'no', 'false', '0'].includes(s)) return '0';
      return s;
    }
    if (NUM_TRI_FIELDS.has(field)) {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : String(value).trim();
    }
    if (field === 'smoking') {
      const s = String(value).trim();
      return SMOKING_ENUM[s] || SMOKING_ENUM[s.toLowerCase()] || s;
    }
    if (field === 'lastFollowupMode') {
      const s = String(value).trim();
      return FOLLOWUP_MODE_ENUM[s] || FOLLOWUP_MODE_ENUM[s.toLowerCase()] || s;
    }
    if (field === 'oligoType') return normOligo(value) || String(value).trim();
    if (field === 'diseaseCategory') {
      /* 四分类：只认这五个值（含空）；中文/大小写混写做一次收敛，其余丢弃 */
      const s2 = String(value).trim();
      const up = s2.toUpperCase();
      if (['NMHSPC', 'MHSPC', 'NMCRPC', 'MCRPC'].includes(up)) return up;
      if (/非转移.*去势抵抗|nmcrpc/i.test(s2)) return 'nmCRPC';
      if (/转移.*去势抵抗|mcrpc/i.test(s2)) return 'mCRPC';
      if (/非转移.*激素敏感|nmhspc/i.test(s2)) return 'nmHSPC';
      if (/转移.*激素敏感|mhspc/i.test(s2)) return 'mHSPC';
      return '';
    }
    if (field === 'dreResult') {
      /* 只接受 normal/abnormal；"未触及结节"属正常，"质硬/固定/结节"属异常。
         其他（阴性、-、未见异常）一律按正常处理；没提就是 null，不猜。 */
      const s = String(value).trim().toLowerCase();
      if (['normal', 'abnormal'].includes(s)) return s;
      if (/异常|结节|质硬|固定|可疑/.test(s)) return 'abnormal';
      if (/正常|阴性|未触及|未见/.test(s)) return 'normal';
      return '';
    }
    if (['birth', 'date', 'rtEndDate', 'adtStartDate', 'lastFollowupDate'].includes(field)) {
      return normDate(value) || String(value).trim();
    }
    if (field === 'clinicalStage' || field === 'pathologicStage') return String(value).trim().toUpperCase();
    if (field === 'gleason') return String(value).replace(/\s+/g, '');
    return String(value).trim();
  }

  function profileConflictMeta(p, item) {
    /* 已建档患者的 name 项在 row.field 留空、field 放在 payload 里；
       这里取有效字段，才能把姓名差异也显示出来（是否允许覆盖由身份保护决定）。 */
    const field = item && (item.field || (item.payload && item.payload.field));
    const col = PROFILE_COLUMNS[field];
    if (!col) return {};
    const raw = p[col];
    const hasExisting = profileHasExisting(field, raw);
    if (!hasExisting) return { hasExisting: false, existingValue: null, conflict: false, overwriteBlocked: '' };
    const existingValue = profileDisplayValue(field, raw);
    const proposed = item.payload ? item.payload.value : null;
    const expected = profileCanonicalValue(field, proposed);
    const actual = profileCanonicalValue(field, raw);
    const conflict = !!(expected !== null && actual !== null && expected !== actual);
    let overwriteBlocked = '';
    if (conflict) {
      if (PROFILE_IDENTITY_FIELDS.has(field)) {
        overwriteBlocked = '身份字段请手工核对，不自动覆盖';
      } else if (field === 'gleason' && String(p.gleason_source || '').startsWith('pathology:')) {
        overwriteBlocked = 'Gleason 由 primary 病理同步，请修改病理报告';
      } else if (field === 'pathologicStage' && String(p.pathologic_stage_source || '').startsWith('pathology:')) {
        overwriteBlocked = 'pTNM 由 primary 病理同步，请修改病理报告';
      }
    }
    return { hasExisting: true, existingValue, conflict, overwriteBlocked };
  }

  /* ---------------- 建表（幂等） ---------------- */
  db.exec(`
CREATE TABLE IF NOT EXISTS ai_intake_sessions (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT,
  new_patient_name TEXT DEFAULT '',
  doc_type      TEXT DEFAULT '',
  status        TEXT NOT NULL,
  stage_detail  TEXT DEFAULT '',
  model_used    TEXT DEFAULT '',
  prompt_ver    TEXT DEFAULT '',
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  latency_ms    INTEGER DEFAULT 0,
  finish_reason TEXT DEFAULT '',
  error_class   TEXT DEFAULT '',
  error_msg     TEXT DEFAULT '',
  redaction_log TEXT DEFAULT '',
  warnings      TEXT DEFAULT '[]',
  document_type TEXT DEFAULT '',
  name_in_doc   TEXT DEFAULT '',
  created_by    TEXT,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE TABLE IF NOT EXISTS ai_intake_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  filename    TEXT,
  stored_name TEXT NOT NULL,
  mime        TEXT DEFAULT '',
  bytes       INTEGER DEFAULT 0,
  width       INTEGER DEFAULT 0,
  height      INTEGER DEFAULT 0,
  page        INTEGER DEFAULT 1,
  est_tokens  INTEGER DEFAULT 0,
  FOREIGN KEY(session_id) REFERENCES ai_intake_sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ai_intake_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL,
  field        TEXT DEFAULT '',
  payload      TEXT DEFAULT '{}',
  evidence     TEXT DEFAULT '',
  page         INTEGER DEFAULT 0,
  risk         TEXT DEFAULT 'ok',
  risk_reason  TEXT DEFAULT '',
  decision     TEXT DEFAULT 'pending',
  edited_value TEXT,
  target_table TEXT DEFAULT '',
  target_id    INTEGER,
  dedupe_key   TEXT DEFAULT '',
  duplicate_of INTEGER,
  dedupe_reason TEXT DEFAULT '',
  FOREIGN KEY(session_id) REFERENCES ai_intake_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_sess_patient ON ai_intake_sessions(patient_id);
CREATE INDEX IF NOT EXISTS idx_ai_sess_status ON ai_intake_sessions(status);
CREATE INDEX IF NOT EXISTS idx_ai_sess_created ON ai_intake_sessions(created_by, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_items_sess ON ai_intake_items(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_ai_files_sess ON ai_intake_files(session_id, page);
`);

  /* 旧库补去重列（P1-10）；新库建表已包含。 */
  {
    const cols = db.prepare('PRAGMA table_info(ai_intake_items)').all().map(c => c.name);
    if (!cols.includes('dedupe_key')) db.exec("ALTER TABLE ai_intake_items ADD COLUMN dedupe_key TEXT DEFAULT ''");
    if (!cols.includes('duplicate_of')) db.exec('ALTER TABLE ai_intake_items ADD COLUMN duplicate_of INTEGER');
    if (!cols.includes('dedupe_reason')) db.exec("ALTER TABLE ai_intake_items ADD COLUMN dedupe_reason TEXT DEFAULT ''");
  }

  /* ---------------- 启动恢复：清理僵尸任务 ----------------
     进程重启会丢掉内存队列，DB 里却还留着 running 态的记录。
     不处理的话前端会一直轮询一个永远不会完成的任务。 */
  {
    const stale = db.prepare(`
      SELECT id, created_by FROM ai_intake_sessions
       WHERE status IN ('queued','preprocessing','redacting','extracting')
    `).all();
    if (stale.length) {
      const now = new Date().toISOString();
      const upd = db.prepare(`UPDATE ai_intake_sessions
          SET status='failed', error_class='interrupted', updated_at=?,
              error_msg='服务重启导致任务中断，请重新上传材料'
        WHERE id=?`);
      stale.forEach(s => upd.run(now, s.id));
      console.log('🔧 AI 登记：已将 ' + stale.length + ' 个中断任务标记为失败（服务重启所致）');
    }
  }

  /* ---------------- 上传中间件 ----------------
     单文件 ≤15MB，与既有 reports 上传一致；只收图片。
     PDF 支持需要单独扩展（技术文档 9.3 列为二期），
     这里刻意不放行，避免收进来却无法解析的材料。 */
  const aiStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, aiDir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
    }
  });
  const aiUpload = multer({
    storage: aiStorage,
    limits: { fileSize: 15 * 1024 * 1024, files: MAX_IMAGES_PER_CALL },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('只能上传图片文件'));
      cb(null, true);
    }
  });

  /* 上传失败时清理已落盘的孤儿文件，沿用既有 discardUploadedFiles 的思路 */
  function discardFiles(files) {
    (files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { /* 已删则忽略 */ } });
  }

  /* ---------------- 会话状态读写 ---------------- */
  const nowIso = () => new Date().toISOString();

  function touchSession(id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map(k => k + '=?').join(',');
    db.prepare('UPDATE ai_intake_sessions SET ' + sets + ', updated_at=? WHERE id=?')
      .run(...keys.map(k => patch[k]), nowIso(), id);
  }

  function getSession(id) {
    return db.prepare('SELECT * FROM ai_intake_sessions WHERE id=?').get(id);
  }

  /* ---------------- 并发队列 ----------------
     刻意不引入 Redis/消息队列：单科室日均 20 份材料的量级用不上，
     多一个中间件只会让部署和排查变复杂。内存队列 + DB 状态持久化足够。 */
  const running = new Set();
  const waiting = [];

  function pump() {
    while (running.size < MAX_CONCURRENT && waiting.length) {
      const sid = waiting.shift();
      const s = getSession(sid);
      /* 排队期间可能已被拒绝或标记失败 */
      if (!s || s.status !== AI_STATUS.QUEUED) continue;
      running.add(sid);
      runPipeline(sid).catch(err => {
        console.error('[ai-intake] 任务异常 ' + sid, err);
        try {
          touchSession(sid, {
            status: AI_STATUS.FAILED,
            error_class: err?.errorClass || 'internal',
            error_msg: String(err?.message || err).slice(0, 500)
          });
        } catch (e) { /* DB 已关时忽略 */ }
      }).finally(() => {
        running.delete(sid);
        pump();
      });
    }
  }

  function enqueue(sid) {
    waiting.push(sid);
    /* setImmediate：先把 HTTP 响应发出去，再开始跑重活。
       否则医生点上传后要等整条流水线跑完才收到 sessionId。 */
    setImmediate(pump);
  }

  /* ---------------- 三段式流水线 ---------------- */
  async function runPipeline(sid) {
    const s = getSession(sid);
    if (!s) return;

    const files = db.prepare('SELECT * FROM ai_intake_files WHERE session_id=? ORDER BY page, id').all(sid);
    const textPayload = loadSessionText(sid);
    /* 纯文本材料（医生口述/自由文本，评测方案 6 类之一）没有图片是合法的，
       只有图片与文本都为空才算「没有可用材料」。创建接口已拦过一次，这里兜底。 */
    if (!files.length && !textPayload) {
      touchSession(sid, { status: AI_STATUS.FAILED, error_class: 'no_material', error_msg: '没有可用材料（图片与文本均为空）' });
      return;
    }

    /* ---- 第一段：预处理（图片已在浏览器端压缩，此处只做体积与 token 核算） ---- */
    touchSession(sid, { status: AI_STATUS.PREPROCESSING, stage_detail: '检查材料' });
    if (files.length > MAX_IMAGES_PER_CALL) {
      touchSession(sid, {
        status: AI_STATUS.FAILED, error_class: 'too_many_images',
        error_msg: '单次最多 ' + MAX_IMAGES_PER_CALL + ' 张图，当前 ' + files.length + ' 张，请分批上传'
      });
      return;
    }

    /* ---- 第二段：脱敏 ----
       T/GDNS 016-2025 要求利用 OCR/NLP 自动识别并脱敏敏感信息。
       本项目材料是图片，文字在第三段才被识别出来，因此脱敏实际发生在
       「医生粘贴的文本材料」上；图片本身的隐私由医院伦理审批与
       上传前的院内脱敏负责（技术文档 7.3 节）。
       未配置 Key 时 redactText 直接返回 skipped。 */
    let redactionLog = '';
    let materialText = '';
    if (textPayload) {
      touchSession(sid, { status: AI_STATUS.REDACTING, stage_detail: '脱敏处理' });
      try {
        const r = await redactText(textPayload);
        if (r.failed) {
          /* 失败即保守：脱敏不成功就不把原文送去云端 */
          touchSession(sid, {
            status: AI_STATUS.FAILED, error_class: 'redaction_failed',
            error_msg: '脱敏环节失败，为避免未脱敏文本外传已中止。可改用图片上传或重试。'
          });
          return;
        }
        redactionLog = JSON.stringify({ replaced: r.replaced, skipped: !!r.skipped });
        materialText = r.text || '';
      } catch (err) {
        touchSession(sid, {
          status: AI_STATUS.FAILED, error_class: err?.errorClass || 'redaction_error',
          error_msg: '脱敏环节异常：' + String(err?.message || err).slice(0, 300)
        });
        return;
      }
    }

    /* ---- 第三段：结构化抽取 ---- */
    touchSession(sid, {
      status: AI_STATUS.EXTRACTING,
      stage_detail: aiConfigured() ? '模型识别中' : '离线演练模式',
      redaction_log: redactionLog
    });

    const p = s.patient_id ? getP(s.patient_id) : null;
    const existingPsa = s.patient_id
      ? db.prepare('SELECT rec_date FROM psa_records WHERE patient_id=? ORDER BY rec_date').all(s.patient_id).map(r => r.rec_date)
      : [];

    const prompt = buildExtractPrompt({
      patientName: p ? p.name : (s.new_patient_name || ''),
      age: p ? (p.birth_date ? ageFromBirth(p.birth_date, null) : p.age) : null,
      diagDate: p ? p.diag_date : null,
      text: materialText,
      existingPsaDates: existingPsa
    });

    const modelName = aiStatus().models.extract;
    let res;
    try {
      res = await extractStructured({
        prompt,
        ctx: { patientName: p ? p.name : (s.new_patient_name || '') },
        images: files.map(f => ({ path: path.join(aiDir, f.stored_name), mime: f.mime || 'image/jpeg' })),
        supportsJsonSchema: modelSupportsJsonSchema(modelName)
      });
    } catch (err) {
      touchSession(sid, {
        status: AI_STATUS.FAILED,
        error_class: err?.errorClass || 'extract_error',
        error_msg: String(err?.message || err).slice(0, 500),
        model_used: modelName
      });
      return;
    }

    const inTok = res.usage?.prompt_tokens || 0;
    const outTok = res.usage?.completion_tokens || 0;
    if (inTok + outTok > SESSION_TOKEN_BUDGET) {
      touchSession(sid, {
        status: AI_STATUS.FAILED, error_class: 'token_budget',
        input_tokens: inTok, output_tokens: outTok,
        error_msg: '本次消耗 ' + (inTok + outTok) + ' tokens，超过单会话预算 ' + SESSION_TOKEN_BUDGET
      });
      return;
    }

    /* ---- 校验与入库 ---- */
    const raw = res.data || {};
    const items = Array.isArray(raw.items) ? raw.items : [];
    const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(w => String(w).slice(0, 300)) : [];
    if (res.offline) warnings.unshift('【离线演练模式】未配置 DASHSCOPE_API_KEY，以下为演示数据，请勿采纳入真实病历。');
    if (res.finishReason === 'length') warnings.unshift('模型输出被截断（finish_reason=length），结果可能不完整，建议拆分材料后重试。');
    (res.repaired || []).forEach(r => warnings.push('JSON 修复：' + r));
    const patientCtx = {
      patient: p, existingPsa, sessionId: sid,
      /* documentType 供 normalizeItem 判断「这份材料能否支撑某个字段」。
         实测发现模型会把化验单上的报告日期当成患者确诊日期输出，
         单靠 prompt 约束不稳定，因此在校验层加一道保护。 */
      documentType: String(raw.documentType || '').toLowerCase()
    };
    /* 模型可能把结构化材料整个塞进 pathology/imaging/radiation/outcome 这类
       本期不支持的 kind（v1.3 prompt 未禁止，实测出现过）。直接丢弃会连带丢掉
       里面的 Gleason 与分期——患者列表的这两列只读 profile 字段，丢了医生
       就看不到。因此先展开：拆出主档项 + 活动事件，再逐项归一化。 */
    const flattened = [];
    items.forEach((it, i) => flattenStructuredItem(it, i, flattened));
    const checked = flattened.map((it, i) => normalizeItem(it, i, patientCtx));
    /* P2-19：在归一化之后清洗 warning，用真实 items/原文核对日期精度、
       自造词，避免模型误报淹没真正的数据问题。 */
    const dedupWarnings = sanitizeWarnings(warnings, checked, materialText);
    const dedupe = computeDedupe(checked);
    const dedupeKeys = new Map();
    checked.forEach(c => {
      const info = dedupeInfo(c);
      if (info) dedupeKeys.set(c.seq, info.key);
    });

    db.transaction(() => {
      db.prepare('DELETE FROM ai_intake_items WHERE session_id=?').run(sid);
      const ins = db.prepare(`INSERT INTO ai_intake_items
        (session_id,seq,kind,field,payload,evidence,page,risk,risk_reason,dedupe_key,dedupe_reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      const seqToId = new Map();
      checked.forEach(c => {
        const d = dedupe.get(c.seq);
        const r = ins.run(sid, c.seq, c.kind, c.field, JSON.stringify(c.payload),
          c.evidence, c.page, c.risk, c.riskReason, dedupeKeys.get(c.seq) || '', d ? d.reason : '');
        seqToId.set(c.seq, r.lastInsertRowid);
      });
      const upd = db.prepare('UPDATE ai_intake_items SET duplicate_of=? WHERE id=?');
      for (const [seq, d] of dedupe) {
        const id = seqToId.get(seq);
        const mainId = seqToId.get(d.duplicateSeq);
        if (id && mainId) upd.run(mainId, id);
      }
    })();

    touchSession(sid, {
      status: AI_STATUS.PENDING,
      stage_detail: '待审核（' + checked.length + ' 项）',
      model_used: res.model || modelName,
      prompt_ver: PROMPT_VERSION,
      input_tokens: inTok,
      output_tokens: outTok,
      latency_ms: res.latencyMs || 0,
      finish_reason: res.finishReason || '',
      warnings: JSON.stringify(dedupWarnings),
      document_type: String(raw.documentType || '').slice(0, 20),
      name_in_doc: String(raw.patientNameInDocument || '').slice(0, 60),
      error_class: '', error_msg: ''
    });
    logAudit(s.created_by, 'AI_EXTRACT', '会话 ' + sid.slice(0, 8) + ' 抽出 ' + checked.length + ' 项（' + (res.model || modelName) + '）');
  }

  /* 文本材料单独存文件，不进 DB 列：病历文本可能很长，
     且属于敏感数据，落盘便于统一清理，也避免撑大 sessions 表。 */
  function sessionTextPath(sid) { return path.join(aiDir, sid + '.txt'); }
  function saveSessionText(sid, txt) { fs.writeFileSync(sessionTextPath(sid), txt, 'utf8'); }
  function loadSessionText(sid) {
    try { return fs.readFileSync(sessionTextPath(sid), 'utf8'); } catch (e) { return ''; }
  }
  function removeSessionFiles(sid) {
    try { fs.unlinkSync(sessionTextPath(sid)); } catch (e) { /* 无则忽略 */ }
    const rows = db.prepare('SELECT id, stored_name FROM ai_intake_files WHERE session_id=?').all(sid);
    rows.forEach(r => {
      db.prepare("DELETE FROM file_assets WHERE source='ai_intake' AND source_id=?").run(r.id);
      try { fs.unlinkSync(path.join(aiDir, r.stored_name)); } catch (e) { /* 已删 */ }
    });
  }

  /* ------------------------------------------------------------------ */
  /* AI 输出归一化与风险标注                                              */
  /* ------------------------------------------------------------------ */

  /* v1.5 起 pathology/imaging/radiation/outcome 是正式结构化 kind，
     不再走“拆成 profile + event”的兼容分支。
     保留旧行为只针对一种情况：模型仍输出 kind=pathology，但 payload 只有
     gleason/stage、没有标本类型/针数/切缘等结构化字段——这时拆成
     profile + event，避免丢掉 Gleason 与分期。
     真正的结构化项原样保留，由 normalizeItem 校验、adopt 写子表。 */
  const PATHOLOGY_EVENT_BY_TYPE = {
    biopsy: BIOPSY_EVENT_TYPE, rp: '手术病理报告', turp: '前列腺电切病理报告'
  };
  function flattenStructuredItem(raw, origSeq, out) {
    const kind = String((raw && raw.kind) || '').trim();
    if (kind !== 'pathology') { out.push(raw); return; }
    const pl = raw.payload || {};
    const looksStructured = !!(pl.specimenType || pl.reportDate || pl.coresTotal != null ||
      pl.coresPositive != null || pl.gleasonPrimary != null || pl.marginStatus ||
      pl.ptnm || pl.lnExamined != null);
    if (looksStructured) { out.push(raw); return; }
    const date = pl.date || pl.reportDate || null;
    const specimen = String(pl.specimenType || pl.specimen || '').toLowerCase();
    /* 事件类型取值优先级：
       1) payload.type 若已是事件字典里的词（模型常直接给「手术病理报告」）→ 原样用；
       2) 否则按 specimenType 关键字推断；
       3) 都推不出才回退穿刺活检。
       只看 specimenType 会把「payload.type=手术病理报告」的条目误归成穿刺活检。 */
    const typeFromPayload = String(pl.type || '').trim();
    const evType = ALL_EVENT_TYPES.includes(typeFromPayload)
      ? typeFromPayload
      : (specimen.includes('turp') || specimen.includes('电切')
        ? PATHOLOGY_EVENT_BY_TYPE.turp
        : (specimen.includes('rp') || specimen.includes('手术') || specimen.includes('切除')
          ? PATHOLOGY_EVENT_BY_TYPE.rp
          : PATHOLOGY_EVENT_BY_TYPE.biopsy));
    const evidence = String(raw.evidence || '').slice(0, 300);
    const page = Number.isFinite(Number(raw.page)) ? Number(raw.page) : 0;

    /* 主档项：Gleason。兼容两种写法：整串 "4+3=7"，或 primary/secondary 分列 */
    let gleason = String(pl.gleason || '').trim();
    if (!gleason && pl.gleasonPrimary != null && pl.gleasonSecondary != null) {
      const gp = Number(pl.gleasonPrimary), gs = Number(pl.gleasonSecondary);
      if (Number.isFinite(gp) && Number.isFinite(gs)) gleason = gp + '+' + gs + '=' + (gp + gs);
    }
    if (gleason) {
      out.push({ kind: 'profile', field: 'gleason', value: gleason, evidence, page,
        _note: '由 pathology 条目拆分而来' });
    }
    /* 主档项：分期。病理报告默认 pTNM（与 prompt 规则 5 一致）；
       若模型给的串带 c 前缀则归入 clinicalStage，避免把临床分期写进病理列。 */
    const stage = String(pl.stage || pl.ptnm || '').trim();
    if (stage) {
      const isC = /^c/i.test(stage);
      out.push({ kind: 'profile', field: isC ? 'clinicalStage' : 'pathologicStage',
        value: stage, evidence, page, _note: '由 pathology 条目拆分而来' });
    }
    /* 活动事件：这次病理报告本身。payload 里不再携带 gleason/stage，
       避免同一次采纳里事件级与主档级两份 Gleason 互相矛盾。 */
    if (date) {
      out.push({ kind: 'event', payload: { date, type: evType, gleason: '', stage: '',
        notes: String(pl.notes || '').slice(0, 1000) }, evidence, page,
        _note: '由 pathology 条目转换而来' });
    }
    /* 三项都没抽到时保留原条目，让审核界面如实显示「未知 kind」 */
    if (!gleason && !stage && !date) out.push(raw);
  }

  /**
   * 把模型输出的一项转成入库前的规范结构，并打风险标记。
   *
   * 风险分级：
   *   ok     — 可正常审核
   *   warn   — 需要医生留意（自造事件类型、字典未命中药名、日期仅精确到月）
   *   danger — 必须显式确认（三态字段给了 false/0 但无证据支撑、
   *            镜像事件类型、被排除字段、唯一索引冲突）
   */
  function normalizeItem(raw, seq, ctx) {
    const it = raw || {};
    const kind = String(it.kind || '').trim();
    const evidence = String(it.evidence || '').slice(0, 300);
    const page = Number.isFinite(Number(it.page)) ? Math.max(0, Math.floor(Number(it.page))) : 0;
    const base = { seq, kind, field: '', payload: {}, evidence, page, risk: 'ok', riskReason: '' };

    /* 风险等级判定：显式 level 优先；否则取 r.risk（调用方常写成
       warn({...base, risk:'danger'}, msg)）；r.risk 若是从 base 继承来的
       'ok' 则视为未指定，降级为 'warn'——因为调用 warn() 本身就意味着有风险。
       不能写成 r.risk || 'warn'：r 里展开过 base，r.risk 恒为 'ok'，
       短路后风险标记会被静默吃掉，审核界面就失去高亮依据。 */
    const warn = (r, msg, level) => ({
      ...base, ...r,
      risk: level || (r.risk && r.risk !== 'ok' ? r.risk : 'warn'),
      riskReason: msg
    });

    /* ---- profile ---- */
    if (kind === 'profile') {
      const field = String(it.field || '').trim();
      /* P2-C20：已建档患者不再抽姓名；新建患者保留 name 作为建档字段。 */
      if (field === 'name' && ctx.patient) {
        return warn({ ...base, payload: { field, value: String(it.value || '') }, risk: 'warn' },
          '患者已建档，材料中的姓名仅用于核对，不再写入 name 字段');
      }
      base.field = field;
      if (!PROFILE_FIELDS.includes(field)) {
        if (EXCLUDED_FIELDS.includes(field)) {
          return warn({ ...base, payload: { value: it.value }, risk: 'danger' },
            '「' + field + '」涉及患者授权或系统派生，AI 不得填写，请医生手工录入');
        }
        return warn({ ...base, payload: { value: it.value } }, '未知主档字段「' + field + '」，采纳时会被忽略');
      }
      /* 确诊日期保护：化验单/检验报告上印的「报告日期」不是确诊日期。
         实测模型（qwen3.7-flash v1.0）会把报告日 2025-03-11 当成 date 输出，
         prompt 约束不完全可靠，故在校验层兜底：材料类型是 lab/imaging 时
         降级为 danger 并要求医生核对；且若患者已有确诊日期，一律不覆盖。 */
      if (field === 'date') {
        const docType = (ctx && ctx.documentType) || '';
        const weakSource = ['lab', 'imaging'].includes(docType);
        const hasExisting = !!(ctx.patient && ctx.patient.diag_date);
        if (weakSource) {
          return warn({ ...base, payload: { value: normDate(it.value) } },
            '材料类型是「' + docType + '」，模型很可能把化验/影像的报告日期当成了确诊日期。' +
            (hasExisting ? '该患者已有确诊日期 ' + ctx.patient.diag_date + '，采纳时不会覆盖。' : '确诊日期应取病理报告日期或明确写出的诊断日期，请核对。'),
            'danger');
        }
        return { ...base, payload: { value: normDate(it.value) } };
      }
      /* 三态字段审查：null=未评估，false/0=明确阴性，二者语义不可互换。
         server.js:4076-4086 的导入代码专门处理「不伪造 0/false」。
         布尔型与数值型分开判定，因为数值型里 0 常是合法临床值。 */
      if (BOOL_TRI_FIELDS.has(field)) {
        const v = it.value;
        if (v === null || v === undefined || v === '') {
          return { ...base, payload: { value: null } };   /* 未评估，正确 */
        }
        const isNo = (v === false || v === 0 || v === '0');
        if (/未(明确|评估|提及|写出|写|查)|不详/.test(evidence)) {
          return warn({ ...base, payload: { value: null }, risk: 'danger' },
            '原文没有明确评估「' + field + '」，已改为未评估');
        }
        if (isNo && !evidence) {
          return warn({ ...base, payload: { value: null }, risk: 'danger' },
            '布尔三态字段「' + field + '」模型给出阴性但无原文证据，已改为「未评估」。若材料确实写明阴性，请医生手工改回');
        }
        if (isNo) {
          return warn({ ...base, payload: { value: false }, risk: 'warn' },
            '布尔三态字段「' + field + '」判为阴性，请核对原文证据');
        }
        return warn({ ...base, payload: { value: true }, risk: 'warn' },
          '布尔三态字段「' + field + '」判为阳性，请核对原文证据');
      }
      if (NUM_TRI_FIELDS.has(field)) {
        const v = it.value;
        if (v === null || v === undefined || v === '') {
          return { ...base, payload: { value: null } };   /* 未评估，正确 */
        }
        if (/未(明确|评估|提及|写出|写|查)|不详/.test(evidence)) {
          return warn({ ...base, payload: { value: null }, risk: 'danger' },
            '原文没有明确评估「' + field + '」，已改为未评估');
        }
        const n = Number(v);
        if (!Number.isFinite(n)) {
          return warn({ ...base, payload: { value: null }, risk: 'warn' },
            '数值三态字段「' + field + '」值「' + v + '」非数字，已改为未评估');
        }
        if (n === 0 && !evidence) {
          return warn({ ...base, payload: { value: null }, risk: 'danger' },
            '数值三态字段「' + field + '」为 0 但无原文证据（模型常把「未提及」误写成 0），已改为未评估，请核对');
        }
        if (field === 'ecog' && (n < 0 || n > 4)) {
          return warn({ ...base, payload: { value: null }, risk: 'danger' }, 'ECOG 只能为 0–4');
        }
        if (field === 'charlson' && (n < 0 || n > 50)) {
          return warn({ ...base, payload: { value: null }, risk: 'danger' }, 'Charlson 指数只能为 0–50');
        }
        if (field === 'bmi' && (n < 5 || n > 80)) {
          return warn({ ...base, payload: { value: null }, risk: 'danger' }, 'BMI 只能为 5–80');
        }
        return { ...base, payload: { value: n } };
      }
      /* 枚举/格式类主档字段：手工界面是下拉/受控输入，AI 不能绕过。 */
      if (field === 'treatment') {
        const v = String(it.value == null ? '' : it.value).trim();
        if (v && !['根治性手术', '放疗', '内分泌治疗', '主动监测', '观察等待'].includes(v)) {
          return warn({ ...base, payload: { value: v }, risk: 'danger' }, '首选治疗「' + v + '」不在允许的 5 个值内');
        }
        return { ...base, payload: { value: v } };
      }
      if (field === 'oligoType') {
        const code = normOligo(it.value);
        if (!code) {
          return warn({ ...base, payload: { value: '' }, risk: 'danger' },
            '瘤负荷分层「' + it.value + '」无法映射到 none/oligo/oligo_sync/oligo_meta/widespread/unknown');
        }
        if (/未(明确|评估|提及|写出|写|查)|不详/.test(evidence) ||
            !/寡转移|低瘤负荷|高瘤负荷|广泛转移|无转移|未见转移|未见骨转移|无骨转移/.test(evidence)) {
          /* 原文只说“骨转移/多发转移”，没有写寡转移/广泛转移/低高瘤负荷时，
             不能替医生推断；但“未评估”本身是合法状态，应允许采纳为 unknown，
             而不是把整条卡成无法采纳。 */
          return { ...base, payload: { value: 'unknown' }, risk: 'warn',
            riskReason: '原文没有明确写“寡转移/低瘤负荷/高瘤负荷/无转移”，已记为“未评估”，不推断高低瘤负荷；如需分层请手工修改' };
        }
        return { ...base, payload: { value: code } };
      }
      if (field === 'gleason') {
        const v = String(it.value == null ? '' : it.value).trim();
        const m = v.match(/^([1-5])\s*\+\s*([1-5])(?:=(\d+))?$/);
        if (v && (!m || (m[3] != null && Number(m[3]) !== Number(m[1]) + Number(m[2])))) {
          return warn({ ...base, payload: { value: '' }, risk: 'danger' }, 'Gleason「' + v + '」格式不合法，应为 4+3=7');
        }
        return { ...base, payload: { value: v } };
      }
      if (field === 'clinicalStage' || field === 'pathologicStage') {
        const v = String(it.value == null ? '' : it.value).trim();
        if (v && !/^[cp]?T[1-4][a-c]?N[0-3xX]?M[0-1][a-c]?$/.test(v)) {
          return warn({ ...base, payload: { value: '' }, risk: 'danger' },
            '分期「' + v + '」不是可识别的 cTNM/pTNM（如 cT2cN0M0 / pT3aN0M0）');
        }
        return { ...base, payload: { value: v } };
      }
      if (field === 'birth') {
        const v = normDate(it.value);
        if (!v) return warn({ ...base, payload: { value: null }, risk: 'danger' }, '出生日期格式无效');
        if (ctx.patient && ctx.patient.diag_date && v >= ctx.patient.diag_date) {
          return warn({ ...base, payload: { value: v }, risk: 'danger' }, '出生日期必须早于诊断日期');
        }
        return { ...base, payload: { value: v } };
      }
      return { ...base, payload: { value: it.value === undefined ? null : it.value } };
    }

    /* ---- 结构化 kind（P0-3：病理/影像/放疗/结局） ---- */
    if (STRUCTURED_KINDS.has(kind)) {
      const pl = Object.assign({}, it.payload || {});
      const birth = ctx && ctx.patient ? ctx.patient.birth_date : null;
      let check = null;
      let extraRisk = '';
      let extraLevel = '';

      if (kind === 'pathology') {
        const specMap = [
          ['穿刺', 'biopsy'], ['活检', 'biopsy'], ['biopsy', 'biopsy'],
          ['手术', 'RP'], ['根治', 'RP'], ['rp', 'RP'],
          ['电切', 'TURP'], ['turp', 'TURP'],
          ['转移', 'metastasis'], ['会诊', 'review'], ['复核', 'review'], ['review', 'review']
        ];
        const rawSpec = String(pl.specimenType || pl.specimen || pl.type || '').trim();
        let spec = rawSpec;
        if (!['biopsy', 'RP', 'TURP', 'metastasis', 'review', 'unknown'].includes(spec)) {
          const hit = specMap.find(x => rawSpec.toLowerCase().includes(x[0].toLowerCase()));
          spec = hit ? hit[1] : 'unknown';
        }
        pl.specimenType = spec;
        pl.reportDate = pl.reportDate || pl.date;
        const marginMap = { '阴性': 'negative', '阳性': 'positive', '近切缘': 'close', '未评估': 'unknown' };
        if (marginMap[pl.marginStatus]) pl.marginStatus = marginMap[pl.marginStatus];
        if (pl.gleason && pl.gleasonPrimary == null) {
          const m = String(pl.gleason).match(/^(\d)\s*\+\s*(\d)/);
          if (m) { pl.gleasonPrimary = Number(m[1]); pl.gleasonSecondary = Number(m[2]); }
        }
        pl.ptnm = String(pl.ptnm || pl.stage || '').trim();
        if (/^c/i.test(pl.ptnm)) {
          pl.ptnm = '';
          extraRisk = '病理结构化里出现 cTNM，已清空 pTNM；临床分期请单独用 profile.clinicalStage 输出';
          extraLevel = 'warn';
        }
        check = validatePathologyBody(pl, birth);
        if (!check.error && check.value.specimenType === 'biopsy' && check.value.ptnm) {
          check.value.ptnm = '';
          extraRisk = '穿刺活检不应有 pTNM，已清空；pTN 只用于 RP/TURP 切除标本';
          extraLevel = 'warn';
        }
      }

      if (kind === 'imaging') {
        const modMap = [
          ['mpmri', 'mpMRI'], ['mri', 'mpMRI'], ['磁共振', 'mpMRI'],
          ['psma', 'PSMA_PET'], ['pet', 'PSMA_PET'],
          ['骨扫描', 'bone_scan'], ['ect', 'bone_scan'],
          ['ct', 'CT'], ['超声', 'other']
        ];
        let stKey = String(pl.studyType || '').trim().toLowerCase();
        /* 模型偶尔只写 region（"胸部"）不写 studyType；CT 的 modality 又分不出胸/腹，
           这里按部位补一次，避免"胸部CT"被记成笼统的"影像学复查"。 */
        if (!STUDY_TYPE_INFO[stKey] && String(pl.modality || '').toUpperCase() === 'CT') {
          const where = String(pl.region || '') + ' ' + String(pl.notes || '');
          if (/胸|肺|纵隔|锁骨上/.test(where)) stKey = 'chest_ct';
          else if (/腹|盆腔|肝|肾上腺|腹膜后|髂/.test(where)) stKey = 'abdomen_ct';
        }
        if (STUDY_TYPE_INFO[stKey]) {
          pl.studyType = stKey;
          pl.modality = STUDY_TYPE_INFO[stKey].modality;
        } else {
          const rawMod = String(pl.modality || pl.type || '').trim();
          let mod = rawMod;
          if (!['mpMRI', 'CT', 'MRI', 'PSMA_PET', 'PSMA_PET_MRI', 'bone_scan', 'choline_pet', 'other'].includes(mod)) {
            const hit = modMap.find(x => rawMod.toLowerCase().includes(x[0]));
            mod = hit ? hit[1] : 'other';
          }
          pl.modality = mod;
        }
        pl.studyDate = pl.studyDate || pl.date;
        const oligo = normOligo(pl.oligoStatus);
        pl.oligoStatus = (oligo === 'oligo_sync' || oligo === 'oligo_meta') ? 'oligo' : oligo;
        check = validateImagingBody(pl, birth);
        /* 校验器只回白名单字段；studyType 是"还原事件类型"的线索，必须随 payload 一起存，
           否则胸部CT 会在采纳时退化成笼统的"影像学复查"。 */
        if (!check.error && pl.studyType) check.value.studyType = pl.studyType;
        if (!check.error && check.value.oligoStatus &&
            (/未(明确|评估|提及|写出|写|查)|不详/.test(evidence) ||
             !/寡转移|低瘤负荷|高瘤负荷|广泛转移|无转移|未见转移|未见骨转移/.test(evidence))) {
          check.value.oligoStatus = '';
          extraRisk = '影像原文没有明确写寡转移/瘤负荷分层，已清空该字段，请手工判断';
          extraLevel = 'warn';
        }
        if (!check.error && (hasUncertainty(evidence) || hasUncertainty(pl.notes))) {
          extraRisk = [extraRisk, '影像原文含不确定措辞，请核对是否可写成明确转移/阳性'].filter(Boolean).join('；');
          extraLevel = 'warn';
          if (check.value.lesionCount > 0 || (check.value.metastaticSites || '') || check.value.psmaPositive === 1) extraLevel = 'danger';
        }
      }

      if (kind === 'radiation') {
        const rtMap = [['brachy', 'brachy'], ['粒子', 'brachy'], ['近距离', 'brachy'], ['sbrt', 'SBRT'], ['ebrt', 'EBRT'], ['外照射', 'EBRT']];
        const rawRt = String(pl.rtType || pl.type || '').trim();
        let rt = rawRt;
        if (!['EBRT', 'SBRT', 'brachy', 'other'].includes(rt)) {
          const hit = rtMap.find(x => rawRt.toLowerCase().includes(x[0].toLowerCase()));
          rt = hit ? hit[1] : 'EBRT';
        }
        pl.rtType = rt;
        pl.startDate = pl.startDate || pl.date;
        const targetMap = { '前列腺': 'prostate', '盆腔': 'pelvis', '前列腺+盆腔': 'prostate_pelvis', '转移灶': 'metastasis' };
        if (targetMap[pl.target]) pl.target = targetMap[pl.target];
        check = validateRadiationBody(pl, birth);
      }

      if (kind === 'outcome') {
        const outMap = {
          '生化复发确认': 'BCR', '去势抵抗确认': 'CRPC', '转移确认': 'metastasis',
          '终止随访/死亡': 'death', '失访确认': 'lost',
          BCR: 'BCR', CRPC: 'CRPC', metastasis: 'metastasis', death: 'death', lost: 'lost'
        };
        pl.outcomeType = outMap[pl.outcomeType] || outMap[pl.type] || pl.outcomeType;
        pl.eventDate = pl.eventDate || pl.date;
        const subMap = { '术后持续可测': 'persistence', '复发': 'recurrence', 'nmCRPC': 'nmCRPC', 'mCRPC': 'mCRPC' };
        if (subMap[pl.subtype]) pl.subtype = subMap[pl.subtype];
        const basisMap = { 'PSA': 'PSA', '影像': 'imaging', 'PSA+影像': 'both', '两者': 'both', '临床': 'clinical' };
        if (basisMap[pl.basis]) pl.basis = basisMap[pl.basis];
        const outOligo = normOligo(pl.oligoStatus);
        pl.oligoStatus = outOligo === 'oligo_sync' || outOligo === 'oligo_meta' ? 'oligo' : outOligo;
        check = validateOutcomeBody(pl, birth);
        if (!check.error && check.value.oligoStatus &&
            (/未(明确|评估|提及|写出|写|查)|不详/.test(evidence) ||
             !/寡转移|低瘤负荷|高瘤负荷|广泛转移|无转移|未见转移|未见骨转移/.test(evidence))) {
          check.value.oligoStatus = '';
          extraRisk = '结局原文没有明确写寡转移/瘤负荷分层，已清空该字段，请手工判断';
          extraLevel = 'warn';
        }
        if (!check.error && (hasUncertainty(evidence) || hasUncertainty(pl.notes))) {
          extraRisk = '结局原文含不确定措辞，不能写成确诊结局';
          extraLevel = 'danger';
        }
      }

      if (!check || check.error) {
        return warn({ ...base, payload: pl }, '结构化' + kind + '校验失败：' + ((check && check.error) || '未知错误'), 'danger');
      }
      const out = { ...base, payload: check.value };
      if (extraRisk) return warn(out, extraRisk, extraLevel || 'warn');
      return out;
    }


    /* ---- episode：治疗段（新版工作台手工添加） ---- */
    if (kind === 'episode') {
      const pl = Object.assign({}, it.payload || {});
      pl.templateCode = normEpisodeTemplate(pl.templateCode || pl.template || pl.type);
      pl.episodeType = String(pl.episodeType || EPISODE_TYPE_BY_TEMPLATE[pl.templateCode] || '').trim();
      const validIntents = ['radical', 'adjuvant', 'salvage', 'palliative', 'neoadjuvant', 'active_surveillance', 'watchful_waiting'];
      if (!validIntents.includes(String(pl.intent || '').trim())) {
        pl.intent = EPISODE_INTENT_BY_TEMPLATE[pl.templateCode] || 'palliative';
      }
      const v = validateEpisodeInput(pl);
      if (!v.ok) return warn({ ...base, payload: pl, risk: 'danger' }, '治疗段校验失败：' + v.error);
      return { ...base, payload: Object.assign({}, v.value, {
        lineNo: Number.isFinite(Number(pl.lineNo)) ? Number(pl.lineNo) : null,
        episodeTemplate: pl.templateCode
      }) };
    }

    /* ---- visit：一次就诊（可带多个治疗段行与AE） ---- */
    if (kind === 'visit') {
      const pl = Object.assign({}, it.payload || {});
      const v = validateVisitInput(pl);
      if (!v.ok) return warn({ ...base, payload: pl, risk: 'danger' }, '就诊校验失败：' + v.error);
      const rows = (Array.isArray(pl.rows) ? pl.rows : []).slice(0, 12).map(r => ({
        episodeId: r && r.episodeId != null ? Number(r.episodeId) : null,
        episodeTemplate: normEpisodeTemplate(r && (r.episodeTemplate || r.templateCode || r.episodeType)),
        episodeLabel: String((r && (r.episodeLabel || r.label)) || '').slice(0, 120),
        lineNo: Number.isFinite(Number(r && r.lineNo)) ? Number(r.lineNo) : null,
        rowType: String((r && r.rowType) || 'followup').slice(0, 30),
        overallResponse: String((r && r.overallResponse) || 'NA').slice(0, 10),
        responseBasis: String((r && r.responseBasis) || 'none').slice(0, 20),
        psaResponse: String((r && r.psaResponse) || 'NA').slice(0, 30),
        imagingResponse: String((r && r.imagingResponse) || 'NA').slice(0, 10),
        clinicalResponse: String((r && r.clinicalResponse) || 'stable').slice(0, 20),
        summary: String((r && r.summary) || '').slice(0, 1000),
        notes: String((r && r.notes) || '').slice(0, 1000),
        adverseEvents: (Array.isArray(r && r.adverseEvents) ? r.adverseEvents : []).slice(0, 20)
      }));
      return { ...base, payload: Object.assign({}, v.value, { rows }) };
    }

    /* ---- surgery：手术实施记录 ---- */
    if (kind === 'surgery') {
      const pl = Object.assign({}, it.payload || {});
      pl.episodeTemplate = normEpisodeTemplate(pl.episodeTemplate || pl.templateCode || 'RP');
      const v = validateSurgeryInput(pl);
      if (!v.ok) return warn({ ...base, payload: pl, risk: 'danger' }, '手术记录校验失败：' + v.error);
      return { ...base, payload: Object.assign({}, v.value, {
        episodeTemplate: pl.episodeTemplate || 'RP',
        lineNo: Number.isFinite(Number(pl.lineNo)) ? Number(pl.lineNo) : null,
        episodeLabel: String(pl.episodeLabel || '').slice(0, 120)
      }) };
    }

    /* ---- chemo_cycle：化疗周期 ---- */
    if (kind === 'chemo_cycle') {
      const pl = Object.assign({}, it.payload || {});
      const v = validateChemoCycleInput(pl);
      if (!v.ok) return warn({ ...base, payload: pl, risk: 'danger' }, '化疗周期校验失败：' + v.error);
      return { ...base, payload: Object.assign({}, v.value, {
        episodeTemplate: normEpisodeTemplate(pl.episodeTemplate || pl.templateCode || 'CHEMO'),
        lineNo: Number.isFinite(Number(pl.lineNo)) ? Number(pl.lineNo) : null,
        episodeLabel: String(pl.episodeLabel || '').slice(0, 120),
        adverseEvents: (Array.isArray(pl.adverseEvents) ? pl.adverseEvents : []).slice(0, 20)
      }) };
    }

    /* ---- administration：ADT/药物给药记录 ---- */
    if (kind === 'administration') {
      const pl = Object.assign({}, it.payload || {});
      const date = normDate(pl.adminDate || pl.date);
      const drug = String(pl.drug || '').trim();
      if (!date) return warn({ ...base, payload: pl, risk: 'danger' }, '给药记录缺少有效日期');
      if (!drug) return warn({ ...base, payload: pl, risk: 'danger' }, '给药记录缺少药物');
      if (date > todayIso()) return warn({ ...base, payload: pl, risk: 'danger' }, '给药日期不能晚于今天');
      return { ...base, payload: {
        adminDate: date, drug: drug.slice(0, 80), dose: String(pl.dose || '').slice(0, 60),
        route: String(pl.route || '').slice(0, 30), site: String(pl.site || '').slice(0, 40),
        lot: String(pl.lot || '').slice(0, 40), nextDueDate: normDate(pl.nextDueDate),
        notes: String(pl.notes || '').slice(0, 500),
        episodeTemplate: normEpisodeTemplate(pl.episodeTemplate || pl.templateCode || 'ADT'),
        lineNo: Number.isFinite(Number(pl.lineNo)) ? Number(pl.lineNo) : null,
        episodeLabel: String(pl.episodeLabel || '').slice(0, 120)
      } };
    }

    /* ---- comorbidity：合并症 ---- */
    if (kind === 'comorbidity') {
      const pl = Object.assign({}, it.payload || {});
      pl.diseaseCode = normComorbidityCode(pl.diseaseCode || pl.code, pl.diseaseLabel || pl.label || pl.name);
      pl.status = normComorbidityStatus(pl.status);
      pl.diseaseLabel = String(pl.diseaseLabel || pl.label || pl.name || '').trim();
      const v = validateComorbidityInput(pl);
      if (!v.ok) return warn({ ...base, payload: pl, risk: 'danger' }, '合并症校验失败：' + v.error);
      return { ...base, payload: v.value };
    }

    /* ---- disease_state：疾病状态快照 ---- */
    if (kind === 'disease_state') {
      const pl = Object.assign({}, it.payload || {});
      pl.stateCode = String(pl.stateCode || pl.code || '').trim().toUpperCase();
      const v = validateDiseaseStateInput(pl);
      if (!v.ok) return warn({ ...base, payload: pl, risk: 'danger' }, '疾病状态校验失败：' + v.error);
      return { ...base, payload: Object.assign({}, v.value, {
        isCurrent: pl.isCurrent !== false
      }) };
    }

    /* ---- adverse_event：不良反应（不依赖照片） ---- */
    if (kind === 'adverse_event' || kind === 'ae') {
      const pl = Object.assign({}, it.payload || {});
      pl.termCode = normToxicityCode(pl.termCode || pl.term || pl.name);
      /* NRS 是疼痛评分，不是 CTCAE 分级；模型常把“NRS 4”直接写成 grade=4。
         骨痛封顶 G3，这里不替医生把 NRS 4 硬映射成 G2/G3，先留未分级。 */
      const nrsNotCtcae = pl.termCode === 'bone_pain' &&
        /NRS\s*\d/i.test(String(evidence || '') + ' ' + String(pl.notes || ''));
      if (nrsNotCtcae) pl.grade = null;
      const v = validateAdverseEventInput(pl);
      if (!v.ok) return warn({ ...base, payload: pl, risk: 'danger' }, '不良反应校验失败：' + v.error);
      const payload = Object.assign({}, v.value, {
        episodeTemplate: normEpisodeTemplate(pl.episodeTemplate || pl.templateCode || ''),
        lineNo: Number.isFinite(Number(pl.lineNo)) ? Number(pl.lineNo) : null,
        visitDate: normDate(pl.visitDate),
        chemoCycleNo: Number.isFinite(Number(pl.chemoCycleNo)) ? Number(pl.chemoCycleNo) : null
      });
      const out = { ...base, kind: 'adverse_event', payload };
      if (nrsNotCtcae) {
        out.risk = 'warn';
        out.riskReason = '原文写的是骨痛 NRS 评分，不是 CTCAE 分级；已保留骨痛但把分级留空，请按评分卡确认 G1–G3';
      }
      return out;
    }

    /* ---- psa ---- */
    if (kind === 'psa') {
      const pl = it.payload || {};
      const date = normDate(pl.date);
      const val = parsePsaValue(pl.value);
      let belowLod = !!pl.belowLod;
      let lod = parsePsaValue(pl.lod);
      let belowWarn = '';
      if (!date) return warn({ ...base, payload: pl, risk: 'danger' }, 'PSA 日期不完整（原文：' + (date || '空') + '），请补全 YYYY-MM-DD 后再采纳；不要猜月首/月末');
      if (val === null) return warn({ ...base, payload: pl, risk: 'danger' }, 'PSA 数值无效，无法采纳');
      /* P0-7：belowLod 只能由原文的“<”“低于检测下限”“检测不到”支撑。
         原文只写 0.01 时，模型可能凭数值小猜成“<0.01”；这里硬性降回可测值。 */
      if (belowLod && !/(<|低于|检测不到|检测下限)/.test(evidence)) {
        belowLod = false;
        lod = null;
        belowWarn = '原文没有写“<”或“低于检测下限”，不能把 ' + val + ' 标成低于检测下限；已按可测值保存';
      }
      if (belowLod && lod === null) {
        return warn({ ...base, payload: { ...pl, date, value: val, belowLod: true, lod: val } },
          'PSA 标为低于检测下限但未给下限值，已用数值本身兜底，请核对');
      }
      /* ---- 游离PSA（可选字段）----
         化验单常同报 T-PSA 与 F-PSA。游离部分单独校验，出错时只丢弃游离、
         保留总PSA——不能因为游离识别坏了就丢掉整条记录。 */
      let freeVal = null, freeBelow = false, freeLod = null, freeWarn = '';
      const rawFree = pl.freeValue;
      if (rawFree !== undefined && rawFree !== null && String(rawFree).trim() !== '') {
        const fv = parsePsaValue(rawFree);
        if (fv === null) {
          freeWarn = '游离PSA 数值无效（' + rawFree + '），已丢弃游离部分，请手工补录';
        } else {
          freeVal = fv;
          freeBelow = !!pl.freeBelowLod;
          if (freeBelow && !/(<|低于|检测不到|检测下限)/.test(evidence)) {
            freeBelow = false;
            freeWarn = '原文没有写游离PSA“<”或“低于检测下限”，不能标成低于下限；已按可测值保存';
          }
          if (freeBelow) {
            const fl = parsePsaValue(pl.freeLod);
            if (fl === null) {
              /* 总PSA 缺失下限时用数值兜底是合理的（数值即当次下限的常见写法），
                 但游离不能用总PSA的值兜底——两者下限通常不同（如 0.006 vs 0.010），
                 兜底会造出一个错的游离下限。宁可丢弃游离。 */
              freeVal = null; freeBelow = false;
              freeWarn = '游离PSA 标为低于检测下限但未给下限值，已丢弃游离部分，请手工补录';
            } else {
              freeLod = fl;
            }
          }
          /* 游离是总的一个组分，fPSA ≤ tPSA 恒成立。反过来几乎只有一种可能：
             模型把「总/游离」两行认反了。此时两个数字都不能信，标 danger。 */
          if (freeVal !== null && !freeBelow && !belowLod && freeVal > val) {
            return warn({ ...base, payload: { date, value: val, belowLod, lod, freeVal, freeBelowLod: freeBelow, freeLod }, risk: 'danger' },
              '游离PSA(' + freeVal + ') 大于总PSA(' + val + ')，物理上不可能；极可能把总/游离两行识别颠倒了，请对照原单核对');
          }
        }
      }
      /* 重复检测：同日期已有 PSA */
      if (ctx.existingPsa.includes(date)) {
        return warn({ ...base, payload: { date, value: val, belowLod, lod, freeVal, freeBelowLod: freeBelow, freeLod } },
          '该患者 ' + date + ' 已有 PSA 记录，采纳会产生同日重复，请确认是否为修正');
      }
      /* 数值合理性：PSA 超过 500 极可能是识别错小数点 */
      if (val > 500) {
        return warn({ ...base, payload: { date, value: val, belowLod, lod, freeVal, freeBelowLod: freeBelow, freeLod }, risk: 'warn' },
          'PSA 值 ' + val + ' 异常偏高，请核对是否小数点错位');
      }
      const out = { ...base, payload: { date, value: val, belowLod, lod, freeVal, freeBelowLod: freeBelow, freeLod } };
      if (belowWarn || freeWarn) {
        return warn(out, [belowWarn, freeWarn].filter(Boolean).join('；'), belowWarn ? 'danger' : 'warn');
      }
      return out;
    }

    /* ---- testosterone ---- */
    if (kind === 'testosterone') {
      const pl = it.payload || {};
      const date = normDate(pl.date);
      const unit = String(pl.unit || 'ng/dl').trim() === 'nmol/L' ? 'nmol/L' : 'ng/dl';
      const entered = Number(pl.value);
      if (!date) return warn({ ...base, payload: pl, risk: 'danger' }, '睾酮日期不完整（原文：' + (date || '空') + '），请补全 YYYY-MM-DD 后再采纳；不要猜月首/月末');
      if (!Number.isFinite(entered) || entered < 0) {
        return warn({ ...base, payload: pl, risk: 'danger' }, '睾酮数值无效，无法采纳');
      }
      /* 与 server.js:2705 完全一致的换算 */
      const value = unit === 'nmol/L'
        ? Math.round(entered * TESTO_NGDL_PER_NMOL * 100) / 100
        : Math.round(entered * 100) / 100;
      const assay = String(pl.assayMethod || '').trim();
      const assayOk = !assay || ['RIA', 'CLIA', 'LC-MS/MS', '其他'].includes(assay);
      return {
        ...base,
        payload: {
          date, value, unit, enteredValue: entered,
          assayMethod: assayOk ? assay : '',
          lab: String(pl.lab || '').slice(0, 60),
          sampleTime: String(pl.sampleTime || '').slice(0, 5)
        },
        risk: assayOk ? 'ok' : 'warn',
        riskReason: assayOk ? '' : '检测方法「' + assay + '」不在白名单，已清空该字段'
      };
    }

    /* ---- lab（P1-12：普通化验 -> lab_values；监测项 -> clinical_records） ---- */
    if (kind === 'lab') {
      const pl = it.payload || {};
      const date = normDate(pl.date);
      const itemRaw = String(pl.itemCode || pl.item || '').trim();
      const resolved = resolveLabItem(itemRaw);
      if (!date) return warn({ ...base, payload: pl, risk: 'danger' }, '化验日期不完整（原文：' + (date || '空') + '），请补全 YYYY-MM-DD 后再采纳；不要猜月首/月末');
      if (!resolved) return warn({ ...base, payload: pl, risk: 'danger' }, '化验项缺少项目名，无法采纳');
      if (resolved.reject === 'psa' || resolved.reject === 'testosterone') {
        return warn({ ...base, payload: pl, risk: 'danger' },
          '「' + itemRaw + '」必须使用 ' + resolved.reject + ' 结构化项，不能写普通化验');
      }
      if (resolved.target === 'clinical') {
        const c = validateClinicalRecordBody({
          date, category: resolved.category, item: resolved.code,
          value: pl.value, unit: pl.unit || resolved.unit,
          status: pl.status || '已完成', note: pl.note || ''
        });
        if (c.error) return warn({ ...base, payload: pl, risk: 'danger' }, '监测项校验失败：' + c.error);
        return {
          ...base, kind: 'clinical', payload: c,
          risk: resolved.code === itemRaw || resolved.label === itemRaw ? 'ok' : 'warn',
          riskReason: resolved.code === itemRaw || resolved.label === itemRaw ? '' : '项目名已归一化：' + itemRaw + ' → ' + resolved.label
        };
      }
      const c = validateLabValueBody({
        date, itemCode: resolved.code, item: resolved.label,
        value: pl.value, unit: pl.unit || resolved.unit,
        lab: pl.lab || '', method: pl.method || '', refRange: pl.refRange || '',
        flag: pl.flag || '', note: pl.note || ''
      }, ctx.patient ? ctx.patient.birth_date : null);
      if (c.error) return warn({ ...base, payload: pl, risk: 'danger' }, '化验项校验失败：' + c.error);
      return {
        ...base, payload: c.value,
        risk: resolved.code === itemRaw || resolved.label === itemRaw ? 'ok' : 'warn',
        riskReason: resolved.code === itemRaw || resolved.label === itemRaw ? '' : '项目名已归一化：' + itemRaw + ' → ' + resolved.label
      };
    }

    /* ---- clinical（监测/QoL -> clinical_records） ---- */
    if (kind === 'clinical') {
      const pl = it.payload || {};
      const c = validateClinicalRecordBody({ ...pl, status: pl.status || '已完成' });
      if (c.error) return warn({ ...base, payload: pl, risk: 'danger' }, '监测项校验失败：' + c.error);
      return { ...base, payload: c };
    }

    /* ---- treatment_line（P1-11：治疗线是当前方案唯一来源） ---- */
    if (kind === 'treatment_line') {
      const pl = it.payload || {};
      const lineNo = Number(pl.lineNo);
      const setting = String(pl.setting || '').trim();
      const regimen = String(pl.regimen || '').trim();
      const startDate = normDate(pl.startDate || pl.date);
      const endDate = pl.endDate ? normDate(pl.endDate) : null;
      if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > 99) {
        return warn({ ...base, payload: pl, risk: 'danger' }, '治疗线线数必须为 1–99 的整数');
      }
      if (!['新辅助','辅助','挽救','mHSPC','nmCRPC','mCRPC','局限治疗','主动监测','观察等待','其他'].includes(setting)) {
        return warn({ ...base, payload: pl, risk: 'danger' }, '治疗情境不合法');
      }
      if (!regimen) return warn({ ...base, payload: pl, risk: 'danger' }, '治疗线缺少方案名');
      if (!startDate) return warn({ ...base, payload: pl, risk: 'danger' }, '治疗线缺少有效开始日期');
      if (endDate && endDate < startDate) return warn({ ...base, payload: pl, risk: 'danger' }, '治疗线结束日期不能早于开始日期');
      const agents = (Array.isArray(pl.agents) ? pl.agents : []).slice(0, 12).map(a => ({
        drug: String((a && a.drug) || '').trim().slice(0, 80),
        dose: String((a && a.dose) || '').trim().slice(0, 80),
        schedule: String((a && a.schedule) || '').trim().slice(0, 80),
        startDate: a && a.startDate ? normDate(a.startDate) : null,
        endDate: a && a.endDate ? normDate(a.endDate) : null
      })).filter(a => a.drug);
      return { ...base, payload: { lineNo, setting, regimen: regimen.slice(0, 200), startDate, endDate, stopReason: String(pl.stopReason || '').slice(0, 300), response: String(pl.response || '').slice(0, 300), agents } };
    }

    /* ---- medication ---- */
    if (kind === 'medication') {
      const pl = it.payload || {};
      const rawDrug = String(pl.drug || pl.drugName || '').trim();
      if (!rawDrug) return warn({ ...base, payload: pl, risk: 'danger' }, '用药记录缺少药名，无法采纳');
      const drug = DRUG_ALIAS[rawDrug] || DRUG_ALIAS[rawDrug.toLowerCase()] || rawDrug;
      let category = String(pl.category || '').trim();
      let risk = 'ok', reason = '';
      if (!MED_CATEGORY_KEYS.has(category)) {
        const guess = DRUG_CATEGORY[drug];
        if (guess) {
          category = guess; risk = 'warn';
          reason = '模型给的分类「' + (pl.category || '空') + '」无效，已按字典改为 ' + guess;
        } else {
          category = 'other'; risk = 'warn';
          reason = '药物「' + drug + '」不在分类字典中，已归为 other，请医生确认';
        }
      } else if (DRUG_CATEGORY[drug] && DRUG_CATEGORY[drug] !== category) {
        risk = 'warn';
        reason = '字典建议分类为 ' + DRUG_CATEGORY[drug] + '，模型给的是 ' + category + '，请核对';
      }
      const startDate = normDate(pl.startDate || pl.start_date);
      const endDate = (pl.endDate !== undefined && pl.endDate !== null && String(pl.endDate).trim() !== '')
        ? normDate(pl.endDate) : null;
      if (!startDate) {
        return warn({ ...base, payload: pl, risk: 'danger' }, '用药记录缺少开始日期，无法采纳');
      }
      if (endDate && endDate < startDate) {
        return warn({ ...base, payload: { drug, category, startDate, endDate: null } },
          '停药日期早于开始日期，已清空停药日期，请核对');
      }
      /* 一代抗雄与 ARPI 同期是明确禁忌（server.js:127-130） */
      if (category === 'endocrine') {
        const conflict = db.prepare(`
          SELECT drug_name, start_date, end_date FROM medication_records
           WHERE patient_id=? AND category='arpi'
        `).all(ctx.patient?.id || '');
        const hit = conflict.find(c => !c.end_date || c.end_date >= startDate);
        if (hit) {
          risk = 'danger';
          reason = '⚠ 该患者已在用 ARPI（' + hit.drug_name + '），一代抗雄激素不能与 ARPI 同期，采纳会被服务端拒绝';
        }
      }
      return {
        ...base, risk, riskReason: reason,
        payload: {
          drug: drug.slice(0, 80), category, startDate, endDate,
          dose: String(pl.dose || '').slice(0, 40),
          schedule: String(pl.schedule || '').slice(0, 40),
          notes: String(pl.notes || '').slice(0, 500)
        }
      };
    }

    /* ---- event ---- */
    if (kind === 'event') {
      const pl = it.payload || {};
      const date = normDate(pl.date);
      const type = String(pl.type || '').trim();
      if (!date) return warn({ ...base, payload: pl, risk: 'danger' }, '事件日期不完整（原文：' + (date || '空') + '），请补全 YYYY-MM-DD 后再采纳；不要猜月首/月末');
      if (!type) return warn({ ...base, payload: pl, risk: 'danger' }, '事件缺少活动类型，无法采纳');

      /* 镜像类型禁止经事件通道写入（server.js:1969-1976 会直接拒绝） */
      if (MIRROR_EVENT_TYPES.includes(type)) {
        return warn({ ...base, payload: { date, type, gleason: pl.gleason || '', stage: pl.stage || '', notes: pl.notes || '' }, risk: 'danger' },
          '「' + type + '」由系统随 PSA/睾酮记录自动生成，不能在时间轴手工添加；请改用对应的 psa/testosterone 抽取项');
      }
      /* 游离/总比值不进诊疗时间轴（2026-10-28 用户明确要求）。
         比值是派生量，系统已按存储的总/游离现算并在 PSA 列表与曲线点位展示；
         再记一条事件只会在时间轴上留下一个没有临床动作的假节点。
         v1.3 的 prompt 曾允许模型把它写成事件，旧会话/旧模型仍可能输出，
         因此服务端硬拦：转成 skipped 项（采纳循环只认 6 种 kind，自然忽略），
         审核界面会归入「未识别类型」并说明原因。 */
      /* P0-3：有结构化子表的活动，必须走 pathology/imaging/radiation/outcome；
         用 event 写会只留父事件、不写子表，风险分层/随访状态会缺数据。 */
      if (STRUCTURED_EVENT_TYPES.has(type) || type === '胸部CT' || type === '腹盆腔CT' || type === '腹盆腔MRI' || type === '挽救性放疗(SRT)') {
        /* 模型（尤其是旧 prompt / 长文本）经常把有结构化子表的活动写成 kind=event。
           以前这里直接判 danger，医生无法采纳。现在把能还原的字段转成对应
           structured kind；还原不了的核心字段再让医生在卡片里补，而不是整条丢弃。 */
        const notes = String(pl.notes || '').slice(0, 1000);
        const gleasonText = String(pl.gleason || '') + ' ' + notes + ' ' + String(evidence || '');
        const gm = gleasonText.match(/Gleason\s*([1-5])\s*\+\s*([1-5])/i) || gleasonText.match(/([1-5])\s*\+\s*([1-5])\s*=\s*\d/);
        let kind2 = '', payload = null, check = null;
        const pathSpec = Object.keys(PATHOLOGY_EVENT_BY_SPECIMEN).find(k => PATHOLOGY_EVENT_BY_SPECIMEN[k] === type);
        const imgMod = Object.keys(IMAGING_EVENT_BY_MODALITY).find(k => IMAGING_EVENT_BY_MODALITY[k] === type);
        const radType = Object.keys(RADIATION_EVENT_BY_TYPE).find(k => RADIATION_EVENT_BY_TYPE[k] === type);
        const outType = Object.keys(OUTCOME_EVENT_BY_TYPE).find(k => OUTCOME_EVENT_BY_TYPE[k] === type);
        const sourceText = notes + ' ' + String(evidence || '');
        if (pathSpec) {
          kind2 = 'pathology';
          const cores = sourceText.match(/(\d+)\s*针[^0-9]{0,8}(\d+)\s*针?阳性/);
          payload = {
            specimenType: pathSpec, reportDate: date,
            gleasonPrimary: gm ? Number(gm[1]) : null, gleasonSecondary: gm ? Number(gm[2]) : null,
            coresTotal: cores ? Number(cores[1]) : null,
            coresPositive: cores ? Number(cores[2]) : null,
            ptnm: /^p/i.test(String(pl.stage || '')) ? String(pl.stage) : '',
            isPrimary: pathSpec === 'biopsy' ? 1 : 0,
            pni: /PNI\s*阳性|神经侵犯\s*阳性/i.test(sourceText) ? 1 : null,
            idcP: /IDC-?P\s*阳性|导管内癌/i.test(sourceText) ? 1 : null,
            cribriform: /筛状\s*阳性/i.test(sourceText) ? 1 : null,
            notes: notes
          };
          check = validatePathologyBody(payload, ctx && ctx.patient ? ctx.patient.birth_date : null);
        } else if (imgMod || ['胸部CT', '腹盆腔CT', '腹盆腔MRI'].includes(type)) {
          kind2 = 'imaging';
          let modality = imgMod || 'CT';
          let studyType = '';
          if (type === '胸部CT') { modality = 'CT'; studyType = 'chest_ct'; }
          if (type === '腹盆腔CT') { modality = 'CT'; studyType = 'abdomen_ct'; }
          if (type === '腹盆腔MRI') { modality = 'MRI'; studyType = 'abdomen_mri'; }
          const pirads = sourceText.match(/PI-?RADS\s*([1-5])/i);
          const size = sourceText.match(/([0-9]+(?:\.[0-9]+)?)\s*cm/i);
          payload = { modality, studyDate: date, studyType,
            pirads: pirads ? Number(pirads[1]) : null,
            indexSizeMm: size ? Math.round(Number(size[1]) * 10) : null,
            notes };
          check = validateImagingBody(payload, ctx && ctx.patient ? ctx.patient.birth_date : null);
        } else if (radType || type === '挽救性放疗(SRT)') {
          kind2 = 'radiation';
          payload = { rtType: 'EBRT', startDate: date, notes };
          check = validateRadiationBody(payload, ctx && ctx.patient ? ctx.patient.birth_date : null);
        } else if (outType) {
          kind2 = 'outcome';
          if (hasUncertainty(evidence) || hasUncertainty(notes)) {
            return warn({ ...base, payload: { date, type, notes }, risk: 'danger' },
              '原文含“考虑/可能/疑似/待排”等不确定措辞，不能写成「' + type + '」确诊结局');
          }
          payload = { outcomeType: outType, eventDate: date, notes };
          check = validateOutcomeBody(payload, ctx && ctx.patient ? ctx.patient.birth_date : null);
        }
        if (kind2 && check && !check.error) {
          return { ...base, kind: kind2, payload: check.value, risk: 'warn',
            riskReason: '原文把「' + type + '」写成了事件，系统已转为' +
              (kind2 === 'pathology' ? '病理' : kind2 === 'imaging' ? '影像' : kind2 === 'radiation' ? '放疗' : '结局') +
              '结构化记录；请核对缺失字段后再采纳' };
        }
        return warn({ ...base, payload: { date, type, gleason: pl.gleason || '', stage: pl.stage || '', notes }, risk: 'danger' },
          '「' + type + '」有结构化子表，但自动转换失败：' + ((check && check.error) || '缺少必要字段') + '；请手工补录');
      }
      /* P0-6：不确定措辞不得升级为确诊事件。 */
      const diagnosticEvent = ['生化复发确认', '去势抵抗确认', '转移确认', '终止随访/死亡', '失访确认'].includes(type);
      if (diagnosticEvent && (hasUncertainty(evidence) || hasUncertainty(pl.notes))) {
        return warn({ ...base, payload: { date, type, gleason: pl.gleason || '', stage: pl.stage || '', notes: pl.notes || '' }, risk: 'danger' },
          '原文含“考虑/可能/疑似/待排”等不确定措辞，不能写成「' + type + '」确诊事件');
      }
      if (type.includes('比值') || /f\/t\s*psa/i.test(type)) {
        return { ...base, kind: 'skipped', field: type,
          payload: { date, type },
          risk: 'warn',
          riskReason: '游离/总比值由系统按存储值自动计算并展示，不写入诊疗时间轴，该项采纳时会被忽略' };
      }
      const known = ALL_EVENT_TYPES.includes(type);
      /* 唯一性提示：同日同类型事件已存在 */
      let dupRisk = null;
      if (ctx.patient?.id) {
        const dup = db.prepare('SELECT id FROM timeline_events WHERE patient_id=? AND event_date=? AND event_type=?')
          .get(ctx.patient.id, date, type);
        if (dup) dupRisk = '该患者 ' + date + ' 已有「' + type + '」事件，采纳会重复，请确认';
      }
      return {
        ...base,
        payload: {
          date, type: type.slice(0, 60),
          gleason: String(pl.gleason || '').slice(0, 20),
          stage: String(pl.stage || '').slice(0, 20),
          notes: String(pl.notes || '').slice(0, 1000)
        },
        risk: dupRisk ? 'warn' : (known ? 'ok' : 'warn'),
        riskReason: dupRisk || (known ? '' : '事件类型「' + type + '」不在预设字典中，时间轴会显示为自定义（中性色）')
      };
    }

    return warn({ ...base, payload: it.payload || { value: it.value } }, '未知 kind「' + kind + '」，采纳时会被忽略');
  }

  /* ------------------------------------------------------------------ */
  /* 跨 kind 去重（P1-10）                                                */
  /* ------------------------------------------------------------------ */

  const PATH_EVENT_SPECIMEN = {
    '前列腺穿刺活检病理报告': 'biopsy', '前列腺穿刺活检': 'biopsy', '穿刺病理报告': 'biopsy',
    '手术病理报告': 'RP', '前列腺电切病理报告': 'TURP',
    '病理亚型复核(DAC/IDC-P/NEPC)': 'review'
  };
  const STRUCT_EVENT_KIND = {
    '多参数磁共振(mpMRI)': 'imaging', 'PSMA PET-CT': 'imaging',
    '骨扫描(ECT)': 'imaging', '影像学复查': 'imaging',
    '外照射放疗(EBRT)': 'radiation', '挽救性放疗(SRT)': 'radiation',
    '近距离放疗/粒子植入': 'radiation',
    '生化复发确认': 'outcome', '去势抵抗确认': 'outcome',
    '转移确认': 'outcome', '终止随访/死亡': 'outcome', '失访确认': 'outcome'
  };
  function treatmentCategoryOfEvent(type) {
    const t = String(type || '');
    if (/ADT启动|戈舍瑞林|亮丙瑞林|曲普瑞林|地加瑞克|瑞卢戈利|手术去势/.test(t)) return 'adt';
    if (/比卡鲁胺|氟他胺|尼鲁米特|一代抗雄/.test(t)) return 'endocrine';
    if (/阿比特龙|恩扎卢胺|阿帕他胺|达罗他胺|瑞维鲁胺|新型内分泌/.test(t)) return 'arpi';
    if (/多西他赛|卡巴他赛|化疗/.test(t)) return 'chemo';
    if (/奥拉帕利|他拉唑帕利|尼拉帕利|PARP/.test(t)) return 'parpi';
    if (/镭-223|Lu-177|核素/.test(t)) return 'nuc';
    if (/地舒单抗|唑来膦酸|骨保护/.test(t)) return 'bone';
    return null;
  }
  function dedupeInfo(it) {
    const p = it.payload || {};
    if (it.kind === 'treatment_line') {
      return { key: 'txline:' + p.lineNo, priority: 3, label: '第' + p.lineNo + '线' };
    }
    if (it.kind === 'medication') {
      return { key: 'tx:' + p.category + ':' + p.startDate, priority: 2, label: '药物 ' + p.drug };
    }
    if (it.kind === 'pathology') {
      return { key: 'path:' + p.reportDate + ':' + p.specimenType, priority: 2, label: '病理 ' + p.reportDate };
    }
    if (it.kind === 'imaging') {
      return { key: 'struct:imaging:' + p.studyDate, priority: 2, label: '影像 ' + p.studyDate };
    }
    if (it.kind === 'radiation') {
      return { key: 'struct:radiation:' + p.startDate, priority: 2, label: '放疗 ' + p.startDate };
    }
    if (it.kind === 'outcome') {
      return { key: 'struct:outcome:' + p.eventDate, priority: 2, label: '结局 ' + p.eventDate };
    }
    if (it.kind === 'lab') {
      return { key: 'lab:' + p.date + ':' + (p.itemCode || p.item), priority: 2, label: '化验 ' + (p.itemLabel || p.item) };
    }
    if (it.kind === 'clinical') {
      return { key: 'clinical:' + p.date + ':' + (p.item || p.category), priority: 2, label: '监测 ' + (p.item || p.category) };
    }
    if (it.kind !== 'event') return null;
    const type = String(p.type || '');
    if (type === LAB_EVENT_TYPE) return null;
    if (PATH_EVENT_SPECIMEN[type]) {
      return { key: 'path:' + p.date + ':' + PATH_EVENT_SPECIMEN[type], priority: 1, label: '病理事件 ' + p.date };
    }
    if (STRUCT_EVENT_KIND[type]) {
      const k = STRUCT_EVENT_KIND[type];
      return { key: 'struct:' + k + ':' + p.date, priority: 1, label: '结构化事件 ' + p.date };
    }
    const cat = treatmentCategoryOfEvent(type);
    if (cat) return { key: 'tx:' + cat + ':' + p.date, priority: 1, label: '治疗事件 ' + type };
    return null;
  }

  /* 返回 seq -> {duplicateSeq, reason}；不修改 items。
     同组按 priority 高者为主项；同优先级取 seq 小者。
     值不同的同组不自动覆盖，只标重复，由医生决定“合并/单独保留”。 */
  function computeDedupe(items) {
    const groups = new Map();
    items.forEach(it => {
      const info = dedupeInfo(it);
      if (!info) return;
      if (!groups.has(info.key)) groups.set(info.key, []);
      groups.get(info.key).push({ it, info });
    });
    const out = new Map();
    for (const [key, arr] of groups) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => (b.info.priority - a.info.priority) || (a.it.seq - b.it.seq));
      const main = arr[0];
      for (let i = 1; i < arr.length; i++) {
        out.set(arr[i].it.seq, {
          duplicateSeq: main.it.seq,
          key,
          reason: '与 #' + main.it.seq + '「' + main.info.label + '」重复；默认合并到主项，可单独保留'
        });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 采纳入库                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 把医生确认的项写入数据库。
   *
   * 单事务写入，但逐项校验失败只记入 skipped/errors 并跳过该条，不是全量回滚；
   * UI 必须把“已写入 X 项 / 跳过 Y 项 / 失败 Z 项”明确显示给医生。
   * 复用既有校验函数与镜像事件函数，保证与手工录入完全同一套规则。
   *
   * @returns {{ok:number, skipped:Array, errors:Array, patientId:string}}
   */
  /* AI 文本不可能知道数据库自增 ID；用模板/线数/标签把新记录挂到治疗段。
     同一模板可能重复（如两次挽救放疗），因此加日期/线数作为次级定位，仍按最近一条兜底。 */
  function resolveEpisodeRef(patientId, pl) {
    const explicit = pl && pl.episodeId != null ? Number(pl.episodeId) : null;
    if (explicit) {
      const ep = getEpisodeOf(patientId, explicit);
      if (ep) return ep;
    }
    const template = normEpisodeTemplate(pl && (pl.episodeTemplate || pl.templateCode));
    const label = String((pl && (pl.episodeLabel || pl.label)) || '').trim();
    const lineNo = Number.isFinite(Number(pl && pl.lineNo)) ? Number(pl.lineNo) : null;
    let rows = db.prepare(`SELECT e.* FROM treatment_episodes e
      LEFT JOIN treatment_lines l ON l.id=e.line_id
      WHERE e.patient_id=? ORDER BY e.start_date DESC, e.id DESC`).all(patientId);
    if (lineNo) rows = rows.filter(e => e.line_id && db.prepare('SELECT line_no FROM treatment_lines WHERE id=?').get(e.line_id)?.line_no === lineNo);
    if (template) rows = rows.filter(e => String(e.template_code || '').toUpperCase() === template);
    if (label) rows = rows.filter(e => String(e.label || '').includes(label) || String(e.template_code || '').toUpperCase() === label.toUpperCase());
    return rows[0] || null;
  }
  function moveEpisodeStartEarlier(epId, d) {
    if (!epId || !d) return;
    db.prepare('UPDATE treatment_episodes SET start_date=? WHERE id=? AND start_date>?').run(d, epId, d);
  }
  function ensureEpisodeRef(patientId, pl, defaults, actor) {
    const opts = defaults || {};
    let template = normEpisodeTemplate(pl && (pl.episodeTemplate || pl.templateCode) || opts.template || '');
    if (!template || !templateByCode(template)) return null;
    const start = normDate(pl && (pl.startDate || pl.surgeryDate || pl.cycleDate || pl.adminDate || pl.visitDate)) || normDate(opts.startDate) || todayIso();
    const lineNo = Number.isFinite(Number(pl && pl.lineNo)) ? Number(pl.lineNo) : null;
    let lineId = null;
    if (lineNo) {
      const ln = db.prepare('SELECT id FROM treatment_lines WHERE patient_id=? AND line_no=?').get(patientId, lineNo);
      lineId = ln ? ln.id : null;
    }
    const tpl = templateByCode(template);
    const type = EPISODE_TYPE_BY_TEMPLATE[template] || opts.episodeType || 'other';
    const label = String((pl && (pl.episodeLabel || pl.label)) || (tpl && tpl.label) || template).slice(0, 120);
    const r = db.prepare(`INSERT INTO treatment_episodes
      (patient_id,episode_type,template_code,label,intent,line_id,guideline_scenario,guideline_option_id,
       recommendation_level,guideline_ref,start_date,end_date,status,stop_reason_code,followup_interval_days,source,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(patientId, type, template, label, opts.intent || 'radical', lineId, '', '', '', '',
           start, null, opts.status || 'completed', '', tpl ? tpl.intervalMonths * 30 : null,
           'ai', 'AI 根据记录自动建立的关联治疗段', actor, nowIso());
    return { id: r.lastInsertRowid, line_id: lineId, template_code: template };
  }

  function resolveVisitRef(patientId, pl) {
    const explicit = pl && pl.visitId != null ? Number(pl.visitId) : null;
    if (explicit) {
      const v = getVisitOf(patientId, explicit);
      if (v) return v;
    }
    const d = normDate(pl && (pl.visitDate || pl.date));
    if (!d) return null;
    return db.prepare('SELECT * FROM visits WHERE patient_id=? AND visit_date=? ORDER BY id DESC LIMIT 1').get(patientId, d) || null;
  }

  function adoptItems(sid, decisions, user) {
    const s = getSession(sid);
    if (!s) throw new Error('会话不存在');
    if (s.status !== AI_STATUS.PENDING) throw new Error('该会话当前状态为 ' + s.status + '，不能采纳');

    const rows = db.prepare('SELECT * FROM ai_intake_items WHERE session_id=? ORDER BY seq, id').all(sid);
    const byId = new Map(rows.map(r => [r.id, r]));

    /* decisions: [{itemId, decision:'adopt'|'reject', value?:object}] */
    let picks = [];
    (decisions || []).forEach(d => {
      const r = byId.get(Number(d.itemId));
      if (!r) return;
      if (String(d.decision) !== 'adopt') return;
      /* 医生改过的值优先；未改则用模型值 */
      let payload = JSON.parse(r.payload || '{}');
      if (d.value && typeof d.value === 'object') payload = { ...payload, ...d.value };
      picks.push({ row: r, payload, edited: !!(d.value && typeof d.value === 'object'), force: !!d.force, overwrite: !!d.overwrite });
    });
    if (!picks.length) throw new Error('没有选择要采纳的项');

    /* 目标患者：已建档患者直接取；新建患者则在本事务内建档 */
    let patientId = s.patient_id;
    const result = { ok: 0, skipped: [], errors: [], patientId, overwritten: 0 };
    /* P1-10：重复项默认不写；医生点“单独保留”会带 force=true。 */
    picks = picks.filter(p => {
      if (p.row.duplicate_of && !p.force) {
        result.skipped.push({ field: p.row.kind, reason: p.row.dedupe_reason || '重复项已合并到主项，未写入' });
        return false;
      }
      return true;
    });
    if (!picks.length) throw new Error('选择的项全部是重复项；请选择主项，或对重复项点“单独保留”');

    db.transaction(() => {
      if (!patientId) {
        /* 新建患者必须满足与 POST /api/patients 相同的不变量：
           姓名、出生日期、诊断日期、初始 PSA 四项必填，且 birth < diag_date。
           缺任何一项则拒绝建档，提示医生先用常规界面建档再补录。 */
        const profItem = f => picks.find(x => x.row.kind === 'profile' && x.row.field === f);
        const name = String((profItem('name')?.payload?.value) || s.new_patient_name || '').trim();
        const birth = profItem('birth') ? normDate(profItem('birth').payload.value) : null;
        const diagDate = profItem('date') ? normDate(profItem('date').payload.value) : null;
        const psaItems = picks.filter(x => x.row.kind === 'psa');
        if (!name) throw new Error('新建患者必须采纳「姓名」项');
        if (!birth) throw new Error('新建患者必须采纳「出生日期」项；若材料未提供，请先用常规界面建档');
        if (!diagDate) throw new Error('新建患者必须采纳「诊断日期」项；若材料未提供，请先用常规界面建档');
        if (birth >= diagDate) throw new Error('出生日期必须早于诊断日期（' + birth + ' < ' + diagDate + '）');
        if (!psaItems.length) throw new Error('新建患者必须至少采纳一条 PSA 记录作为初始锚点；若材料未提供，请先用常规界面建档');
        /* 同名同生日去重，与 POST /api/patients 的 409 逻辑一致 */
        const dup = db.prepare('SELECT id FROM patients WHERE name=? AND birth_date=? LIMIT 1').get(name, birth);
        if (dup) throw new Error('已存在同名同生日患者 ' + dup.id + '，请先在患者列表中选择该患者再上传材料');

        patientId = nextPatientId();
        db.prepare(`INSERT INTO patients(id,name,age,birth_date,diag_date,status,followup_status,created_at,created_by)
                    VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(patientId, name.slice(0, 60), ageFromBirth(birth, diagDate), birth, diagDate,
               '待评估', '在访', nowIso(), user.username);
        result.patientId = patientId;
      }

      const p0 = getP(patientId);
      if (!p0) throw new Error('患者不存在');

      /* --- profile 字段：一次性 UPDATE，三态字段严格区分 null --- */
      const profileSets = [];
      const profileVals = [];
      const profileNotes = [];
      /* gleason / pathologic_stage 需要同时维护 _manual 留底，
         与 server.js:3370-3386 的病理同步逻辑保持一致：
         只有当前 source 不是 pathology: 时才覆盖，否则会与病理同步打架。 */
      const curGleasonSource = String(p0.gleason_source || '');
      const curPtnmSource = String(p0.pathologic_stage_source || '');
      /* P0-5：treatment=手术 必须有 RP 事件。AI 常只写 profile.treatment，
         如果不拦，会造出“治疗=手术、无手术日期”的矛盾档案，后续手工保存还会被拒。 */
      const hasRpEvent = picks.some(x => x.row.kind === 'event' && x.payload && x.payload.type === RP_EVENT_TYPE)
        || !!db.prepare('SELECT 1 FROM timeline_events WHERE patient_id=? AND event_type=? LIMIT 1').get(patientId, RP_EVENT_TYPE);

      picks.filter(x => x.row.kind === 'profile').forEach(x => {
        const f = x.row.field;
        let v = x.payload.value;
        const col = PROFILE_COLUMNS[f];
        if (!col) { result.skipped.push({ field: f, reason: '不支持的主档字段' }); return; }

        /* P0-5：主档枚举/格式复用与手工界面相同的约束，不能 AI 直写。 */
        if (col === 'treatment') {
          const tv = String(v == null ? '' : v).trim();
          if (tv && !['根治性手术', '放疗', '内分泌治疗', '主动监测', '观察等待'].includes(tv)) {
            result.skipped.push({ field: f, reason: '首选治疗取值不合法' }); return;
          }
          if (tv.includes('手术') && !hasRpEvent) {
            result.skipped.push({ field: f, reason: '治疗=手术但没有 RP 事件；请先采纳一条「根治性前列腺切除术(RP)」事件' }); return;
          }
          v = tv;
        }
        if (col === 'oligo_type') {
          v = normOligo(v);
          if (!v) { result.skipped.push({ field: f, reason: '瘤负荷分层取值不合法' }); return; }
        }
        if (col === 'gleason') {
          const g = String(v == null ? '' : v).trim();
          const m = g.match(/^([1-5])\s*\+\s*([1-5])(?:=(\d+))?$/);
          if (g && (!m || (m[3] != null && Number(m[3]) !== Number(m[1]) + Number(m[2])))) {
            result.skipped.push({ field: f, reason: 'Gleason 格式不合法' }); return;
          }
          v = g;
        }
        if (col === 'clinical_stage' || col === 'pathologic_stage') {
          const st = String(v == null ? '' : v).trim();
          if (st && !/^[cp]?T[1-4][a-c]?N[0-3xX]?M[0-1][a-c]?$/.test(st)) {
            result.skipped.push({ field: f, reason: '分期格式不合法' }); return;
          }
          v = st;
        }

        /* 已有值默认不覆盖——避免 AI 把医生手填的档案冲掉。
           医生在审核卡上对“冲突项”显式点“采纳并更新”时，decisions 会带
           overwrite=true；此时才允许更新临床字段。
           身份字段（姓名/生日）仍不自动覆盖，必须手工核对。 */
        const existing = p0[col];
        const isTri = TRI_STATE_FIELDS.includes(f);
        const hasExisting = isTri
          ? (existing !== null && existing !== undefined)
          : (existing !== null && existing !== undefined && existing !== '' && existing !== 0);
        if (hasExisting && !x.overwrite) {
          result.skipped.push({ field: f, reason: '该字段已有值（' + existing + '），未覆盖' });
          return;
        }
        if (hasExisting && x.overwrite && PROFILE_IDENTITY_FIELDS.has(f)) {
          result.skipped.push({ field: f, reason: '身份字段请手工核对，不自动覆盖' });
          return;
        }

        /* 日期类字段规范化 */
        if (['birth_date', 'diag_date', 'rt_end_date', 'adt_start_date', 'last_followup_date'].includes(col)) {
          v = normDate(v);
          if (!v) { result.skipped.push({ field: f, reason: '日期格式无效' }); return; }
          const fut = assertNotFuture(v, f);
          if (fut) { result.skipped.push({ field: f, reason: fut }); return; }
          if (col === 'birth_date' && p0.diag_date && v >= p0.diag_date) {
            result.skipped.push({ field: f, reason: '出生日期必须早于诊断日期' }); return;
          }
          if (col === 'diag_date' && p0.birth_date && v <= p0.birth_date) {
            result.skipped.push({ field: f, reason: '诊断日期必须晚于出生日期' }); return;
          }
        }
        /* 三态布尔字段：库里是 INTEGER 列，必须转 1/0，
           直接把 true/false 塞进去 better-sqlite3 会报错或存成非预期值。
           null（未评估）则跳过写入，保持列原值 NULL。 */
        if (['castration_status', 'met_extra_pelvis', 'visceral_met', 'family_history'].includes(col)) {
          if (v === null || v === undefined || v === '') return;   /* 未评估就不写 */
          if (typeof v === 'boolean') v = v ? 1 : 0;
          else if (v === 1 || v === 0) { /* 已是整数，原样保留 */ }
          else if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (['是', '有', 'yes', 'true', '1'].includes(s)) v = 1;
            else if (['否', '无', 'no', 'false', '0'].includes(s)) v = 0;
            else { result.skipped.push({ field: f, reason: '三态字段值「' + v + '」无法判定，请医生手工填写' }); return; }
          } else { result.skipped.push({ field: f, reason: '三态字段值类型无效' }); return; }
        }
        /* 数值类（含三态数值字段：null 表示未评估，跳过写入） */
        if (['met_count', 'ecog', 'charlson', 'bmi'].includes(col)) {
          if (v === null || v === undefined || v === '') { return; }  /* 未评估就不写 */
          const n = Number(v);
          if (!Number.isFinite(n)) { result.skipped.push({ field: f, reason: '数值无效' }); return; }
          v = col === 'bmi' ? n : Math.round(n);
          if (col === 'met_count') v = Math.max(0, v);
          if (col === 'ecog' && (v < 0 || v > 4)) { result.skipped.push({ field: f, reason: 'ECOG 应为 0-4' }); return; }
          if (col === 'charlson' && (v < 0 || v > 50)) { result.skipped.push({ field: f, reason: 'Charlson 应为 0-50' }); return; }
          if (col === 'bmi' && (v < 5 || v > 80)) { result.skipped.push({ field: f, reason: 'BMI 应为 5-80' }); return; }
        }
        /* 字符串截断，与既有 UPDATE 保持一致 */
        if (typeof v === 'string') {
          const max = { name: 60, gleason: 20, clinical_stage: 20, pathologic_stage: 20, oligo_type: 20, last_followup_mode: 20, smoking: 20, concomitant_meds: 1000, family_history_detail: 500, treatment: 100 }[col] || 200;
          v = v.trim().slice(0, max);
        }

        /* smoking / lastFollowupMode 库里存英文枚举 key，
           但模型常输出中文标签。readBaselineProfile（server.js:2309-2311）
           对这两个字段做白名单校验，非白名单值会直接报错，
           因此这里必须先归一化；映射不到就跳过，不写脏值。 */
        if (col === 'smoking') {
          const mapped = SMOKING_ENUM[v] || SMOKING_ENUM[String(v).toLowerCase()];
          if (!mapped) { result.skipped.push({ field: f, reason: '吸烟状态「' + v + '」无法映射到 never/former/current/unknown' }); return; }
          v = mapped;
        }
        if (col === 'last_followup_mode') {
          const mapped = FOLLOWUP_MODE_ENUM[v] || FOLLOWUP_MODE_ENUM[String(v).toLowerCase()];
          if (!mapped) { result.skipped.push({ field: f, reason: '随访方式「' + v + '」无法映射到 clinic/phone/external/hospital/other' }); return; }
          v = mapped;
        }

        /* gleason / pTNM 的来源保护 */
        if (col === 'gleason' && curGleasonSource.startsWith('pathology:')) {
          result.skipped.push({ field: f, reason: 'Gleason 由 primary 病理同步，请修改病理报告' });
          return;
        }
        if (col === 'pathologic_stage' && curPtnmSource.startsWith('pathology:')) {
          result.skipped.push({ field: f, reason: 'pTNM 由 primary 病理同步，请修改病理报告' });
          return;
        }

        if (hasExisting && x.overwrite) result.overwritten += 1;
        profileSets.push(col + '=?');
        profileVals.push(v);
        profileNotes.push(f + '=' + v);
        if (col === 'gleason') { profileSets.push("gleason_source='manual'"); }
        if (col === 'pathologic_stage') { profileSets.push("pathologic_stage_source='manual'"); }
      });

      if (profileSets.length) {
        db.prepare('UPDATE patients SET ' + profileSets.join(',') + ' WHERE id=?')
          .run(...profileVals, patientId);
        result.ok += profileSets.filter(x => x.includes('=?')).length;
      }

      const p = getP(patientId);

      /* --- PSA ---
         顺序不变量（server.js:2566）：初始 PSA 必须是该患者最早的一条记录。
         前端按 rec_date 排序后把「第一条」当作初始 PSA 展示，并只给非首条挂删除按钮；
         若 AI 输出顺序不是时间顺序就照序插入，会把较晚的一条标成 is_initial=1，
         界面上真正的首次值反而带上删除按钮、后端又以「初始PSA不可删除」拒绝，前后端对不上。
         因此这里先按日期排序再插入。 */
      const psaPicks = picks.filter(x => x.row.kind === 'psa')
        .filter(x => normDate(x.payload.date))
        .sort((a, b) => normDate(a.payload.date) < normDate(b.payload.date) ? -1 : 1);
      psaPicks.forEach(x => {
        const d = x.payload;
        if (parsePsaValue(d.value) === null) {
          result.errors.push({ kind: 'psa', reason: '数值无效' }); return;
        }
        if (p.birth_date && d.date <= p.birth_date) {
          result.errors.push({ kind: 'psa', reason: '日期不晚于出生日期' }); return;
        }
        const f = assertNotFuture(d.date, 'PSA 日期');
        if (f) { result.errors.push({ kind: 'psa', reason: f }); return; }
        const a = assertAliveForRecord(p, d.date, 'PSA');
        if (a) { result.errors.push({ kind: 'psa', reason: a }); return; }
        /* 该患者尚无任何 PSA 记录时，本次最早的一条即为初始锚点 */
        const any = db.prepare('SELECT COUNT(*) AS n FROM psa_records WHERE patient_id=?').get(patientId).n;
        const isInitial = any === 0 ? 1 : 0;
        const belowLod = d.belowLod ? 1 : 0;
        const lodVal = parsePsaValue(d.lod);
        const lod = belowLod ? (lodVal != null ? lodVal : parsePsaValue(d.value)) : null;
        /* 低于检测下限时下限值必须大于 0（与 POST /api/patients 的校验一致） */
        if (belowLod && !(lod > 0)) {
          result.errors.push({ kind: 'psa', reason: '低于检测下限时，检测下限值必须大于 0' }); return;
        }
        /* 游离三列：normalizeItem 已校验过（数值无效/下限缺失/总游离颠倒都已拦），
           这里只负责如实落库；未抽到游离时三列保持 NULL。 */
        const fVal = parsePsaValue(d.freeVal);
        const fBelow = fVal != null && d.freeBelowLod ? 1 : 0;
        const fLodRaw = parsePsaValue(d.freeLod);
        const fLod = fBelow ? (fLodRaw != null ? fLodRaw : null) : null;
        if (fBelow && !(fLod > 0)) {
          result.errors.push({ kind: 'psa', reason: '游离PSA低于检测下限时，检测下限值必须大于 0' }); return;
        }
        const rec = db.prepare(`INSERT INTO psa_records(patient_id,rec_date,value,is_initial,created_by,is_below_lod,lod_value,free_value,free_below_lod,free_lod_value)
                                VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, d.date, parsePsaValue(d.value), isInitial, user.username, belowLod, lod,
               fVal, fBelow, fBelow ? fLod : null);
        ensurePsaMirrorEvent(patientId, rec.lastInsertRowid, d.date, isInitial, user.username);
        x.row._targetTable = 'psa_records'; x.row._targetId = rec.lastInsertRowid;
        result.ok++;
      });
      /* 无有效日期的 PSA 项单独记错，不静默丢弃 */
      picks.filter(x => x.row.kind === 'psa' && !psaPicks.includes(x)).forEach(x => {
        result.errors.push({ kind: 'psa', reason: '缺少有效日期' });
      });

      /* --- 睾酮 --- */
      picks.filter(x => x.row.kind === 'testosterone').forEach(x => {
        const d = x.payload;
        if (!d.date) { result.errors.push({ kind: 'testosterone', reason: '日期无效' }); return; }
        if (p.birth_date && d.date <= p.birth_date) {
          result.errors.push({ kind: 'testosterone', reason: '日期不晚于出生日期' }); return;
        }
        const f = assertNotFuture(d.date, '睾酮检测日期');
        if (f) { result.errors.push({ kind: 'testosterone', reason: f }); return; }
        const a = assertAliveForRecord(p, d.date, '睾酮检测');
        if (a) { result.errors.push({ kind: 'testosterone', reason: a }); return; }
        const entered = Number(d.enteredValue != null ? d.enteredValue : d.value);
        if (!Number.isFinite(entered) || entered < 0) {
          result.errors.push({ kind: 'testosterone', reason: '数值无效' }); return;
        }
        const unit = d.unit === 'nmol/L' ? 'nmol/L' : 'ng/dl';
        const val = unit === 'nmol/L' ? Math.round(entered * TESTO_NGDL_PER_NMOL * 100) / 100 : Math.round(entered * 100) / 100;
        const r = db.prepare(`INSERT INTO testosterone_records
            (patient_id,rec_date,value,unit,entered_value,assay_method,lab,sample_time,created_by)
            VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(patientId, d.date, val, unit, entered,
               String(d.assayMethod || '').slice(0, 20), String(d.lab || '').slice(0, 60),
               String(d.sampleTime || '').slice(0, 5), user.username);
        ensureTestoMirrorEvent(patientId, r.lastInsertRowid, d.date, val, user.username);
        x.row._targetTable = 'testosterone_records'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 普通化验：写 lab_values，时间轴事件由 rebuildLabEvent 生成 --- */
      picks.filter(x => x.row.kind === 'lab').forEach(x => {
        const d = x.payload;
        const v = validateLabValueBody(d, p.birth_date);
        if (v.error) { result.errors.push({ kind: 'lab', reason: v.error }); return; }
        const a = assertAliveForRecord(p, v.value.date, '化验');
        if (a) { result.errors.push({ kind: 'lab', reason: a }); return; }
        const r = db.prepare(`INSERT INTO lab_values
          (patient_id,rec_date,item_code,item_label,value,unit,lab,method,ref_range,flag,note,source,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, v.value.date, v.value.itemCode, v.value.itemLabel, v.value.value, v.value.unit,
               v.value.lab, v.value.method, v.value.refRange, v.value.flag, v.value.note,
               'ai', user.username, nowIso());
        rebuildLabEvent(patientId, v.value.date, user.username);
        x.row._targetTable = 'lab_values'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 临床监测/QoL：写 clinical_records（DEXA/FRAX/IPSS/IIEF-5/NRS 等） --- */
      picks.filter(x => x.row.kind === 'clinical').forEach(x => {
        const d = x.payload;
        const v = validateClinicalRecordBody(d);
        if (v.error) { result.errors.push({ kind: 'clinical', reason: v.error }); return; }
        const a = assertAliveForRecord(p, v.date, '监测日期');
        if (a) { result.errors.push({ kind: 'clinical', reason: a }); return; }
        const rec = v;
        const r = db.prepare(`INSERT INTO clinical_records
            (patient_id,category,item,rec_date,value,unit,status,note,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, rec.category, rec.item, rec.date, rec.value, rec.unit, rec.status, rec.note,
               user.username, nowIso());
        x.row._targetTable = 'clinical_records'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 治疗线：写 treatment_lines + agents，并同步关联药物（P1-11） --- */
      picks.filter(x => x.row.kind === 'treatment_line').forEach(x => {
        const d = x.payload;
        const v = validateTreatmentLineBody(d, p.birth_date);
        if (v.error) { result.errors.push({ kind: 'treatment_line', reason: v.error }); return; }
        const dup = db.prepare('SELECT id FROM treatment_lines WHERE patient_id=? AND line_no=?').get(patientId, v.lineNo);
        if (dup) { result.errors.push({ kind: 'treatment_line', reason: '该患者已有第 ' + v.lineNo + ' 线治疗' }); return; }
        const alive = assertAliveForRecord(p, v.start, '治疗线开始');
        if (alive) { result.errors.push({ kind: 'treatment_line', reason: alive }); return; }
        const r = db.prepare(`INSERT INTO treatment_lines
          (patient_id,line_no,setting,regimen,start_date,end_date,stop_reason,stop_reason_code,response,response_code,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, v.lineNo, v.setting, v.regimen, v.start, v.end, v.stopReason || '', v.stopReasonCode || '',
               v.response || '', v.responseCode || '', user.username, nowIso());
        insertTreatmentAgents(r.lastInsertRowid, v.agents);
        syncLineMedications(p, { id: r.lastInsertRowid, start: v.start, end: v.end }, v.agents, user.username);
        x.row._targetTable = 'treatment_lines'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 治疗段（episode）--- */
      picks.filter(x => x.row.kind === 'episode').forEach(x => {
        const d = x.payload;
        const validIntents = ['radical', 'adjuvant', 'salvage', 'palliative', 'neoadjuvant', 'active_surveillance', 'watchful_waiting'];
        if (!validIntents.includes(String(d.intent || '').trim())) {
          d.intent = EPISODE_INTENT_BY_TEMPLATE[String(d.templateCode || '').toUpperCase()] || 'palliative';
        }
        const alive = assertAliveForRecord(p, d.startDate, '治疗段开始日期');
        if (alive) { result.errors.push({ kind: 'episode', reason: alive }); return; }
        let lineId = d.lineId == null ? null : Number(d.lineId);
        if (!lineId && d.lineNo) {
          const ln = db.prepare('SELECT id FROM treatment_lines WHERE patient_id=? AND line_no=?').get(patientId, Number(d.lineNo));
          lineId = ln ? ln.id : null;
        }
        const tpl = templateByCode(d.templateCode);
        const r = db.prepare(`INSERT INTO treatment_episodes
          (patient_id,episode_type,template_code,label,intent,line_id,guideline_scenario,guideline_option_id,
           recommendation_level,guideline_ref,start_date,end_date,status,stop_reason_code,followup_interval_days,source,notes,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, d.episodeType, d.templateCode, d.label || (tpl && tpl.label) || d.templateCode,
               d.intent, lineId, d.guidelineScenario || '', d.guidelineOptionId || '',
               d.recommendationLevel || '', d.guidelineRef || '', d.startDate, d.endDate || null,
               d.status, d.stopReasonCode || '',
               d.followupIntervalDays == null ? (tpl ? tpl.intervalMonths * 30 : null) : d.followupIntervalDays,
               'ai', d.notes || '', user.username, nowIso());
        x.row._targetTable = 'treatment_episodes'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 就诊（visit）+ 治疗段行；一次可带动多个行/AE --- */
      picks.filter(x => x.row.kind === 'visit').forEach(x => {
        const d = x.payload;
        const alive = assertAliveForRecord(p, d.visitDate, '就诊日期');
        if (alive) { result.errors.push({ kind: 'visit', reason: alive }); return; }
        const r = db.prepare(`INSERT INTO visits
          (patient_id,visit_date,visit_type,department,physician,chief_complaint,ecog,pain_nrs,summary,next_plan,next_visit_date,
           mdt_participants,mdt_conclusion,source,status,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, d.visitDate, d.visitType || 'outpatient', d.department || '', d.physician || '',
               d.chiefComplaint || '', d.ecog == null ? null : Number(d.ecog), d.painNrs == null ? null : Number(d.painNrs),
               d.summary || '', d.nextPlan || '', d.nextVisitDate || null,
               d.mdtParticipants || '', d.mdtConclusion || '', 'ai', d.status || 'final',
               user.username, nowIso(), nowIso());
        const vid = r.lastInsertRowid;
        let rowsOk = 0;
        (d.rows || []).forEach(row => {
          const ep = resolveEpisodeRef(patientId, row) || ensureEpisodeRef(patientId, row, { template: row.episodeTemplate || row.templateCode, startDate: d.visitDate }, user.username);
          if (!ep) { result.errors.push({ kind: 'visit', reason: '就诊行找不到对应治疗段（模板/线数/标签）' }); return; }
          try {
            saveVisitRow(patientId, vid, Object.assign({}, row, { episodeId: ep.id }), user.username);
            rowsOk++;
          } catch (e) {
            result.errors.push({ kind: 'visit', reason: '就诊行写入失败：' + (e.message || e) });
          }
        });
        x.row._targetTable = 'visits'; x.row._targetId = vid;
        result.ok++;
      });

      /* --- 手术实施记录 --- */
      picks.filter(x => x.row.kind === 'surgery').forEach(x => {
        const d = x.payload;
        const ep = resolveEpisodeRef(patientId, d) || ensureEpisodeRef(patientId, d, { template: d.episodeTemplate || 'RP', startDate: d.surgeryDate }, user.username);
        if (!ep) { result.errors.push({ kind: 'surgery', reason: '找不到对应治疗段，请同时采纳一条 episode（RP/手术）' }); return; }
        moveEpisodeStartEarlier(ep.id, d.surgeryDate);
        const alive = assertAliveForRecord(p, d.surgeryDate, '手术日期');
        if (alive) { result.errors.push({ kind: 'surgery', reason: alive }); return; }
        const existing = db.prepare('SELECT id FROM surgery_records WHERE episode_id=?').get(ep.id);
        let sid;
        if (existing) {
          db.prepare(`UPDATE surgery_records SET surgery_date=?,surgeon=?,procedure=?,approach=?,nerve_sparing=?,ln_dissection=?,
            ln_examined_left=?,ln_positive_left=?,ln_examined_right=?,ln_positive_right=?,catheter_days=?,drain_days=?,
            complications_json=?,complication_management=?,conversion=?,blood_loss_ml=?,hospital_days=?,notes=? WHERE id=?`)
            .run(d.surgeryDate, d.surgeon, d.procedure, d.approach, d.nerveSparing, d.lnDissection,
                 d.lnExaminedLeft, d.lnPositiveLeft, d.lnExaminedRight, d.lnPositiveRight, d.catheterDays,
                 d.drainDays, JSON.stringify(d.complications || []), d.complicationManagement, d.conversion,
                 d.bloodLossMl, d.hospitalDays, d.notes, existing.id);
          sid = existing.id;
        } else {
          const r = db.prepare(`INSERT INTO surgery_records
            (patient_id,episode_id,surgery_date,surgeon,procedure,approach,nerve_sparing,ln_dissection,
             ln_examined_left,ln_positive_left,ln_examined_right,ln_positive_right,catheter_days,drain_days,
             complications_json,complication_management,conversion,blood_loss_ml,hospital_days,notes,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(patientId, ep.id, d.surgeryDate, d.surgeon, d.procedure, d.approach, d.nerveSparing, d.lnDissection,
                 d.lnExaminedLeft, d.lnPositiveLeft, d.lnExaminedRight, d.lnPositiveRight, d.catheterDays,
                 d.drainDays, JSON.stringify(d.complications || []), d.complicationManagement, d.conversion,
                 d.bloodLossMl, d.hospitalDays, d.notes, user.username, nowIso());
          sid = r.lastInsertRowid;
        }
        x.row._targetTable = 'surgery_records'; x.row._targetId = sid;
        result.ok++;
      });

      /* --- 化疗周期 --- */
      picks.filter(x => x.row.kind === 'chemo_cycle').forEach(x => {
        const d = x.payload;
        const ep = resolveEpisodeRef(patientId, d) || ensureEpisodeRef(patientId, d, { template: d.episodeTemplate || 'CHEMO', startDate: d.cycleDate }, user.username);
        if (!ep) { result.errors.push({ kind: 'chemo_cycle', reason: '找不到对应化疗治疗段，请同时采纳 episode（CHEMO）' }); return; }
        moveEpisodeStartEarlier(ep.id, d.cycleDate);
        const alive = assertAliveForRecord(p, d.cycleDate, '化疗日期');
        if (alive) { result.errors.push({ kind: 'chemo_cycle', reason: alive }); return; }
        const r = db.prepare(`INSERT INTO chemo_cycles
          (patient_id,episode_id,line_id,cycle_no,cycle_date,regimen,agents_json,bsa,planned_dose,actual_dose,
           dose_reduction_pct,delay_days,delay_reason,gcsf,ecog,next_cycle_date,notes,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, ep.id, ep.line_id || null, d.cycleNo, d.cycleDate, d.regimen,
               JSON.stringify(d.agents || []), d.bsa, d.plannedDose, d.actualDose,
               d.doseReductionPct, d.delayDays, d.delayReason, d.gcsf, d.ecog,
               d.nextCycleDate || null, d.notes, user.username, nowIso());
        const cid = r.lastInsertRowid;
        (d.adverseEvents || []).forEach(ae => {
          try { insertAdverseEvent(patientId, null, null, ep.id, cid, ae, user.username); }
          catch (e) { result.errors.push({ kind: 'chemo_cycle', reason: '化疗AE写入失败：' + (e.message || e) }); }
        });
        x.row._targetTable = 'chemo_cycles'; x.row._targetId = cid;
        result.ok++;
      });

      /* --- 给药记录（ADT 等） --- */
      picks.filter(x => x.row.kind === 'administration').forEach(x => {
        const d = x.payload;
        const ep = resolveEpisodeRef(patientId, d) || ensureEpisodeRef(patientId, d, { template: d.episodeTemplate || 'ADT', startDate: d.adminDate }, user.username);
        const r = db.prepare(`INSERT INTO medication_administrations
          (patient_id,medication_id,episode_id,admin_date,drug,dose,route,site,lot,next_due_date,notes,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, null, ep ? ep.id : null, d.adminDate, d.drug, d.dose, d.route, d.site, d.lot,
               d.nextDueDate || null, d.notes, user.username, nowIso());
        x.row._targetTable = 'medication_administrations'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 合并症（按疾病编码 upsert） --- */
      picks.filter(x => x.row.kind === 'comorbidity').forEach(x => {
        const d = x.payload;
        const existing = db.prepare('SELECT id FROM comorbidities WHERE patient_id=? AND disease_code=?').get(patientId, d.diseaseCode);
        if (existing) {
          db.prepare(`UPDATE comorbidities SET system=?,disease_label=?,status=?,severity=?,diagnosed_date=?,notes=?,source='ai' WHERE id=?`)
            .run(d.system, d.diseaseLabel, d.status, d.severity, d.diagnosedDate, d.notes, existing.id);
          x.row._targetTable = 'comorbidities'; x.row._targetId = existing.id;
        } else {
          const r = db.prepare(`INSERT INTO comorbidities(patient_id,system,disease_code,disease_label,status,severity,diagnosed_date,notes,source,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(patientId, d.system, d.diseaseCode, d.diseaseLabel, d.status, d.severity, d.diagnosedDate, d.notes,
                 'ai', user.username, nowIso());
          x.row._targetTable = 'comorbidities'; x.row._targetId = r.lastInsertRowid;
        }
        result.ok++;
      });

      /* --- 疾病状态快照 --- */
      picks.filter(x => x.row.kind === 'disease_state').forEach(x => {
        const d = x.payload;
        if (d.isCurrent) {
          db.prepare("UPDATE disease_states SET is_current=0,superseded_at=? WHERE patient_id=? AND is_current=1")
            .run(nowIso(), patientId);
        }
        const r = db.prepare(`INSERT INTO disease_states(patient_id,state_code,state_label,since_date,basis,evidence_json,status,confirmed_by,confirmed_at,is_current)
          VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, d.stateCode, d.stateLabel, d.sinceDate, d.basis, d.evidenceJson, d.status,
               user.username, nowIso(), d.isCurrent ? 1 : 0);
        x.row._targetTable = 'disease_states'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 不良反应（独立于就诊/化疗也可写；能定位到行/周期就挂上） --- */
      picks.filter(x => x.row.kind === 'adverse_event' || x.row.kind === 'ae').forEach(x => {
        const d = x.payload;
        const ep = resolveEpisodeRef(patientId, d) || ensureEpisodeRef(patientId, d, {}, user.username);
        const visit = resolveVisitRef(patientId, d);
        let cycleId = null;
        if (ep && d.chemoCycleNo) {
          const cyc = db.prepare('SELECT id FROM chemo_cycles WHERE episode_id=? AND cycle_no=? ORDER BY id DESC LIMIT 1')
            .get(ep.id, Number(d.chemoCycleNo));
          cycleId = cyc ? cyc.id : null;
        }
        try {
          const aid = insertAdverseEvent(patientId, visit ? visit.id : null, null, ep ? ep.id : null, cycleId, d, user.username);
          x.row._targetTable = 'adverse_events'; x.row._targetId = aid;
          result.ok++;
        } catch (e) {
          result.errors.push({ kind: 'adverse_event', reason: e.message || '写入失败' });
        }
      });

      /* --- 用药 ---
         validateMedicationBody 返回 {category,drug,start,end,dose,schedule,notes}，
         冲突检测是独立函数 findMedicationConflict（同大类重叠、
         内分泌与 ARPI 同期均拒绝），必须一并调用，否则 AI 能绕过
         手工录入时会被拦住的那两条业务规则。 */
      const lineAgentDrugs = new Set();
      picks.filter(x => x.row.kind === 'treatment_line').forEach(x => {
        (x.payload.agents || []).forEach(a => { if (a.drug) lineAgentDrugs.add(a.drug); });
      });
      picks.filter(x => x.row.kind === 'medication').forEach(x => {
        const d = x.payload;
        if (!d.lineId && lineAgentDrugs.has(String(d.drug || '').trim())) {
          result.skipped.push({ field: 'medication', reason: '该药已由治疗线同步，避免重复' });
          return;
        }
        const v = validateMedicationBody({
          category: d.category, drug: d.drug, startDate: d.startDate, endDate: d.endDate,
          dose: d.dose, schedule: d.schedule, notes: d.notes
        }, p.birth_date);
        if (v.error) { result.errors.push({ kind: 'medication', drug: d.drug, reason: v.error }); return; }
        const alive = assertAliveForRecord(p, v.start, '用药开始');
        if (alive) { result.errors.push({ kind: 'medication', drug: v.drug, reason: alive }); return; }
        const conflict = findMedicationConflict(p, v, null);
        if (conflict) { result.errors.push({ kind: 'medication', drug: v.drug, reason: conflict.error }); return; }
        const r = db.prepare(`INSERT INTO medication_records
            (patient_id,category,drug_name,start_date,end_date,dose,schedule,line_id,source,notes,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patientId, v.category, v.drug, v.start, v.end, v.dose, v.schedule,
               d.lineId || null, 'ai', v.notes, user.username, nowIso());
        x.row._targetTable = 'medication_records'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* --- 结构化子表：病理/影像/放疗/结局（P0-3） ---
         先插父事件，再调用 server.js 的手工保存函数写子表；
         这样风险分层、负荷同步、随访状态仍只有一套规则。 */
      const structuredEventKeys = new Set();
      picks.filter(x => STRUCTURED_KINDS.has(x.row.kind)).forEach(x => {
        const kind = x.row.kind;
        const d = x.payload || {};
        let v = null, childTable = '', childId = null;
        let eventType = '', eventDate = '', eventGleason = '', eventStage = '';

        if (kind === 'pathology') {
          const check = validatePathologyBody(d, p.birth_date);
          if (check.error) { result.errors.push({ kind, reason: check.error }); return; }
          v = check.value;
          eventType = PATHOLOGY_EVENT_BY_SPECIMEN[v.specimenType] || BIOPSY_EVENT_TYPE;
          eventDate = v.reportDate;
          eventGleason = v.gleasonPrimary != null
            ? v.gleasonPrimary + '+' + v.gleasonSecondary + '=' + (v.gleasonPrimary + v.gleasonSecondary) : '';
          eventStage = v.ptnm || '';
          childTable = 'pathology_reports';
        } else if (kind === 'imaging') {
          const check = validateImagingBody(d, p.birth_date);
          if (check.error) { result.errors.push({ kind, reason: check.error }); return; }
          v = check.value;
          const stInfo = STUDY_TYPE_INFO[String(d.studyType || '').trim().toLowerCase()];
          eventType = (stInfo && stInfo.event) || IMAGING_EVENT_BY_MODALITY[v.modality] || '影像学复查';
          eventDate = v.studyDate;
          childTable = 'imaging_studies';
        } else if (kind === 'radiation') {
          const check = validateRadiationBody(d, p.birth_date);
          if (check.error) { result.errors.push({ kind, reason: check.error }); return; }
          v = check.value;
          eventType = RADIATION_EVENT_BY_TYPE[v.rtType] || '外照射放疗(EBRT)';
          eventDate = v.startDate;
          childTable = 'radiation_records';
        } else if (kind === 'outcome') {
          const check = validateOutcomeBody(d, p.birth_date);
          if (check.error) { result.errors.push({ kind, reason: check.error }); return; }
          v = check.value;
          eventType = OUTCOME_EVENT_BY_TYPE[v.outcomeType] || '转移确认';
          eventDate = v.eventDate;
          childTable = 'patient_outcomes';
        }
        if (!v || !eventType || !eventDate) { result.errors.push({ kind, reason: '结构化字段不完整' }); return; }

        /* 与手工结构化路径一致：BCR/CRPC/死亡/失访各限一条；
           已有结局时不再新建事件，避免旧事件失去 outcome 关联。 */
        if (kind === 'outcome' && v.outcomeType !== 'metastasis') {
          const existingOutcome = db.prepare(
            'SELECT id FROM patient_outcomes WHERE patient_id=? AND outcome_type=? LIMIT 1'
          ).get(patientId, v.outcomeType);
          if (existingOutcome) {
            result.errors.push({ kind, type: eventType, reason: '该患者已有 ' + v.outcomeType + ' 结局记录；请编辑原记录，不要重复添加' });
            return;
          }
        }
        const ev = validateEventBody({
          date: eventDate, type: eventType, gleason: eventGleason, stage: eventStage, notes: v.notes || ''
        }, p.birth_date);
        if (ev.error) { result.errors.push({ kind, type: eventType, reason: ev.error }); return; }
        const deathEvent = kind === 'outcome' && v.outcomeType === 'death';
        const aliveErr = assertAliveForRecord(p, ev.date, '事件日期', { deathEvent });
        if (aliveErr) { result.errors.push({ kind, type: eventType, reason: aliveErr }); return; }

        const r = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,gleason,stage,is_surgery,notes,created_by)
                              VALUES(?,?,?,?,?,?,?,?)`)
          .run(patientId, ev.date, ev.type, ev.gleason, ev.stage, 0, ev.notes, user.username);
        try {
          if (kind === 'pathology') {
            childId = savePathologyForEvent(patientId, r.lastInsertRowid, v, user.username);
          } else if (kind === 'imaging') {
            childId = saveImagingForEvent(patientId, r.lastInsertRowid, v, user.username);
          } else if (kind === 'radiation') {
            childId = saveRadiationForEvent(patientId, r.lastInsertRowid, v, user.username);
          } else if (kind === 'outcome') {
            const out = saveOutcomeForEvent(patientId, r.lastInsertRowid, v, user.username);
            if (out && out.error) throw new Error(out.error);
            childId = out && out.id;
          }
          x.row._targetTable = childTable; x.row._targetId = childId;
          structuredEventKeys.add(ev.date + '|' + ev.type);
          result.ok++;
        } catch (err) {
          /* 子表写失败时把刚插入的父事件删掉，避免时间轴留下空节点。 */
          db.prepare('DELETE FROM timeline_events WHERE id=?').run(r.lastInsertRowid);
          result.errors.push({ kind, type: eventType, reason: err.message || '结构化写入失败' });
        }
      });

      /* --- 事件 --- */
      picks.filter(x => x.row.kind === 'event').forEach(x => {
        const d = x.payload;
        const v = validateEventBody({ date: d.date, type: d.type, gleason: d.gleason, stage: d.stage, notes: d.notes }, p.birth_date);
        if (v.error) { result.errors.push({ kind: 'event', type: d.type, reason: v.error }); return; }
        /* P0-3：结构化活动不允许再走纯事件；避免时间轴只有父事件、没有子表。 */
        if (STRUCTURED_EVENT_TYPES.has(v.type)) {
          result.errors.push({ kind: 'event', type: v.type, reason: '该活动必须使用结构化 kind（pathology/imaging/radiation/outcome），不能写纯 event' });
          return;
        }
        if (MIRROR_EVENT_TYPES.includes(v.type)) {
          result.errors.push({ kind: 'event', type: v.type, reason: '镜像事件由 PSA/睾酮记录自动生成，不能经事件写入' });
          return;
        }
        if (structuredEventKeys.has(v.date + '|' + v.type)) {
          result.skipped.push({ field: 'event', reason: '同一活动已由结构化项写入' });
          return;
        }
        const a = assertAliveForRecord(p, v.date, '事件日期');
        if (a) { result.errors.push({ kind: 'event', type: v.type, reason: a }); return; }
        const r = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,gleason,stage,is_surgery,notes,created_by)
                              VALUES(?,?,?,?,?,?,?,?)`)
          .run(patientId, v.date, v.type, v.gleason, v.stage, v.isSurgery, v.notes, user.username);
        x.row._targetTable = 'timeline_events'; x.row._targetId = r.lastInsertRowid;
        result.ok++;
      });

      /* RP 事件影响 surg_date，必须在同一事务内同步 */
      syncSurgDate(patientId);

      /* 回写溯源链：哪条 AI 项写进了哪张表的哪一行 */
      const upd = db.prepare('UPDATE ai_intake_items SET target_table=?, target_id=? WHERE id=?');
      picks.forEach(x => {
        if (x.row._targetTable) upd.run(x.row._targetTable, x.row._targetId, x.row.id);
      });
    })();

    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 路由                                                                */
  /* ------------------------------------------------------------------ */

  /* 功能开关与配置状态：前端据此决定是否显示入口、是否提示离线演练 */
  app.get('/api/ai-intake/status', auth(), (req, res) => {
    res.json(aiStatus());
  });

  /* 受控词表：前端下拉与校验用，避免前后端各存一份字典 */
  app.get('/api/ai-intake/dict', auth(), (req, res) => {
    res.json({
      eventTypes: ALL_EVENT_TYPES,
      mirrorEventTypes: MIRROR_EVENT_TYPES,
      medCategories: MED_CATEGORIES,
      oligoTypes: OLIGO_TYPES,
      profileFields: PROFILE_FIELDS,
      triStateFields: TRI_STATE_FIELDS,
      excludedFields: EXCLUDED_FIELDS,
      structuredKinds: ['pathology', 'imaging', 'radiation', 'outcome', 'treatment_line', 'lab', 'clinical'],
      v13Kinds: ['episode', 'visit', 'surgery', 'chemo_cycle', 'administration', 'comorbidity', 'disease_state', 'adverse_event'],
      promptVersion: PROMPT_VERSION
    });
  });

  /* 创建会话：收材料、建记录、立即返回 sessionId，重活交给后台 */
  app.post('/api/ai-intake/sessions', auth(), aiUpload.array('files', MAX_IMAGES_PER_CALL), (req, res) => {
    if (!aiEnabled()) {
      discardFiles(req.files);
      return res.status(503).json({ error: 'AI 登记功能未启用（AI_INTAKE_ENABLED=false）' });
    }
    const b = req.body || {};
    const patientId = String(b.patientId || '').trim() || null;
    const textMaterial = String(b.text || '').trim();

    if (patientId) {
      const p = getP(patientId);
      if (!p) { discardFiles(req.files); return res.status(404).json({ error: '患者不存在' }); }
      if (!requireOwn(req, res, p)) { discardFiles(req.files); return; }
    }
    const files = req.files || [];
    if (!files.length && !textMaterial) {
      return res.status(400).json({ error: '请至少上传一张图片或粘贴一段文字材料' });
    }
    if (!patientId && !String(b.newPatientName || '').trim() && !files.length) {
      return res.status(400).json({ error: '新建患者请提供姓名或含姓名的材料' });
    }

    const sid = crypto.randomUUID();
    let created = null;
    try {
      created = db.transaction(() => {
        db.prepare(`INSERT INTO ai_intake_sessions
            (id,patient_id,new_patient_name,doc_type,status,stage_detail,prompt_ver,created_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(sid, patientId, String(b.newPatientName || '').slice(0, 60),
               String(b.docType || '').slice(0, 20),
               AI_STATUS.QUEUED, '排队中', PROMPT_VERSION, req.user.username, nowIso(), nowIso());

        const insF = db.prepare(`INSERT INTO ai_intake_files
            (session_id,filename,stored_name,mime,bytes,width,height,page,est_tokens)
            VALUES(?,?,?,?,?,?,?,?,?)`);
        files.forEach((f, i) => {
          const w = Number(b['w' + i]) || 0;
          const hh = Number(b['h' + i]) || 0;
          const info = insF.run(sid, String(f.originalname || '').slice(0, 200), f.filename,
                   f.mimetype || '', f.size || 0, w, hh, i + 1, estimateImageTokens(w, hh));
          registerFileAsset({ patientId: patientId || null, source: 'ai_intake', sourceId: info.lastInsertRowid,
            storedName: 'ai-intake/' + f.filename, filename: String(f.originalname || ''), mime: f.mimetype || '',
            bytes: f.size || 0, createdBy: req.user.username });
        });
        return sid;
      })();
      if (textMaterial) saveSessionText(sid, textMaterial.slice(0, 200000));
    } catch (err) {
      discardFiles(files);
      return res.status(500).json({ error: '创建会话失败：' + (err.message || err) });
    }

    logAudit(req.user.username, 'AI_INTAKE_START',
      '会话 ' + sid.slice(0, 8) + '，' + files.length + ' 张图' + (textMaterial ? ' + 文本' : '') +
      (patientId ? '，患者 ' + patientId : '，新建患者'));
    enqueue(created);
    res.status(202).json({ sessionId: created, status: AI_STATUS.QUEUED, offline: !aiConfigured() });
  });

  /* 会话详情（含进度）：前端轮询用 */
  app.get('/api/ai-intake/sessions/:sid', auth(), (req, res) => {
    const s = getSession(req.params.sid);
    if (!s) return res.status(404).json({ error: '会话不存在' });
    if (!canAccessSession(req.user, s)) return res.status(403).json({ error: '无权访问该会话' });
    res.json(sessionView(s, { light: true }));
  });

  /* 抽取结果：候选项 + 风险标记 + warnings */
  app.get('/api/ai-intake/sessions/:sid/result', auth(), (req, res) => {
    const s = getSession(req.params.sid);
    if (!s) return res.status(404).json({ error: '会话不存在' });
    if (!canAccessSession(req.user, s)) return res.status(403).json({ error: '无权访问该会话' });
    res.json(sessionView(s, { light: false }));
  });

  /* 材料图片：审核界面并排显示原文用 */
  app.get('/api/ai-intake/files/:fid', auth(), (req, res) => {
    const f = db.prepare('SELECT * FROM ai_intake_files WHERE id=?').get(req.params.fid);
    if (!f) return res.status(404).json({ error: '文件不存在' });
    const s = getSession(f.session_id);
    if (!s || !canAccessSession(req.user, s)) return res.status(403).json({ error: '无权访问该文件' });
    const fp = path.join(aiDir, f.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件已丢失' });
    res.setHeader('Content-Type', f.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(fp).pipe(res);
  });

  /* 采纳：写入数据库。decisions 由医生在审核界面逐项决定 */
  app.post('/api/ai-intake/sessions/:sid/adopt', auth(), (req, res) => {
    const s = getSession(req.params.sid);
    if (!s) return res.status(404).json({ error: '会话不存在' });
    if (!canAccessSession(req.user, s)) return res.status(403).json({ error: '无权操作该会话' });
    if (s.patient_id) {
      const p = getP(s.patient_id);
      if (!p) return res.status(404).json({ error: '目标患者不存在' });
      if (!requireOwn(req, res, p)) return;
    }
    let out;
    try {
      out = adoptItems(s.id, req.body?.decisions || [], req.user);
    } catch (err) {
      return res.status(400).json({ error: err.message || '采纳失败' });
    }

    /* 记录医生对每一项的处置；改过的值单独留档，
       这批 edited_value 就是将来 prompt 迭代与微调的标注数据。 */
    const upd = db.prepare('UPDATE ai_intake_items SET decision=?, edited_value=? WHERE id=?');
    (req.body?.decisions || []).forEach(d => {
      const v = d.value ? JSON.stringify(d.value).slice(0, 2000) : null;
      upd.run(String(d.decision) === 'adopt' ? 'adopted' : 'rejected', v, Number(d.itemId));
    });
    const adoptedPid = out.patientId || s.patient_id;
    if (adoptedPid) {
      db.prepare(`UPDATE file_assets SET patient_id=?
                  WHERE source='ai_intake' AND source_id IN
                    (SELECT id FROM ai_intake_files WHERE session_id=?)`).run(adoptedPid, s.id);
    }
    touchSession(s.id, {
      status: AI_STATUS.ADOPTED,
      /* 新建患者路径：采纳后把新患者 id 回写到会话。
         否则这条会话的 patient_id 永远是 NULL，在患者隔离的历史列表里
         任何患者下都看不到它，医生事后无法追溯"这位患者是 AI 建的"。 */
      patient_id: out.patientId || s.patient_id,
      stage_detail: '已采纳 ' + out.ok + ' 项' +
        (out.overwritten ? '（覆盖现有值 ' + out.overwritten + ' 项）' : '') +
        (out.patientId && !s.patient_id ? '（新建 ' + out.patientId + '）' : '')
    });
    logAudit(req.user.username, 'AI_ADOPT',
      '会话 ' + s.id.slice(0, 8) + ' 采纳 ' + out.ok + ' 项，覆盖 ' + out.overwritten +
      ' 项，跳过 ' + out.skipped.length +
      '，失败 ' + out.errors.length + (out.patientId ? '，患者 ' + out.patientId : ''));
    res.json({
      ok: true, adopted: out.ok, overwritten: out.overwritten,
      skipped: out.skipped, errors: out.errors,
      patientId: out.patientId,
      patient: out.patientId ? buildPatient(getP(out.patientId)) : null
    });
  });

  /* 拒绝：留原因，供后续分析模型的系统性偏差 */
  app.post('/api/ai-intake/sessions/:sid/reject', auth(), (req, res) => {
    const s = getSession(req.params.sid);
    if (!s) return res.status(404).json({ error: '会话不存在' });
    if (!canAccessSession(req.user, s)) return res.status(403).json({ error: '无权操作该会话' });
    const reason = String(req.body?.reason || '').slice(0, 500);
    touchSession(s.id, { status: AI_STATUS.REJECTED, stage_detail: '已拒绝' + (reason ? '：' + reason : '') });
    db.prepare("UPDATE ai_intake_items SET decision='rejected' WHERE session_id=? AND decision='pending'").run(s.id);
    logAudit(req.user.username, 'AI_REJECT', '会话 ' + s.id.slice(0, 8) + (reason ? '：' + reason : ''));
    res.json({ ok: true });
  });

  /* 会话列表：医生的历史与统计（修改率是模型质量的核心指标）
     患者隔离（2026-10-28 修复）：带 patientId 时只返回该患者的会话，
     且先校验调用者对该患者有访问权——否则任何登录医生都能看到全院
     所有患者的识别记录（材料缩略图、抽取内容都含患者信息）。
     同患者的会话即使由同事创建也应可见（与 canAccessSession 口径一致），
     因此这里按 patient_id 过滤而不是按 created_by。
     不带 patientId 时保持旧行为：admin 看全部、普通医生只看自己创建的
     （前端界面始终会传 patientId，此分支只留给运维排查用）。 */
  app.get('/api/ai-intake/sessions', auth(), (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 200);
    const patientId = String(req.query.patientId || '').trim();
    let rows;
    if (patientId) {
      const p = getP(patientId);
      if (!p) return res.status(404).json({ error: '患者不存在' });
      if (!canAccess(req.user, p)) return res.status(403).json({ error: '无权访问该患者的识别记录' });
      rows = db.prepare('SELECT * FROM ai_intake_sessions WHERE patient_id=? ORDER BY created_at DESC LIMIT ?')
        .all(patientId, limit);
    } else {
      rows = isAdmin(req.user)
        ? db.prepare('SELECT * FROM ai_intake_sessions ORDER BY created_at DESC LIMIT ?').all(limit)
        : db.prepare('SELECT * FROM ai_intake_sessions WHERE created_by=? ORDER BY created_at DESC LIMIT ?')
          .all(req.user.username, limit);
    }
    /* 附带每会话的采纳/修改统计，医生能直观看到模型靠不靠谱。
       只算本次返回的会话，避免每次列表请求都聚合整张条目表。 */
    let statMap = new Map();
    if (rows.length) {
      const ph = rows.map(() => '?').join(',');
      const stat = db.prepare(`SELECT session_id,
                SUM(CASE WHEN decision='adopted' THEN 1 ELSE 0 END) AS adopted,
                SUM(CASE WHEN decision='rejected' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN edited_value IS NOT NULL AND edited_value<>'' THEN 1 ELSE 0 END) AS edited,
                COUNT(*) AS total
          FROM ai_intake_items WHERE session_id IN (${ph}) GROUP BY session_id`)
        .all(...rows.map(r => r.id));
      statMap = new Map(stat.map(r => [r.session_id, r]));
    }
    res.json(rows.map(r => Object.assign(sessionView(r, { light: true }), { stats: statMap.get(r.id) || null })));
  });

  /* 删除会话（含材料文件）：仅本人或管理员 */
  app.delete('/api/ai-intake/sessions/:sid', auth(), (req, res) => {
    const s = getSession(req.params.sid);
    if (!s) return res.status(404).json({ error: '会话不存在' });
    if (!canAccessSession(req.user, s)) return res.status(403).json({ error: '无权删除该会话' });
    if ([AI_STATUS.QUEUED, AI_STATUS.PREPROCESSING, AI_STATUS.REDACTING, AI_STATUS.EXTRACTING].includes(s.status)) {
      return res.status(400).json({ error: '任务正在处理中，请等待完成或失败后再删除' });
    }
    removeSessionFiles(s.id);
    db.prepare('DELETE FROM ai_intake_sessions WHERE id=?').run(s.id);
    logAudit(req.user.username, 'AI_INTAKE_DELETE', '会话 ' + s.id.slice(0, 8));
    res.json({ ok: true });
  });

  /* 仅管理员：查看模型原始响应与 token 消耗，用于排障与成本核算。
     刻意与 result 接口分开——原始响应可能含未脱敏内容，不对普通医生开放。 */
  app.get('/api/ai-intake/sessions/:sid/raw', auth(true), (req, res) => {
    const s = getSession(req.params.sid);
    if (!s) return res.status(404).json({ error: '会话不存在' });
    res.json(sessionView(s, { light: false, raw: true }));
  });

  function canAccessSession(user, s) {
    if (isAdmin(user)) return true;
    if (s.created_by === user.username) return true;
    /* 目标患者归属本人时也允许（例如同事帮忙上传后转交） */
    if (s.patient_id) {
      const p = getP(s.patient_id);
      if (p && canAccess(user, p)) return true;
    }
    return false;
  }

  function sessionView(s, opt) {
    const o = opt || {};
    const base = {
      id: s.id,
      patientId: s.patient_id,
      newPatientName: s.new_patient_name || '',
      docType: s.doc_type || '',
      status: s.status,
      stageDetail: s.stage_detail || '',
      modelUsed: s.model_used || '',
      promptVer: s.prompt_ver || '',
      offline: s.model_used === 'offline-mock',
      documentType: s.document_type || '',
      nameInDoc: s.name_in_doc || '',
      warnings: safeJson(s.warnings, []),
      errorClass: s.error_class || '',
      errorMsg: s.error_msg || '',
      createdBy: s.created_by,
      createdAt: s.created_at,
      updatedAt: s.updated_at
    };
    if (o.light) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM ai_intake_files WHERE session_id=?').get(s.id).n;
      return Object.assign(base, { fileCount: n });
    }
    const files = db.prepare('SELECT id,filename,mime,bytes,width,height,page,est_tokens FROM ai_intake_files WHERE session_id=? ORDER BY page,id').all(s.id)
      .map(f => ({ ...f, url: '/api/ai-intake/files/' + f.id }));
    const existingPatient = s.patient_id ? getP(s.patient_id) : null;
    const items = db.prepare('SELECT * FROM ai_intake_items WHERE session_id=? ORDER BY seq,id').all(s.id)
      .map(r => {
        const it = {
          id: r.id, seq: r.seq, kind: r.kind, field: r.field,
          payload: safeJson(r.payload, {}),
          evidence: r.evidence, page: r.page,
          risk: r.risk, riskReason: r.risk_reason,
          decision: r.decision,
          editedValue: safeJson(r.edited_value, null),
          dedupeKey: r.dedupe_key || '',
          duplicateOf: r.duplicate_of == null ? null : r.duplicate_of,
          dedupeReason: r.dedupe_reason || '',
          targetTable: r.target_table, targetId: r.target_id
        };
        /* 主档项在审核时就带上现有值/冲突标记，前端口径与采纳写库共用后端判断，
           避免前端另算一套、或医生直到 skipped 才知道没覆盖。 */
        if (existingPatient && it.kind === 'profile') {
          Object.assign(it, profileConflictMeta(existingPatient, it));
        }
        return it;
      });
    const out = Object.assign(base, {
      files, items,
      inputTokens: s.input_tokens, outputTokens: s.output_tokens,
      latencyMs: s.latency_ms, finishReason: s.finish_reason,
      redactionLog: safeJson(s.redaction_log, null)
    });
    if (o.raw) {
      out.redactionLog = s.redaction_log || '';
    } else {
      /* 普通医生视角不返回脱敏日志原文，避免泄露被替换的标识符位置信息 */
      delete out.redactionLog;
    }
    return out;
  }

  function safeJson(s, fb) {
    if (!s) return fb;
    try { const v = JSON.parse(s); return v === undefined ? fb : v; } catch (e) { return fb; }
  }

  return { aiDir, sessionView, normalizeItem, flattenStructuredItem, sanitizeWarnings };
}

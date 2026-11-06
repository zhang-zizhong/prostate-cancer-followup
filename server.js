/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * 前列腺癌临床数据库 - 后端服务
 * Node.js + Express + SQLite
 * ========================================================= */
import express from 'express';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { registerAiIntake } from './lib/ai-intake.mjs';
import { resolveLabItem, canonicalClinicalItem } from './lib/lab-catalog.mjs';
import { DRUG_CATEGORY } from './lib/ai-prompt.mjs';
import { getCatalog, catalogSummary, optionById, templateByCode, toxicityByCode } from './lib/guideline-catalog.mjs';
import {
  validateEpisodeInput, validateVisitInput, validateRowInput, validateAdverseEventInput,
  validateSurgeryInput, validateChemoCycleInput, validateComorbidityInput, validateDiseaseStateInput,
  computeMyelosuppressionGrade, nextVisitNo, missedVisitEstimate,
  VISIT_TYPES, ROW_TYPES, RESPONSES, RESPONSE_BASES
} from './lib/visit-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

/* 启动即校验 JWT_SECRET，不再只打印警告后照常启动。
   弱密钥可被用于自行签发 role='admin' 的合法令牌，无需密码即获得管理员权限。
   生成方式：openssl rand -hex 32 */
const KNOWN_WEAK_SECRETS = [
  'dev-secret', 'local-dev-secret-change-me', 'change-me', 'secret',
  'your-secret-key', 'jwt_secret', 'jwt-secret', '1234567890',
];
if (!JWT_SECRET) {
  console.error('❌ 缺少 JWT_SECRET：请在 .env 中配置（生成方式：openssl rand -hex 32）');
  process.exit(1);
}
if (JWT_SECRET.length < 32 || KNOWN_WEAK_SECRETS.includes(JWT_SECRET.toLowerCase())) {
  console.error('❌ JWT_SECRET 过弱或为已知占位值：需 ≥32 位且不得使用示例值（生成方式：openssl rand -hex 32）');
  process.exit(1);
}

/* ================= 目录与数据库初始化 ================= */
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const dbFile = process.env.DB_FILE || path.join(dataDir, 'clinical.db');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username     TEXT PRIMARY KEY,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'user',
  pass_hash    TEXT NOT NULL,
  created_at   TEXT,
  last_login   TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS patients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  age         INTEGER,
  diag_date   TEXT,
  gleason     TEXT,
  gleason_manual TEXT DEFAULT '',   /* 病理同步前的手工 Gleason，取消 primary 后回退 */
  stage       TEXT,                 /* 旧版单一分期：保留兼容 */
  clinical_stage   TEXT,            /* 临床分期 cTNM：风险分层唯一依据 */
  pathologic_stage TEXT,            /* 病理分期 pTNM：术后复发风险/病理特征 */
  pathologic_stage_manual TEXT DEFAULT '', /* 病理同步前的手工 pTNM */
  treatment   TEXT,
  concomitant_meds TEXT DEFAULT '', /* 合并用药（非抗肿瘤），用于相互作用提示 */
  status      TEXT,                 /* 旧版手填随访状态：保留兼容，不再参与自动判定 */
  followup_status TEXT DEFAULT '在访', /* 在访/失访/死亡：手工维护的随访终止状态 */
  created_at  TEXT,
  created_by  TEXT
);
CREATE TABLE IF NOT EXISTS psa_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  rec_date   TEXT NOT NULL,
  value      REAL NOT NULL,
  is_initial INTEGER DEFAULT 0,
  created_by TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL,
  filename    TEXT,
  stored_name TEXT NOT NULL,
  upload_date TEXT,
  uploaded_by TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
/* P2-15：统一文件索引。原表仍是所有者，file_assets 只做跨来源索引、
   生命周期/去重/备份清单；不替代 reports/timeline_images/ai_intake_files。 */
CREATE TABLE IF NOT EXISTS file_assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT,
  source      TEXT NOT NULL,
  source_id   INTEGER,
  stored_name TEXT NOT NULL,
  filename    TEXT DEFAULT '',
  mime        TEXT DEFAULT '',
  bytes       INTEGER DEFAULT 0,
  sha256      TEXT DEFAULT '',
  created_by  TEXT,
  created_at  TEXT,
  deleted_at  TEXT,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_file_assets_patient ON file_assets(patient_id);
CREATE INDEX IF NOT EXISTS idx_file_assets_sha ON file_assets(sha256);
CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT,
  username TEXT,
  action   TEXT,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_psa_patient ON psa_records(patient_id);
CREATE INDEX IF NOT EXISTS idx_report_patient ON reports(patient_id);
CREATE TABLE IF NOT EXISTS timeline_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL,
  event_date  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  gleason     TEXT,
  stage       TEXT,
  is_surgery  INTEGER NOT NULL DEFAULT 0,
  psa_record_id INTEGER,
  notes       TEXT,
  created_by  TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS timeline_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL,
  filename    TEXT,
  stored_name TEXT NOT NULL,
  upload_date TEXT,
  uploaded_by TEXT,
  FOREIGN KEY(event_id) REFERENCES timeline_events(id) ON DELETE CASCADE
);
/* 药物使用记录：一条 = 一种药物/方案的一次连续使用。
   同一大类内 start_date/end_date 不允许重叠；比卡鲁胺/氟他胺/尼鲁米特（内分泌）
   不能与 ARPI 同期。时间轴按“每个治疗大类一条泳道”绘制，同类内按停药/换药顺序排列。
   end_date 为空表示仍在用。category 存分类 key，便于前端配色和统计。 */
CREATE TABLE IF NOT EXISTS medication_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL,
  category    TEXT NOT NULL,
  drug_name   TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT,
  dose        TEXT DEFAULT '',
  schedule    TEXT DEFAULT '',
  line_id     INTEGER,
  source      TEXT DEFAULT 'manual',
  notes       TEXT DEFAULT '',
  created_by  TEXT,
  created_at  TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
/* 治疗线：一条 = 一个治疗情境下的一线方案；具体药物在 treatment_agents。
   与“首选治疗”单值不同，治疗线可表达手术+ADT、放疗+ADT、ADT+ARPI+化疗等联合方案。 */
CREATE TABLE IF NOT EXISTS treatment_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  setting     TEXT NOT NULL,        /* 新辅助/辅助/挽救/mHSPC/nmCRPC/mCRPC/局限治疗/主动监测/观察等待/其他 */
  regimen     TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT,
  stop_reason TEXT DEFAULT '',
  response    TEXT DEFAULT '',
  created_by  TEXT,
  created_at  TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS treatment_agents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id    INTEGER NOT NULL,
  drug       TEXT NOT NULL,
  dose       TEXT DEFAULT '',
  schedule   TEXT DEFAULT '',
  start_date TEXT,
  end_date   TEXT,
  FOREIGN KEY(line_id) REFERENCES treatment_lines(id) ON DELETE CASCADE
);
/* 结构化监测记录：骨健康/心血管代谢/生活质量/药物监测勾选统一存放。
   category: bone / cardio / qol / monitor；item 为具体项目（如 DEXA_T、FRAX_HIP、IPSS、药名·血常规）。 */
CREATE TABLE IF NOT EXISTS clinical_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL,
  category    TEXT NOT NULL,
  item        TEXT NOT NULL,
  rec_date    TEXT NOT NULL,
  value       REAL,
  unit        TEXT DEFAULT '',
  status      TEXT DEFAULT '',      /* 未做/已完成/异常 */
  note        TEXT DEFAULT '',
  created_by  TEXT,
  created_at  TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
/* 普通化验：一个项目一行；DEXA/FRAX/IPSS 等监测项仍放 clinical_records。
   event_id 指向当天汇总的“化验/监测”时间轴事件，该事件是投影，不是数据源。 */
CREATE TABLE IF NOT EXISTS lab_values (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL,
  rec_date    TEXT NOT NULL,
  item_code   TEXT NOT NULL,
  item_label  TEXT DEFAULT '',
  value       REAL,
  unit        TEXT DEFAULT '',
  lab         TEXT DEFAULT '',
  method      TEXT DEFAULT '',
  ref_range   TEXT DEFAULT '',
  flag        TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  source      TEXT DEFAULT 'manual',
  event_id    INTEGER,
  created_by  TEXT,
  created_at  TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES timeline_events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_values_patient ON lab_values(patient_id, rec_date);
CREATE INDEX IF NOT EXISTS idx_lab_values_item ON lab_values(patient_id, item_code, rec_date);
CREATE INDEX IF NOT EXISTS idx_lab_values_event ON lab_values(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_tl_line_patient ON treatment_lines(patient_id);
CREATE INDEX IF NOT EXISTS idx_ta_line ON treatment_agents(line_id);
CREATE INDEX IF NOT EXISTS idx_cr_patient ON clinical_records(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_owner ON patients(created_by);
CREATE INDEX IF NOT EXISTS idx_tl_event_patient ON timeline_events(patient_id);
CREATE INDEX IF NOT EXISTS idx_tl_img_event ON timeline_images(event_id);
CREATE INDEX IF NOT EXISTS idx_med_patient ON medication_records(patient_id);
CREATE INDEX IF NOT EXISTS idx_med_dates ON medication_records(patient_id, start_date);

/* ================= 结构化专病数据（2026-10-20） =================
   病理/影像/放疗/结局与病程事件一对一；样本/IHC/基因组为科研层。
   全部 patient_id 级联删除；事件删除时病理/影像/放疗级联，
   结局 SET NULL 并由接口层阻止“有结局的事件被直接删除”。 */
CREATE TABLE IF NOT EXISTS pathology_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  event_id INTEGER,
  specimen_type TEXT NOT NULL DEFAULT 'unknown',
  report_date TEXT NOT NULL,
  cores_total INTEGER,
  cores_positive INTEGER,
  cores_positive_pct REAL,
  gleason_primary INTEGER,
  gleason_secondary INTEGER,
  gleason_total INTEGER,
  isup INTEGER,
  ptnm TEXT DEFAULT '',
  margin_status TEXT DEFAULT 'unknown',
  margin_site TEXT DEFAULT '',
  ece INTEGER,
  svi INTEGER,
  ln_positive INTEGER,
  ln_examined INTEGER,
  idc_p INTEGER,
  cribriform INTEGER,
  dac INTEGER,
  nepc INTEGER,
  nepc_detail TEXT DEFAULT '',
  pni INTEGER,
  tumor_volume_pct REAL,
  tumor_cell_pct REAL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES timeline_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imaging_studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  event_id INTEGER,
  modality TEXT NOT NULL DEFAULT 'other',
  study_date TEXT NOT NULL,
  region TEXT DEFAULT '',
  lesion_count INTEGER,
  metastatic_sites TEXT DEFAULT '',
  extra_pelvic INTEGER,
  new_lesion INTEGER,
  pirads INTEGER,
  psma_positive INTEGER,
  psma_suvmax REAL,
  psma_lesion_count INTEGER,
  recist TEXT DEFAULT '',
  pcwg TEXT DEFAULT '',
  flare INTEGER,
  oligo_status TEXT DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES timeline_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS radiation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  event_id INTEGER,
  rt_type TEXT NOT NULL DEFAULT 'other',
  start_date TEXT NOT NULL,
  end_date TEXT,
  dose_gy REAL,
  fractions INTEGER,
  target TEXT DEFAULT '',
  concurrent_adt INTEGER,
  adt_duration_months REAL,
  technique TEXT DEFAULT '',
  toxicity_grade TEXT DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES timeline_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS patient_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  event_id INTEGER,
  outcome_type TEXT NOT NULL,
  event_date TEXT NOT NULL,
  subtype TEXT DEFAULT '',
  basis TEXT DEFAULT '',
  psa_value REAL,
  imaging_negative INTEGER,
  metastatic_sites TEXT DEFAULT '',
  lesion_count INTEGER,
  oligo_status TEXT DEFAULT '',
  death_cause TEXT DEFAULT '',
  lost_reason TEXT DEFAULT '',
  last_contact_date TEXT,
  note TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES timeline_events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS specimens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  sample_type TEXT NOT NULL DEFAULT 'other',
  collection_date TEXT NOT NULL,
  timepoint TEXT DEFAULT '',
  treatment_status TEXT DEFAULT '',
  storage TEXT DEFAULT '',
  tumor_cell_pct REAL,
  nucleic_quality TEXT DEFAULT '',
  library_id TEXT DEFAULT '',
  biobank_id TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS genomic_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  specimen_id INTEGER,
  test_type TEXT NOT NULL DEFAULT 'somatic',
  test_date TEXT NOT NULL,
  lab TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  genes TEXT DEFAULT '',
  hrr_status TEXT DEFAULT '',
  msi_status TEXT DEFAULT '',
  tmb_value REAL,
  ar_status TEXT DEFAULT '',
  tp53_status TEXT DEFAULT '',
  pten_status TEXT DEFAULT '',
  rb1_status TEXT DEFAULT '',
  result_summary TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(specimen_id) REFERENCES specimens(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ihc_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  specimen_id INTEGER,
  marker TEXT NOT NULL,
  result TEXT DEFAULT '',
  percent REAL,
  intensity TEXT DEFAULT '',
  test_date TEXT,
  lab TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(specimen_id) REFERENCES specimens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_path_event ON pathology_reports(event_id) WHERE event_id IS NOT NULL;
/* 活检与手术病理各自可以有一份“主要”：临床风险用 primary 活检，
   pTNM 用 primary RP/TURP；不能因为标记 RP 主要就把活检主要挤掉。 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_path_primary_scope ON pathology_reports(patient_id, specimen_type) WHERE is_primary=1;
CREATE INDEX IF NOT EXISTS idx_path_patient_date ON pathology_reports(patient_id, report_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_img_event ON imaging_studies(event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_img_current ON imaging_studies(patient_id) WHERE is_current=1;
CREATE INDEX IF NOT EXISTS idx_img_patient_date ON imaging_studies(patient_id, study_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rt_event ON radiation_records(event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rt_current ON radiation_records(patient_id) WHERE is_current=1;
CREATE INDEX IF NOT EXISTS idx_rt_patient_date ON radiation_records(patient_id, start_date);
CREATE INDEX IF NOT EXISTS idx_outcome_patient ON patient_outcomes(patient_id, outcome_type, event_date);
CREATE INDEX IF NOT EXISTS idx_spec_patient ON specimens(patient_id, collection_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_biobank ON specimens(biobank_id) WHERE biobank_id<>'';
CREATE INDEX IF NOT EXISTS idx_gen_patient ON genomic_tests(patient_id, test_date);
CREATE INDEX IF NOT EXISTS idx_ihc_patient ON ihc_results(patient_id, marker);
`);

/* ---- 2026-10 结构化字段细化：影像按检查类型、病理按标本类型补齐 ----
   幂等：只加缺的列，不动既有数据。字段依据 CSCO 2026 第3.2/3.3/3.4/3.5.2 章
   （mpMRI 的 PI-RADS/ECE/SVI、骨扫描的灶数/超级骨显像、胸CT 的肺结节、
   PSMA 的 miTNM/PSMA-RADS/决策影响、穿刺的单针癌占比与路径、病理的组织学类型）。 */
{
  const ensure = (table, defs) => {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
    defs.forEach(([name, decl]) => {
      if (!cols.includes(name)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + decl);
    });
  };
  ensure('imaging_studies', [
    ['technique', "TEXT DEFAULT ''"],           /* 场强/序列、示踪剂、扫描范围 */
    ['index_location', "TEXT DEFAULT ''"],      /* 主病灶位置（左右×基底/中/尖×带） */
    ['index_size_mm', 'REAL'],                  /* 主病灶最大径 */
    ['ece', 'INTEGER'],                         /* 包膜外侵犯（MRI） */
    ['svi', 'INTEGER'],                         /* 精囊侵犯（MRI） */
    ['prostate_volume_ml', 'REAL'],             /* 前列腺体积，PSAD 分母 */
    ['ln_short_axis_mm', 'REAL'],               /* 可疑淋巴结短径 */
    ['superscan', 'INTEGER'],                   /* 超级骨显像 */
    ['lung_nodule_count', 'INTEGER'],           /* 胸部CT 肺结节数 */
    ['lung_nodule_max_mm', 'REAL'],             /* 胸部CT 最大结节径 */
    ['mi_tnm', "TEXT DEFAULT ''"],              /* PSMA 分子影像分期 */
    ['psma_rads', "TEXT DEFAULT ''"],           /* PSMA-RADS 1–5 */
    ['changed_management', 'INTEGER'],          /* 是否改变治疗决策 */
    ['comparison', "TEXT DEFAULT ''"],          /* 与旧片比较：new/progress/stable/improved */
    /* 2026-10-31：MRI 只让医生填三径（cm），体积由 0.52×三径 自动算。
       保留 prostate_volume_ml 作为计算结果与旧数据/外院报告的兜底。 */
    ['dim_transverse_cm', 'REAL'],              /* 横径/左右径 cm */
    ['dim_ap_cm', 'REAL'],                      /* 前后径 cm */
    ['dim_cranial_cm', 'REAL']                  /* 上下径 cm */
  ]);
  /* 2026-10-31：同一次「引导登记保存」产生的多条事件共用一个批号，
     时间轴据此把它们框成一组；手工/其他入口创建的事件批号为空。 */
  ensure('timeline_events', [
    ['guided_batch', "TEXT DEFAULT ''"]
  ]);
  ensure('pathology_reports', [
    ['cores_max_cancer_pct', 'REAL'],           /* 单针最大癌占比 */
    ['histology_type', "TEXT DEFAULT ''"],      /* 组织学类型：acinar/ductal/… */
    ['specimen_site', "TEXT DEFAULT ''"],       /* 转移灶/会诊标本取材部位 */
    ['biopsy_route', "TEXT DEFAULT ''"],        /* 经会阴/经直肠 */
    ['biopsy_guidance', "TEXT DEFAULT ''"]      /* 超声/MRI 融合/认知融合 */
  ]);
  /* 2026-10-31：直肠指检回到"建档基线"，不再作为一条检查事件。
     三态：'' 未做/未记录 / normal 正常 / abnormal 异常（可疑结节）。 */
  ensure('patients', [
    ['dre_result', "TEXT DEFAULT ''"],
    ['dre_note', "TEXT DEFAULT ''"],
    /* 2026-10-31：疾病阶段四分类（医生确认值）。
       ''=未判定；nmHSPC/mHSPC/nmCRPC/mCRPC。自动推断只作建议，不写库。 */
    ['disease_category', "TEXT DEFAULT ''"]
  ]);
  /* 一次性回填：把旧的「直肠指检(DRE)」事件搬进建档基线。
     只处理“备注能明确判断”的记录（质硬/结节→异常，未触及/正常→正常），
     空备注一律不动——把没写当成正常，正是这套数据最不该犯的错。
     幂等：只填 dre_result 仍为空的患者；事件本身保留，作为历史证据。 */
  const dreRows = db.prepare(`SELECT te.patient_id, te.notes FROM timeline_events te
                              JOIN patients p ON p.id = te.patient_id
                              WHERE te.event_type LIKE '%直肠指检%'
                                AND (p.dre_result IS NULL OR p.dre_result = '')
                              ORDER BY te.event_date DESC, te.id DESC`).all();
  const dreUpd = db.prepare("UPDATE patients SET dre_result=?, dre_note=? WHERE id=? AND (dre_result IS NULL OR dre_result='')");
  for (const r of dreRows) {
    const t = String(r.notes || '');
    let res = '';
    if (/异常|质硬|固定|结节|可疑/.test(t)) res = 'abnormal';
    else if (/正常|未触及|阴性|未见/.test(t)) res = 'normal';
    if (res) dreUpd.run(res, t.slice(0, 200), r.patient_id);
  }
  /* 2026-10-31：「前列腺穿刺活检」与「穿刺病理报告」合并为
     「前列腺穿刺活检病理报告」——一次穿刺本来就是"取材+病理"同一件事，
     拆两条会让医生在两处各填一半，也让时间轴同一天出现两条重复节点。
     只改名，不删不去重：同一天历史遗留的两条会并存，证据不丢。 */
  db.prepare(`UPDATE timeline_events SET event_type = '前列腺穿刺活检病理报告'
              WHERE event_type IN ('前列腺穿刺活检', '穿刺病理报告')`).run();
}

/* ---- 结构化专病数据迁移：患者基线/科研合规字段 + 治疗线编码（幂等） ---- */
{
  const cols = db.prepare('PRAGMA table_info(patients)').all().map(c => c.name);
  const add = (name, decl) => { if (!cols.includes(name)) db.exec('ALTER TABLE patients ADD COLUMN ' + name + ' ' + decl); };
  add('family_history', 'INTEGER');
  add('family_history_detail', "TEXT DEFAULT ''");
  add('ecog', 'INTEGER');
  add('charlson', 'INTEGER');
  add('bmi', 'REAL');
  add('smoking', "TEXT DEFAULT ''");
  add('race', "TEXT DEFAULT ''");
  add('ethnicity', "TEXT DEFAULT ''");
  add('center_id', "TEXT DEFAULT ''");
  add('research_consent', 'INTEGER');
  add('research_consent_date', 'TEXT');
  add('research_consent_version', "TEXT DEFAULT ''");
  add('data_sharing', 'INTEGER');
  add('data_sharing_scope', "TEXT DEFAULT ''");
  add('data_sharing_date', 'TEXT');
  add('last_followup_mode', "TEXT DEFAULT ''");
  /* 2026-10-21 病理主档来源追踪：临床 Gleason 来自活检、pTNM 来自 RP/TURP primary。
     source 为空表示旧数据未识别；manual 表示档案手工输入；pathology:<id> 表示病理同步。 */
  add('gleason_source', "TEXT DEFAULT ''");
  add('pathologic_stage_source', "TEXT DEFAULT ''");
  /* 2026-10-21 审计 P0-01：病理同步前的手工值单独留一份，
     取消/删除 primary 病理后回退，不再静默清空或丢失原值。 */
  add('gleason_manual', "TEXT DEFAULT ''");
  add('pathologic_stage_manual', "TEXT DEFAULT ''");
  /* 旧索引限制每个患者只能有一份 primary，导致标记 RP 主要后活检主要被清掉。
     改为按标本类型各保留一份；旧库先删旧索引，数据本身不动。 */
  db.exec('DROP INDEX IF EXISTS idx_path_primary');

  const tlCols = db.prepare('PRAGMA table_info(treatment_lines)').all().map(c => c.name);
  if (!tlCols.includes('stop_reason_code')) db.exec("ALTER TABLE treatment_lines ADD COLUMN stop_reason_code TEXT DEFAULT ''");
  if (!tlCols.includes('response_code')) db.exec("ALTER TABLE treatment_lines ADD COLUMN response_code TEXT DEFAULT ''");
}

/* ---- 药物分类迁移：比卡鲁胺等一代抗雄激素从 ADT 拆到「内分泌」，
      钙+维生素D 从「骨保护」拆到「支持治疗」。幂等，重复启动不会重复计数。 */
{
  const movedEndo = db.prepare(
    "UPDATE medication_records SET category='endocrine' WHERE category='adt' AND drug_name IN ('比卡鲁胺','氟他胺','尼鲁米特')"
  ).run().changes;
  const movedSupport = db.prepare(
    "UPDATE medication_records SET category='support' WHERE category='bone' AND drug_name='钙+维生素D'"
  ).run().changes;
  if (movedEndo || movedSupport) {
    console.log('🔧 药物分类迁移：内分泌 ' + movedEndo + ' 条，支持治疗 ' + movedSupport + ' 条');
  }
}

/* ---- 结构升级迁移：出生日期 / 手术日期（对已有库幂等，可重复执行）----
   旧库只有 age 列；升级后新录入用 birth_date 动态算年龄，
   存量患者 birth_date 为 NULL，继续回退显示登记时的 age，不丢数据。 */
{
  const cols = db.prepare('PRAGMA table_info(patients)').all().map(c => c.name);
  if (!cols.includes('birth_date')) db.exec('ALTER TABLE patients ADD COLUMN birth_date TEXT');
  if (!cols.includes('surg_date'))  db.exec('ALTER TABLE patients ADD COLUMN surg_date TEXT');

  /* ---- CSCO 2026 对齐：治疗情境与随访管理字段（报告 P1 ⑧⑨⑩）----
     rt_end_date    放疗结束日期：指南 6.2 放疗后生化复发以「放疗后 PSA 最低值 +2」判定，
                    必须知道放疗何时结束才能切分治疗后序列（指南 PDF p118）。
     adt_start_date ADT 起始日期：切分内分泌治疗情境的 PSA 序列。
     last_followup_date 末次随访日期：第 10 章随访频次提醒与生存分析删失所必需
                    （指南 PDF p203、p207-208）。
     castration_status 是否处于去势状态：nmCRPC/mCRPC 诊断前提
                    （睾酮<50ng/dl 或 1.7nmol/L，指南 PDF p154/p158）。 */
  if (!cols.includes('rt_end_date'))       db.exec('ALTER TABLE patients ADD COLUMN rt_end_date TEXT');
  if (!cols.includes('adt_start_date'))    db.exec('ALTER TABLE patients ADD COLUMN adt_start_date TEXT');
  if (!cols.includes('last_followup_date')) db.exec('ALTER TABLE patients ADD COLUMN last_followup_date TEXT');
  if (!cols.includes('castration_status')) db.exec('ALTER TABLE patients ADD COLUMN castration_status INTEGER');

  /* ---- 临床/病理分期拆分（2026-10-19 第二轮）----
     风险分层必须用 cTNM；pTNM 只用于术后复发风险/病理特征。
     旧 stage 以 p 开头 → pathologic_stage，其余（c/无前缀）→ clinical_stage。
     不删除旧 stage，便于回滚与审计。 */
  const hadClinicalStage = cols.includes('clinical_stage');
  const hadPathStage = cols.includes('pathologic_stage');
  if (!hadClinicalStage) db.exec('ALTER TABLE patients ADD COLUMN clinical_stage TEXT');
  if (!hadPathStage) db.exec('ALTER TABLE patients ADD COLUMN pathologic_stage TEXT');
  if (!cols.includes('concomitant_meds')) db.exec("ALTER TABLE patients ADD COLUMN concomitant_meds TEXT DEFAULT ''");
  if (!hadClinicalStage || !hadPathStage) {
    db.prepare(`UPDATE patients SET clinical_stage=stage
                 WHERE (clinical_stage IS NULL OR clinical_stage='')
                   AND stage IS NOT NULL AND stage<>'' AND stage NOT LIKE 'p%'`).run();
    db.prepare(`UPDATE patients SET pathologic_stage=stage
                 WHERE (pathologic_stage IS NULL OR pathologic_stage='')
                   AND stage IS NOT NULL AND stage<>'' AND stage LIKE 'p%'`).run();
  }

  /* ---- 随访状态拆分（2026-10-19 临床反馈）----
     旧 status 把生命状态、疾病状态、随访状态混在一个下拉里；现在只保留
     “在访/失访/死亡”作为手工随访终止状态，疾病状态由前端 clinical-core
     根据 PSA/睾酮/分期/事件实时计算。旧 status 不删除，作为历史值展示。
     迁移只把死亡/失访映射过来，其余一律“在访”；幂等。 */
  const hadFollowupStatus = cols.includes('followup_status');
  if (!hadFollowupStatus) {
    db.exec("ALTER TABLE patients ADD COLUMN followup_status TEXT DEFAULT '在访'");
    /* 首次迁移：把旧 status 里的死亡/失访映射过来；此后不再覆盖，
       否则医生手工把“死亡”改回“在访”后，下次启动又会被改回去。 */
    db.prepare(`UPDATE patients
                   SET followup_status = CASE
                         WHEN status='死亡' THEN '死亡'
                         WHEN status='失访' THEN '失访'
                         ELSE '在访'
                       END`).run();
  } else {
    db.prepare(`UPDATE patients SET followup_status='在访'
                 WHERE followup_status IS NULL OR followup_status=''`).run();
  }

  /* ---- 转移负荷字段（报告 P1 ⑫）----
     指南 7.2：高瘤负荷 = ≥4 个骨转移灶（其中≥1 个位于盆腔或脊柱以外）或内脏转移（CHAARTED，PDF p131）；
     寡转移 = 传统影像 1~5 处 / PSMA-PET 1~10 处，分同时性（初诊即有）与异时性（治疗后随访出现，PDF p135）。
     没有这几个字段就无法落地 2026 版新增的寡转移/瘤负荷分层治疗推荐。 */
  if (!cols.includes('met_count'))        db.exec('ALTER TABLE patients ADD COLUMN met_count INTEGER');
  if (!cols.includes('met_extra_pelvis')) db.exec('ALTER TABLE patients ADD COLUMN met_extra_pelvis INTEGER');
  if (!cols.includes('visceral_met'))     db.exec('ALTER TABLE patients ADD COLUMN visceral_met INTEGER');
  if (!cols.includes('oligo_type'))       db.exec("ALTER TABLE patients ADD COLUMN oligo_type TEXT DEFAULT ''");

  /* 三态字段历史 0 值迁移（P0-1）
     旧 schema 给 castration_status / met_count / met_extra_pelvis / visceral_met
     加了 DEFAULT 0。0 在业务语义里是「明确阴性/零转移」，但旧数据里绝大多数只是
     建表默认值，医生从未评估过；继续保留会把「未评估」伪装成「明确阴性」。
     迁移策略：一次性把 0 归零为 NULL（未评估）。M0 的「无转移」由分期表达，
     不再依赖 met_count=0；医生如确需明确阴性，重新在界面选择即可。
     ⚠ 必须用 meta 标记保证只跑一次：否则医生后来明确选择的 0（否/零转移）
       会在每次重启时被重新清成 NULL。 */
  {
    const TRI_MIG_KEY = 'tri_state_0_to_null_v1';
    const done = db.prepare('SELECT value FROM meta WHERE key=?').get(TRI_MIG_KEY);
    if (!done) {
      const fixed = db.transaction(() => {
        const r = {
          castration: db.prepare('UPDATE patients SET castration_status=NULL WHERE castration_status=0').run().changes,
          metCount: db.prepare('UPDATE patients SET met_count=NULL WHERE met_count=0').run().changes,
          extraPelvic: db.prepare('UPDATE patients SET met_extra_pelvis=NULL WHERE met_extra_pelvis=0').run().changes,
          visceral: db.prepare('UPDATE patients SET visceral_met=NULL WHERE visceral_met=0').run().changes
        };
        db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(TRI_MIG_KEY, '1');
        return r;
      })();
      const total = fixed.castration + fixed.metCount + fixed.extraPelvic + fixed.visceral;
      if (total) {
        console.log('🔧 三态迁移（一次性）：castration=' + fixed.castration +
          '，metCount=' + fixed.metCount + '，extraPelvic=' + fixed.extraPelvic +
          '，visceral=' + fixed.visceral + '（0 → NULL，未评估）');
      }
    }
  }

  /* oligo_type 词表迁移（P0-2）
     历史上档案页用中文三值、影像结构化用英文 code；统一为
     none / oligo / oligo_sync / oligo_meta / widespread / unknown，
     页面只负责显示中文标签。oligo_sync / oligo_meta 保留同时/异时信息，
     clinical-core 与影像的 oligo（未分型）都按低瘤负荷处理。
     幂等：已经是英文 code 的行不会被改。 */
  {
    const toSync = db.prepare("UPDATE patients SET oligo_type='oligo_sync' WHERE oligo_type='同时性寡转移/低瘤负荷'").run().changes;
    const toMeta = db.prepare("UPDATE patients SET oligo_type='oligo_meta' WHERE oligo_type='异时性寡转移/低瘤负荷'").run().changes;
    const toWide = db.prepare("UPDATE patients SET oligo_type='widespread' WHERE oligo_type='高瘤负荷'").run().changes;
    if (toSync || toMeta || toWide) console.log('🔧 oligo_type 迁移：sync=' + toSync + '，meta=' + toMeta + '，widespread=' + toWide);
  }
}

/* ---- 用药记录补 dose/schedule 列（P0-4）
   AI 抽取与审核界面一直能编辑剂量/频次，但表里没有列，采纳时被静默丢弃。
   旧库幂等补列；新库在建表语句里已包含。 */
{
  const cols = db.prepare('PRAGMA table_info(medication_records)').all().map(c => c.name);
  if (!cols.includes('dose')) db.exec("ALTER TABLE medication_records ADD COLUMN dose TEXT DEFAULT ''");
  if (!cols.includes('schedule')) db.exec("ALTER TABLE medication_records ADD COLUMN schedule TEXT DEFAULT ''");
  if (!cols.includes('line_id')) db.exec('ALTER TABLE medication_records ADD COLUMN line_id INTEGER');
  if (!cols.includes('source')) db.exec("ALTER TABLE medication_records ADD COLUMN source TEXT DEFAULT 'manual'");
}

/* P2-18：SBP/DBP 旧目录 -> BP_SYS/BP_DIA。
   同日同分类下若已有 canonical 行，合并 note 后删旧行；否则改 item。
   幂等；只在存在历史别名时执行。 */
{
  const rows = db.prepare(`SELECT * FROM clinical_records WHERE item IN ('SBP','DBP')`).all();
  let updated = 0, merged = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const item = canonicalClinicalItem(row.item);
      if (!item || item === row.item) continue;
      const dup = db.prepare(`SELECT id, note FROM clinical_records
          WHERE patient_id=? AND category=? AND item=? AND rec_date=? AND id<>? LIMIT 1`)
        .get(row.patient_id, row.category, item, row.rec_date, row.id);
      if (dup) {
        const note = [dup.note, row.note].filter(Boolean).join('\n').slice(0, 1000);
        db.prepare('UPDATE clinical_records SET note=? WHERE id=?').run(note, dup.id);
        db.prepare('DELETE FROM clinical_records WHERE id=?').run(row.id);
        merged++;
      } else {
        db.prepare('UPDATE clinical_records SET item=? WHERE id=?').run(item, row.id);
        updated++;
      }
    }
  });
  if (rows.length) {
    tx();
    if (updated || merged) console.log('🔧 临床项目别名迁移：更新 ' + updated + ' 条，合并 ' + merged + ' 条 SBP/DBP');
  }
}

/* P2-17：旧 patients.stage 单值回填到临床/病理分期。
   仅在两个新字段都为空时执行；无法判断 c/p 的保留旧值，不硬塞。
   stage 列保留一版只读，方便回滚和对照。 */
{
  const rows = db.prepare(`SELECT id, stage, clinical_stage, pathologic_stage FROM patients
                           WHERE stage IS NOT NULL AND stage <> ''
                             AND (clinical_stage IS NULL OR clinical_stage='')
                             AND (pathologic_stage IS NULL OR pathologic_stage='')`).all();
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const s = String(r.stage).trim();
      if (!s) continue;
      if (/^p/i.test(s)) {
        db.prepare('UPDATE patients SET pathologic_stage=? WHERE id=?').run(s, r.id);
        n++;
      } else if (/^c/i.test(s) || /^(I|II|III|IV)[A-C]?$/i.test(s)) {
        db.prepare('UPDATE patients SET clinical_stage=? WHERE id=?').run(s, r.id);
        n++;
      }
    }
  });
  if (rows.length) { tx(); if (n) console.log('🔧 旧版 stage 回填：' + n + ' 位患者'); }
}

/* ---- 时间轴镜像溯源列：睾酮 / 化验记录 → 事件（与 psa_record_id 同语义）----
   details         医生录入内容摘要（JSON 文本）：睾酮值、化验项目/数值/文字描述。
                   时间轴节点必须点开就能看到「测出来是多少」，否则「睾酮检测」
                   这个节点只剩类型和日期，数值还得回编辑面板翻记录才能对上。
   testo_record_id 该事件是哪条睾酮记录的投影；lab_record_id 同理。
                   有了溯源才能维持「记录是唯一数据源」：删记录事件跟着走、
                   改记录日期事件跟着改、事件本身拒绝单独改期改名。 */
{
  const cols = db.prepare('PRAGMA table_info(timeline_events)').all().map(c => c.name);
  if (!cols.includes('details'))         db.exec('ALTER TABLE timeline_events ADD COLUMN details TEXT');
  if (!cols.includes('testo_record_id')) db.exec('ALTER TABLE timeline_events ADD COLUMN testo_record_id INTEGER');
  if (!cols.includes('lab_record_id'))   db.exec('ALTER TABLE timeline_events ADD COLUMN lab_record_id INTEGER');
  if (!cols.includes('notes'))           db.exec('ALTER TABLE timeline_events ADD COLUMN notes TEXT');
}

/* ---- CSCO 2026 对齐：睾酮与化验记录表（报告 P1 ⑨、P2 ⑲⑳）----
   指南 8.1/8.2.1 的去势抵抗诊断以血清睾酮为前提（<50ng/dl 或 1.7nmol/L），
   第 10 章综合治疗后随访把「血清睾酮水平」列为 I 级推荐内容（PDF p203），
   此前只有事件类型没有数值字段，测了也无处存、无法参与判定。
   labs_records 承载骨密度 T 值、FRAX、肌酐/血红蛋白/肝功能、CTC/CEA/CGA/NSE、
   血常规/神经系统/血脂/皮疹等监测值，对应指南第 10 章随访表与药物不良反应监测表。 */
db.exec(`
CREATE TABLE IF NOT EXISTS testosterone_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  rec_date   TEXT NOT NULL,
  value      REAL NOT NULL,          /* 规范值：血清睾酮 ng/dl */
  unit       TEXT DEFAULT 'ng/dl',   /* 录入单位：ng/dl 或 nmol/L */
  entered_value REAL,                /* 录入值（按 unit 原样保存，便于回显） */
  assay_method TEXT DEFAULT '',      /* RIA / CLIA / LC-MS/MS / 其他 */
  lab          TEXT DEFAULT '',      /* 实验室 */
  sample_time  TEXT DEFAULT '',      /* 采血时间 HH:mm */
  created_by TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS labs_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  rec_date   TEXT NOT NULL,
  item       TEXT NOT NULL,          /* 如：骨密度T值 / FRAX / 肌酐 / 血红蛋白 / 肝功能 / CTC / CEA / CGA / NSE / 血常规 / 神经系统 / 血脂 / 皮疹 */
  value      REAL,
  note       TEXT DEFAULT '',
  created_by TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_testo_patient ON testosterone_records(patient_id);
CREATE INDEX IF NOT EXISTS idx_labs_patient ON labs_records(patient_id);
`);

/* ---- 睾酮单位迁移（2026-10-19 临床反馈）----
   本院常用 mmol/L；value 继续存规范 ng/dl，unit/entered_value 保存录入口径。
   旧数据全部是 ng/dl，回填 entered_value=value、unit='ng/dl'。幂等。 */
{
  const cols = db.prepare('PRAGMA table_info(testosterone_records)').all().map(c => c.name);
  if (!cols.includes('unit')) {
    db.exec("ALTER TABLE testosterone_records ADD COLUMN unit TEXT DEFAULT 'ng/dl'");
  }
  if (!cols.includes('entered_value')) {
    db.exec('ALTER TABLE testosterone_records ADD COLUMN entered_value REAL');
  }
  if (!cols.includes('assay_method')) db.exec("ALTER TABLE testosterone_records ADD COLUMN assay_method TEXT DEFAULT ''");
  if (!cols.includes('lab')) db.exec("ALTER TABLE testosterone_records ADD COLUMN lab TEXT DEFAULT ''");
  if (!cols.includes('sample_time')) db.exec("ALTER TABLE testosterone_records ADD COLUMN sample_time TEXT DEFAULT ''");
  db.prepare("UPDATE testosterone_records SET entered_value=value WHERE entered_value IS NULL").run();
  db.prepare("UPDATE testosterone_records SET unit='ng/dl' WHERE unit IS NULL OR unit=''").run();
}

/* ---- CSCO 2026 对齐：PSA 低于检测下限的左删失标记（报告 P1 ⑪）----
   指南 6.1 注释 a 以「术后 6 周血清 PSA 下降至 0.03ng/ml 以下」为临床治愈判据，
   第 10 章注释 b 写「根治性手术后 6 周内应检测不到 PSA 水平」（PDF p112、p206）。
   「检测不到」是指南的正式判定用语，REAL NOT NULL 的 value 列无法表达：
   存 0 会让对数回归崩溃，存 0.03 会高估。故加 is_below_lod 标记 + lod_value 存当次下限。 */
{
  const cols = db.prepare('PRAGMA table_info(psa_records)').all().map(c => c.name);
  if (!cols.includes('is_below_lod')) db.exec('ALTER TABLE psa_records ADD COLUMN is_below_lod INTEGER DEFAULT 0');
  if (!cols.includes('lod_value'))    db.exec('ALTER TABLE psa_records ADD COLUMN lod_value REAL');
}

/* ---- 游离PSA（fPSA / F-PSA / free PSA）支持（2026-10-28 临床需求）----
   化验单常同时报告总PSA（T-PSA）与游离PSA（F-PSA），临床上有意义的是
   游离/总比值（f/t PSA）：比值偏低提示恶性可能更高，是灰区（4~10ng/mL）
   鉴别的重要参考。因此：
   · free_value      游离PSA数值（可选——化验单未必两项都报）
   · free_below_lod  游离值低于检测下限的左删失标记（与总PSA同一套语义）
   · free_lod_value  游离项当次检测下限
   存量记录三项全为 NULL，表示「该次未录游离」，前端不显示比值。
   ⚠ f/t 比值不落库、也不由前端或 AI 计算：比值是派生量，
   存库会在改值后失同步；统一在 buildPatient 读取时按当前值现算。
   ⚠ 总PSA或游离PSA任一低于检测下限时不计算比值：「<0.010」只给出上界，
   用上界值相除会得到一个看似精确实则无意义的数（如 0.010/0.006 会被
   误读成比值异常），宁可不显示也不能给假精度。 */
{
  const cols = db.prepare('PRAGMA table_info(psa_records)').all().map(c => c.name);
  if (!cols.includes('free_value'))      db.exec('ALTER TABLE psa_records ADD COLUMN free_value REAL');
  if (!cols.includes('free_below_lod'))  db.exec('ALTER TABLE psa_records ADD COLUMN free_below_lod INTEGER DEFAULT 0');
  if (!cols.includes('free_lod_value'))  db.exec('ALTER TABLE psa_records ADD COLUMN free_lod_value REAL');
}

/* =========================================================
 * v13：以记录册为骨架的就诊/治疗段/毒性模型
 * ---------------------------------------------------------
 * 新增表全部与 patients 级联；旧表不删不改类型。
 * 设计见 docs/网站修改计划_2026-11-04.md。
 * ========================================================= */
db.exec(`
/* 治疗段：记录册的一段（RP/RT/ADT/SYSTEMIC/CHEMO/AS/WW/OTHER）。
   一个患者可同时有多段；systemic 段通过 line_id 关联治疗线。 */
CREATE TABLE IF NOT EXISTS treatment_episodes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id            TEXT NOT NULL,
  episode_type          TEXT NOT NULL,
  template_code         TEXT NOT NULL,
  label                 TEXT DEFAULT '',
  intent                TEXT DEFAULT 'radical',
  line_id               INTEGER,
  guideline_scenario    TEXT DEFAULT '',
  guideline_option_id   TEXT DEFAULT '',
  recommendation_level  TEXT DEFAULT '',
  guideline_ref         TEXT DEFAULT '',
  start_date            TEXT NOT NULL,
  end_date              TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  stop_reason_code      TEXT DEFAULT '',
  followup_interval_days INTEGER,
  source                TEXT DEFAULT 'manual',
  notes                 TEXT DEFAULT '',
  created_by            TEXT,
  created_at            TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(line_id) REFERENCES treatment_lines(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_patient ON treatment_episodes(patient_id, status, start_date);
CREATE INDEX IF NOT EXISTS idx_episodes_line ON treatment_episodes(line_id);

/* 一次就诊：一个日期、一份小结；可覆盖多个治疗段。 */
CREATE TABLE IF NOT EXISTS visits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id        TEXT NOT NULL,
  visit_date        TEXT NOT NULL,
  visit_type        TEXT NOT NULL DEFAULT 'outpatient',
  department        TEXT DEFAULT '',
  physician         TEXT DEFAULT '',
  chief_complaint   TEXT DEFAULT '',
  ecog              INTEGER,
  pain_nrs          INTEGER,
  summary           TEXT DEFAULT '',
  next_plan         TEXT DEFAULT '',
  next_visit_date   TEXT,
  mdt_participants  TEXT DEFAULT '',
  mdt_conclusion    TEXT DEFAULT '',
  source            TEXT DEFAULT 'manual',
  status            TEXT NOT NULL DEFAULT 'final',
  created_by        TEXT,
  created_at        TEXT,
  updated_at        TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_visits_patient_date ON visits(patient_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_type ON visits(patient_id, visit_type);

/* 就诊-治疗段行：记录册“一次门诊 = 一段一行”。 */
CREATE TABLE IF NOT EXISTS visit_episode_rows (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id          INTEGER NOT NULL,
  episode_id        INTEGER NOT NULL,
  visit_no          INTEGER,
  row_type          TEXT NOT NULL DEFAULT 'followup',
  overall_response  TEXT DEFAULT 'NA',
  response_basis    TEXT DEFAULT 'none',
  psa_response      TEXT DEFAULT 'NA',
  imaging_response  TEXT DEFAULT 'NA',
  clinical_response TEXT DEFAULT 'NA',
  ecog              INTEGER,
  pain_nrs          INTEGER,
  symptom_status    TEXT DEFAULT '',
  summary           TEXT DEFAULT '',
  notes             TEXT DEFAULT '',
  next_visit_date   TEXT,
  created_at        TEXT,
  FOREIGN KEY(visit_id) REFERENCES visits(id) ON DELETE CASCADE,
  FOREIGN KEY(episode_id) REFERENCES treatment_episodes(id) ON DELETE CASCADE,
  UNIQUE(visit_id, episode_id, row_type)
);
CREATE INDEX IF NOT EXISTS idx_rows_visit ON visit_episode_rows(visit_id);
CREATE INDEX IF NOT EXISTS idx_rows_episode ON visit_episode_rows(episode_id, visit_no);

/* 本次应做/实际做清单：不是结果表，结果仍在 PSA/影像/化验/AE。 */
CREATE TABLE IF NOT EXISTS visit_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id        INTEGER NOT NULL,
  episode_row_id  INTEGER,
  item_code       TEXT NOT NULL,
  item_label      TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',
  reason          TEXT DEFAULT '',
  due_date        TEXT,
  linked_table    TEXT DEFAULT '',
  linked_id       INTEGER,
  source          TEXT DEFAULT 'template',
  created_at      TEXT,
  FOREIGN KEY(visit_id) REFERENCES visits(id) ON DELETE CASCADE,
  FOREIGN KEY(episode_row_id) REFERENCES visit_episode_rows(id) ON DELETE CASCADE,
  UNIQUE(visit_id, episode_row_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_items_visit ON visit_items(visit_id);
CREATE INDEX IF NOT EXISTS idx_items_row ON visit_items(episode_row_id);

/* 化疗周期块（记录册 p55 / p97）。 */
CREATE TABLE IF NOT EXISTS chemo_cycles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id        TEXT NOT NULL,
  episode_id        INTEGER NOT NULL,
  line_id           INTEGER,
  cycle_no          INTEGER NOT NULL,
  cycle_date        TEXT NOT NULL,
  regimen           TEXT DEFAULT '',
  agents_json       TEXT DEFAULT '[]',
  bsa               REAL,
  planned_dose      TEXT DEFAULT '',
  actual_dose       TEXT DEFAULT '',
  dose_reduction_pct REAL,
  delay_days        INTEGER,
  delay_reason      TEXT DEFAULT '',
  gcsf              INTEGER DEFAULT 0,
  ecog              INTEGER,
  psa_record_id     INTEGER,
  assessment_visit_id INTEGER,
  next_cycle_date   TEXT,
  notes             TEXT DEFAULT '',
  created_by        TEXT,
  created_at        TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(episode_id) REFERENCES treatment_episodes(id) ON DELETE CASCADE,
  FOREIGN KEY(line_id) REFERENCES treatment_lines(id) ON DELETE SET NULL,
  FOREIGN KEY(assessment_visit_id) REFERENCES visits(id) ON DELETE SET NULL,
  UNIQUE(episode_id, cycle_no)
);
CREATE INDEX IF NOT EXISTS idx_chemo_patient ON chemo_cycles(patient_id, cycle_date);
CREATE INDEX IF NOT EXISTS idx_chemo_episode ON chemo_cycles(episode_id, cycle_no);

/* 不良事件：grade NULL=未评估，0=评估为无。 */
CREATE TABLE IF NOT EXISTS adverse_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id        TEXT NOT NULL,
  visit_id          INTEGER,
  episode_row_id    INTEGER,
  chemo_cycle_id    INTEGER,
  episode_id        INTEGER,
  term_code         TEXT NOT NULL,
  term_label        TEXT DEFAULT '',
  grade             INTEGER,
  ctcae_version     TEXT DEFAULT 'CTCAE 5.0',
  grade_basis       TEXT DEFAULT '',
  onset_date         TEXT,
  resolution_date   TEXT,
  recovery_status   TEXT DEFAULT 'unknown',
  aux_meds          TEXT DEFAULT '',
  management        TEXT DEFAULT '',
  action            TEXT DEFAULT 'none',
  causality         TEXT DEFAULT '',
  notes             TEXT DEFAULT '',
  created_by        TEXT,
  created_at        TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(visit_id) REFERENCES visits(id) ON DELETE CASCADE,
  FOREIGN KEY(episode_row_id) REFERENCES visit_episode_rows(id) ON DELETE CASCADE,
  FOREIGN KEY(chemo_cycle_id) REFERENCES chemo_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY(episode_id) REFERENCES treatment_episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ae_patient ON adverse_events(patient_id, grade);
CREATE INDEX IF NOT EXISTS idx_ae_row ON adverse_events(episode_row_id);
CREATE INDEX IF NOT EXISTS idx_ae_cycle ON adverse_events(chemo_cycle_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_row_term ON adverse_events(episode_row_id, term_code) WHERE episode_row_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_cycle_term ON adverse_events(chemo_cycle_id, term_code) WHERE chemo_cycle_id IS NOT NULL;

/* 手术实施（记录册 p3）：术式/神经保留/左右淋巴结/导管/围手术期并发症。 */
CREATE TABLE IF NOT EXISTS surgery_records (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id            TEXT NOT NULL,
  episode_id            INTEGER,
  event_id              INTEGER,
  surgery_date          TEXT NOT NULL,
  surgeon               TEXT DEFAULT '',
  procedure             TEXT DEFAULT 'RP',
  approach              TEXT DEFAULT '',
  nerve_sparing        TEXT DEFAULT 'none',
  ln_dissection         TEXT DEFAULT 'none',
  ln_examined_left      INTEGER,
  ln_positive_left      INTEGER,
  ln_examined_right     INTEGER,
  ln_positive_right     INTEGER,
  catheter_days         INTEGER,
  drain_days            INTEGER,
  complications_json    TEXT DEFAULT '[]',
  complication_management TEXT DEFAULT '',
  conversion            INTEGER DEFAULT 0,
  blood_loss_ml         INTEGER,
  hospital_days         INTEGER,
  pathology_id          INTEGER,
  notes                 TEXT DEFAULT '',
  created_by            TEXT,
  created_at            TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(episode_id) REFERENCES treatment_episodes(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES timeline_events(id) ON DELETE SET NULL,
  FOREIGN KEY(pathology_id) REFERENCES pathology_reports(id) ON DELETE SET NULL,
  UNIQUE(episode_id)
);
CREATE INDEX IF NOT EXISTS idx_surgery_patient ON surgery_records(patient_id, surgery_date);

/* ADT/注射逐次给药日志（记录册 p27 的“次数 1–13”）。 */
CREATE TABLE IF NOT EXISTS medication_administrations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      TEXT NOT NULL,
  medication_id   INTEGER,
  episode_id      INTEGER,
  admin_date      TEXT NOT NULL,
  drug            TEXT NOT NULL,
  dose            TEXT DEFAULT '',
  route           TEXT DEFAULT '',
  site            TEXT DEFAULT '',
  lot             TEXT DEFAULT '',
  next_due_date   TEXT,
  notes           TEXT DEFAULT '',
  created_by      TEXT,
  created_at      TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY(medication_id) REFERENCES medication_records(id) ON DELETE SET NULL,
  FOREIGN KEY(episode_id) REFERENCES treatment_episodes(id) ON DELETE CASCADE,
  UNIQUE(medication_id, admin_date)
);
CREATE INDEX IF NOT EXISTS idx_admin_patient ON medication_administrations(patient_id, admin_date);
CREATE INDEX IF NOT EXISTS idx_admin_episode ON medication_administrations(episode_id, admin_date);

/* 合并症：记录册 p2 实拍 21 项 + other。 */
CREATE TABLE IF NOT EXISTS comorbidities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      TEXT NOT NULL,
  system          TEXT DEFAULT '',
  disease_code    TEXT NOT NULL,
  disease_label   TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'unknown',
  severity        TEXT DEFAULT '',
  diagnosed_date  TEXT,
  notes           TEXT DEFAULT '',
  source          TEXT DEFAULT 'manual',
  created_by      TEXT,
  created_at      TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  UNIQUE(patient_id, disease_code)
);
CREATE INDEX IF NOT EXISTS idx_comorb_patient ON comorbidities(patient_id, status);

/* 疾病状态确认快照：自动评估仍由 clinical-core 计算，本表只记录医生确认。 */
CREATE TABLE IF NOT EXISTS disease_states (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id      TEXT NOT NULL,
  state_code      TEXT NOT NULL,
  state_label     TEXT DEFAULT '',
  since_date      TEXT NOT NULL,
  basis           TEXT DEFAULT '',
  evidence_json   TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'confirmed',
  confirmed_by    TEXT,
  confirmed_at    TEXT,
  superseded_at   TEXT,
  is_current      INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_states_patient ON disease_states(patient_id, since_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_states_current ON disease_states(patient_id) WHERE is_current=1;
`);

/* v13 列扩展：全部可空，旧数据不动。 */
{
  const ensure = (table, defs) => {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
    defs.forEach(([name, decl]) => {
      if (!cols.includes(name)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + decl);
    });
  };
  ensure('patients', [
    ['main_symptom', "TEXT DEFAULT ''"],
    ['symptom_duration_months', 'REAL'],
    ['baseline_pain_nrs', 'INTEGER'],
    ['birthplace', "TEXT DEFAULT ''"],
    ['admission_no', "TEXT DEFAULT ''"]
  ]);
  ensure('testosterone_records', [['is_initial', 'INTEGER DEFAULT 0']]);
  const visitCols = [['visit_id', 'INTEGER'], ['episode_id', 'INTEGER']];
  ['psa_records', 'testosterone_records', 'lab_values', 'clinical_records', 'imaging_studies',
   'pathology_reports', 'radiation_records', 'patient_outcomes', 'timeline_events'].forEach(t => ensure(t, visitCols));
  ensure('radiation_records', [
    ['purpose', "TEXT DEFAULT ''"],
    ['dose_per_fraction', 'REAL'],
    ['treatment_days', 'INTEGER'],
    ['target_testes', 'INTEGER']
  ]);
  ensure('genomic_tests', [
    ['counseling_status', "TEXT DEFAULT ''"],
    ['counseling_note', "TEXT DEFAULT ''"]
  ]);
  ensure('patient_outcomes', [['sre_type', "TEXT DEFAULT ''"]]);
  ensure('clinical_records', [
    ['visit_id', 'INTEGER'],
    ['instrument_code', "TEXT DEFAULT ''"],
    ['details_json', "TEXT DEFAULT ''"]
  ]);
  ensure('timeline_events', [
    ['event_code', "TEXT DEFAULT ''"],
    ['visit_id', 'INTEGER'],
    ['episode_id', 'INTEGER']
  ]);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_psa_visit ON psa_records(visit_id);
    CREATE INDEX IF NOT EXISTS idx_testo_visit ON testosterone_records(visit_id);
    CREATE INDEX IF NOT EXISTS idx_lab_visit ON lab_values(visit_id);
    CREATE INDEX IF NOT EXISTS idx_clin_visit ON clinical_records(visit_id);
    CREATE INDEX IF NOT EXISTS idx_img_visit ON imaging_studies(visit_id);
    CREATE INDEX IF NOT EXISTS idx_path_visit ON pathology_reports(visit_id);
    CREATE INDEX IF NOT EXISTS idx_rt_visit ON radiation_records(visit_id);
    CREATE INDEX IF NOT EXISTS idx_outcome_visit ON patient_outcomes(visit_id);
    CREATE INDEX IF NOT EXISTS idx_tl_visit ON timeline_events(visit_id);
    CREATE INDEX IF NOT EXISTS idx_tl_episode ON timeline_events(episode_id);
  `);
}

/* v13 回填：把现有 RT/治疗线/手术/用药映射成治疗段（幂等，只跑一次）。
   不伪造 AE、手术实施细节、合并症；只建“容器”，其余留待补录。 */
{
  const MIG_KEY = 'schema_v13_episodes_backfill_v1';
  const done = db.prepare('SELECT value FROM meta WHERE key=?').get(MIG_KEY);
  if (!done) {
    const tx = db.transaction(() => {
      let made = 0;
      const add = (pid, type, template, label, intent, start, end, lineId, source, notes) => {
        if (!start) return;
        const exists = db.prepare(`SELECT id FROM treatment_episodes
          WHERE patient_id=? AND template_code=? AND start_date=? AND IFNULL(line_id,0)=? LIMIT 1`)
          .get(pid, template, start, lineId || 0);
        if (exists) return;
        db.prepare(`INSERT INTO treatment_episodes
          (patient_id,episode_type,template_code,label,intent,line_id,start_date,end_date,status,source,notes,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(pid, type, template, label, intent, lineId || null, start, end || null,
               template === 'RP' ? 'completed' : (end ? 'completed' : 'active'),
               source, notes || '', new Date().toISOString());
        made++;
      };
      /* 手术：surg_date 优先；没有日期但有 RP 事件则用事件日期 */
      db.prepare(`SELECT p.id, p.surg_date,
                         (SELECT MIN(event_date) FROM timeline_events e
                           WHERE e.patient_id=p.id AND (e.event_type LIKE '%根治性前列腺切除%' OR e.is_surgery=1)) AS ev_date
                    FROM patients p`).all().forEach(r => {
        const d = r.surg_date || r.ev_date;
        if (d) add(r.id, 'surgery', 'RP', '根治性前列腺切除术', 'radical', d, null, null, 'backfill', '由历史手术日期/事件生成，实施细节待补录');
      });
      /* 放疗：每条 radiation_records 一段 */
      db.prepare('SELECT * FROM radiation_records ORDER BY patient_id,start_date').all().forEach(r => {
        add(r.patient_id, 'radiotherapy', 'RT', '放射治疗', /挽救/.test(String(r.rt_type || '')) ? 'salvage' : 'radical',
          r.start_date, r.end_date, null, 'backfill', '由历史放疗记录生成');
      });
      /* 治疗线：按情境映射模板 */
      db.prepare('SELECT * FROM treatment_lines ORDER BY patient_id,line_no,start_date').all().forEach(l => {
        const s = String(l.setting || '') + ' ' + String(l.regimen || '');
        let type = 'systemic', template = 'SYSTEMIC';
        if (/化疗|多西他赛|卡巴他赛|铂类|依托泊苷/.test(s)) { type = 'chemo'; template = 'CHEMO'; }
        else if (/nmCRPC|mCRPC|mHSPC|阿比特龙|恩扎|阿帕|达罗|瑞维|PARP|镭|Lu-177|Sipuleucel/i.test(s)) { type = 'systemic'; template = 'SYSTEMIC'; }
        else if (/ADT|内分泌|比卡鲁胺|氟他胺|戈舍瑞林|亮丙瑞林|曲普瑞林|地加瑞克|去势/.test(s)) { type = 'endocrine'; template = 'ADT'; }
        else if (/主动监测/.test(s)) { type = 'surveillance'; template = 'AS'; }
        else if (/观察等待/.test(s)) { type = 'surveillance'; template = 'WW'; }
        const intent = /新辅助/.test(s) ? 'neoadjuvant' : /辅助/.test(s) ? 'adjuvant' : /挽救/.test(s) ? 'salvage' : /姑息/.test(s) ? 'palliative' : 'radical';
        add(l.patient_id, type, template, l.regimen || template, intent, l.start_date, l.end_date, l.id, 'backfill', '由历史治疗线生成');
      });
      /* 只有用药、没有治疗线的患者：按大类建段；同类别同日去重 */
      db.prepare(`SELECT m.* FROM medication_records m
                  WHERE NOT EXISTS (SELECT 1 FROM treatment_lines l WHERE l.patient_id=m.patient_id)
                  ORDER BY m.patient_id,m.start_date`).all().forEach(m => {
        const cat = String(m.category || '');
        const type = cat === 'chemo' ? 'chemo' : (cat === 'adt' || cat === 'endocrine') ? 'endocrine' : 'systemic';
        const template = type === 'chemo' ? 'CHEMO' : type === 'endocrine' ? 'ADT' : 'SYSTEMIC';
        add(m.patient_id, type, template, m.drug_name || template, 'radical', m.start_date, m.end_date, null, 'backfill', '由历史用药记录生成');
      });
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(MIG_KEY, '1');
      return made;
    });
    const made = tx();
    if (made) console.log('🔧 v13 治疗段回填：' + made + ' 段');
  }
}

/* ---- 数据修复迁移：psa_records 的 is_initial / created_by 错位（幂等，可重复执行）----
   历史上两处 INSERT 写成 VALUES(?,?,?,?,1) / VALUES(?,?,?,?,0)：5 个列只配了 4 个占位符，
   于是 is_initial 绑定到了用户名（非空字符串，SQL 判定恒为真），created_by 绑定到了
   字面量 1 / 0。表现为「界面新增的患者，其全部复查记录都删不掉（提示：初始PSA不可删除）」。

   识别特征明确：正常行 is_initial 必为 INTEGER 0/1，错位行则是 TEXT（用户名）。
   因此只修 typeof(is_initial)<>'integer' 的行，其余数据一律不碰。
   修复即按写入时的错位关系还原：真正的初始标记来自 created_by 里的 1/0，
   真正的操作人来自 is_initial 里的用户名。 */
{
  const bad = db.prepare("SELECT COUNT(*) AS n FROM psa_records WHERE typeof(is_initial)<>'integer'").get().n;
  if (bad > 0) {
    const fixed = db.transaction(() => db.prepare(`
      UPDATE psa_records
         SET is_initial = CASE WHEN CAST(created_by AS INTEGER)=1 THEN 1 ELSE 0 END,
             created_by = is_initial
       WHERE typeof(is_initial)<>'integer'
    `).run().changes)();
    console.log('🔧 已修复 ' + fixed + ' 条 PSA 记录的初始标记/操作人错位（历史 INSERT 列值错位所致）');
  }
}

/* ---- 结构升级迁移：timeline_events.psa_record_id（对已有库幂等）----
   该列标记「这条事件是哪条 PSA 记录的镜像」。有了它，录入/修改/删除 PSA 时
   时间轴能跟着动，而不是各写各的、两边对不上。

   刻意不加外键：SQLite 的 ALTER TABLE ADD COLUMN 不支持带 REFERENCES 的列，
   若只在新建库上加外键，新库与升级库的删除行为就会不一致（一个自动级联、一个不级联）。
   统一由代码层保证配对，删除路径见 removePsaMirrorEvent。 */
{
  const cols = db.prepare('PRAGMA table_info(timeline_events)').all().map(c => c.name);
  if (!cols.includes('psa_record_id')) db.exec('ALTER TABLE timeline_events ADD COLUMN psa_record_id INTEGER');
  /* 索引必须建在这里而不是顶部的 db.exec 块：那一块先于本迁移执行，
     对已有库而言 psa_record_id 还不存在，CREATE INDEX 会直接报错。 */
  db.exec('CREATE INDEX IF NOT EXISTS idx_tl_event_psa ON timeline_events(psa_record_id)');
}

/* ---- 数据迁移：把存量 surg_date 回填成时间轴上的手术事件（幂等，可重复执行）----
   手术日期不再单独录入，改由时间轴里的「根治性前列腺切除术」事件推导。
   存量患者只有 surg_date 没有事件，若直接删掉输入框，这些患者的手术日期就成了孤岛。

   注意本函数不自己开事务：它既在启动时单独跑，也要在备份导入的事务末尾跑，
   better-sqlite3 不支持嵌套事务。调用方负责事务边界。

   ⚠️ 必须在两处调用：启动时 + 备份导入之后。
   reset-local-data.sh 的流程是先启动服务（此刻库是空的，回填无事可做）、再导入演示数据，
   若只在启动时跑，导入进来的 surg_date 永远不会变成事件。 */
const RP_EVENT_TYPE = '根治性前列腺切除术(RP)';

/* 新建患者尚未完成风险资料录入时使用；不能默认成「稳定」，
   否则未做分期/Gleason/治疗判断的人会被系统标成稳定病例。 */
const PENDING_STATUS = '待评估';

/* 随访终止状态：只记录生命/随访状态，不再和疾病状态混用。
   疾病状态（稳定/生化复发/去势抵抗/转移）由前端 clinical-core 自动计算。 */
const FOLLOWUP_STATUSES = new Set(['在访', '失访', '死亡']);
function normalizeFollowupStatus(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  return FOLLOWUP_STATUSES.has(s) ? s : false;
}
function legacyFollowupStatus(s) {
  return s === '死亡' ? '死亡' : s === '失访' ? '失访' : '在访';
}

/* 药物分类：必须与前端 public/index.html 的 MED_CATEGORIES 保持一致。
   key 存库，label 只用于服务端报错/日志；前端负责最终显示与配色。 */
const MED_CATEGORIES = [
  { key: 'adt', label: '去势/ADT' },
  { key: 'endocrine', label: '内分泌' },
  { key: 'arpi', label: '新型内分泌（ARPI）' },
  { key: 'chemo', label: '化疗' },
  { key: 'parpi', label: 'PARP抑制剂/靶向' },
  { key: 'nuc', label: '核素/免疫' },
  { key: 'bone', label: '骨保护' },
  { key: 'support', label: '支持治疗' },
  { key: 'other', label: '其他' }
];
const MED_CATEGORY_KEYS = new Set(MED_CATEGORIES.map(c => c.key));
const MED_CATEGORY_LABEL = Object.fromEntries(MED_CATEGORIES.map(c => [c.key, c.label]));

/* PSA 镜像事件的两种类型名，必须与前端 EVENT_PRESETS 里的字符串逐字一致 */
const PSA_INIT_EVENT_TYPE = 'PSA检测';
const PSA_FU_EVENT_TYPE = 'PSA复查';

function backfillSurgeryEvents() {
  const rows = db.prepare(`
    SELECT id, surg_date, created_by FROM patients
     WHERE surg_date IS NOT NULL AND surg_date <> ''
       AND id NOT IN (SELECT patient_id FROM timeline_events WHERE is_surgery = 1)
  `).all();
  if (!rows.length) return 0;
  const ins = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,is_surgery,created_by)
                          VALUES(?,?,?,?,?)`);
  rows.forEach(p => ins.run(p.id, p.surg_date, RP_EVENT_TYPE, 1, p.created_by));
  return rows.length;
}

{
  const n = db.transaction(() => backfillSurgeryEvents())();
  if (n > 0) console.log('🔧 已为 ' + n + ' 位患者按存量手术日期回填「' + RP_EVENT_TYPE + '」事件');
}

/* ---- 病理主档来源修复（幂等）----
   旧逻辑会把 RP/TURP 的 Gleason 写进 patients.gleason，覆盖活检分级。
   这里只处理“当前主档 Gleason 等于某份 RP/TURP、且存在不同活检分级”的明确污染，
   恢复为活检 Gleason；无法判断的数据不碰。 */
{
  const n = db.transaction(() => inferPathologySources())();
  if (n > 0) console.log('🔧 已修复 ' + n + ' 位患者的病理主档来源（RP 分级不再覆盖活检）');
}

/* ---- 数据迁移：把存量 PSA 事件与 PSA 记录重新配对（幂等，可重复执行）----
   时间轴上线前填充的 PSA检测/PSA复查 事件没有 psa_record_id，删除对应 PSA 记录时
   会留下无法追溯的孤儿事件。这里按「患者 + 日期 + 初始/复查」把两者一一绑定。

   同一患者同一天可能有多条同类 PSA 记录（如一天内两次复查），
   故在 (patient_id, event_date) 分组内按各自 id 顺序 zip 配对，而不是仅按日期匹配。

   只认领「尚未被任何事件绑定」的 PSA 记录，因此重复运行不会二次分配。
   同样不自己开事务，调用方负责边界。 */
function backfillPsaMirrorEvents() {
  const upd = db.prepare('UPDATE timeline_events SET psa_record_id=? WHERE id=?');
  let n = 0;
  /* PSA检测 ↔ 初始记录；PSA复查 ↔ 复查记录 */
  [[PSA_INIT_EVENT_TYPE, 1], [PSA_FU_EVENT_TYPE, 0]].forEach(([type, isInit]) => {
    const recsByGroup = new Map();
    db.prepare(`
      SELECT id, patient_id, rec_date FROM psa_records
       WHERE is_initial=?
         AND id NOT IN (SELECT psa_record_id FROM timeline_events WHERE psa_record_id IS NOT NULL)
       ORDER BY patient_id, rec_date, id`).all(isInit)
      .forEach(r => {
        const k = r.patient_id + '|' + r.rec_date;
        if (!recsByGroup.has(k)) recsByGroup.set(k, []);
        recsByGroup.get(k).push(r.id);
      });
    const cursor = new Map();
    db.prepare(`
      SELECT id, patient_id, event_date FROM timeline_events
       WHERE psa_record_id IS NULL AND event_type=?
       ORDER BY patient_id, event_date, id`).all(type)
      .forEach(e => {
        const k = e.patient_id + '|' + e.event_date;
        const arr = recsByGroup.get(k);
        if (!arr) return;
        const ci = cursor.get(k) || 0;
        if (ci >= arr.length) return;
        upd.run(arr[ci], e.id);
        cursor.set(k, ci + 1);
        n++;
      });
  });
  return n;
}

/* ---- 让「每条 PSA 记录都有镜像事件」这件事收敛到位（幂等）----
   三种情形都会走到这里，缺一不可：
     1. v4 备份导入：事件与记录都重建了，但 psa_record_id 没进 INSERT，配对全丢
     2. v3 及更早备份导入：压根没有 PSA 事件，需要按记录补建
     3. 首次部署到已有 PSA 数据的库：线上老患者有复查记录但从未有过事件

   顺序不能颠倒——先配对、再补建。反过来的话，第 2 步会为「其实已有事件、
   只是绑定丢了」的记录再造一个节点，时间轴上同一次复查就出现两个。 */
function syncPsaMirrorEvents() {
  const paired = backfillPsaMirrorEvents();
  const orphans = db.prepare(`
    SELECT id, patient_id, rec_date, is_initial, created_by FROM psa_records
     WHERE id NOT IN (SELECT psa_record_id FROM timeline_events WHERE psa_record_id IS NOT NULL)
     ORDER BY patient_id, rec_date, id
  `).all();
  orphans.forEach(r => ensurePsaMirrorEvent(r.patient_id, r.id, r.rec_date, r.is_initial ? 1 : 0, r.created_by));
  /* 配对+补建之后，若仍有 PSA 类事件没绑定，说明它是手工造出来的野节点
     （日期与任何记录都对不上）。只报数不删——静默删事件会让医生莫名其妙少数据。 */
  const stray = db.prepare(`
    SELECT COUNT(*) AS n FROM timeline_events
     WHERE psa_record_id IS NULL AND event_type IN (?,?)
  `).get(PSA_INIT_EVENT_TYPE, PSA_FU_EVENT_TYPE).n;
  return { paired, created: orphans.length, stray };
}

{
  const r = db.transaction(() => syncPsaMirrorEvents())();
  if (r.paired) console.log('🔧 已绑定 ' + r.paired + ' 条存量 PSA 事件');
  if (r.created) console.log('🔧 已为 ' + r.created + ' 条无镜像的 PSA 记录补建时间轴事件');
  if (r.stray) console.warn('⚠ 有 ' + r.stray + ' 条 PSA 类事件未对应任何 PSA 记录，请核对');
}

/* ---- PSA 记录 → 时间轴镜像事件 的运行时联动 ----
   PSA 是单一数据源：数值只存在 psa_records，事件不冗余存值。
   镜像事件只承载「这一天做了检测/复查」这件事，以及绑定关系 psa_record_id。
   两个函数都不自己开事务，必须与调用方的 PSA 写操作处于同一事务内。 */

/* 保证某条 PSA 记录有且仅有一个镜像事件；已存在则只同步日期（改期时用） */
function ensurePsaMirrorEvent(patientId, psaRecordId, date, isInitial, createdBy, guidedBatch) {
  const batch = normGuidedBatch(guidedBatch);
  const type = isInitial ? PSA_INIT_EVENT_TYPE : PSA_FU_EVENT_TYPE;
  const existing = db.prepare('SELECT id, event_date FROM timeline_events WHERE psa_record_id=?').get(psaRecordId);
  if (existing) {
    if (existing.event_date !== date) {
      db.prepare('UPDATE timeline_events SET event_date=?, event_type=? WHERE id=?').run(date, type, existing.id);
    }
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,is_surgery,psa_record_id,guided_batch,created_by)
                        VALUES(?,?,?,?,?,?,?)`)
    .run(patientId, date, type, 0, psaRecordId, batch, createdBy);
  return r.lastInsertRowid;
}

/* 删除某条 PSA 记录的镜像事件，并清理其附属图片的物理文件。
   外键级联只删 timeline_images 的行，不删 uploads/ 里的文件，故先收集再删。 */
function removePsaMirrorEvent(psaRecordId) {
  const ev = db.prepare('SELECT id FROM timeline_events WHERE psa_record_id=?').get(psaRecordId);
  if (!ev) return false;
  const files = db.prepare('SELECT stored_name FROM timeline_images WHERE event_id=?').all(ev.id);
  removeFileAssetsForEvent(ev.id);
  db.prepare('DELETE FROM timeline_events WHERE id=?').run(ev.id);
  files.forEach(f => { try { fs.unlinkSync(path.join(uploadDir, f.stored_name)); } catch (e) {} });
  return true;
}

/* ---- 睾酮 / 化验记录 → 时间轴镜像事件 ----
   与 PSA 镜像同一套不变量：记录是唯一数据源，事件是它的投影。
   类型名必须与前端 EVENT_PRESETS 逐字一致，否则时间轴着色会落到 other 中性色。
   化验用单一通用类型「化验/监测」+ details 承载项目/数值/描述：
   14 个检查项目各造一种事件类型会让时间轴图例和预设清单都爆炸，
   而医生真正关心的是「这天测了什么、结果多少」，details 点开即见。 */
const TESTO_EVENT_TYPE = '睾酮检测';
const LAB_EVENT_TYPE = '化验/监测';

function removeMirrorEventWithFiles(eventId) {
  const files = db.prepare('SELECT stored_name FROM timeline_images WHERE event_id=?').all(eventId);
  removeFileAssetsForEvent(eventId);
  db.prepare('DELETE FROM timeline_events WHERE id=?').run(eventId);
  files.forEach(f => { try { fs.unlinkSync(path.join(uploadDir, f.stored_name)); } catch (e) {} });
}

/* 保证某条睾酮记录有且仅有一个镜像事件；已存在则同步日期与详情 */
function ensureTestoMirrorEvent(patientId, recId, date, val, createdBy, guidedBatch) {
  const batch = normGuidedBatch(guidedBatch);
  const details = JSON.stringify({ testo: val });
  const existing = db.prepare('SELECT id, event_date, details FROM timeline_events WHERE testo_record_id=?').get(recId);
  if (existing) {
    if (existing.event_date !== date || existing.details !== details) {
      db.prepare('UPDATE timeline_events SET event_date=?, event_type=?, details=? WHERE id=?')
        .run(date, TESTO_EVENT_TYPE, details, existing.id);
    }
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,is_surgery,details,testo_record_id,guided_batch,created_by)
                        VALUES(?,?,?,?,?,?,?,?)`)
    .run(patientId, date, TESTO_EVENT_TYPE, 0, details, recId, batch, createdBy);
  return r.lastInsertRowid;
}

function removeTestoMirrorEvent(recId) {
  const ev = db.prepare('SELECT id FROM timeline_events WHERE testo_record_id=?').get(recId);
  if (!ev) return false;
  removeMirrorEventWithFiles(ev.id);
  return true;
}

/* 化验镜像：details 存 {item,val,note}，val 可为 null（纯文字记录） */
function ensureLabMirrorEvent(patientId, recId, date, item, val, note, createdBy) {
  const details = JSON.stringify({ item, val: val == null ? null : val, note: note || '' });
  const existing = db.prepare('SELECT id, event_date, details FROM timeline_events WHERE lab_record_id=?').get(recId);
  if (existing) {
    if (existing.event_date !== date || existing.details !== details) {
      db.prepare('UPDATE timeline_events SET event_date=?, event_type=?, details=? WHERE id=?')
        .run(date, LAB_EVENT_TYPE, details, existing.id);
    }
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,is_surgery,details,lab_record_id,created_by)
                        VALUES(?,?,?,?,?,?,?)`)
    .run(patientId, date, LAB_EVENT_TYPE, 0, details, recId, createdBy);
  return r.lastInsertRowid;
}

function removeLabMirrorEvent(recId) {
  const ev = db.prepare('SELECT id FROM timeline_events WHERE lab_record_id=?').get(recId);
  if (!ev) return false;
  removeMirrorEventWithFiles(ev.id);
  return true;
}

/* 先按「患者+日期+类型」把存量事件与未绑定记录配对（导入/旧库场景），
   再为仍无镜像的记录补建事件；最后清理指向已不存在记录的悬空镜像。
   顺序同 PSA：先配对再补建，否则同一次检测会出现两个节点。
   悬空镜像必须删而 PSA 的 stray 只报不删，区别在于：PSA 的 stray 是
   「手工造的野节点」（无绑定），这里的悬空是「绑定在但记录没了」，
   留着只会显示一个数值为空的假节点。 */
function syncRecordMirrorEvents() {
  const upd = db.prepare('UPDATE timeline_events SET testo_record_id=?, details=? WHERE id=?');
  const updLab = db.prepare('UPDATE timeline_events SET lab_record_id=?, details=? WHERE id=?');
  let paired = 0;
  /* 睾酮配对 */
  {
    const recsByGroup = new Map();
    db.prepare(`SELECT id, patient_id, rec_date, value FROM testosterone_records
                 WHERE id NOT IN (SELECT testo_record_id FROM timeline_events WHERE testo_record_id IS NOT NULL)
                 ORDER BY patient_id, rec_date, id`).all()
      .forEach(r => {
        const k = r.patient_id + '|' + r.rec_date;
        if (!recsByGroup.has(k)) recsByGroup.set(k, []);
        recsByGroup.get(k).push(r);
      });
    const cursor = new Map();
    db.prepare(`SELECT id, patient_id, event_date FROM timeline_events
                 WHERE testo_record_id IS NULL AND event_type=?
                 ORDER BY patient_id, event_date, id`).all(TESTO_EVENT_TYPE)
      .forEach(e => {
        const arr = recsByGroup.get(e.patient_id + '|' + e.event_date);
        if (!arr) return;
        const ci = cursor.get(e.patient_id + '|' + e.event_date) || 0;
        if (ci >= arr.length) return;
        upd.run(arr[ci].id, JSON.stringify({ testo: arr[ci].value }), e.id);
        cursor.set(e.patient_id + '|' + e.event_date, ci + 1);
        paired++;
      });
  }
  /* 化验配对 */
  {
    const recsByGroup = new Map();
    db.prepare(`SELECT id, patient_id, rec_date, item, value, note FROM labs_records
                 WHERE id NOT IN (SELECT lab_record_id FROM timeline_events WHERE lab_record_id IS NOT NULL)
                 ORDER BY patient_id, rec_date, id`).all()
      .forEach(r => {
        const k = r.patient_id + '|' + r.rec_date;
        if (!recsByGroup.has(k)) recsByGroup.set(k, []);
        recsByGroup.get(k).push(r);
      });
    const cursor = new Map();
    db.prepare(`SELECT id, patient_id, event_date FROM timeline_events
                 WHERE lab_record_id IS NULL AND event_type=?
                 ORDER BY patient_id, event_date, id`).all(LAB_EVENT_TYPE)
      .forEach(e => {
        const arr = recsByGroup.get(e.patient_id + '|' + e.event_date);
        if (!arr) return;
        const ci = cursor.get(e.patient_id + '|' + e.event_date) || 0;
        if (ci >= arr.length) return;
        updLab.run(arr[ci].id, JSON.stringify({ item: arr[ci].item, val: arr[ci].value, note: arr[ci].note || '' }), e.id);
        cursor.set(e.patient_id + '|' + e.event_date, ci + 1);
        paired++;
      });
  }
  /* 补建无镜像的记录 */
  let created = 0;
  db.prepare(`SELECT id, patient_id, rec_date, value, created_by FROM testosterone_records
               WHERE id NOT IN (SELECT testo_record_id FROM timeline_events WHERE testo_record_id IS NOT NULL)
               ORDER BY patient_id, rec_date, id`).all()
    .forEach(r => { ensureTestoMirrorEvent(r.patient_id, r.id, r.rec_date, r.value, r.created_by); created++; });
  db.prepare(`SELECT id, patient_id, rec_date, item, value, note, created_by FROM labs_records
               WHERE id NOT IN (SELECT lab_record_id FROM timeline_events WHERE lab_record_id IS NOT NULL)
               ORDER BY patient_id, rec_date, id`).all()
    .forEach(r => { ensureLabMirrorEvent(r.patient_id, r.id, r.rec_date, r.item, r.value, r.note || '', r.created_by); created++; });
  /* 清理悬空镜像 */
  let pruned = 0;
  db.prepare(`SELECT id FROM timeline_events
               WHERE testo_record_id IS NOT NULL
                 AND testo_record_id NOT IN (SELECT id FROM testosterone_records)`).all()
    .forEach(e => { removeMirrorEventWithFiles(e.id); pruned++; });
  db.prepare(`SELECT id FROM timeline_events
               WHERE lab_record_id IS NOT NULL
                 AND lab_record_id NOT IN (SELECT id FROM labs_records)`).all()
    .forEach(e => { removeMirrorEventWithFiles(e.id); pruned++; });
  return { paired, created, pruned };
}

/* ---- 把旧版独立化验记录并入病程事件（一次性迁移，幂等）----
   旧模型：labs_records 一行一个项目，每条记录再生成一个「化验/监测」镜像事件。
   新模型：同一患者同一天的化验合并为一个普通时间轴事件，项目/数值/单位写入 notes；
   事件照片、备注和事件本身保留。迁移后删除 labs_records，避免下次启动重新生成镜像。
   本函数不自己开事务：启动时和备份导入调用方负责事务边界。 */
function labResultLine(r) {
  const item = String(r.item || '').trim();
  const val = r.value == null ? '' : String(r.value);
  const note = String(r.note || '').replace(/\s+/g, ' ').trim();
  const tail = val + (note ? (val ? ' ' : '') + note : '');
  return item + '：' + (tail || '—');
}

function mergeLabsIntoEvents() {
  const rows = db.prepare(
    'SELECT id, patient_id, rec_date, item, value, note, created_by FROM labs_records ORDER BY patient_id, rec_date, id'
  ).all();
  if (!rows.length) return { labs: 0, groups: 0, eventsRemoved: 0 };

  const groups = new Map();
  rows.forEach(r => {
    const key = r.patient_id + '|' + r.rec_date;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  let eventsRemoved = 0;
  for (const group of groups.values()) {
    const first = group[0];
    const ids = group.map(r => r.id);
    const ph = ids.map(() => '?').join(',');
    const linked = db.prepare(
      'SELECT id, notes FROM timeline_events WHERE lab_record_id IN (' + ph + ') ORDER BY id'
    ).all(...ids);
    const resultNotes = group.map(labResultLine).join('\n');

    let keepId;
    let existingNotes = '';
    if (linked.length) {
      keepId = linked[0].id;
      existingNotes = [linked[0].notes || ''].concat(linked.slice(1).map(e => e.notes || ''))
        .map(t => String(t).trim()).filter(Boolean).join('\n');
      const extraIds = linked.slice(1).map(e => e.id);
      if (extraIds.length) {
        const eph = extraIds.map(() => '?').join(',');
        /* 若额外的旧镜像事件上有人工补传的照片，先迁到保留事件，再删除事件。 */
        db.prepare('UPDATE timeline_images SET event_id=? WHERE event_id IN (' + eph + ')').run(keepId, ...extraIds);
        db.prepare('DELETE FROM timeline_events WHERE id IN (' + eph + ')').run(...extraIds);
        eventsRemoved += extraIds.length;
      }
    } else {
      /* 理论上 syncRecordMirrorEvents 已经补建；这里兜底。 */
      const ins = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,is_surgery,notes,created_by)
                              VALUES(?,?,?,?,?,?)`)
        .run(first.patient_id, first.rec_date, LAB_EVENT_TYPE, 0, resultNotes, first.created_by);
      keepId = ins.lastInsertRowid;
    }

    const notes = (resultNotes + (existingNotes ? '\n' + existingNotes : '')).slice(0, 1000);
    db.prepare(`UPDATE timeline_events SET event_type=?, event_date=?, notes=?, details=NULL, lab_record_id=NULL WHERE id=?`)
      .run(LAB_EVENT_TYPE, first.rec_date, notes, keepId);
  }

  db.prepare('DELETE FROM labs_records').run();
  return { labs: rows.length, groups: groups.size, eventsRemoved };
}

/* 首次启动即收敛存量睾酮/化验记录的镜像事件（必须放在 syncRecordMirrorEvents
   定义之后：其内部引用的 TESTO_EVENT_TYPE 为 const，先调用会触发 TDZ 报错） */
{
  const r = db.transaction(() => syncRecordMirrorEvents())();
  if (r.paired) console.log('🔧 已绑定 ' + r.paired + ' 条存量睾酮/化验事件');
  if (r.created) console.log('🔧 已为 ' + r.created + ' 条无镜像的睾酮/化验记录补建时间轴事件');
  if (r.pruned) console.log('🔧 已清理 ' + r.pruned + ' 条指向不存在记录的悬空睾酮/化验事件');
}

/* 化验/监测合并为普通病程事件：历史项目值写入事件备注，旧 labs_records 清空。 */
{
  const merged = db.transaction(() => mergeLabsIntoEvents())();
  if (merged.labs) {
    console.log('🔧 已将 ' + merged.labs + ' 条化验记录合并为 ' + merged.groups +
      ' 个病程事件（减少 ' + merged.eventsRemoved + ' 个重复节点）');
  }
}

/* 首次启动：创建初始管理员（账号密码必须由 .env 提供，不再内置 admin/admin123） */
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const adminUser = (process.env.INIT_ADMIN_USER || '').trim();
  const adminPass = process.env.INIT_ADMIN_PASS || '';
  if (!adminUser || !adminPass || adminPass.length < 12) {
    console.error('❌ 首次启动需在 .env 中设置 INIT_ADMIN_USER 与 INIT_ADMIN_PASS（密码≥12位），已拒绝启动');
    process.exit(1);
  }
  if (adminUser.toLowerCase() === 'admin' || KNOWN_WEAK_SECRETS.includes(adminPass.toLowerCase())) {
    console.error('❌ 初始管理员用户名不得使用 admin，密码不得使用常见弱口令，已拒绝启动');
    process.exit(1);
  }
  db.prepare('INSERT INTO users(username,display_name,role,pass_hash,created_at) VALUES(?,?,?,?,?)')
    .run(adminUser, '管理员', 'admin', bcrypt.hashSync(adminPass, 10), new Date().toISOString());
  console.log('✅ 已创建初始管理员：' + adminUser + ' —— 建议登录后立即再修改一次密码');
}
if (!db.prepare("SELECT 1 FROM meta WHERE key='id_counter'").get()) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM patients').get().n;
  db.prepare("INSERT INTO meta(key,value) VALUES('id_counter',?)").run(String(n + 1));
}

/* ================= Express 配置 ================= */
const app = express();

/* Nginx 反向代理必需：不设置则 req.ip 全部为 127.0.0.1，
   会导致登录限流对所有用户共用一个计数桶（攻击者故意输错 10 次即可让全团队锁死 15 分钟），
   审计日志中的来源 IP 也会全部失真。 */
app.set('trust proxy', 1);

/* 基础安全响应头（零依赖实现，等效于 helmet 默认集合）。
   注：未启用 CSP —— 前端为单文件 index.html 且含内联脚本，
   默认 CSP 会直接拦掉页面功能，需单独梳理白名单后再开。 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // 仅在 HTTPS 请求下下发 HSTS，避免 HTTP 阶段产生错误策略
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
});
app.disable('x-powered-by');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================= 工具函数 ================= */
/* 日期规范化：只接受 YYYY-MM-DD 且为真实存在的日历日期。
   浏览器 <input type=date> 允许手动键入，输入 0、2026-13-45、2026-2-30 之类
   会得到空值或非法值；这里统一拦截，避免脏数据入库后污染统计与曲线。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function normDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || y > 2100) return null;
  return v;
}

/* 服务端“今天”按科室本地时区（默认 Asia/Shanghai）计算。
   不能直接用 new Date().toISOString()：凌晨 0–8 点会得到昨天的日期，
   未来日期校验和“今天”默认值都会错一天。 */
function todayIso() {
  const tz = process.env.APP_TZ || 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = k => (parts.find(x => x.type === k) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function assertNotFuture(date, label) {
  if (!date) return null;
  if (date > todayIso()) return label + '不能晚于今天（' + todayIso() + '）';
  return null;
}
function deathOutcomeOf(p) {
  return db.prepare(`SELECT * FROM patient_outcomes WHERE patient_id=? AND outcome_type='death'
                     ORDER BY event_date DESC, id DESC LIMIT 1`).get(p.id) || null;
}
function recordsAfterDate(pid, date, excludeEventId) {
  if (!date) return [];
  const checks = [
    ['PSA', 'psa_records', 'rec_date'],
    ['睾酮', 'testosterone_records', 'rec_date'],
    ['病程事件', 'timeline_events', 'event_date'],
    ['用药', 'medication_records', 'start_date'],
    ['治疗线', 'treatment_lines', 'start_date'],
    ['临床监测', 'clinical_records', 'rec_date'],
    ['样本', 'specimens', 'collection_date'],
    ['基因检测', 'genomic_tests', 'test_date'],
    ['IHC', 'ihc_results', 'test_date'],
    ['化验', 'labs_records', 'rec_date']
  ];
  const out = [];
  checks.forEach(([label, table, col]) => {
    let sql = 'SELECT ' + col + ' AS d FROM ' + table + ' WHERE patient_id=? AND ' + col + '>?';
    const args = [pid, date];
    if (table === 'timeline_events' && excludeEventId != null) {
      sql += ' AND id<>?'; args.push(excludeEventId);
    }
    sql += ' ORDER BY ' + col;
    const rows = db.prepare(sql).all(...args);
    rows.forEach(r => out.push(label + ' ' + r.d));
  });
  return out;
}
/* 统一守卫：未来日期 + 死亡后记录。死亡结局本身由调用方传 deathEvent:true。 */
function assertAliveForRecord(p, date, label, opts) {
  const future = assertNotFuture(date, label);
  if (future) return future;
  if (opts && opts.deathEvent) return null;
  const death = deathOutcomeOf(p);
  if (p.followup_status === '死亡' || death) {
    if (!death) return '患者已标记死亡但缺死亡结局/死亡日期，请先补录「终止随访/死亡」事件';
    if (date && date > death.event_date) {
      const dateLabel = /日期$/.test(label) ? label : label + '日期';
      return dateLabel + ' ' + date + ' 晚于死亡日期 ' + death.event_date + '，不能保存死亡后记录';
    }
  }
  return null;
}
/* PSA 数值解析：只接受有限、非负的数字。
   不能直接用 Number(v) + isNaN 判断——Number('') / Number(null) / Number([]) 都得 0，
   前端一旦把清空后的输入框原样提交，就会静默写成 "0.0 ng/mL" 的假复查结果，
   而这个 0 会立刻参与风险评估（术后 0.2 阈值）与曲线绘制，比报错危险得多。
   合法返回数字，非法返回 null（由调用方转成 400）。 */
function parsePsaValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;          // 布尔、数组、对象一律拒绝
  const s = v.trim();
  if (!s) return null;                             // 空串视为「没填」，而不是 0
  /* 只认十进制非负数：挡住 '1e3'、'-1'、'abc'、'5.'；
     允许 '.05' 这种省略整数位的写法（PSA 极低值常见） */
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ---- 游离PSA 请求体解析 ----
   返回 { value, below, lod, error }：
   · 未提供游离值（undefined/null/空串）→ value 为 null，表示「该次未录游离」，
     这不是错误：化验单常常只报总PSA。
   · 勾选低于下限 → 必须给大于0的当次下限（与总PSA同一套规则）。
   游离值本身复用 parsePsaValue 的严格校验（挡 0/负数/非数字）。 */
function parseFreePsaBody(body) {
  const b = body || {};
  const raw = b.freeVal;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: null, below: 0, lod: null, error: null };
  }
  const value = parsePsaValue(raw);
  if (value === null) return { value: null, below: 0, lod: null, error: '游离PSA值必须为不小于0的数字' };
  const below = (b.freeBelowLod === true || b.freeBelowLod === 1 || b.freeBelowLod === '1') ? 1 : 0;
  let lod = null;
  if (below) {
    lod = parsePsaValue(b.freeLod);
    if (lod === null || lod <= 0) return { value, below, lod: null, error: '勾选游离PSA低于检测下限时，请填写大于0的当次检测下限（如 0.010）' };
  }
  return { value, below, lod, error: null };
}

/* 游离/总比值（f/t PSA）：仅当两个值都是「实测数字」时才算。
   任一低于检测下限时返回 null——「<0.010」是上界不是数值，相除得假精度。
   总比值为 0 也不除（防除零；总PSA=0 在术后检测不到时理论上会出现，
   但那时必然勾了 belowLod，走不到这里，仍留一道防线）。
   保留 3 位小数：临床习惯表述为 0.16 / 0.25 这类两位，3 位足够且不显假精度。 */
function psaFreeRatio(totalVal, totalBelow, freeVal, freeBelow) {
  if (totalBelow || freeBelow) return null;
  if (totalVal == null || freeVal == null) return null;
  if (!(totalVal > 0)) return null;
  return Math.round((freeVal / totalVal) * 1000) / 1000;
}

/* 可空布尔字段统一语义：未传/空串 = 未评估(null)，而不是 false。
   现有 0/1 存量数据保持原意，不会被反推成「未评估」。 */
function triState(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false') return 0;
  return 1;
}

/* 由出生日期计算周岁（按公历生日当天满岁） */
function ageFromBirth(birth, onDate) {
  const b = new Date(birth + 'T00:00:00Z');
  const on = onDate ? new Date(onDate + 'T00:00:00Z') : new Date();
  let a = on.getUTCFullYear() - b.getUTCFullYear();
  const mDiff = on.getUTCMonth() - b.getUTCMonth();
  if (mDiff < 0 || (mDiff === 0 && on.getUTCDate() < b.getUTCDate())) a--;
  return a;
}
/* 患者展示年龄：有出生日期则按今天动态计算，存量旧数据回退登记时的 age */
function displayAge(p) {
  if (p.birth_date) return ageFromBirth(p.birth_date, null);
  return p.age;
}

function logAudit(username, action, detail) {
  db.prepare('INSERT INTO audit_log(ts,username,action,detail) VALUES(?,?,?,?)')
    .run(new Date().toISOString(), username || 'anonymous', action, detail || '');
}

/* ================= P2-15 统一文件索引 ================= */
function fileSha256(storedName) {
  try {
    const fp = path.join(uploadDir, storedName);
    if (!fs.existsSync(fp)) return { bytes: 0, sha256: '' };
    const buf = fs.readFileSync(fp);
    return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch (e) { return { bytes: 0, sha256: '' }; }
}

function registerFileAsset(o) {
  const rec = o || {};
  if (!rec.storedName || !rec.source) return null;
  const meta = fileSha256(rec.storedName);
  const info = db.prepare(`INSERT INTO file_assets
      (patient_id,source,source_id,stored_name,filename,mime,bytes,sha256,created_by,created_at,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(source,source_id) DO UPDATE SET
        patient_id=excluded.patient_id, stored_name=excluded.stored_name,
        filename=excluded.filename, mime=excluded.mime, bytes=excluded.bytes,
        sha256=excluded.sha256, deleted_at=NULL`)
    .run(rec.patientId || null, rec.source, rec.sourceId == null ? null : rec.sourceId,
         rec.storedName, rec.filename || '', rec.mime || '', rec.bytes || meta.bytes,
         rec.sha256 || meta.sha256, rec.createdBy || null, new Date().toISOString());
  return info.lastInsertRowid;
}

function removeFileAsset(source, sourceId) {
  db.prepare('DELETE FROM file_assets WHERE source=? AND source_id=?').run(source, sourceId);
}

function removeFileAssetsForEvent(eventId) {
  db.prepare(`DELETE FROM file_assets WHERE source='event_image'
              AND source_id IN (SELECT id FROM timeline_images WHERE event_id=?)`).run(eventId);
}

/* 回填三类历史文件；INSERT OR IGNORE 保证幂等，不重算 sha（上传时/首次入索引时算）。 */
function backfillFileAssets() {
  let added = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO file_assets
    (patient_id,source,source_id,stored_name,filename,mime,bytes,sha256,created_by,created_at,deleted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`);
  db.prepare('SELECT id,patient_id,filename,stored_name,uploaded_by,upload_date FROM reports').all()
    .forEach(r => { added += ins.run(r.patient_id, 'report', r.id, r.stored_name, r.filename || '', '', 0, '', r.uploaded_by || null, r.upload_date || null).changes; });
  db.prepare(`SELECT ti.id, te.patient_id, ti.filename, ti.stored_name, ti.uploaded_by, ti.upload_date
              FROM timeline_images ti JOIN timeline_events te ON te.id=ti.event_id`).all()
    .forEach(r => { added += ins.run(r.patient_id, 'event_image', r.id, r.stored_name, r.filename || '', '', 0, '', r.uploaded_by || null, r.upload_date || null).changes; });
  db.prepare(`SELECT af.id, s.patient_id, af.filename, af.stored_name, s.created_by, s.created_at
              FROM ai_intake_files af JOIN ai_intake_sessions s ON s.id=af.session_id`).all()
    .forEach(r => { added += ins.run(r.patient_id || null, 'ai_intake', r.id, 'ai-intake/' + r.stored_name, r.filename || '', '', 0, '', r.created_by || null, r.created_at || null).changes; });
  if (added) console.log('🔧 文件索引回填：' + added + ' 条');
}

function auth(adminOnly) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: '未登录' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      if (adminOnly && req.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
      }
      next();
    } catch (e) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
  };
}

/* 列表摘要的科研覆盖信息：不返回 specimens/genomic/ihc 全量数组，
   只给总览页需要的计数与布尔标志，避免 /api/patients payload 过大。 */
function emptyResearchSummary() {
  return {
    specimenCount: 0, tissueCount: 0, bloodCount: 0, ctdnaCount: 0,
    tumorCellCount: 0, biobankCount: 0, timepointCount: 0,
    genomicCount: 0, pairedGenomicCount: 0, hrrStatus: '', msiStatus: '', tmbValue: null,
    ihcCount: 0, pairedIhcCount: 0,
    ptenLoss: false, ergPositive: false, arPositive: false, psmaPositive: false,
    ki67Positive: false, nePositive: false,
    radiationCount: 0
  };
}
function chooseHrrStatus(a, b) {
  const rank = { pathogenic: 4, VUS: 3, negative: 2, unknown: 1, '': 0 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}
function buildResearchMaps(ids) {
  const map = new Map();
  ids.forEach(id => map.set(id, emptyResearchSummary()));
  if (!ids.length) return map;
  const chunks = [];
  for (let i = 0; i < ids.length; i += 400) chunks.push(ids.slice(i, i + 400));
  for (const chunk of chunks) {
    const qs = chunk.map(() => '?').join(',');
    db.prepare(`SELECT patient_id, sample_type, timepoint, tumor_cell_pct, biobank_id FROM specimens
                WHERE patient_id IN (${qs})`).all(...chunk).forEach(r => {
      const o = map.get(r.patient_id); if (!o) return;
      o.specimenCount++;
      if (r.timepoint) o.timepointCount++;
      const st = String(r.sample_type || '');
      if (st.startsWith('tissue_')) o.tissueCount++;
      if (st === 'blood') o.bloodCount++;
      if (st === 'ctDNA') o.ctdnaCount++;
      if (r.tumor_cell_pct != null) o.tumorCellCount++;
      if (r.biobank_id) o.biobankCount++;
    });
    db.prepare(`SELECT patient_id, specimen_id, hrr_status, msi_status, tmb_value, test_date
                FROM genomic_tests WHERE patient_id IN (${qs}) ORDER BY patient_id, test_date, id`).all(...chunk).forEach(r => {
      const o = map.get(r.patient_id); if (!o) return;
      o.genomicCount++;
      if (r.specimen_id != null) o.pairedGenomicCount++;
      o.hrrStatus = chooseHrrStatus(o.hrrStatus || '', String(r.hrr_status || ''));
      const msi = String(r.msi_status || '');
      if (msi === 'MSI-H' || !o.msiStatus) o.msiStatus = msi;
      if (r.tmb_value != null) o.tmbValue = r.tmb_value;
    });
    db.prepare(`SELECT patient_id, specimen_id, marker, result FROM ihc_results
                WHERE patient_id IN (${qs})`).all(...chunk).forEach(r => {
      const o = map.get(r.patient_id); if (!o) return;
      o.ihcCount++;
      if (r.specimen_id != null) o.pairedIhcCount++;
      const marker = String(r.marker || '').toUpperCase();
      const result = String(r.result || '').toLowerCase();
      if (marker === 'PTEN' && result === 'lost') o.ptenLoss = true;
      if (marker === 'ERG' && result === 'positive') o.ergPositive = true;
      if (marker === 'AR' && result === 'positive') o.arPositive = true;
      if (marker === 'PSMA' && result === 'positive') o.psmaPositive = true;
      if (marker === 'KI67' && result === 'positive') o.ki67Positive = true;
      if (['SYN', 'CGA', 'CD56'].includes(marker) && result === 'positive') o.nePositive = true;
    });
    db.prepare(`SELECT patient_id, COUNT(*) AS n FROM radiation_records
                WHERE patient_id IN (${qs}) GROUP BY patient_id`).all(...chunk).forEach(r => {
      const o = map.get(r.patient_id); if (o) o.radiationCount = r.n;
    });
  }
  return map;
}

function buildPatient(p, opts) {
  const opt = (opts && typeof opts === 'object') ? opts : {};
  const detail = opt.detail !== false;
  const research = opt.research || null;
  const psa = db.prepare(
    'SELECT id, rec_date, value, is_initial, is_below_lod, lod_value, free_value, free_below_lod, free_lod_value, visit_id FROM psa_records WHERE patient_id=? ORDER BY rec_date, id'
  ).all(p.id).map(r => ({
    id: r.id, date: r.rec_date, val: r.value,
    isInitial: !!r.is_initial, visitId: r.visit_id || null,
    /* 左删失标记：true 表示该次结果低于检测下限（如「<0.03」），
       lod 存当次检测的下限值。前端据此显示「<0.03」而非裸数字。 */
    belowLod: !!r.is_below_lod, lod: r.lod_value != null ? r.lod_value : null,
    /* 游离PSA：未录时 freeVal 为 null（存量记录与只报总PSA的化验单都是这种）。
       前端在 freeVal != null 时才显示游离值与比值。 */
    freeVal: r.free_value != null ? r.free_value : null,
    freeBelowLod: !!r.free_below_lod,
    freeLod: r.free_lod_value != null ? r.free_lod_value : null,
    /* f/t 比值在读取时现算，保证与当前存储值永远一致；
       任一项低于检测下限或游离未录时为 null（不给假精度）。 */
    freeRatio: psaFreeRatio(r.value, !!r.is_below_lod, r.free_value, !!r.free_below_lod)
  }));

  /* 睾酮：value 为规范 ng/dl；unit/entered_value 保留录入口径（本院常用 nmol/L）。
     旧数据迁移后 entered_value=value、unit='ng/dl'。 */
  const testo = db.prepare(
    'SELECT id, rec_date, value, unit, entered_value, assay_method, lab, sample_time, visit_id FROM testosterone_records WHERE patient_id=? ORDER BY rec_date, id'
  ).all(p.id).map(r => ({
    id: r.id,
    date: r.rec_date,
    val: r.value,
    unit: r.unit || 'ng/dl',
    enteredVal: r.entered_value == null ? r.value : r.entered_value,
    assayMethod: r.assay_method || '',
    lab: r.lab || '',
    sampleTime: r.sample_time || '', visitId: r.visit_id || null
  }));

  /* 列表摘要不取化验/报告/图片，避免患者数上来后 payload 膨胀；
     详情页再按需取。 */
  /* 药物使用记录：按开始日期排序，结束日期为空表示仍在用。
     id 作为次级键，保证同一天开始的多种药有稳定顺序。 */
  const medications = db.prepare(
    'SELECT id, category, drug_name, start_date, end_date, dose, schedule, line_id, source, notes FROM medication_records WHERE patient_id=? ORDER BY start_date, id'
  ).all(p.id).map(r => ({
    id: r.id,
    category: r.category,
    drug: r.drug_name,
    startDate: r.start_date,
    endDate: r.end_date || null,
    dose: r.dose || '',
    schedule: r.schedule || '',
    lineId: r.line_id == null ? null : r.line_id,
    source: r.source || 'manual',
    notes: r.notes || ''
  }));

  /* 治疗线：一条线 = 一个情境下的一线方案；agents 存具体药物/剂量/周期。 */
  const tlRows = db.prepare(
    'SELECT id, line_no, setting, regimen, start_date, end_date, stop_reason, stop_reason_code, response, response_code FROM treatment_lines WHERE patient_id=? ORDER BY line_no, start_date, id'
  ).all(p.id);
  const agentsByLine = new Map();
  if (detail && tlRows.length) {
    const taRows = db.prepare(
      'SELECT id, line_id, drug, dose, schedule, start_date, end_date FROM treatment_agents WHERE line_id IN (' +
      tlRows.map(() => '?').join(',') + ') ORDER BY id'
    ).all(tlRows.map(x => x.id));
    taRows.forEach(a => {
      if (!agentsByLine.has(a.line_id)) agentsByLine.set(a.line_id, []);
      agentsByLine.get(a.line_id).push({
        id: a.id, drug: a.drug, dose: a.dose || '', schedule: a.schedule || '',
        startDate: a.start_date || null, endDate: a.end_date || null
      });
    });
  }
  /* 展示层收口：已完成但未填结束日期的治疗段（常见于自动监测→手术），
     不能让治疗线一直“进行中”，否则随访计划会继续按 AS 而不是术后生成。
     以同一线关联段的下一个治疗段开始日作为结束；不改数据库。 */
  const allEpsForLine = db.prepare('SELECT id,line_id,start_date,end_date,status FROM treatment_episodes WHERE patient_id=? ORDER BY start_date,id').all(p.id);
  const treatmentLines = tlRows.map(x => {
    let effectiveEnd = x.end_date || null;
    if (!effectiveEnd) {
      const linked = allEpsForLine.filter(e => Number(e.line_id) === Number(x.id)).sort((a,b) => String(a.start_date).localeCompare(String(b.start_date)));
      const done = linked.filter(e => e.status === 'completed').slice(-1)[0];
      if (done) {
        const next = allEpsForLine.find(e => String(e.start_date) > String(done.start_date));
        effectiveEnd = next ? next.start_date : (done.end_date || done.start_date);
      }
    }
    return {
    id: x.id,
    lineNo: x.line_no,
    setting: x.setting,
    regimen: x.regimen,
    startDate: x.start_date,
    endDate: effectiveEnd,
    stopReason: x.stop_reason || '',
    stopReasonCode: x.stop_reason_code || '',
    response: x.response || '',
    responseCode: x.response_code || '',
    agents: agentsByLine.get(x.id) || []
    };
  });

  /* 结构化监测：骨健康/心血管代谢/QoL/药物监测勾选。 */
  /* 普通化验：结构化行；时间轴上的“化验/监测”事件只是它的投影。 */
  const labValues = detail ? db.prepare(
    'SELECT id, rec_date, item_code, item_label, value, unit, lab, method, ref_range, flag, note, source, event_id, visit_id FROM lab_values WHERE patient_id=? ORDER BY rec_date, id'
  ).all(p.id).map(r => ({
    id: r.id, date: r.rec_date, itemCode: r.item_code, item: r.item_label || r.item_code,
    value: r.value == null ? null : r.value, unit: r.unit || '', lab: r.lab || '',
    method: r.method || '', refRange: r.ref_range || '', flag: r.flag || '',
    note: r.note || '', source: r.source || 'manual', eventId: r.event_id || null, visitId: r.visit_id || null
  })) : [];

  const clinicalRecords = db.prepare(
    'SELECT id, category, item, rec_date, value, unit, status, note, visit_id FROM clinical_records WHERE patient_id=? ORDER BY category, rec_date, id'
  ).all(p.id).map(r => ({
    id: r.id, category: r.category, item: canonicalClinicalItem(r.item), date: r.rec_date,
    val: r.value == null ? null : r.value, unit: r.unit || '',
    status: r.status || '', note: r.note || '', visitId: r.visit_id || null
  }));

  const reports = detail ? db.prepare(
    'SELECT id, filename, upload_date FROM reports WHERE patient_id=? ORDER BY id'
  ).all(p.id).map(r => ({ id: r.id, name: r.filename, date: r.upload_date, url: '/api/reports/' + r.id + '/file' })) : [];

  /* 排序必须带 id 作为次级键：确诊日当天往往同时有「PSA检测」与「穿刺病理报告」，
     只按日期排序则同日事件的先后由查询计划决定，刷新一次就可能变一次。
     填充脚本与录入界面都按临床先后顺序插入，id 递增即可稳定复现该顺序。 */
  const evRows = db.prepare(
    'SELECT id, event_date, event_type, gleason, stage, is_surgery, psa_record_id, details, notes, testo_record_id, lab_record_id, guided_batch, visit_id, episode_id FROM timeline_events WHERE patient_id=? ORDER BY event_date, id'
  ).all(p.id);

  /* 结构化记录只在详情页取；列表摘要用不到。 */
  const pathologyReports = db.prepare(
    'SELECT * FROM pathology_reports WHERE patient_id=? ORDER BY is_primary DESC, report_date, id'
  ).all(p.id).map(r => ({
    id: r.id, eventId: r.event_id || null, visitId: r.visit_id || null,
    specimenType: r.specimen_type, reportDate: r.report_date,
    coresTotal: r.cores_total == null ? null : r.cores_total,
    coresPositive: r.cores_positive == null ? null : r.cores_positive,
    coresPositivePct: r.cores_positive_pct == null ? null : r.cores_positive_pct,
    gleasonPrimary: r.gleason_primary == null ? null : r.gleason_primary,
    gleasonSecondary: r.gleason_secondary == null ? null : r.gleason_secondary,
    gleasonTotal: r.gleason_total == null ? null : r.gleason_total,
    isup: r.isup == null ? null : r.isup,
    ptnm: r.ptnm || '', marginStatus: r.margin_status || 'unknown', marginSite: r.margin_site || '',
    ece: r.ece == null ? null : !!r.ece, svi: r.svi == null ? null : !!r.svi,
    lnPositive: r.ln_positive == null ? null : r.ln_positive,
    lnExamined: r.ln_examined == null ? null : r.ln_examined,
    idcP: r.idc_p == null ? null : !!r.idc_p, cribriform: r.cribriform == null ? null : !!r.cribriform,
    dac: r.dac == null ? null : !!r.dac, nepc: r.nepc == null ? null : !!r.nepc,
    nepcDetail: r.nepc_detail || '', pni: r.pni == null ? null : !!r.pni,
    tumorVolumePct: r.tumor_volume_pct == null ? null : r.tumor_volume_pct,
    tumorCellPct: r.tumor_cell_pct == null ? null : r.tumor_cell_pct,
    coresMaxCancerPct: r.cores_max_cancer_pct == null ? null : r.cores_max_cancer_pct,
    histologyType: r.histology_type || '', specimenSite: r.specimen_site || '',
    biopsyRoute: r.biopsy_route || '', biopsyGuidance: r.biopsy_guidance || '',
    isPrimary: !!r.is_primary, notes: r.notes || ''
  }));

  const imagingStudies = db.prepare(
    'SELECT * FROM imaging_studies WHERE patient_id=? ORDER BY study_date, id'
  ).all(p.id).map(r => ({
    id: r.id, eventId: r.event_id || null, visitId: r.visit_id || null, modality: r.modality, studyDate: r.study_date,
    region: r.region || '', lesionCount: r.lesion_count == null ? null : r.lesion_count,
    metastaticSites: r.metastatic_sites || '', extraPelvic: r.extra_pelvic == null ? null : !!r.extra_pelvic,
    newLesion: r.new_lesion == null ? null : !!r.new_lesion,
    pirads: r.pirads == null ? null : r.pirads,
    psmaPositive: r.psma_positive == null ? null : !!r.psma_positive,
    psmaSuvmax: r.psma_suvmax == null ? null : r.psma_suvmax,
    psmaLesionCount: r.psma_lesion_count == null ? null : r.psma_lesion_count,
    recist: r.recist || '', pcwg: r.pcwg || '', flare: r.flare == null ? null : !!r.flare,
    oligoStatus: r.oligo_status || '',
    technique: r.technique || '', indexLocation: r.index_location || '',
    indexSizeMm: r.index_size_mm == null ? null : r.index_size_mm,
    ece: r.ece == null ? null : !!r.ece, svi: r.svi == null ? null : !!r.svi,
    prostateVolumeMl: r.prostate_volume_ml == null ? null : r.prostate_volume_ml,
    dimTransverseCm: r.dim_transverse_cm == null ? null : r.dim_transverse_cm,
    dimApCm: r.dim_ap_cm == null ? null : r.dim_ap_cm,
    dimCranialCm: r.dim_cranial_cm == null ? null : r.dim_cranial_cm,
    lnShortAxisMm: r.ln_short_axis_mm == null ? null : r.ln_short_axis_mm,
    superscan: r.superscan == null ? null : !!r.superscan,
    lungNoduleCount: r.lung_nodule_count == null ? null : r.lung_nodule_count,
    lungNoduleMaxMm: r.lung_nodule_max_mm == null ? null : r.lung_nodule_max_mm,
    miTnm: r.mi_tnm || '', psmaRads: r.psma_rads || '',
    changedManagement: r.changed_management == null ? null : !!r.changed_management,
    comparison: r.comparison || '',
    isCurrent: !!r.is_current, notes: r.notes || ''
  }));

  const radiationRecords = detail ? db.prepare(
    'SELECT * FROM radiation_records WHERE patient_id=? ORDER BY start_date, id'
  ).all(p.id).map(r => ({
    id: r.id, eventId: r.event_id || null, visitId: r.visit_id || null, rtType: r.rt_type,
    startDate: r.start_date, endDate: r.end_date || null,
    doseGy: r.dose_gy == null ? null : r.dose_gy,
    fractions: r.fractions == null ? null : r.fractions,
    target: r.target || '', concurrentAdt: r.concurrent_adt == null ? null : !!r.concurrent_adt,
    adtDurationMonths: r.adt_duration_months == null ? null : r.adt_duration_months,
    technique: r.technique || '', toxicityGrade: r.toxicity_grade || '',
    isCurrent: !!r.is_current, notes: r.notes || ''
  })) : [];

  const outcomes = db.prepare(
    'SELECT * FROM patient_outcomes WHERE patient_id=? ORDER BY event_date, id'
  ).all(p.id).map(r => ({
    id: r.id, eventId: r.event_id || null, visitId: r.visit_id || null, outcomeType: r.outcome_type,
    eventDate: r.event_date, subtype: r.subtype || '', basis: r.basis || '',
    psaValue: r.psa_value == null ? null : r.psa_value,
    imagingNegative: r.imaging_negative == null ? null : !!r.imaging_negative,
    metastaticSites: r.metastatic_sites || '',
    lesionCount: r.lesion_count == null ? null : r.lesion_count,
    oligoStatus: r.oligo_status || '', deathCause: r.death_cause || '',
    lostReason: r.lost_reason || '', lastContactDate: r.last_contact_date || null,
    note: r.note || ''
  }));

  const specimens = detail ? db.prepare(
    'SELECT * FROM specimens WHERE patient_id=? ORDER BY collection_date, id'
  ).all(p.id).map(r => ({
    id: r.id, sampleType: r.sample_type, collectionDate: r.collection_date,
    timepoint: r.timepoint || '', treatmentStatus: r.treatment_status || '',
    storage: r.storage || '', tumorCellPct: r.tumor_cell_pct == null ? null : r.tumor_cell_pct,
    nucleicQuality: r.nucleic_quality || '', libraryId: r.library_id || '',
    biobankId: r.biobank_id || '', notes: r.notes || ''
  })) : [];

  const genomicTests = detail ? db.prepare(
    'SELECT * FROM genomic_tests WHERE patient_id=? ORDER BY test_date, id'
  ).all(p.id).map(r => ({
    id: r.id, specimenId: r.specimen_id || null, testType: r.test_type,
    testDate: r.test_date, lab: r.lab || '', platform: r.platform || '',
    genes: r.genes || '', hrrStatus: r.hrr_status || '', msiStatus: r.msi_status || '',
    tmbValue: r.tmb_value == null ? null : r.tmb_value,
    arStatus: r.ar_status || '', tp53Status: r.tp53_status || '',
    ptenStatus: r.pten_status || '', rb1Status: r.rb1_status || '',
    resultSummary: r.result_summary || '', notes: r.notes || ''
  })) : [];

  const ihcResults = detail ? db.prepare(
    'SELECT * FROM ihc_results WHERE patient_id=? ORDER BY marker, test_date, id'
  ).all(p.id).map(r => ({
    id: r.id, specimenId: r.specimen_id || null, marker: r.marker,
    result: r.result || '', percent: r.percent == null ? null : r.percent,
    intensity: r.intensity || '', testDate: r.test_date || null,
    lab: r.lab || '', notes: r.notes || ''
  })) : [];

  const imgRows = detail && evRows.length
    ? db.prepare(
        'SELECT id, event_id, filename, upload_date FROM timeline_images WHERE event_id IN (' +
        evRows.map(() => '?').join(',') + ') ORDER BY id'
      ).all(evRows.map(e => e.id))
    : [];
  const imgsByEvent = new Map();
  imgRows.forEach(r => {
    if (!imgsByEvent.has(r.event_id)) imgsByEvent.set(r.event_id, []);
    imgsByEvent.get(r.event_id).push({
      id: r.id, name: r.filename, date: r.upload_date, url: '/api/timeline-images/' + r.id + '/file'
    });
  });

  const pathByEvent = new Map(pathologyReports.filter(x => x.eventId).map(x => [x.eventId, x]));
  const imgByEvent = new Map(imagingStudies.filter(x => x.eventId).map(x => [x.eventId, x]));
  const rtByEvent = new Map(radiationRecords.filter(x => x.eventId).map(x => [x.eventId, x]));
  const outcomeByEvent = new Map(outcomes.filter(x => x.eventId).map(x => [x.eventId, x]));

  /* PSA 数值一律现查现给，不存在事件表里。
     psa_records 是唯一数据源：医生在复查区把 0.08 改成 0.12，
     时间轴上那个节点显示的数值必须跟着变，不能出现两处各说各话。
     睾酮/化验镜像同理：数值现查 testosterone_records / labs_records，
     details 只是录入时的文字摘要兜底（记录被改过数值时以记录为准）。 */
  const psaValById = new Map(psa.map(r => [r.id, r.val]));
  const testoById = new Map(testo.map(r => [r.id, r]));
  const events = evRows.map(e => {
    const structured = e.id != null
      ? (pathByEvent.get(e.id) ? { kind: 'pathology', data: pathByEvent.get(e.id) }
        : imgByEvent.get(e.id) ? { kind: 'imaging', data: imgByEvent.get(e.id) }
        : rtByEvent.get(e.id) ? { kind: 'radiation', data: rtByEvent.get(e.id) }
        : outcomeByEvent.get(e.id) ? { kind: 'outcome', data: outcomeByEvent.get(e.id) }
        : null)
      : null;
    const base = {
      id: e.id, date: e.event_date, type: e.event_type,
      gleason: e.gleason || '', stage: e.stage || '',
      isSurgery: !!e.is_surgery,
      guidedBatch: e.guided_batch || '',
      /* psaRecordId/psaVal 仅镜像事件有值；前端据此锁定编辑并显示数值 */
      psaRecordId: e.psa_record_id || null,
      psaVal: e.psa_record_id != null && psaValById.has(e.psa_record_id) ? psaValById.get(e.psa_record_id) : null,
      testoRecordId: e.testo_record_id || null,
      testoVal: e.testo_record_id != null && testoById.has(e.testo_record_id) ? testoById.get(e.testo_record_id).val : null,
      testoUnit: e.testo_record_id != null && testoById.has(e.testo_record_id) ? testoById.get(e.testo_record_id).unit : null,
      testoEnteredVal: e.testo_record_id != null && testoById.has(e.testo_record_id) ? testoById.get(e.testo_record_id).enteredVal : null,
      labRecordId: e.lab_record_id || null,
      visitId: e.visit_id || null,
      episodeId: e.episode_id || null,
      labItem: null,
      labVal: null,
      labNote: null
    };
    if (!detail) return base;
    return Object.assign(base, {
      /* details 为镜像摘要，notes 为医生手写的自由备注，两者不要混用 */
      details: e.details || null,
      notes: e.notes || '',
      images: imgsByEvent.get(e.id) || [],
      structured
    });
  });

  return {
    id: p.id, name: p.name, age: displayAge(p), birth: p.birth_date || null,
    createdAt: p.created_at || null,
    surgDate: p.surg_date || null,
    date: p.diag_date, gleason: p.gleason || '',
    gleasonSource: p.gleason_source || '',
    pathologicStageSource: p.pathologic_stage_source || '',
    /* 临床/病理分期拆分；旧 stage 作为兼容回退。 */
    stage: p.clinical_stage || p.pathologic_stage || p.stage || '',
    clinicalStage: p.clinical_stage || (p.stage && !/^p/i.test(p.stage) ? p.stage : ''),
    pathologicStage: p.pathologic_stage || (p.stage && /^p/i.test(p.stage) ? p.stage : ''),
    treatment: p.treatment || '',
    concomitantMeds: p.concomitant_meds || '',
    /* status 保留兼容；疾病状态由前端自动计算，followupStatus 只记录在访/失访/死亡。 */
    status: p.status || PENDING_STATUS,
    followupStatus: p.followup_status || '在访',
    legacyStatus: (p.status && p.status !== PENDING_STATUS) ? p.status : null,
    psa, reports, events,
    /* CSCO 2026 对齐的新字段：治疗情境切分、去势状态、转移负荷、末次随访 */
    rtEndDate: p.rt_end_date || null,
    adtStartDate: p.adt_start_date || null,
    lastFollowupDate: p.last_followup_date || null,
    lastFollowupMode: p.last_followup_mode || '',
    /* 三态字段：null=未评估，不再把「没填」显示成否/0 */
    castration: p.castration_status == null ? null : !!p.castration_status,
    metCount: p.met_count == null ? null : p.met_count,
    metExtraPelvis: p.met_extra_pelvis == null ? null : !!p.met_extra_pelvis,
    visceralMet: p.visceral_met == null ? null : !!p.visceral_met,
    oligoType: p.oligo_type || '',
    familyHistory: p.family_history == null ? null : !!p.family_history,
    familyHistoryDetail: p.family_history_detail || '',
    dreResult: p.dre_result || '',
    dreNote: p.dre_note || '',
    diseaseCategory: p.disease_category || '',
    mainSymptom: p.main_symptom || '',
    symptomDurationMonths: p.symptom_duration_months == null ? null : p.symptom_duration_months,
    baselinePainNrs: p.baseline_pain_nrs == null ? null : p.baseline_pain_nrs,
    birthplace: p.birthplace || '',
    admissionNoMasked: maskAdmissionNo(p.admission_no),
    hasAdmissionNo: !!p.admission_no,
    ecog: p.ecog == null ? null : p.ecog,
    charlson: p.charlson == null ? null : p.charlson,
    bmi: p.bmi == null ? null : p.bmi,
    smoking: p.smoking || '',
    race: p.race || '',
    ethnicity: p.ethnicity || '',
    centerId: p.center_id || '',
    researchConsent: p.research_consent == null ? null : !!p.research_consent,
    researchConsentDate: p.research_consent_date || null,
    researchConsentVersion: p.research_consent_version || '',
    dataSharing: p.data_sharing == null ? null : !!p.data_sharing,
    dataSharingScope: p.data_sharing_scope || '',
    dataSharingDate: p.data_sharing_date || null,
    testo, labValues, medications, treatmentLines, clinicalRecords,
    pathologyReports, imagingStudies, outcomes,
    ...(detail ? { radiationRecords, specimens, genomicTests, ihcResults } : {}),
    ...(research ? { research } : {}),
    ...(detail ? { workspace: buildWorkspace(p) } : {}),
    owner: p.created_by || null
  };
}
const getP = id => db.prepare('SELECT * FROM patients WHERE id=?').get(id);

/* ================= v13：治疗段 / 就诊 / 毒性 的对象映射 ================= */
function maskAdmissionNo(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}
function episodeApi(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id,
    episodeType: r.episode_type, templateCode: r.template_code,
    label: r.label || '', intent: r.intent || '', lineId: r.line_id == null ? null : r.line_id,
    guidelineScenario: r.guideline_scenario || '', guidelineOptionId: r.guideline_option_id || '',
    recommendationLevel: r.recommendation_level || '', guidelineRef: r.guideline_ref || '',
    startDate: r.start_date, endDate: r.end_date || null, status: r.status,
    stopReasonCode: r.stop_reason_code || '', followupIntervalDays: r.followup_interval_days == null ? null : r.followup_interval_days,
    source: r.source || 'manual', notes: r.notes || '', createdAt: r.created_at || null,
    template: templateByCode(r.template_code) || null
  };
}
function visitApi(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id, visitDate: r.visit_date, visitType: r.visit_type,
    department: r.department || '', physician: r.physician || '', chiefComplaint: r.chief_complaint || '',
    ecog: r.ecog == null ? null : r.ecog, painNrs: r.pain_nrs == null ? null : r.pain_nrs,
    summary: r.summary || '', nextPlan: r.next_plan || '', nextVisitDate: r.next_visit_date || null,
    mdtParticipants: r.mdt_participants || '', mdtConclusion: r.mdt_conclusion || '',
    source: r.source || 'manual', status: r.status || 'final',
    createdAt: r.created_at || null, updatedAt: r.updated_at || null
  };
}
function rowApi(r) {
  if (!r) return null;
  return {
    id: r.id, visitId: r.visit_id, episodeId: r.episode_id, visitNo: r.visit_no == null ? null : r.visit_no,
    rowType: r.row_type, overallResponse: r.overall_response || 'NA', responseBasis: r.response_basis || 'none',
    psaResponse: r.psa_response || 'NA', imagingResponse: r.imaging_response || 'NA',
    clinicalResponse: r.clinical_response || 'NA',
    ecog: r.ecog == null ? null : r.ecog, painNrs: r.pain_nrs == null ? null : r.pain_nrs,
    symptomStatus: r.symptom_status || '', summary: r.summary || '', notes: r.notes || '',
    nextVisitDate: r.next_visit_date || null, visitDate: r.visit_date || null
  };
}
function itemApi(r) {
  if (!r) return null;
  return {
    id: r.id, visitId: r.visit_id, episodeRowId: r.episode_row_id == null ? null : r.episode_row_id,
    itemCode: r.item_code, itemLabel: r.item_label || '', status: r.status || 'pending',
    reason: r.reason || '', dueDate: r.due_date || null,
    linkedTable: r.linked_table || '', linkedId: r.linked_id == null ? null : r.linked_id,
    source: r.source || 'manual'
  };
}
function aeApi(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id, visitId: r.visit_id == null ? null : r.visit_id,
    episodeRowId: r.episode_row_id == null ? null : r.episode_row_id,
    chemoCycleId: r.chemo_cycle_id == null ? null : r.chemo_cycle_id,
    episodeId: r.episode_id == null ? null : r.episode_id,
    termCode: r.term_code, termLabel: r.term_label || '',
    grade: r.grade == null ? null : r.grade, ctcaeVersion: r.ctcae_version || '',
    gradeBasis: r.grade_basis || '', onsetDate: r.onset_date || null, resolutionDate: r.resolution_date || null,
    recoveryStatus: r.recovery_status || 'unknown', auxMeds: r.aux_meds || '', management: r.management || '',
    action: r.action || 'none', causality: r.causality || '', notes: r.notes || '',
    visitDate: r.visit_date || null
  };
}
function surgeryApi(r) {
  if (!r) return null;
  let complications = [];
  try { complications = JSON.parse(r.complications_json || '[]'); } catch (e) { complications = []; }
  return {
    id: r.id, patientId: r.patient_id, episodeId: r.episode_id == null ? null : r.episode_id,
    eventId: r.event_id == null ? null : r.event_id, surgeryDate: r.surgery_date,
    surgeon: r.surgeon || '', procedure: r.procedure || '', approach: r.approach || '',
    nerveSparing: r.nerve_sparing || '', lnDissection: r.ln_dissection || '',
    lnExaminedLeft: r.ln_examined_left == null ? null : r.ln_examined_left,
    lnPositiveLeft: r.ln_positive_left == null ? null : r.ln_positive_left,
    lnExaminedRight: r.ln_examined_right == null ? null : r.ln_examined_right,
    lnPositiveRight: r.ln_positive_right == null ? null : r.ln_positive_right,
    catheterDays: r.catheter_days == null ? null : r.catheter_days,
    drainDays: r.drain_days == null ? null : r.drain_days,
    complications, complicationManagement: r.complication_management || '',
    conversion: !!r.conversion, bloodLossMl: r.blood_loss_ml == null ? null : r.blood_loss_ml,
    hospitalDays: r.hospital_days == null ? null : r.hospital_days,
    pathologyId: r.pathology_id == null ? null : r.pathology_id, notes: r.notes || ''
  };
}
function chemoApi(r) {
  if (!r) return null;
  let agents = [];
  try { agents = JSON.parse(r.agents_json || '[]'); } catch (e) { agents = []; }
  return {
    id: r.id, patientId: r.patient_id, episodeId: r.episode_id, lineId: r.line_id == null ? null : r.line_id,
    cycleNo: r.cycle_no, cycleDate: r.cycle_date, regimen: r.regimen || '', agents,
    bsa: r.bsa == null ? null : r.bsa, plannedDose: r.planned_dose || '', actualDose: r.actual_dose || '',
    doseReductionPct: r.dose_reduction_pct == null ? null : r.dose_reduction_pct,
    delayDays: r.delay_days == null ? null : r.delay_days, delayReason: r.delay_reason || '',
    gcsf: !!r.gcsf, ecog: r.ecog == null ? null : r.ecog,
    psaRecordId: r.psa_record_id == null ? null : r.psa_record_id,
    assessmentVisitId: r.assessment_visit_id == null ? null : r.assessment_visit_id,
    nextCycleDate: r.next_cycle_date || null, notes: r.notes || ''
  };
}
function adminApi(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id, medicationId: r.medication_id == null ? null : r.medication_id,
    episodeId: r.episode_id == null ? null : r.episode_id, adminDate: r.admin_date,
    drug: r.drug, dose: r.dose || '', route: r.route || '', site: r.site || '', lot: r.lot || '',
    nextDueDate: r.next_due_date || null, notes: r.notes || ''
  };
}
function comorbidityApi(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id, system: r.system || '', diseaseCode: r.disease_code,
    diseaseLabel: r.disease_label || '', status: r.status || 'unknown', severity: r.severity || '',
    diagnosedDate: r.diagnosed_date || null, notes: r.notes || '', source: r.source || 'manual'
  };
}
function stateApi(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id, stateCode: r.state_code, stateLabel: r.state_label || '',
    sinceDate: r.since_date, basis: r.basis || '', evidenceJson: r.evidence_json || '',
    status: r.status || 'confirmed', confirmedBy: r.confirmed_by || '', confirmedAt: r.confirmed_at || null,
    supersededAt: r.superseded_at || null, isCurrent: !!r.is_current
  };
}

/* 详情页摘要：当前段、全部就诊/行/AE（64 例规模可控），
   列表接口不调用本函数，避免 N+1；分页接口仍保留。 */
function buildWorkspace(p) {
  const episodes = db.prepare(
    'SELECT * FROM treatment_episodes WHERE patient_id=? ORDER BY start_date, id'
  ).all(p.id).map(episodeApi);
  const visitRows = db.prepare(
    `SELECT * FROM visits WHERE patient_id=? ORDER BY visit_date DESC, id DESC`
  ).all(p.id);
  const visits = visitRows.map(visitApi);
  const visitIds = visitRows.map(v => v.id);
  const rows = db.prepare(
    `SELECT r.*, v.visit_date FROM visit_episode_rows r JOIN visits v ON v.id=r.visit_id
      WHERE v.patient_id=? ORDER BY v.visit_date, r.visit_no, r.id`
  ).all(p.id).map(rowApi);
  const items = db.prepare(
    `SELECT i.* FROM visit_items i JOIN visits v ON v.id=i.visit_id
      WHERE v.patient_id=? ORDER BY i.visit_id, i.id`
  ).all(p.id);
  const aes = db.prepare(
    `SELECT a.*, v.visit_date FROM adverse_events a LEFT JOIN visits v ON v.id=a.visit_id
      WHERE a.patient_id=? ORDER BY IFNULL(v.visit_date,a.onset_date), a.id`
  ).all(p.id).map(aeApi);
  const comorbidities = db.prepare(
    'SELECT * FROM comorbidities WHERE patient_id=? ORDER BY system, disease_code'
  ).all(p.id).map(comorbidityApi);
  const diseaseStates = db.prepare(
    'SELECT * FROM disease_states WHERE patient_id=? ORDER BY since_date, id'
  ).all(p.id).map(stateApi);
  const surgeryRecords = db.prepare(
    'SELECT * FROM surgery_records WHERE patient_id=? ORDER BY surgery_date, id'
  ).all(p.id).map(surgeryApi);
  const chemoCycles = db.prepare(
    'SELECT * FROM chemo_cycles WHERE patient_id=? ORDER BY cycle_date, cycle_no, id'
  ).all(p.id).map(chemoApi);
  const administrations = db.prepare(
    'SELECT * FROM medication_administrations WHERE patient_id=? ORDER BY admin_date, id'
  ).all(p.id).map(adminApi);
  const visitCount = db.prepare('SELECT COUNT(*) AS n FROM visits WHERE patient_id=?').get(p.id).n;
  const activeEpisodes = episodes.filter(e => e.status === 'active');
  const grade2plus = aes.filter(a => a.grade != null && a.grade >= 2 && a.recoveryStatus !== 'recovered');
  const latestRowByEpisode = {};
  rows.forEach(r => { if (r.visitDate) latestRowByEpisode[r.episodeId] = r; });
  return {
    episodes, activeEpisodes, visits, visitCount,
    rows, items, adverseEvents: aes, grade2plus,
    comorbidities, diseaseStates, surgeryRecords, chemoCycles, administrations,
    latestRowByEpisode,
    catalogVersion: catalogSummary().version,
    summary: catalogSummary()
  };
}


/* ================= 时间轴：手术日期同步与校验 ================= */

/* 用时间轴上的手术事件反推 surg_date。
   必须在事件写操作的同一个事务内调用，否则中间状态会被其他请求读到。
   取最早日期：临床上根治术只做一次，出现多条通常是重复录入，取最早最安全。

   刻意不参考 treatment 字段——「做过手术」是客观事实，
   不会因为医生后来把首选治疗改成放疗就该从档案里消失。 */
function syncSurgDate(patientId) {
  const row = db.prepare(
    'SELECT MIN(event_date) AS d FROM timeline_events WHERE patient_id=? AND is_surgery=1'
  ).get(patientId);
  db.prepare('UPDATE patients SET surg_date=? WHERE id=?').run(row && row.d ? row.d : null, patientId);
}

/* 一次性纠正历史误勾选：旧界面允许任意事件勾「记为手术」，
   这里只保留真正 RP 事件的手术标记，并重算受影响患者的手术日期。幂等。 */
{
  const bad = db.prepare(
    'SELECT DISTINCT patient_id FROM timeline_events WHERE is_surgery=1 AND event_type<>?'
  ).all(RP_EVENT_TYPE);
  if (bad.length) {
    db.transaction(() => {
      db.prepare('UPDATE timeline_events SET is_surgery=0 WHERE is_surgery=1 AND event_type<>?').run(RP_EVENT_TYPE);
      bad.forEach(r => syncSurgDate(r.patient_id));
    })();
    console.log('🔧 已清理 ' + bad.length + ' 位患者名下非 RP 事件的手术标记');
  }
}

const getSurgeryEventDate = id => {
  const row = db.prepare(
    'SELECT MIN(event_date) AS d FROM timeline_events WHERE patient_id=? AND is_surgery=1'
  ).get(id);
  return (row && row.d) || null;
};

/* 事件字段校验：合法返回规范化对象，非法返回 { error } 由调用方转 400。
   event_type 是医生自定义文本，长度必须设上限——它要进下拉框、时间轴节点和备份 JSON。 */

/* ================= 结构化专病数据校验 =================
   前端 record-core.js 有一份同语义校验；服务端这里是最终权威。
   枚举值必须与 public/record-core.js 保持一致。 */
const PATH_SPECIMEN_TYPES = ['biopsy', 'RP', 'TURP', 'metastasis', 'review', 'unknown'];
const MARGIN_STATUSES = ['negative', 'positive', 'close', 'unknown'];
const IMAGING_MODALITIES = ['mpMRI', 'CT', 'MRI', 'PSMA_PET', 'PSMA_PET_MRI', 'bone_scan', 'choline_pet', 'other'];
const MET_SITES = ['bone', 'lymph_node', 'visceral', 'other'];
/* 与旧片比较：CSCO 6.1/8.2.1 的“新发/进展/稳定”表述；improved 用于治疗有效 */
const IMAGING_COMPARISONS = ['', 'new', 'progress', 'stable', 'improved', 'mixed', 'na'];
/* PSMA-RADS（分子影像分级）：1 良性，2 可能良性，3 不确定，4 可能恶性，5 恶性 */
const PSMA_RADS_VALUES = ['', '1', '2', '3', '4', '5'];
/* 组织学类型：腺泡腺癌之外的类型直接改变治疗强度（CSCO 第9章） */
const HISTOLOGY_TYPES = ['', 'acinar', 'ductal', 'idc_p', 'neuroendocrine', 'adenosquamous', 'mucinous', 'signet', 'other'];
const BIOPSY_ROUTES = ['', 'transrectal', 'transperineal', 'unknown'];
const BIOPSY_GUIDANCE = ['', 'us', 'mri_fusion', 'mri_cognitive', 'template', 'unknown'];
/* 疾病阶段四分类：非转移/转移 × 激素敏感/去势抵抗 */
const DISEASE_CATEGORIES = ['', 'nmHSPC', 'mHSPC', 'nmCRPC', 'mCRPC'];
const RECIST_VALUES = ['', 'CR', 'PR', 'SD', 'PD', 'NE'];
const PCWG_VALUES = ['', 'PSA_response', 'PSA_progression', 'bone_response', 'bone_progression', 'NE'];
const RT_TYPES = ['EBRT', 'SBRT', 'brachy', 'other'];
const RT_TARGETS = ['', 'prostate', 'pelvis', 'prostate_pelvis', 'metastasis', 'other'];
const OUTCOME_TYPES = ['BCR', 'CRPC', 'metastasis', 'death', 'lost'];
/* 寡转移/瘤负荷统一 code。oligo_sync/oligo_meta 保留同时/异时；影像/结局的
   oligo 是未分型低瘤负荷，clinical-core 与档案页都按低瘤负荷处理。 */
const OLIGO_CODES = ['', 'none', 'oligo', 'oligo_sync', 'oligo_meta', 'widespread', 'unknown'];
function normalizeOligoCode(v) {
  const raw = String(v == null ? '' : v).trim();
  if (OLIGO_CODES.includes(raw)) return raw;
  const map = {
    '无转移': 'none', '无': 'none', '寡转移': 'oligo', '低瘤负荷': 'oligo',
    '同时性寡转移/低瘤负荷': 'oligo_sync', '同时性寡转移': 'oligo_sync',
    '异时性寡转移/低瘤负荷': 'oligo_meta', '异时性寡转移': 'oligo_meta',
    '高瘤负荷': 'widespread', '广泛转移': 'widespread',
    '未评估': 'unknown', '未知': 'unknown'
  };
  return map[raw] || '';
}
const BCR_SUBTYPES = ['', 'persistence', 'recurrence'];
const CRPC_SUBTYPES = ['', 'nmCRPC', 'mCRPC'];
const DEATH_CAUSES = ['', 'prostate_cancer', 'other', 'unknown'];
const SAMPLE_TYPES = ['tissue_biopsy', 'tissue_RP', 'tissue_TURP', 'tissue_metastasis', 'blood', 'urine', 'ctDNA', 'other'];
const SAMPLE_TIMEPOINTS = ['', 'diagnosis', 'preop', 'postop', 'BCR', 'metastasis', 'progression', 'other'];
const SAMPLE_TREATMENT_STATUSES = ['', 'naive', 'ADT', 'ARPI', 'chemo', 'PARP', 'RT', 'other'];
const STORAGE_TYPES = ['', 'FFPE', 'fresh_frozen', 'RNAlater', 'other'];
const IHC_MARKERS = ['PTEN', 'ERG', 'AR', 'PSMA', 'KI67', 'SYN', 'CGA', 'CD56', 'P53', 'RB1', 'MSH2', 'MSH6', 'PMS2', 'MLH1', 'PDL1'];
const IHC_RESULTS = ['positive', 'negative', 'lost', 'retained', 'equivocal', 'not_done'];
const HRR_STATUSES = ['', 'pathogenic', 'VUS', 'negative', 'unknown'];
const MSI_STATUSES = ['', 'MSI-H', 'MSS', 'unknown'];

const STRUCTURED_EVENT_KINDS = {
  /* 2026-10-31 合并事件；旧名保留为别名，旧备份/旧客户端仍可解析 */
  '前列腺穿刺活检病理报告': 'pathology',
  '前列腺穿刺活检': 'pathology',
  '穿刺病理报告': 'pathology',
  '手术病理报告': 'pathology',
  '前列腺电切病理报告': 'pathology',
  '病理会诊/复核': 'pathology',
  '病理亚型复核(DAC/IDC-P/NEPC)': 'pathology',
  '转移灶活检病理': 'pathology',
  '多参数磁共振(mpMRI)': 'imaging',
  'PSMA PET-CT': 'imaging',
  'PSMA PET-MRI': 'imaging',
  '骨扫描(ECT)': 'imaging',
  '胸部CT': 'imaging',
  '腹盆腔CT': 'imaging',
  '腹盆腔MRI': 'imaging',
  '胆碱PET-CT': 'imaging',
  '影像学复查': 'imaging',
  '外照射放疗(EBRT)': 'radiation',
  '挽救性放疗(SRT)': 'radiation',
  '近距离放疗/粒子植入': 'radiation',
  '生化复发确认': 'outcome',
  '去势抵抗确认': 'outcome',
  '转移确认': 'outcome',
  '终止随访/死亡': 'outcome',
  '失访确认': 'outcome'
};
const OUTCOME_BY_EVENT = {
  '生化复发确认': 'BCR',
  '去势抵抗确认': 'CRPC',
  '转移确认': 'metastasis',
  '终止随访/死亡': 'death',
  '失访确认': 'lost'
};
const STRUCTURED_DEFAULT_FIELDS = {
  pathology: { specimenType: 'unknown' },
  imaging: { modality: 'other' },
  radiation: { rtType: 'EBRT' },
  outcome: { outcomeType: 'BCR' }
};

function structuredKindOfEvent(type) { return STRUCTURED_EVENT_KINDS[String(type || '').trim()] || null; }
function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function intOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function listText(v) {
  if (Array.isArray(v)) return v.map(x => text(x, 30)).filter(Boolean).join(',');
  return text(v, 120);
}
function listArr(v) {
  if (Array.isArray(v)) return v.map(x => text(x, 30)).filter(Boolean);
  return String(v || '').split(',').map(x => x.trim()).filter(Boolean);
}
/* 转移部位只接受标准编码；中文/大小写别名统一归一化，未知值报错而不是静默丢掉。 */
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
    if (!code || !MET_SITES.includes(code)) {
      return { error: '转移部位只接受 bone/lymph_node/visceral/other（或中文：骨/淋巴结/内脏/其他）' };
    }
    if (!out.includes(code)) out.push(code);
  }
  return { value: out };
}
function gleasonIsup(g) {
  const m = String(g || '').match(/^(\d)\+(\d)/);
  if (!m) return null;
  const a = +m[1], b = +m[2], total = a + b;
  if (total <= 6) return 1;
  if (total === 7) return a === 3 ? 2 : 3;
  if (total === 8) return 4;
  if (total >= 9) return 5;
  return null;
}
function validatePathologyBody(b, birth) {
  const d = b || {};
  const specimenType = text(d.specimenType, 20) || 'unknown';
  if (!PATH_SPECIMEN_TYPES.includes(specimenType)) return { error: '标本类型不合法' };
  const reportDate = normDate(d.reportDate);
  if (!reportDate) return { error: '病理日期格式应为 YYYY-MM-DD' };
  if (birth && reportDate < birth) return { error: '病理日期不能早于出生日期' };
  { const f = assertNotFuture(reportDate, '病理日期'); if (f) return { error: f }; }
  const gp = intOrNull(d.gleasonPrimary), gs = intOrNull(d.gleasonSecondary);
  if ((gp == null) !== (gs == null)) return { error: 'Gleason 原发/次要分型必须同时填写或同时留空' };
  if (gp != null && (gp < 1 || gp > 5 || gs < 1 || gs > 5)) return { error: 'Gleason 分型必须为 1–5' };
  const gleasonTotal = gp != null ? gp + gs : null;
  const isup = gleasonTotal != null ? gleasonIsup(gp + '+' + gs) : null;
  const coresTotal = intOrNull(d.coresTotal), coresPositive = intOrNull(d.coresPositive);
  if (coresTotal != null && coresTotal < 0) return { error: '穿刺总针数不能为负' };
  if (coresPositive != null && coresPositive < 0) return { error: '阳性针数不能为负' };
  if (coresTotal != null && coresPositive != null && coresPositive > coresTotal) return { error: '阳性针数不能大于总针数' };
  const coresPositivePct = (coresTotal && coresPositive != null)
    ? Math.round((coresPositive / coresTotal) * 1000) / 10 : null;
  const marginStatus = text(d.marginStatus, 20) || 'unknown';
  if (!MARGIN_STATUSES.includes(marginStatus)) return { error: '切缘状态不合法' };
  const lnPositive = intOrNull(d.lnPositive), lnExamined = intOrNull(d.lnExamined);
  if (lnPositive != null && lnPositive < 0) return { error: '淋巴结阳性数不能为负' };
  if (lnExamined != null && lnExamined < 0) return { error: '淋巴结检查数不能为负' };
  if (lnPositive != null && lnExamined != null && lnPositive > lnExamined) return { error: '淋巴结阳性数不能大于检查数' };
  const pct = v => { const n = numOrNull(v); return n == null ? null : Math.max(0, Math.min(100, n)); };
  /* ---- 2026-10 新增：按标本类型收敛字段 ----
     CSCO 3.3/3.4：穿刺标本报告针数、阳性针、Gleason/ISUP、PNI、IDC-P、筛状结构；
     pTNM/切缘/ECE/SVI/淋巴结只属于 RP（TURP 只有 pT 与瘤占比）。
     医生手误或旧客户端把手术字段塞进穿刺时，这里直接清空，避免“穿刺带 pT3a”这种脏数据。 */
  const isBiopsy = specimenType === 'biopsy';
  const isResection = specimenType === 'RP' || specimenType === 'TURP';
  const histologyType = text(d.histologyType, 20);
  if (!HISTOLOGY_TYPES.includes(histologyType)) return { error: '组织学类型不合法' };
  const biopsyRoute = text(d.biopsyRoute, 20);
  if (!BIOPSY_ROUTES.includes(biopsyRoute)) return { error: '穿刺路径不合法' };
  const biopsyGuidance = text(d.biopsyGuidance, 20);
  if (!BIOPSY_GUIDANCE.includes(biopsyGuidance)) return { error: '穿刺引导方式不合法' };
  return { value: {
    specimenType, reportDate,
    coresTotal: isBiopsy || specimenType === 'unknown' ? coresTotal : null,
    coresPositive: isBiopsy || specimenType === 'unknown' ? coresPositive : null,
    coresPositivePct: isBiopsy || specimenType === 'unknown' ? coresPositivePct : null,
    coresMaxCancerPct: isBiopsy ? pct(d.coresMaxCancerPct) : null,
    gleasonPrimary: gp, gleasonSecondary: gs, gleasonTotal, isup,
    ptnm: isResection ? text(d.ptnm, 20) : '',
    marginStatus: isResection ? marginStatus : 'unknown',
    marginSite: isResection ? text(d.marginSite, 80) : '',
    ece: isResection ? triState(d.ece) : null,
    svi: isResection ? triState(d.svi) : null,
    lnPositive: isResection ? lnPositive : null,
    lnExamined: isResection ? lnExamined : null,
    idcP: triState(d.idcP), cribriform: triState(d.cribriform), dac: triState(d.dac),
    nepc: triState(d.nepc), nepcDetail: text(d.nepcDetail, 200), pni: triState(d.pni),
    tumorVolumePct: pct(d.tumorVolumePct), tumorCellPct: pct(d.tumorCellPct),
    histologyType, specimenSite: text(d.specimenSite, 80),
    biopsyRoute: isBiopsy ? biopsyRoute : '',
    biopsyGuidance: isBiopsy ? biopsyGuidance : '',
    isPrimary: triState(d.isPrimary) === 1 ? 1 : 0,
    notes: text(d.notes, 1000)
  }};
}

function validateImagingBody(b, birth) {
  const d = b || {};
  const modality = text(d.modality, 20);
  if (!IMAGING_MODALITIES.includes(modality)) return { error: '影像模态不合法' };
  const studyDate = normDate(d.studyDate);
  if (!studyDate) return { error: '影像日期格式应为 YYYY-MM-DD' };
  if (birth && studyDate < birth) return { error: '影像日期不能早于出生日期' };
  { const f = assertNotFuture(studyDate, '影像日期'); if (f) return { error: f }; }
  const lesionCount = intOrNull(d.lesionCount);
  if (lesionCount != null && lesionCount < 0) return { error: '病灶数不能为负' };
  const pirads = intOrNull(d.pirads);
  if (pirads != null && (pirads < 1 || pirads > 5)) return { error: 'PI-RADS 必须为 1–5' };
  const suv = numOrNull(d.psmaSuvmax);
  if (suv != null && suv < 0) return { error: 'SUVmax 不能为负' };
  const siteCheck = normalizeMetSites(d.metastaticSites);
  if (siteCheck.error) return { error: siteCheck.error };
  const sites = siteCheck.value;
  const recist = text(d.recist, 10);
  if (!RECIST_VALUES.includes(recist)) return { error: 'RECIST 取值不合法' };
  const pcwg = text(d.pcwg, 30);
  if (!PCWG_VALUES.includes(pcwg)) return { error: 'PCWG 取值不合法' };
  const oligo = text(d.oligoStatus, 20);
  if (oligo && !['none', 'oligo', 'widespread', 'unknown'].includes(oligo)) return { error: '寡转移状态不合法' };
  /* ---- 2026-10 新增：按检查类型细化的报告字段 ---- */
  const comparison = text(d.comparison, 20);
  if (!IMAGING_COMPARISONS.includes(comparison)) return { error: '与旧片比较的取值不合法' };
  const psmaRads = text(d.psmaRads, 10);
  if (!PSMA_RADS_VALUES.includes(psmaRads)) return { error: 'PSMA-RADS 必须为 1–5' };
  const lengths = [
    ['indexSizeMm', d.indexSizeMm, '主病灶最大径'],
    ['prostateVolumeMl', d.prostateVolumeMl, '前列腺体积'],
    ['lnShortAxisMm', d.lnShortAxisMm, '淋巴结短径'],
    ['lungNoduleMaxMm', d.lungNoduleMaxMm, '肺结节最大径']
  ];
  const numMap = {};
  for (const [k, raw, label] of lengths) {
    const n = numOrNull(raw);
    if (n != null && n < 0) return { error: label + '不能为负' };
    numMap[k] = n;
  }
  const noduleCount = intOrNull(d.lungNoduleCount);
  if (noduleCount != null && noduleCount < 0) return { error: '肺结节数不能为负' };
  /* ---- 2026-10-31：MRI 前列腺三径（cm）→ 体积 ----
     三项要么全空、要么齐全；齐全时服务端重算体积，不信任前端算术。
     只有三径全空时才接受直接给的体积（旧数据、外院报告、AI 摘要）。 */
  const dims = [d.dimTransverseCm, d.dimApCm, d.dimCranialCm].map(v => numOrNull(v));
  const dimGiven = dims.filter(v => v != null).length;
  let prostateVolumeMl = numMap.prostateVolumeMl;
  let dimTransverseCm = null, dimApCm = null, dimCranialCm = null;
  if (dimGiven > 0 && dimGiven < 3) {
    return { error: '前列腺三径（横径/前后径/上下径）需同时填写，或全部留空' };
  }
  if (dimGiven === 3) {
    for (const v of dims) {
      if (!(v > 0) || v > 15) return { error: '前列腺三径应在 0–15 cm 之间' };
    }
    [dimTransverseCm, dimApCm, dimCranialCm] = dims;
    prostateVolumeMl = Math.round(0.52 * dimTransverseCm * dimApCm * dimCranialCm * 10) / 10;
  } else if (prostateVolumeMl != null && (prostateVolumeMl <= 0 || prostateVolumeMl > 500)) {
    return { error: '前列腺体积应在 0–500 ml 之间' };
  }
  /* 决策影响只在 PSMA/分子影像上问；其他影像存 null，避免被统计成“未改变” */
  const changed = (modality === 'PSMA_PET' || modality === 'PSMA_PET_MRI')
    ? triState(d.changedManagement) : null;
  return { value: {
    modality, studyDate, region: text(d.region, 80), lesionCount,
    metastaticSites: sites.join(','), extraPelvic: triState(d.extraPelvic),
    newLesion: triState(d.newLesion), pirads, psmaPositive: triState(d.psmaPositive),
    psmaSuvmax: suv, psmaLesionCount: intOrNull(d.psmaLesionCount),
    recist, pcwg, flare: triState(d.flare), oligoStatus: oligo,
    technique: text(d.technique, 120),
    indexLocation: text(d.indexLocation, 120),
    indexSizeMm: numMap.indexSizeMm,
    ece: triState(d.ece), svi: triState(d.svi),
    prostateVolumeMl,
    dimTransverseCm, dimApCm, dimCranialCm,
    lnShortAxisMm: numMap.lnShortAxisMm,
    superscan: triState(d.superscan),
    lungNoduleCount: noduleCount,
    lungNoduleMaxMm: numMap.lungNoduleMaxMm,
    miTnm: text(d.miTnm, 40),
    psmaRads: psmaRads,
    changedManagement: changed,
    comparison: comparison,
    isCurrent: triState(d.isCurrent) === 1 ? 1 : 0,
    notes: text(d.notes, 1000)
  }};
}

function validateRadiationBody(b, birth) {
  const d = b || {};
  const rtType = text(d.rtType, 20);
  if (!RT_TYPES.includes(rtType)) return { error: '放疗类型不合法' };
  const startDate = normDate(d.startDate);
  if (!startDate) return { error: '放疗开始日期格式应为 YYYY-MM-DD' };
  if (birth && startDate < birth) return { error: '放疗开始日期不能早于出生日期' };
  { const f = assertNotFuture(startDate, '放疗开始日期'); if (f) return { error: f }; }
  const endDate = d.endDate ? normDate(d.endDate) : null;
  if (d.endDate && !endDate) return { error: '放疗结束日期格式应为 YYYY-MM-DD' };
  if (endDate && endDate < startDate) return { error: '放疗结束日期不能早于开始日期' };
  { const f = assertNotFuture(endDate, '放疗结束日期'); if (f) return { error: f }; }
  const doseGy = numOrNull(d.doseGy);
  if (doseGy != null && doseGy <= 0) return { error: '放疗剂量必须大于 0' };
  const fractions = intOrNull(d.fractions);
  if (fractions != null && fractions <= 0) return { error: '分割次数必须为正整数' };
  const target = text(d.target, 30);
  if (!RT_TARGETS.includes(target)) return { error: '放疗靶区不合法' };
  const adtMonths = numOrNull(d.adtDurationMonths);
  if (adtMonths != null && adtMonths < 0) return { error: 'ADT 时长不能为负' };
  return { value: {
    rtType, startDate, endDate, doseGy, fractions, target,
    concurrentAdt: triState(d.concurrentAdt), adtDurationMonths: adtMonths,
    technique: text(d.technique, 80), toxicityGrade: text(d.toxicityGrade, 20),
    isCurrent: triState(d.isCurrent) === 1 ? 1 : 0,
    notes: text(d.notes, 1000)
  }};
}

function validateOutcomeBody(b, birth) {
  const d = b || {};
  const outcomeType = text(d.outcomeType, 20);
  if (!OUTCOME_TYPES.includes(outcomeType)) return { error: '结局类型不合法' };
  const eventDate = normDate(d.eventDate);
  if (!eventDate) return { error: '结局日期格式应为 YYYY-MM-DD' };
  if (birth && eventDate < birth) return { error: '结局日期不能早于出生日期' };
  { const f = assertNotFuture(eventDate, '结局日期'); if (f) return { error: f }; }
  const psaValue = numOrNull(d.psaValue);
  if (psaValue != null && psaValue < 0) return { error: 'PSA 值不能为负' };
  const lesionCount = intOrNull(d.lesionCount);
  if (lesionCount != null && lesionCount < 0) return { error: '病灶数不能为负' };
  const lastContactDate = d.lastContactDate ? normDate(d.lastContactDate) : null;
  if (d.lastContactDate && !lastContactDate) return { error: '末次接触日期格式应为 YYYY-MM-DD' };
  { const f = assertNotFuture(lastContactDate, '末次接触日期'); if (f) return { error: f }; }
  if (outcomeType === 'lost' && !lastContactDate) {
    return { error: '失访结局必须填写末次接触日期，用于生存分析删失' };
  }
  const subtype = text(d.subtype, 30);
  if (outcomeType === 'BCR' && !BCR_SUBTYPES.includes(subtype)) return { error: 'BCR 类型不合法' };
  if (outcomeType === 'CRPC' && !CRPC_SUBTYPES.includes(subtype)) return { error: 'CRPC 类型不合法' };
  const deathCause = text(d.deathCause, 30);
  if (outcomeType === 'death' && !DEATH_CAUSES.includes(deathCause)) return { error: '死亡原因不合法' };
  const outcomeSites = normalizeMetSites(d.metastaticSites);
  if (outcomeSites.error) return { error: outcomeSites.error };
  return { value: {
    outcomeType, eventDate, subtype, basis: text(d.basis, 20), psaValue,
    imagingNegative: triState(d.imagingNegative),
    metastaticSites: outcomeSites.value.join(','),
    lesionCount, oligoStatus: text(d.oligoStatus, 20),
    deathCause: outcomeType === 'death' ? deathCause : '',
    lostReason: outcomeType === 'lost' ? text(d.lostReason, 200) : '',
    lastContactDate: outcomeType === 'lost' ? lastContactDate : null,
    note: text(d.note, 1000)
  }};
}

function validateSpecimenBody(b, birth) {
  const d = b || {};
  const sampleType = text(d.sampleType, 30);
  if (!SAMPLE_TYPES.includes(sampleType)) return { error: '样本类型不合法' };
  const collectionDate = normDate(d.collectionDate);
  if (!collectionDate) return { error: '采样日期格式应为 YYYY-MM-DD' };
  if (birth && collectionDate < birth) return { error: '采样日期不能早于出生日期' };
  { const f = assertNotFuture(collectionDate, '采样日期'); if (f) return { error: f }; }
  const timepoint = text(d.timepoint, 20);
  if (!SAMPLE_TIMEPOINTS.includes(timepoint)) return { error: '采样时点不合法' };
  const treatmentStatus = text(d.treatmentStatus, 20);
  if (!SAMPLE_TREATMENT_STATUSES.includes(treatmentStatus)) return { error: '采样时治疗状态不合法' };
  const storage = text(d.storage, 20);
  if (!STORAGE_TYPES.includes(storage)) return { error: '保存方式不合法' };
  const tumorCellPct = numOrNull(d.tumorCellPct);
  if (tumorCellPct != null && (tumorCellPct < 0 || tumorCellPct > 100)) return { error: '肿瘤细胞含量应为 0–100%' };
  return { value: {
    sampleType, collectionDate, timepoint, treatmentStatus, storage,
    tumorCellPct, nucleicQuality: text(d.nucleicQuality, 60),
    libraryId: text(d.libraryId, 60), biobankId: text(d.biobankId, 60),
    notes: text(d.notes, 1000)
  }};
}

function validateGenomicBody(b, birth) {
  const d = b || {};
  const testType = text(d.testType, 20);
  if (!['germline', 'somatic'].includes(testType)) return { error: '检测类型只能是胚系或体系' };
  const testDate = normDate(d.testDate);
  if (!testDate) return { error: '检测日期格式应为 YYYY-MM-DD' };
  if (birth && testDate < birth) return { error: '检测日期不能早于出生日期' };
  { const f = assertNotFuture(testDate, '检测日期'); if (f) return { error: f }; }
  const hrrStatus = text(d.hrrStatus, 30);
  if (!HRR_STATUSES.includes(hrrStatus)) return { error: 'HRR 状态不合法' };
  const msiStatus = text(d.msiStatus, 20);
  if (!MSI_STATUSES.includes(msiStatus)) return { error: 'MSI 状态不合法' };
  const tmb = numOrNull(d.tmbValue);
  if (tmb != null && tmb < 0) return { error: 'TMB 不能为负' };
  return { value: {
    testType, testDate, lab: text(d.lab, 60), platform: text(d.platform, 60),
    genes: listArr(d.genes).join(','), hrrStatus, msiStatus, tmbValue: tmb,
    arStatus: text(d.arStatus, 30), tp53Status: text(d.tp53Status, 30),
    ptenStatus: text(d.ptenStatus, 30), rb1Status: text(d.rb1Status, 30),
    resultSummary: text(d.resultSummary, 1000), notes: text(d.notes, 1000)
  }};
}

function validateIhcBody(b, birth) {
  const d = b || {};
  const marker = text(d.marker, 20);
  if (!IHC_MARKERS.includes(marker)) return { error: 'IHC 标志物不合法' };
  const result = text(d.result, 20);
  if (!IHC_RESULTS.includes(result)) return { error: 'IHC 结果不合法' };
  const percent = numOrNull(d.percent);
  if (percent != null && (percent < 0 || percent > 100)) return { error: 'IHC 阳性百分比应为 0–100%' };
  const testDate = d.testDate ? normDate(d.testDate) : null;
  if (d.testDate && !testDate) return { error: 'IHC 检测日期格式应为 YYYY-MM-DD' };
  if (birth && testDate && testDate < birth) return { error: 'IHC 日期不能早于出生日期' };
  { const f = assertNotFuture(testDate, 'IHC 日期'); if (f) return { error: f }; }
  return { value: {
    marker, result, percent, intensity: text(d.intensity, 20),
    testDate, lab: text(d.lab, 60), notes: text(d.notes, 1000)
  }};
}

/* 引导登记批号：客户端生成的短 token（仅字母数字_-），长度受限，避免写进任意文本 */
function normGuidedBatch(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9_-]{6,40}$/.test(s) ? s : '';
}

function validateEventBody(b, birth) {
  const date = normDate(b.date);
  if (!date) return { error: '事件日期为必填，格式应为 YYYY-MM-DD' };
  if (birth && date < birth) return { error: '事件日期不能早于出生日期' };
  { const f = assertNotFuture(date, '事件日期'); if (f) return { error: f }; }
  const type = String(b.type || '').trim();
  if (!type) return { error: '诊疗活动不能为空' };
  if (type.length > 60) return { error: '诊疗活动名称不能超过 60 字' };
  /* PSA 类事件一律不允许经事件接口手工创建或改写。
     它们是 psa_records 的镜像，只能由 ensurePsaMirrorEvent 在录入复查时生成——
     两个入口都能写就必然出现「时间轴上有个 PSA 节点，但 psa_records 里没有这条记录」
     的数据孤岛，而且医生改了数值两边还会对不上。前端也已把这两个选项从下拉里去掉。
     注意：镜像事件本身的插入走的是 SQL 直写，不经过本函数，因此不受影响。 */
  if (type === PSA_INIT_EVENT_TYPE || type === PSA_FU_EVENT_TYPE) {
    return { error: '「' + type + '」事件由系统随 PSA 记录自动生成，请在「PSA复查记录」区录入，不要在时间轴手工添加' };
  }
  /* 睾酮仍是独立结构化记录；化验/监测已合并为普通病程事件，
     允许手工创建，但必须把项目/数值/单位写进临床备注。 */
  if (type === TESTO_EVENT_TYPE) {
    return { error: '「睾酮检测」由「血清睾酮」记录自动生成，请在对应记录区录入，不要在时间轴手工添加' };
  }
  const gleason = String(b.gleason || '').trim().slice(0, 20);
  const stage = String(b.stage || '').trim().slice(0, 20);
  const notes = String(b.notes || '').trim();
  if (notes.length > 1000) return { error: '临床备注不能超过 1000 字' };
  if (type === LAB_EVENT_TYPE && !notes) {
    return { error: '「化验/监测」事件请在临床备注中填写项目、数值和单位（可每行一项）' };
  }
  /* 手术标记由事件类型唯一决定，不再信任客户端布尔值。
     否则骨扫描、影像复查等任意事件都能被误标成手术，污染手术日期。 */
  const isSurgery = type === RP_EVENT_TYPE ? 1 : 0;
  return { date, type, gleason, stage, notes, isSurgery };
}

/* 药物记录校验：一条记录 = 一种药物/方案的一次连续使用。
   同一大类内不允许重叠；比卡鲁胺/氟他胺/尼鲁米特（内分泌）与 ARPI 不允许同期。
   不同大类可以同期（如 ADT+ARPI、ADT+多西他赛、ARPI+PARPi）。
   end_date 为空表示“仍在用”。 */
function validateMedicationBody(b, birth) {
  const body = b || {};
  const category = String(body.category || '').trim();
  if (!MED_CATEGORY_KEYS.has(category)) {
    return { error: '请选择有效的药物分类' };
  }
  const drug = String(body.drug || body.drugName || '').trim();
  if (!drug) return { error: '请填写药物/方案名称' };
  if (drug.length > 80) return { error: '药物/方案名称不能超过 80 字' };
  const start = normDate(body.startDate || body.start_date);
  if (!start) return { error: '开始日期为必填，格式应为 YYYY-MM-DD' };
  if (birth && start < birth) return { error: '开始日期不能早于出生日期' };
  { const f = assertNotFuture(start, '开始日期'); if (f) return { error: f }; }
  const endRaw = body.endDate !== undefined ? body.endDate : body.end_date;
  let end = null;
  if (endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== '') {
    end = normDate(endRaw);
    if (!end) return { error: '结束日期格式不正确（应为 YYYY-MM-DD）' };
    if (end < start) return { error: '结束日期不能早于开始日期' };
  }
  const notes = String(body.notes || '').trim();
  if (notes.length > 500) return { error: '用药备注不能超过 500 字' };
  const dose = String(body.dose || '').trim();
  if (dose.length > 40) return { error: '剂量不能超过 40 字' };
  const schedule = String(body.schedule || '').trim();
  if (schedule.length > 40) return { error: '频次不能超过 40 字' };
  return { category, drug, start, end, dose, schedule, notes };
}

/* 用药逻辑冲突检测。
   · 同一 category 内重叠（含同一天停药/换药）→ 拒绝，需至少间隔 1 天。
   · 内分泌（比卡鲁胺等）与 ARPI 使用闭区间，同一天也不允许，确保不同时暴露。
   不同大类（ADT+ARPI、ADT+化疗、ARPI+PARPi 等）不做限制。 */
function findMedicationConflict(p, v, excludeId) {
  const rows = db.prepare(
    'SELECT id, category, drug_name, start_date, end_date FROM medication_records WHERE patient_id=?'
  ).all(p.id).filter(r => Number(r.id) !== Number(excludeId));
  const FAR = '9999-12-31';
  const vEnd = v.end || FAR;
  for (const r of rows) {
    const rEnd = r.end_date || FAR;
    const sameCategory = r.category === v.category &&
      v.start <= rEnd && r.start_date <= vEnd;
    const endocrineVsArpi = (v.category === 'endocrine' && r.category === 'arpi') ||
      (v.category === 'arpi' && r.category === 'endocrine');
    const crossOverlap = endocrineVsArpi &&
      v.start <= rEnd && r.start_date <= vEnd;
    if (sameCategory) {
      return {
        error: '同一分类“' + (MED_CATEGORY_LABEL[v.category] || v.category) +
          '”内已有重叠用药：' + r.drug_name + '（' + r.start_date + ' → ' +
          (r.end_date || '至今') + '）。请先停用或调整原记录的结束日期。'
      };
    }
    if (crossOverlap) {
      return {
        error: '内分泌类药物（比卡鲁胺/氟他胺/尼鲁米特）不能与 ARPI 同期：' +
          r.drug_name + '（' + r.start_date + ' → ' + (r.end_date || '至今') +
          '）。请先停用内分泌药，或把 ARPI 的开始日期调到其后。'
      };
    }
  }
  return null;
}

/* 药物记录可选关联治疗线：line_id 必须属于同一患者。 */
function medicationLineId(p, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { lineId: null };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { error: '所属治疗线 id 无效' };
  const line = db.prepare('SELECT id FROM treatment_lines WHERE id=? AND patient_id=?').get(id, p.id);
  if (!line) return { error: '所属治疗线不存在或不属于该患者' };
  return { lineId: id };
}

/* 删除或改型最后一条 RP 事件前，若患者仍以「根治性手术」为首选治疗，
   会留下「治疗=手术、无手术日期」的矛盾状态，必须由医生先改治疗。 */
function lastSurgeryEventError(p, e, nextType) {
  if (e.event_type !== RP_EVENT_TYPE) return null;
  if (nextType === RP_EVENT_TYPE) return null;
  if (!(p.treatment || '').includes('手术')) return null;
  const n = db.prepare(
    'SELECT COUNT(*) AS n FROM timeline_events WHERE patient_id=? AND event_type=? AND id<>?'
  ).get(p.id, RP_EVENT_TYPE, e.id).n;
  if (n > 0) return null;
  return '这是该患者唯一一条根治性前列腺切除术事件。请先把首选治疗改为非手术，再删除或改型该事件。';
}

/* 治疗方式为根治性手术时，时间轴上必须有对应的手术事件。
   仅在 PUT 患者时强制执行：POST 时患者还没有 id，事件无法先于患者存在。 */
function requireSurgeryEvent(p, treatment) {
  if (!(treatment || '').includes('手术')) return null;
  return getSurgeryEventDate(p.id)
    ? null
    : '根治性手术患者须在时间轴中添加「' + RP_EVENT_TYPE + '」事件，用于记录手术日期';
}

/* ================= 患者归属与访问控制 =================
   规则：admin 可访问全部患者；普通医生(role='user')仅可访问 created_by 为自己的患者。
   created_by 为空的历史数据视为「无归属」，仅 admin 可见 —— 宁可少给权限，
   也不让来历不明的患者数据落到某个医生名下被误改误删。
   注意：psa_records.created_by 与 reports.uploaded_by 记录的是「谁执行的这次操作」，
   属审计语义，改派患者归属时不随之变更。 */
const isAdmin = u => !!(u && u.role === 'admin');

function canAccess(user, p) {
  if (!p) return false;
  if (isAdmin(user)) return true;
  return p.created_by === user.username;
}

/* 校验不通过时返回 false 并已写好响应，调用方应立即 return */
function requireOwn(req, res, p) {
  if (canAccess(req.user, p)) return true;
  logAudit(req.user.username, 'ACCESS_DENIED', '尝试访问非本人登记的患者 ' + p.id);
  res.status(403).json({ error: '无权访问该患者（非本人登记）' });
  return false;
}

function nextPatientId() {
  const row = db.prepare("SELECT value FROM meta WHERE key='id_counter'").get();
  const n = parseInt(row.value) || 1;
  db.prepare("UPDATE meta SET value=? WHERE key='id_counter'").run(String(n + 1));
  return 'PC-' + String(n).padStart(3, '0');
}

/* 登录限流：15分钟内最多10次失败尝试 */
const attempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;

/* 提取真实客户端 IP：优先取 X-Forwarded-For 的第一个地址（需配合 app.set('trust proxy', 1)）。
   若反代未正确传递该头，会退化为 req.ip，此时所有请求共用一个桶——
   上线后请用验收清单第 7 项（跨网络测试限流）确认此项生效。 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || 'unknown';
}

function rateLimit(ip) {
  const now = Date.now();
  // 惰性清理：条目过多时清除已过期记录，避免 Map 只增不减导致内存泄漏
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (now - v.first > RATE_WINDOW_MS) attempts.delete(k);
    }
  }
  let rec = attempts.get(ip);
  if (!rec || now - rec.first > RATE_WINDOW_MS) rec = { count: 0, first: now };
  rec.count++;
  attempts.set(ip, rec);
  return rec.count <= RATE_MAX;
}

/* ================= 认证接口 ================= */
app.post('/api/auth/login', (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: '尝试次数过多，请15分钟后再试' });
  }
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get((username || '').trim());
  if (!u || !bcrypt.compareSync(password || '', u.pass_hash)) {
    logAudit(username, 'LOGIN_FAILED', '用户名或密码错误');
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  db.prepare('UPDATE users SET last_login=? WHERE username=?')
    .run(new Date().toISOString(), u.username);
  attempts.delete(ip);

  const token = jwt.sign(
    { username: u.username, display: u.display_name, role: u.role },
    JWT_SECRET, { expiresIn: JWT_EXPIRES }
  );
  logAudit(u.username, 'LOGIN_SUCCESS', '');
  res.json({ token, user: { username: u.username, display: u.display_name, role: u.role } });
});

app.get('/api/auth/me', auth(), (req, res) => res.json({ user: req.user }));

app.post('/api/auth/change-password', auth(), (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少6位' });
  }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.user.username);
  if (!bcrypt.compareSync(oldPassword || '', u.pass_hash)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  db.prepare('UPDATE users SET pass_hash=? WHERE username=?')
    .run(bcrypt.hashSync(newPassword, 10), u.username);
  logAudit(u.username, 'CHANGE_PASSWORD', '');
  res.json({ ok: true });
});

/* ================= 患者接口 ================= */
app.get('/api/patients', auth(), (req, res) => {
  /* admin 取全部；普通医生仅取自己登记的。
     created_by 为空的历史数据只有 admin 能看到，需在用户管理里改派后才会分配给医生。 */
  const rows = isAdmin(req.user)
    ? db.prepare('SELECT * FROM patients ORDER BY id').all()
    : db.prepare('SELECT * FROM patients WHERE created_by=? ORDER BY id').all(req.user.username);
  const researchMap = buildResearchMaps(rows.map(p => p.id));
  res.json(rows.map(p => buildPatient(p, { detail: false, research: researchMap.get(p.id) })));
});

app.get('/api/patients/:id', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  res.json(buildPatient(p, { detail: true }));
});

app.post('/api/patients', auth(), (req, res) => {
  const b = req.body || {};
  const followupCheck = normalizeFollowupStatus(b.followupStatus);
  if (followupCheck === false) {
    return res.status(400).json({ error: '随访终止状态只能是 在访/失访/死亡' });
  }
  const followupStatus = followupCheck || legacyFollowupStatus(String(b.status || '').trim());
  if (followupStatus === '死亡') {
    return res.status(400).json({ error: '新建患者不能直接标记死亡；请先建档，再在病程中记录「终止随访/死亡」事件' });
  }
  if (followupStatus === '失访') {
    return res.status(400).json({ error: '新建患者不能直接标记失访；请先建档，再在病程中记录「失访确认」事件（含末次接触日期）' });
  }
  /* 临床/病理分期：新客户端分别提交；旧客户端只提交 stage 时按 p 前缀拆分。 */
  const rawStage = String(b.stage || '').trim();
  const clinicalStage = String(b.clinicalStage !== undefined ? (b.clinicalStage || '') : (rawStage && !/^p/i.test(rawStage) ? rawStage : '')).trim().slice(0, 20);
  const pathologicStage = String(b.pathologicStage !== undefined ? (b.pathologicStage || '') : (rawStage && /^p/i.test(rawStage) ? rawStage : '')).trim().slice(0, 20);
  const concomitantMeds = String(b.concomitantMeds || '').trim().slice(0, 1000);
  const name = String(b.name || '').trim();
  const birth = normDate(b.birth);
  const date = normDate(b.date);
  const psa = parsePsaValue(b.psa);
  if (!name || !birth || !date || psa === null) {
    return res.status(400).json({ error: '姓名、出生日期、诊断日期、初始PSA为必填' });
  }
  if (birth >= date) {
    return res.status(400).json({ error: '出生日期必须早于诊断日期' });
  }
  { const f = assertNotFuture(birth, '出生日期'); if (f) return res.status(400).json({ error: f }); }
  { const f = assertNotFuture(date, '诊断日期'); if (f) return res.status(400).json({ error: f }); }
  if (b.confirmDuplicate !== true) {
    const dup = db.prepare('SELECT id,name FROM patients WHERE name=? AND birth_date=? LIMIT 1').get(name, birth);
    if (dup) {
      return res.status(409).json({ error: '已存在同名同生日患者 ' + dup.id + '；如确认不是重复，请确认后重新提交', duplicateOf: dup.id });
    }
  }
  /* 初始 PSA 的检测日期独立于诊断日期：PSA 常早于穿刺/确诊，
     旧接口强制绑定诊断日期会把曲线起点做错。旧客户端未传 psaDate 时仍回退到诊断日期。 */
  const psaDate = (b.psaDate === undefined || b.psaDate === null || b.psaDate === '')
    ? date : normDate(b.psaDate);
  if (!psaDate) return res.status(400).json({ error: 'PSA检测日期格式不正确（应为 YYYY-MM-DD）' });
  if (psaDate < birth) return res.status(400).json({ error: 'PSA检测日期不能早于出生日期' });
  if (psaDate > todayIso()) return res.status(400).json({ error: 'PSA检测日期不能晚于今天（' + todayIso() + '）' });

  const psaBelow = (b.belowLod === true || b.belowLod === 1 || b.belowLod === '1') ? 1 : 0;
  const psaLod = parsePsaValue(b.lod);
  if (psaBelow && (psaLod === null || psaLod <= 0)) {
    return res.status(400).json({ error: '低于检测下限时，请填写大于0的检测下限值' });
  }
  /* 初始PSA 也可带游离值：建档时手里的第一张化验单常常就是总+游离两项。
     未提供 freeVal 时三项全为 NULL，与存量记录一致。 */
  const freePsa = parseFreePsaBody(b);
  if (freePsa.error) return res.status(400).json({ error: freePsa.error });

  /* 建档时的直肠指检：正常的"未触及结节"和异常的"质硬结节"必须分开记，
     空字符串表示这次没做（不是阴性）。 */
  const dreResult = String(b.dreResult || '').trim();
  if (!['', 'normal', 'abnormal'].includes(dreResult)) {
    return res.status(400).json({ error: 'DRE 结果只能是 正常/异常/未做' });
  }
  const dreNote = String(b.dreNote || '').trim().slice(0, 200);
  const diseaseCategory = String(b.diseaseCategory || '').trim();
  if (!DISEASE_CATEGORIES.includes(diseaseCategory)) {
    return res.status(400).json({ error: '疾病阶段只能是 nmHSPC/mHSPC/nmCRPC/mCRPC 或留空' });
  }

  let metCount = null;
  if (b.metCount !== undefined && b.metCount !== null && String(b.metCount).trim() !== '') {
    const n = Number(b.metCount);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: '转移灶数量必须为不小于0的整数，或留空表示未评估' });
    }
    metCount = n;
  }
  const oligoType = String(b.oligoType || '').trim().slice(0, 20);
  if (!OLIGO_CODES.includes(oligoType)) {
    return res.status(400).json({ error: '寡转移/瘤负荷分层取值不合法' });
  }

  /* 手术日期不再单独录入，改由时间轴上的手术事件推导（见 syncSurgDate）。
     这里刻意不强制「治疗含手术则必填手术日期」：新患者此刻还没有 id，
     事件根本无法先于患者存在，强制校验会让新建手术患者永远失败。
     仍接受显式传入的 surgDate（兼容旧客户端与备份导入），只校验格式。 */
  let surgDate = null;
  if (b.surgDate !== undefined && b.surgDate !== null && b.surgDate !== '') {
    surgDate = normDate(b.surgDate);
    if (!surgDate) return res.status(400).json({ error: '手术日期格式不正确（应为 YYYY-MM-DD）' });
    if (surgDate < birth) return res.status(400).json({ error: '手术日期不能早于出生日期' });
    { const f = assertNotFuture(surgDate, '手术日期'); if (f) return res.status(400).json({ error: f }); }
  }
  const id = nextPatientId();
  db.transaction(() => {
    db.prepare(`INSERT INTO patients(id,name,age,birth_date,diag_date,surg_date,gleason,gleason_source,stage,clinical_stage,pathologic_stage,pathologic_stage_source,treatment,concomitant_meds,status,followup_status,
                 rt_end_date,adt_start_date,last_followup_date,castration_status,
                 met_count,met_extra_pelvis,visceral_met,oligo_type,dre_result,dre_note,disease_category,created_at,created_by)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, ageFromBirth(birth, date), birth, date, surgDate,
           String(b.gleason || ''), String(b.gleason || '').trim() ? 'manual' : '',
           clinicalStage || pathologicStage,
           clinicalStage, pathologicStage, pathologicStage ? 'manual' : '',
           String(b.treatment || ''), concomitantMeds,
           String(b.status || '').trim() || PENDING_STATUS,
           followupStatus,
           normDate(b.rtEndDate) || null, normDate(b.adtStartDate) || null,
           normDate(b.lastFollowupDate) || null, triState(b.castration),
           metCount, triState(b.metExtraPelvis), triState(b.visceralMet),
           oligoType, dreResult, dreNote, diseaseCategory,
           new Date().toISOString(), req.user.username);
    /* 初始 PSA 记录使用独立检测日期；镜像事件也落在同一天。
       游离三列一并写入：未录游离时 value 为 null、标记为 0。 */
    const psaRec = db.prepare('INSERT INTO psa_records(patient_id,rec_date,value,is_initial,created_by,is_below_lod,lod_value,free_value,free_below_lod,free_lod_value) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, psaDate, psa, 1, req.user.username, psaBelow, psaBelow ? psaLod : null,
           freePsa.value, freePsa.below, freePsa.below ? freePsa.lod : null);
    ensurePsaMirrorEvent(id, psaRec.lastInsertRowid, psaDate, 1, req.user.username);
  })();
  logAudit(req.user.username, 'CREATE_PATIENT', id + ' ' + name);
  res.json(buildPatient(getP(id)));
});

function readBaselineProfile(body, p) {
  const b = body || {};
  const pick = (k, old) => b[k] !== undefined ? b[k] : old;
  const tri = (k, old) => b[k] !== undefined ? triState(b[k]) : (old == null ? null : (old ? 1 : 0));
  const date = (k, old) => {
    const raw = b[k] !== undefined ? b[k] : old;
    if (raw === '' || raw === null || raw === undefined) return { value: null };
    const d = normDate(raw);
    return d ? { value: d } : { error: k + ' 日期格式不正确' };
  };
  const ecog = pick('ecog', p.ecog);
  const charlson = pick('charlson', p.charlson);
  const bmi = pick('bmi', p.bmi);
  const smoking = String(pick('smoking', p.smoking || '') || '');
  if (!['', 'never', 'former', 'current', 'unknown'].includes(smoking)) return { error: '吸烟状态不合法' };
  const mode = String(pick('lastFollowupMode', p.last_followup_mode || '') || '');
  if (!['', 'clinic', 'phone', 'external', 'hospital', 'other'].includes(mode)) return { error: '末次随访方式不合法' };
  const consentDate = date('researchConsentDate', p.research_consent_date);
  if (consentDate.error) return consentDate;
  const sharingDate = date('dataSharingDate', p.data_sharing_date);
  if (sharingDate.error) return sharingDate;
  return { value: {
    familyHistory: tri('familyHistory', p.family_history),
    familyHistoryDetail: String(pick('familyHistoryDetail', p.family_history_detail || '') || '').slice(0, 500),
    ecog: ecog === '' || ecog == null ? null : Number(ecog),
    charlson: charlson === '' || charlson == null ? null : Number(charlson),
    bmi: bmi === '' || bmi == null ? null : Number(bmi),
    smoking, race: String(pick('race', p.race || '') || '').slice(0, 40),
    ethnicity: String(pick('ethnicity', p.ethnicity || '') || '').slice(0, 40),
    centerId: String(pick('centerId', p.center_id || '') || '').slice(0, 40),
    researchConsent: tri('researchConsent', p.research_consent),
    researchConsentDate: consentDate.value,
    researchConsentVersion: String(pick('researchConsentVersion', p.research_consent_version || '') || '').slice(0, 40),
    dataSharing: tri('dataSharing', p.data_sharing),
    dataSharingScope: String(pick('dataSharingScope', p.data_sharing_scope || '') || '').slice(0, 200),
    dataSharingDate: sharingDate.value,
    lastFollowupMode: mode,
    dreResult: String(pick('dreResult', p.dre_result || '') || '').slice(0, 20),
    dreNote: String(pick('dreNote', p.dre_note || '') || '').slice(0, 200),
    mainSymptom: String(pick('mainSymptom', p.main_symptom || '') || '').slice(0, 2000),
    symptomDurationMonths: (() => {
      const v = pick('symptomDurationMonths', p.symptom_duration_months);
      if (v === '' || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 600 ? n : null;
    })(),
    baselinePainNrs: (() => {
      const v = pick('baselinePainNrs', p.baseline_pain_nrs);
      if (v === '' || v == null) return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
    })(),
    birthplace: String(pick('birthplace', p.birthplace || '') || '').slice(0, 120),
    admissionNo: String(pick('admissionNo', p.admission_no || '') || '').slice(0, 60)
  }};
}

app.put('/api/patients/:id', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const body = req.body || {};
  let followupStatus = p.followup_status || '在访';
  if (body.followupStatus !== undefined) {
    const check = normalizeFollowupStatus(body.followupStatus);
    if (check === false) {
      return res.status(400).json({ error: '随访终止状态只能是 在访/失访/死亡' });
    }
    followupStatus = check || '在访';
  } else if (body.status !== undefined) {
    /* 旧客户端仍提交 status：只提取死亡/失访，避免把疾病状态写回。 */
    followupStatus = legacyFollowupStatus(String(body.status || '').trim());
  }
  const name = String(body.name !== undefined ? body.name : p.name).trim();
  const date = normDate(body.diag_date !== undefined ? body.diag_date : p.diag_date);
  if (!name || !date) {
    return res.status(400).json({ error: '姓名、诊断日期不能为空' });
  }
  /* 出生日期：新患者必填；存量旧数据（birth_date 为空）允许暂不补录，
     此时继续显示登记时的 age，补录后切换为自动计算 */
  const birthRaw = body.birth !== undefined ? body.birth : p.birth_date;
  let birth = null, age = p.age;
  if (birthRaw === null || birthRaw === '') {
    if (body.age !== undefined && Number.isFinite(Number(body.age)) && Number(body.age) > 0) {
      age = Number(body.age);
    }
  } else {
    birth = normDate(birthRaw);
    if (!birth) return res.status(400).json({ error: '出生日期格式不正确（应为 YYYY-MM-DD）' });
    age = ageFromBirth(birth, date);
  }
  if (birth && birth >= date) {
    return res.status(400).json({ error: '出生日期必须早于诊断日期' });
  }
  { const f = assertNotFuture(birth, '出生日期'); if (f) return res.status(400).json({ error: f }); }
  { const f = assertNotFuture(date, '诊断日期'); if (f) return res.status(400).json({ error: f }); }
  /* 死亡状态必须由死亡结局支撑；已有死亡结局时不能改回在访/失访。 */
  const deathOutcome = deathOutcomeOf(p);
  const lostOutcome = db.prepare("SELECT * FROM patient_outcomes WHERE patient_id=? AND outcome_type='lost' ORDER BY event_date DESC, id DESC LIMIT 1").get(p.id);
  if (followupStatus === '死亡' && !deathOutcome) {
    return res.status(400).json({ error: '设为「死亡」前请先在病程中记录「终止随访/死亡」事件（含死亡日期/死因）' });
  }
  if (followupStatus !== '死亡' && deathOutcome) {
    return res.status(400).json({ error: '该患者已有死亡结局，不能改回「' + followupStatus + '」；如确需更正，请先删除死亡结局' });
  }
  /* P1-05：失访必须有失访结局（含末次接触日期），不能只改一个下拉框；
     已有失访结局时也不能直接改回在访，必须先删除结局，避免时间轴/生存分析与状态矛盾。 */
  if (followupStatus === '失访' && !lostOutcome) {
    return res.status(400).json({ error: '设为「失访」前请先在病程中记录「失访确认」事件（含末次接触日期）' });
  }
  if (followupStatus !== '失访' && lostOutcome) {
    return res.status(400).json({ error: '该患者已有失访结局，不能改回「' + followupStatus + '」；如确需更正，请先删除失访结局' });
  }
  const treatment = String(body.treatment !== undefined ? (body.treatment || '') : (p.treatment || ''));
  /* 临床/病理分期分开保存；旧客户端只传 stage 时按 p 前缀写入对应字段。 */
  let clinicalStage = body.clinicalStage !== undefined
    ? String(body.clinicalStage || '').trim().slice(0, 20)
    : (p.clinical_stage || '');
  let pathologicStage = body.pathologicStage !== undefined
    ? String(body.pathologicStage || '').trim().slice(0, 20)
    : (p.pathologic_stage || '');
  if (body.stage !== undefined) {
    const raw = String(body.stage || '').trim().slice(0, 20);
    if (raw && /^p/i.test(raw)) pathologicStage = raw;
    else if (raw) clinicalStage = raw;
  }
  const concomitantMeds = body.concomitantMeds !== undefined
    ? String(body.concomitantMeds || '').trim().slice(0, 1000)
    : (p.concomitant_meds || '');
  const profile = readBaselineProfile(body, p);
  if (profile.error) return res.status(400).json({ error: profile.error });
  const bv = profile.value;
  if (bv.ecog != null && (!Number.isInteger(bv.ecog) || bv.ecog < 0 || bv.ecog > 4)) {
    return res.status(400).json({ error: 'ECOG 必须为 0–4 的整数' });
  }
  if (bv.charlson != null && (!Number.isInteger(bv.charlson) || bv.charlson < 0 || bv.charlson > 50)) {
    return res.status(400).json({ error: 'Charlson 指数必须为 0–50 的整数' });
  }
  if (bv.bmi != null && (!Number.isFinite(bv.bmi) || bv.bmi < 5 || bv.bmi > 80)) {
    return res.status(400).json({ error: 'BMI 必须为 5–80 的数值' });
  }
  for (const [dt, label] of [[bv.researchConsentDate, '知情同意日期'], [bv.dataSharingDate, '数据共享日期']]) {
    const f = assertNotFuture(dt, label);
    if (f) return res.status(400).json({ error: f });
  }
  const lastFuRaw = body.lastFollowupDate !== undefined ? body.lastFollowupDate : p.last_followup_date;
  const lastFu = lastFuRaw ? normDate(lastFuRaw) : null;
  { const f = assertNotFuture(lastFu, '末次随访日期'); if (f) return res.status(400).json({ error: f }); }
  const adtStart = body.adtStartDate !== undefined ? normDate(body.adtStartDate) : p.adt_start_date;
  { const f = assertNotFuture(adtStart, 'ADT 起始日期'); if (f) return res.status(400).json({ error: f }); }
  const rtEnd = body.rtEndDate !== undefined ? normDate(body.rtEndDate) : p.rt_end_date;
  { const f = assertNotFuture(rtEnd, '放疗结束日期'); if (f) return res.status(400).json({ error: f }); }
  /* 手术日期不再接受前端传入，一律以时间轴上的手术事件为准（syncSurgDate 维护）。
     这里只校验：治疗方式为根治性手术时，时间轴上必须已有对应的手术事件。 */
  const surgErr = requireSurgeryEvent(p, treatment);
  if (surgErr) return res.status(400).json({ error: surgErr });
  const surgDate = getSurgeryEventDate(p.id);

  let metCount = p.met_count;
  if (body.metCount !== undefined) {
    if (body.metCount === null || String(body.metCount).trim() === '') {
      metCount = null;
    } else {
      const n = Number(body.metCount);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: '转移灶数量必须为不小于0的整数，或留空表示未评估' });
      }
      metCount = n;
    }
  }
  let diseaseCategory = body.diseaseCategory !== undefined
    ? String(body.diseaseCategory || '').trim()
    : (p.disease_category || '');
  if (!DISEASE_CATEGORIES.includes(diseaseCategory)) {
    return res.status(400).json({ error: '疾病阶段只能是 nmHSPC/mHSPC/nmCRPC/mCRPC 或留空' });
  }
  const oligoType = body.oligoType !== undefined
    ? String(body.oligoType || '').trim().slice(0, 20)
    : (p.oligo_type || '');
  if (!OLIGO_CODES.includes(oligoType)) {
    return res.status(400).json({ error: '寡转移/瘤负荷分层取值不合法' });
  }

  /* 手工改主档时只把“真正变了”的字段标为 manual，避免每次保存档案
     都把病理同步来的 source 覆盖成 manual，导致删除病理后无法回收。 */
  const newGleason = body.gleason !== undefined ? String(body.gleason || '') : (p.gleason || '');
  const gleasonEdited = body.gleason !== undefined && newGleason !== (p.gleason || '');
  const newGleasonSource = gleasonEdited ? (newGleason ? 'manual' : '') : (p.gleason_source || '');
  const newGleasonManual = gleasonEdited ? newGleason : (p.gleason_manual || '');
  const ptnmChanged = pathologicStage !== (p.pathologic_stage || '');
  const newPtnmSource = ptnmChanged ? (pathologicStage ? 'manual' : '') : (p.pathologic_stage_source || '');
  const newPtnmManual = ptnmChanged ? pathologicStage : (p.pathologic_stage_manual || '');

  /* 注意：不接受请求体里的 created_by，否则普通医生可把患者改派给自己或他人。
     三态字段显式传 null 时保存 null，不能回退成 0/false。 */
  db.prepare(`UPDATE patients SET name=?,age=?,birth_date=?,diag_date=?,surg_date=?,gleason=?,gleason_source=?,gleason_manual=?,stage=?,clinical_stage=?,pathologic_stage=?,pathologic_stage_source=?,pathologic_stage_manual=?,treatment=?,concomitant_meds=?,status=?,followup_status=?,
              rt_end_date=?,adt_start_date=?,last_followup_date=?,castration_status=?,
              met_count=?,met_extra_pelvis=?,visceral_met=?,oligo_type=?,
              family_history=?,family_history_detail=?,ecog=?,charlson=?,bmi=?,smoking=?,race=?,ethnicity=?,center_id=?,
              research_consent=?,research_consent_date=?,research_consent_version=?,data_sharing=?,data_sharing_scope=?,data_sharing_date=?,last_followup_mode=?,
              dre_result=?,dre_note=?,disease_category=?,
              main_symptom=?,symptom_duration_months=?,baseline_pain_nrs=?,birthplace=?,admission_no=?
              WHERE id=?`)
    .run(name, age, birth, date, surgDate,
         newGleason, newGleasonSource, newGleasonManual,
         clinicalStage || pathologicStage,
         clinicalStage, pathologicStage, newPtnmSource, newPtnmManual,
         treatment, concomitantMeds,
         body.status !== undefined
           ? (String(body.status || '').trim() || PENDING_STATUS)
           : (p.status || PENDING_STATUS),
         followupStatus,
         body.rtEndDate !== undefined ? (normDate(body.rtEndDate) || null) : p.rt_end_date,
         body.adtStartDate !== undefined ? (normDate(body.adtStartDate) || null) : p.adt_start_date,
         body.lastFollowupDate !== undefined ? (normDate(body.lastFollowupDate) || null) : p.last_followup_date,
         body.castration !== undefined ? triState(body.castration) : p.castration_status,
         metCount,
         body.metExtraPelvis !== undefined ? triState(body.metExtraPelvis) : p.met_extra_pelvis,
         body.visceralMet !== undefined ? triState(body.visceralMet) : p.visceral_met,
         oligoType,
         bv.familyHistory, bv.familyHistoryDetail, bv.ecog, bv.charlson, bv.bmi, bv.smoking,
         bv.race, bv.ethnicity, bv.centerId,
         bv.researchConsent, bv.researchConsentDate, bv.researchConsentVersion,
         bv.dataSharing, bv.dataSharingScope, bv.dataSharingDate, bv.lastFollowupMode,
         bv.dreResult, bv.dreNote, diseaseCategory,
         bv.mainSymptom, bv.symptomDurationMonths, bv.baselinePainNrs, bv.birthplace, bv.admissionNo,
         p.id);
  logAudit(req.user.username, 'UPDATE_PATIENT', p.id);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const files = db.prepare('SELECT stored_name FROM reports WHERE patient_id=?').all(p.id);
  /* 时间轴图片的文件名也要先取出来：外键级联只会删掉 timeline_images 的行，
     不会删 uploads/ 里的物理文件，不先收集就会留下一批永远无法访问的孤儿图片。 */
  const tlFiles = db.prepare(`
    SELECT ti.stored_name FROM timeline_images ti
      JOIN timeline_events te ON te.id = ti.event_id
     WHERE te.patient_id = ?
  `).all(p.id);
  const aiFiles = db.prepare(`
    SELECT af.stored_name FROM ai_intake_files af
      JOIN ai_intake_sessions s ON s.id = af.session_id
     WHERE s.patient_id = ?
  `).all(p.id);
  db.prepare('DELETE FROM file_assets WHERE patient_id=?').run(p.id);
  db.prepare('DELETE FROM patients WHERE id=?').run(p.id);   // 外键级联删除 psa/reports/事件 记录
  files.concat(tlFiles).forEach(f => { try { fs.unlinkSync(path.join(uploadDir, f.stored_name)); } catch (e) {} });
  aiFiles.forEach(f => { try { fs.unlinkSync(path.join(uploadDir, 'ai-intake', f.stored_name)); } catch (e) {} });
  logAudit(req.user.username, 'DELETE_PATIENT', p.id + ' ' + p.name);
  res.json({ ok: true });
});

/* ---- 患者归属改派（仅管理员）----
   用于分配存量患者、医生离职交接。改派只变更 patients.created_by；
   psa_records.created_by 与 reports.uploaded_by 保留原操作人，作为审计痕迹不变。 */
app.put('/api/patients/:id/owner', auth(true), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  const target = (req.body && req.body.owner ? String(req.body.owner) : '').trim();
  if (!target) return res.status(400).json({ error: '请指定新的归属账号' });
  const u = db.prepare('SELECT username,role FROM users WHERE username=?').get(target);
  if (!u) return res.status(404).json({ error: '目标账号不存在' });
  if (p.created_by === target) {
    return res.status(400).json({ error: '该患者已归属于此账号' });
  }
  db.prepare('UPDATE patients SET created_by=? WHERE id=?').run(target, p.id);
  logAudit(req.user.username, 'REASSIGN_PATIENT',
           p.id + ' ' + p.name + '：' + (p.created_by || '无归属') + ' → ' + target);
  res.json(buildPatient(getP(p.id)));
});

/* ---- PSA 复查记录 ---- */
app.post('/api/patients/:id/psa', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const date = normDate((req.body || {}).date);
  const val = parsePsaValue((req.body || {}).val);
  if (!date || val === null) {
    return res.status(400).json({ error: '请填写有效的复查日期和PSA值' });
  }
  /* 镜像事件会把这个日期带上时间轴，而事件一律要求晚于出生日期。
     这里先拦住，否则一条录错的 PSA 会在时间轴上留下一个不可能存在的节点。 */
  if (p.birth_date && date <= p.birth_date) {
    return res.status(400).json({ error: '复查日期必须晚于出生日期（' + p.birth_date + '）' });
  }
  { const f = assertNotFuture(date, '复查日期'); if (f) return res.status(400).json({ error: f }); }
  { const a = assertAliveForRecord(p, date, '复查'); if (a) return res.status(400).json({ error: a }); }
  /* 同上：5 列必须对 5 个占位符。旧的 VALUES(?,?,?,?,0) 会把 is_initial 写成用户名
     （真值 → 被当作初始PSA，导致这条复查记录再也删不掉），created_by 被写成 0。 */
  /* belowLod：化验单写「<0.03」这类低于检测下限的结果时勾选，
     数值格填当次下限（如 0.03）。指南 6.1/第10章以「检测不到/0.03 以下」为
     临床治愈判据，必须能如实记录，不能存成 0 也不能静默丢弃（PDF p112、p206）。 */
  const belowLod = (req.body || {}).belowLod ? 1 : 0;
  const lodVal = parsePsaValue((req.body || {}).lod);
  /* 游离PSA 为可选项：化验单只报总PSA 时不传 freeVal，三列保持 NULL。 */
  const freePsa = parseFreePsaBody(req.body);
  if (freePsa.error) return res.status(400).json({ error: freePsa.error });
  db.transaction(() => {
    const rec = db.prepare('INSERT INTO psa_records(patient_id,rec_date,value,is_initial,created_by,is_below_lod,lod_value,free_value,free_below_lod,free_lod_value) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(p.id, date, val, 0, req.user.username, belowLod, belowLod ? (lodVal != null ? lodVal : val) : null,
           freePsa.value, freePsa.below, freePsa.below ? freePsa.lod : null);
    /* 录入复查即在时间轴上留下同一天的「PSA复查」节点，医生不必两边各录一次 */
    ensurePsaMirrorEvent(p.id, rec.lastInsertRowid, date, 0, req.user.username, (req.body || {}).guidedBatch);
  })();
  logAudit(req.user.username, 'ADD_PSA', p.id + ' ' + date + '=' + val + (belowLod ? '(低于检测下限)' : '') +
    (freePsa.value != null ? ' 游离=' + (freePsa.below ? '<' + freePsa.lod : freePsa.value) : ''));
  res.json(buildPatient(getP(p.id)));
});

/* 修改 PSA 记录（含初始PSA）：日期与数值在同一次请求里一起更正，二者互不依赖。
   初始记录改日期后仍保持 is_initial=1，保证备份/导入与统计逻辑不变。

   顺序不变量：初始PSA 必须是该患者最早的一条记录。
   前端按 rec_date 排序后把「第一条」当作初始PSA 展示，并只给非首条挂删除按钮；
   若某条复查记录被改到早于初始记录，界面上它会被误标为「初始」而真正的首次值
   反而带上删除按钮（后端又会以「初始PSA不可删除」拒绝），前后端就此对不上。
   现在日期改起来更方便，这个错配更容易被无意触发，因此在写入前统一拦下。 */
app.put('/api/patients/:id/psa/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM psa_records WHERE id=? AND patient_id=?')
              .get(req.params.rid, req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const body = req.body || {};

  /* 未提供的字段沿用原值；提供了就必须合法，不接受静默降级 */
  let date = r.rec_date;
  if (body.date !== undefined) {
    date = normDate(body.date);
    if (!date) return res.status(400).json({ error: '请填写有效的日期（YYYY-MM-DD）' });
  }
  let val = r.value;
  if (body.val !== undefined) {
    const nv = parsePsaValue(body.val);
    if (nv === null) return res.status(400).json({ error: 'PSA值必须为不小于0的数字' });
    val = nv;
  }
  /* 低于检测下限标记：提供则更新，未提供沿用原值 */
  let belowLod = r.is_below_lod || 0;
  let lodVal = r.lod_value != null ? r.lod_value : null;
  if (body.belowLod !== undefined) {
    belowLod = body.belowLod ? 1 : 0;
    if (belowLod && body.lod !== undefined) {
      const lv = parsePsaValue(body.lod);
      if (lv === null) return res.status(400).json({ error: '检测下限值必须为不小于0的数字' });
      lodVal = lv;
    }
    if (!belowLod) lodVal = null;
  }
  /* 游离PSA 三态语义（与上面各字段「未提供沿用原值」一致，但多一种「清空」）：
     · 未提供 freeVal        → 三列沿用原值（旧客户端、AI 采纳未抽到游离时走这里）
     · freeVal 为 null/空串  → 清空（医生发现录错了，或该次其实没有游离结果）
     · freeVal 有值          → 更新，并按 freeBelowLod/freeLod 校验下限标记 */
  let freeVal = r.free_value != null ? r.free_value : null;
  let freeBelow = r.free_below_lod || 0;
  let freeLod = r.free_lod_value != null ? r.free_lod_value : null;
  if (body.freeVal !== undefined) {
    if (body.freeVal === null || String(body.freeVal).trim() === '') {
      freeVal = null; freeBelow = 0; freeLod = null;
    } else {
      const fp = parseFreePsaBody(body);
      if (fp.error) return res.status(400).json({ error: fp.error });
      freeVal = fp.value; freeBelow = fp.below; freeLod = fp.below ? fp.lod : null;
    }
  }

  /* 镜像事件会跟着改期，而事件一律要求晚于出生日期 */
  if (p.birth_date && date <= p.birth_date) {
    return res.status(400).json({ error: '日期必须晚于出生日期（' + p.birth_date + '）' });
  }
  { const f = assertNotFuture(date, 'PSA 日期'); if (f) return res.status(400).json({ error: f }); }
  { const a = assertAliveForRecord(p, date, 'PSA'); if (a) return res.status(400).json({ error: a }); }

  /* 校验顺序不变量：按本次改动后的日期，比较初始记录与最早的复查记录 */
  const others = db.prepare(
    'SELECT id, rec_date, is_initial FROM psa_records WHERE patient_id=? AND id<>?'
  ).all(p.id, r.id);
  if (r.is_initial) {
    const next = others.filter(o => !o.is_initial).map(o => o.rec_date).sort()[0];
    if (next && date > next) {
      return res.status(400).json({
        error: '初始PSA日期不能晚于最早的复查日期（' + next + '），请核对后再保存'
      });
    }
  } else {
    const init = others.find(o => o.is_initial);
    if (init && date < init.rec_date) {
      /* P1-08：这条记录如果本来就早于初始 PSA（历史外院复查），
         允许保持原日期、只修正数值；只有把日期再改到更早/更晚才拦截。
         否则医生只能删除重录，反而丢失原始记录 id 与审计链。 */
      if (date !== r.rec_date) {
        return res.status(400).json({
          error: '复查日期不能早于初始PSA日期（' + init.rec_date + '）；如仅修正数值，请保持原日期不变'
        });
      }
    }
  }

  db.transaction(() => {
    db.prepare('UPDATE psa_records SET rec_date=?, value=?, is_below_lod=?, lod_value=?, free_value=?, free_below_lod=?, free_lod_value=? WHERE id=?')
      .run(date, val, belowLod, lodVal, freeVal, freeBelow, freeBelow ? freeLod : null, r.id);
    /* 改期后镜像事件必须跟着走，否则时间轴上那个节点会停在旧日期，
       与 PSA 曲线对不上。ensurePsaMirrorEvent 对已存在的事件只同步日期，不会重复插入；
       历史数据若缺镜像事件（如老库导入），这里顺带补建。 */
    ensurePsaMirrorEvent(p.id, r.id, date, r.is_initial ? 1 : 0, r.created_by);
  })();
  logAudit(req.user.username, 'UPDATE_PSA',
           p.id + ' #' + r.id + '：' + r.rec_date + '=' + r.value + ' → ' + date + '=' + val);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/psa/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM psa_records WHERE id=? AND patient_id=?')
              .get(req.params.rid, req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  if (r.is_initial) return res.status(400).json({ error: '初始PSA不可删除' });
  db.transaction(() => {
    db.prepare('DELETE FROM psa_records WHERE id=?').run(r.id);
    /* 镜像事件只是这条记录的投影，记录没了投影也该消失，
       否则时间轴上会留一个点开看不到数值的孤儿节点，医生无从判断它对应什么。
       医生在时间轴手工添加的其他事件（如生化复发确认）不受影响。 */
    removePsaMirrorEvent(r.id);
  })();
  logAudit(req.user.username, 'DELETE_PSA', req.params.id + ' #' + r.id);
  res.json(buildPatient(getP(p.id)));
});

/* ================= 血清睾酮记录 =================
   指南 8.1/8.2.1：去势抵抗的诊断前提是「血清睾酮<50ng/dl 或 1.7nmol/L」（PDF p154/p158）；
   第 10 章综合治疗后随访把血清睾酮列为 I 级推荐内容，注释 h 另给预后观察点 20ng/dl（PDF p203/p207）。
   没有数值字段就无法判定 nmCRPC/mCRPC，也无法区分「药物起效」与「耐药进展」。 */
app.post('/api/patients/:id/testo', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const body = req.body || {};
  const date = normDate(body.date);
  const rawUnit = body.unit;
  if (rawUnit !== undefined && rawUnit !== null && String(rawUnit).trim() !== '' &&
      !['ng/dl', 'nmol/L'].includes(String(rawUnit).trim())) {
    return res.status(400).json({ error: '睾酮单位只能是 ng/dl 或 nmol/L' });
  }
  const unit = String(rawUnit || 'ng/dl').trim() === 'nmol/L' ? 'nmol/L' : 'ng/dl';
  const raw = body.val;
  const entered = typeof raw === 'number' ? raw : parseFloat(String(raw || '').trim());
  if (!date || !Number.isFinite(entered) || entered < 0) {
    return res.status(400).json({ error: '请填写有效的检测日期和睾酮值（ng/dl 或 nmol/L，不小于0）' });
  }
  if (p.birth_date && date <= p.birth_date) {
    return res.status(400).json({ error: '检测日期必须晚于出生日期（' + p.birth_date + '）' });
  }
  { const f = assertNotFuture(date, '睾酮检测日期'); if (f) return res.status(400).json({ error: f }); }
  { const a = assertAliveForRecord(p, date, '睾酮检测'); if (a) return res.status(400).json({ error: a }); }
  const assayMethod = String(body.assayMethod || '').trim().slice(0, 20);
  if (assayMethod && !['RIA', 'CLIA', 'LC-MS/MS', '其他'].includes(assayMethod)) {
    return res.status(400).json({ error: '检测方法只能是 RIA/CLIA/LC-MS/MS/其他' });
  }
  const lab = String(body.lab || '').trim().slice(0, 60);
  const sampleTimeRaw = String(body.sampleTime || '').trim();
  if (sampleTimeRaw && !/^([01]\d|2[0-3]):[0-5]\d$/.test(sampleTimeRaw)) {
    return res.status(400).json({ error: '采血时间格式应为 HH:mm' });
  }
  /* 规范值统一 ng/dl；同时保留录入值与单位，界面回显“本院 mmol/L”时不失真。 */
  const val = unit === 'nmol/L' ? Math.round(entered * 28.84 * 100) / 100 : Math.round(entered * 100) / 100;
  const tIns = db.prepare(`INSERT INTO testosterone_records
      (patient_id,rec_date,value,unit,entered_value,assay_method,lab,sample_time,created_by) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(p.id, date, val, unit, entered, assayMethod, lab, sampleTimeRaw, req.user.username);
  /* 镜像事件与记录同一事务：事件建失败则记录也不留，避免时间轴缺节点 */
  db.transaction(() => ensureTestoMirrorEvent(p.id, tIns.lastInsertRowid, date, val, req.user.username, (req.body || {}).guidedBatch))();
  logAudit(req.user.username, 'ADD_TESTO',
    p.id + ' ' + date + '=' + entered + unit + '（规范 ' + val + 'ng/dl）');
  res.json(buildPatient(getP(p.id)));
});

app.put('/api/patients/:id/testo/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM testosterone_records WHERE id=? AND patient_id=?')
    .get(req.params.rid, req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const body = req.body || {};
  const date = body.date !== undefined ? normDate(body.date) : r.rec_date;
  if (!date) return res.status(400).json({ error: '请填写有效的检测日期' });
  const rawUnit = body.unit !== undefined ? body.unit : (r.unit || 'ng/dl');
  if (!['ng/dl', 'nmol/L'].includes(String(rawUnit || '').trim())) {
    return res.status(400).json({ error: '睾酮单位只能是 ng/dl 或 nmol/L' });
  }
  const unit = String(rawUnit || 'ng/dl').trim() === 'nmol/L' ? 'nmol/L' : 'ng/dl';
  if (body.unit !== undefined && body.val === undefined && unit !== (r.unit || 'ng/dl')) {
    return res.status(400).json({ error: '修改单位时请同时填写睾酮值，避免旧数值被按新单位换算' });
  }
  const raw = body.val !== undefined ? body.val : (r.entered_value != null ? r.entered_value : r.value);
  const entered = typeof raw === 'number' ? raw : parseFloat(String(raw || '').trim());
  if (!Number.isFinite(entered) || entered < 0) {
    return res.status(400).json({ error: '睾酮值必须为不小于 0 的数字' });
  }
  if (p.birth_date && date <= p.birth_date) {
    return res.status(400).json({ error: '检测日期必须晚于出生日期（' + p.birth_date + '）' });
  }
  { const f = assertNotFuture(date, '睾酮检测日期'); if (f) return res.status(400).json({ error: f }); }
  { const a = assertAliveForRecord(p, date, '睾酮检测'); if (a) return res.status(400).json({ error: a }); }
  const assayMethod = String(body.assayMethod !== undefined ? body.assayMethod : (r.assay_method || '')).trim().slice(0, 20);
  if (assayMethod && !['RIA', 'CLIA', 'LC-MS/MS', '其他'].includes(assayMethod)) {
    return res.status(400).json({ error: '检测方法只能是 RIA/CLIA/LC-MS/MS/其他' });
  }
  const lab = String(body.lab !== undefined ? body.lab : (r.lab || '')).trim().slice(0, 60);
  const sampleTime = String(body.sampleTime !== undefined ? body.sampleTime : (r.sample_time || '')).trim();
  if (sampleTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(sampleTime)) {
    return res.status(400).json({ error: '采血时间格式应为 HH:mm' });
  }
  const val = unit === 'nmol/L' ? Math.round(entered * 28.84 * 100) / 100 : Math.round(entered * 100) / 100;
  db.transaction(() => {
    db.prepare(`UPDATE testosterone_records
                   SET rec_date=?, value=?, unit=?, entered_value=?, assay_method=?, lab=?, sample_time=?
                 WHERE id=? AND patient_id=?`)
      .run(date, val, unit, entered, assayMethod, lab, sampleTime, r.id, p.id);
    ensureTestoMirrorEvent(p.id, r.id, date, val, r.created_by || req.user.username);
  })();
  logAudit(req.user.username, 'UPDATE_TESTO',
    p.id + ' #' + r.id + '：' + r.rec_date + '=' + (r.entered_value != null ? r.entered_value : r.value) + r.unit +
    ' → ' + date + '=' + entered + unit + '（规范 ' + val + 'ng/dl）');
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/testo/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM testosterone_records WHERE id=? AND patient_id=?')
              .get(req.params.rid, req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  db.transaction(() => {
    db.prepare('DELETE FROM testosterone_records WHERE id=?').run(r.id);
    removeTestoMirrorEvent(r.id);
  })();
  logAudit(req.user.username, 'DELETE_TESTO', req.params.id + ' #' + r.id);
  res.json(buildPatient(getP(p.id)));
});

/* ================= 药物使用记录 =================
   一条记录 = 一种药物/方案的一次连续使用。同一大类不能重叠，
   比卡鲁胺/氟他胺/尼鲁米特（内分泌）不能与 ARPI 同期；
   不同大类（ADT+ARPI、ADT+化疗、ARPI+PARPi 等）可以同期。
   前端按“每个治疗大类一条泳道”画甘特时间轴。end_date 为空表示仍在用。 */
app.post('/api/patients/:id/medications', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateMedicationBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.start, '用药开始'); if (a) return res.status(400).json({ error: a }); }
  const conflict = findMedicationConflict(p, v, null);
  if (conflict) return res.status(400).json({ error: conflict.error });
  const lineCheck = medicationLineId(p, (req.body || {}).lineId);
  if (lineCheck.error) return res.status(400).json({ error: lineCheck.error });
  const info = db.prepare(`INSERT INTO medication_records
      (patient_id,category,drug_name,start_date,end_date,dose,schedule,line_id,source,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, v.category, v.drug, v.start, v.end, v.dose, v.schedule, lineCheck.lineId,
         'manual', v.notes, req.user.username, new Date().toISOString());
  logAudit(req.user.username, 'ADD_MEDICATION',
    p.id + ' #' + info.lastInsertRowid + ' ' + v.drug + ' ' + v.start + '→' + (v.end || '至今'));
  res.json(buildPatient(getP(p.id)));
});

app.put('/api/patients/:id/medications/:mid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM medication_records WHERE id=? AND patient_id=?')
              .get(req.params.mid, req.params.id);
  if (!r) return res.status(404).json({ error: '用药记录不存在' });
  const v = validateMedicationBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.start, '用药开始'); if (a) return res.status(400).json({ error: a }); }
  const conflict = findMedicationConflict(p, v, r.id);
  if (conflict) return res.status(400).json({ error: conflict.error });
  const lineCheck = medicationLineId(p, (req.body || {}).lineId !== undefined ? req.body.lineId : r.line_id);
  if (lineCheck.error) return res.status(400).json({ error: lineCheck.error });
  db.prepare(`UPDATE medication_records
                 SET category=?, drug_name=?, start_date=?, end_date=?, dose=?, schedule=?, line_id=?, notes=?
               WHERE id=? AND patient_id=?`)
    .run(v.category, v.drug, v.start, v.end, v.dose, v.schedule, lineCheck.lineId, v.notes, r.id, p.id);
  logAudit(req.user.username, 'UPDATE_MEDICATION',
    p.id + ' #' + r.id + ' ' + r.drug_name + ' ' + r.start_date + '→' + (r.end_date || '至今') +
    ' ⇒ ' + v.drug + ' ' + v.start + '→' + (v.end || '至今'));
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/medications/:mid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM medication_records WHERE id=? AND patient_id=?')
              .get(req.params.mid, req.params.id);
  if (!r) return res.status(404).json({ error: '用药记录不存在' });
  db.prepare('DELETE FROM medication_records WHERE id=? AND patient_id=?').run(r.id, p.id);
  logAudit(req.user.username, 'DELETE_MEDICATION',
    p.id + ' #' + r.id + ' ' + r.drug_name + ' ' + r.start_date + '→' + (r.end_date || '至今'));
  res.json(buildPatient(getP(p.id)));
});

/* ================= 治疗线 / 结构化监测 ================= */
const TREATMENT_SETTINGS = ['新辅助', '辅助', '挽救', 'mHSPC', 'nmCRPC', 'mCRPC', '局限治疗', '主动监测', '观察等待', '其他'];
const CLINICAL_CATEGORIES = ['bone', 'cardio', 'qol', 'monitor'];
const CLINICAL_STATUSES = ['', '未做', '已完成', '异常'];

function validateTreatmentLineBody(b, birth) {
  const body = b || {};
  const lineNo = Number(body.lineNo);
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > 99) {
    return { error: '治疗线序号必须为 1~99 的整数' };
  }
  const setting = String(body.setting || '').trim();
  if (!TREATMENT_SETTINGS.includes(setting)) return { error: '请选择有效的治疗情境' };
  const regimen = String(body.regimen || '').trim().slice(0, 200);
  if (!regimen) return { error: '请填写方案名称（如 ADT+达罗他胺+多西他赛）' };
  const start = normDate(body.startDate);
  if (!start) return { error: '治疗线开始日期为必填，格式应为 YYYY-MM-DD' };
  if (birth && start < birth) return { error: '开始日期不能早于出生日期' };
  { const f = assertNotFuture(start, '治疗线开始日期'); if (f) return { error: f }; }
  const endRaw = body.endDate;
  let end = null;
  if (endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== '') {
    end = normDate(endRaw);
    if (!end) return { error: '结束日期格式不正确（应为 YYYY-MM-DD）' };
    if (end < start) return { error: '结束日期不能早于开始日期' };
  }
  const stopReason = String(body.stopReason || '').trim().slice(0, 200);
  const stopReasonCode = String(body.stopReasonCode || '').trim();
  if (!['', 'progression', 'toxicity', 'completed', 'patient_choice', 'other'].includes(stopReasonCode)) {
    return { error: '停药原因编码不合法' };
  }
  const response = String(body.response || '').trim().slice(0, 200);
  const responseCode = String(body.responseCode || '').trim();
  if (!['', 'PSA50', 'PSA30', 'PR', 'SD', 'PD', 'NE'].includes(responseCode)) {
    return { error: '疗效编码不合法' };
  }
  const agents = Array.isArray(body.agents) ? body.agents.slice(0, 12) : [];
  const cleanAgents = [];
  for (const a of agents) {
    const drug = String((a && a.drug) || '').trim().slice(0, 80);
    if (!drug) continue;
    const dose = String((a && a.dose) || '').trim().slice(0, 80);
    const schedule = String((a && a.schedule) || '').trim().slice(0, 80);
    let aStart = null, aEnd = null;
    if (a && a.startDate) {
      aStart = normDate(a.startDate);
      if (!aStart) return { error: '药物“' + drug + '”开始日期格式不正确' };
    }
    if (a && a.endDate) {
      aEnd = normDate(a.endDate);
      if (!aEnd) return { error: '药物“' + drug + '”结束日期格式不正确' };
      if (aStart && aEnd < aStart) return { error: '药物“' + drug + '”结束日期不能早于开始日期' };
    }
    cleanAgents.push({ drug, dose, schedule, startDate: aStart, endDate: aEnd });
  }
  return { lineNo, setting, regimen, start, end, stopReason, stopReasonCode, response, responseCode, agents: cleanAgents };
}

function validateClinicalRecordBody(b) {
  const body = b || {};
  const category = String(body.category || '').trim();
  if (!CLINICAL_CATEGORIES.includes(category)) return { error: '监测分类只能是 bone/cardio/qol/monitor' };
  const item = canonicalClinicalItem(body.item).slice(0, 60);
  if (!item) return { error: '请填写监测项目' };
  const date = normDate(body.date || body.recDate);
  if (!date) return { error: '监测日期格式不正确（应为 YYYY-MM-DD）' };
  { const f = assertNotFuture(date, '监测日期'); if (f) return { error: f }; }
  let value = null;
  const rawValue = body.val !== undefined ? body.val : body.value;
  if (rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '') {
    value = Number(rawValue);
    if (!Number.isFinite(value)) return { error: '监测数值必须为数字，或留空' };
  }
  const unit = String(body.unit || '').trim().slice(0, 20);
  const status = String(body.status || '').trim();
  if (!CLINICAL_STATUSES.includes(status)) return { error: '状态只能是 未做/已完成/异常' };
  const note = String(body.note || '').trim().slice(0, 500);
  return { category, item, date, value, unit, status, note };
}

/* ================= 普通化验：lab_values（P1-12） ================= */
function validateLabValueBody(b, birth) {
  const body = b || {};
  const rawItem = String(body.itemCode || body.item || '').trim();
  const item = resolveLabItem(rawItem);
  if (!item) return { error: '请填写化验项目' };
  if (item.reject) return { error: '「' + rawItem + '」必须走 ' + item.reject + ' 结构化记录，不能写普通化验' };
  if (item.target === 'clinical') return { error: '「' + rawItem + '」属于临床监测项目，请写到临床监测（clinical_records）' };
  const date = normDate(body.date || body.recDate);
  if (!date) return { error: '化验日期格式应为 YYYY-MM-DD' };
  if (birth && date < birth) return { error: '化验日期不能早于出生日期' };
  { const f = assertNotFuture(date, '化验日期'); if (f) return { error: f }; }
  let value = null;
  if (body.value !== undefined && body.value !== null && String(body.value).trim() !== '') {
    value = Number(body.value);
    if (!Number.isFinite(value)) return { error: '化验值必须为数字，或留空' };
  }
  const unit = String(body.unit || item.unit || '').trim().slice(0, 20);
  const lab = String(body.lab || '').trim().slice(0, 60);
  const method = String(body.method || '').trim().slice(0, 40);
  const refRange = String(body.refRange || body.ref_range || '').trim().slice(0, 80);
  const flag = String(body.flag || '').trim().slice(0, 20);
  const note = String(body.note || '').trim().slice(0, 200);
  return { value: { itemCode: item.code, itemLabel: item.label || item.code, date, value, unit, lab, method, refRange, flag, note } };
}

/* 重建某患者某天的“化验/监测”时间轴摘要事件。
   结构化 lab_values 是数据源，事件只是投影；保留事件里人工写的旧备注，
   在 [结构化化验] 标记之后重建摘要，避免重复追加。 */
function rebuildLabEvent(patientId, date, actor) {
  const stripStructuredBlock = (notes) => {
    const s = String(notes || '');
    const marker = '[结构化化验]\n';
    const idx = s.indexOf(marker);
    return (idx >= 0 ? s.slice(0, idx) : s).trim();
  };
  const rows = db.prepare(
    'SELECT id, item_code, item_label, value, unit, flag, note FROM lab_values WHERE patient_id=? AND rec_date=? ORDER BY id'
  ).all(patientId, date);
  const existing = db.prepare(
    'SELECT id, notes FROM timeline_events WHERE patient_id=? AND event_date=? AND event_type=? ORDER BY id LIMIT 1'
  ).get(patientId, date, LAB_EVENT_TYPE);
  if (!rows.length) {
    /* 没有结构化行的日期：若事件只剩 [结构化化验] 摘要，删掉；若还有
       医生手写的旧备注，只去掉结构化块，保留旧事件。 */
    if (!existing) return null;
    const base = stripStructuredBlock(existing.notes);
    if (base) {
      db.prepare('UPDATE timeline_events SET notes=? WHERE id=?').run(base.slice(0, 1000), existing.id);
      return existing.id;
    }
    db.prepare('DELETE FROM timeline_events WHERE id=?').run(existing.id);
    return null;
  }
  const lines = rows.map(r => {
    const v = r.value == null ? '—' : (r.value + (r.unit ? ' ' + r.unit : ''));
    const extra = [r.flag, r.note].filter(Boolean).join(' ');
    return r.item_label + '：' + v + (extra ? ' ' + extra : '');
  });
  const block = '[结构化化验]\n' + lines.join('\n');
  let notes = block;
  if (existing && existing.notes) {
    const base = stripStructuredBlock(existing.notes);
    if (base) {
      /* 旧事件备注里可能已经有同一行（如“肌酐：89.3 μmol/L”）。
         逐行去重，避免结构化摘要和旧文本重复。 */
      const generated = new Set(lines);
      const kept = base.split('\n').map(x => x.trim()).filter(x => x && !generated.has(x));
      notes = kept.length ? kept.join('\n') + '\n' + block : block;
    }
  }
  notes = notes.slice(0, 1000);
  let eventId;
  if (existing) {
    db.prepare('UPDATE timeline_events SET notes=? WHERE id=?').run(notes, existing.id);
    eventId = existing.id;
  } else {
    const r = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,is_surgery,notes,created_by)
                          VALUES(?,?,?,?,?,?)`)
      .run(patientId, date, LAB_EVENT_TYPE, 0, notes, actor || 'system');
    eventId = r.lastInsertRowid;
  }
  db.prepare('UPDATE lab_values SET event_id=? WHERE patient_id=? AND rec_date=?').run(eventId, patientId, date);
  return eventId;
}

function insertTreatmentAgents(lineId, agents) {
  const stmt = db.prepare(`INSERT INTO treatment_agents(line_id,drug,dose,schedule,start_date,end_date)
                           VALUES(?,?,?,?,?,?)`);
  (agents || []).forEach(a => stmt.run(lineId, a.drug, a.dose || '', a.schedule || '', a.startDate || null, a.endDate || null));
}

/* 治疗线 -> 药物记录同步（P1-11）。
   只新增/更新 line_id 关联的药物，不删除历史用药；手术/放疗/观察等
   非药物 agent 不生成 medication，避免把“根治性前列腺切除术”写成药。 */
function syncLineMedications(p, line, agents, actor) {
  const nonDrug = /手术|切除|放疗|照射|观察|等待|监测|随访|会诊|活检/;
  let created = 0, updated = 0, skipped = 0;
  (agents || []).forEach(a => {
    const drug = String(a.drug || '').trim();
    if (!drug || nonDrug.test(drug)) { skipped++; return; }
    const category = DRUG_CATEGORY[drug] || 'other';
    const start = normDate(a.startDate || line.start) || line.start;
    const end = a.endDate ? normDate(a.endDate) : (line.end || null);
    if (!start) { skipped++; return; }
    const existing = db.prepare(
      'SELECT * FROM medication_records WHERE patient_id=? AND line_id=? AND drug_name=? ORDER BY id LIMIT 1'
    ).get(p.id, line.id, drug);
    if (existing) {
      db.prepare(`UPDATE medication_records
                     SET start_date=?, end_date=?, dose=?, schedule=?, source='line_sync'
                   WHERE id=? AND patient_id=?`)
        .run(start, end, a.dose || '', a.schedule || '', existing.id, p.id);
      updated++;
      return;
    }
    const v = {
      category, drug, start, end,
      dose: String(a.dose || '').slice(0, 40),
      schedule: String(a.schedule || '').slice(0, 40),
      notes: '由治疗线同步'
    };
    const conflict = findMedicationConflict(p, v, null);
    if (conflict) { skipped++; return; }
    db.prepare(`INSERT INTO medication_records
        (patient_id,category,drug_name,start_date,end_date,dose,schedule,line_id,source,notes,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, category, drug, start, end, v.dose, v.schedule, line.id, 'line_sync', v.notes,
           actor || 'system', new Date().toISOString());
    created++;
  });
  if (created || updated || skipped) {
    logAudit(actor || 'system', 'SYNC_TREATMENT_MEDS',
      p.id + ' 治疗线#' + line.id + '：新增 ' + created + '，更新 ' + updated + '，跳过 ' + skipped);
  }
  return { created, updated, skipped };
}

app.post('/api/patients/:id/treatment-lines', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateTreatmentLineBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.start, '治疗线开始'); if (a) return res.status(400).json({ error: a }); }
  const dup = db.prepare('SELECT id FROM treatment_lines WHERE patient_id=? AND line_no=?').get(p.id, v.lineNo);
  if (dup) return res.status(400).json({ error: '该患者已有第 ' + v.lineNo + ' 线治疗，请先编辑或删除原记录' });
  let syncResult = null;
  const info = db.transaction(() => {
    const r = db.prepare(`INSERT INTO treatment_lines
      (patient_id,line_no,setting,regimen,start_date,end_date,stop_reason,stop_reason_code,response,response_code,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, v.lineNo, v.setting, v.regimen, v.start, v.end, v.stopReason, v.stopReasonCode, v.response, v.responseCode,
           req.user.username, new Date().toISOString());
    insertTreatmentAgents(r.lastInsertRowid, v.agents);
    if (req.body && (req.body.syncMedications === true || req.body.syncMedications === 1 ||
        req.body.syncMedications === '1' || req.body.syncMedications === 'true')) {
      syncResult = syncLineMedications(p, { id: r.lastInsertRowid, start: v.start, end: v.end }, v.agents, req.user.username);
    }
    return r;
  })();
  logAudit(req.user.username, 'ADD_TREATMENT_LINE', p.id + ' #' + info.lastInsertRowid + ' 第' + v.lineNo + '线 ' + v.regimen);
  res.json(Object.assign(buildPatient(getP(p.id)), { sync: syncResult }));
});

app.put('/api/patients/:id/treatment-lines/:lid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const line = db.prepare('SELECT * FROM treatment_lines WHERE id=? AND patient_id=?').get(req.params.lid, p.id);
  if (!line) return res.status(404).json({ error: '治疗线不存在' });
  const v = validateTreatmentLineBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.start, '治疗线开始'); if (a) return res.status(400).json({ error: a }); }
  const dup = db.prepare('SELECT id FROM treatment_lines WHERE patient_id=? AND line_no=? AND id<>?').get(p.id, v.lineNo, line.id);
  if (dup) return res.status(400).json({ error: '该患者已有第 ' + v.lineNo + ' 线治疗，请调整序号' });
  let syncResult = null;
  db.transaction(() => {
    db.prepare(`UPDATE treatment_lines
                   SET line_no=?, setting=?, regimen=?, start_date=?, end_date=?, stop_reason=?, stop_reason_code=?, response=?, response_code=?
                 WHERE id=? AND patient_id=?`)
      .run(v.lineNo, v.setting, v.regimen, v.start, v.end, v.stopReason, v.stopReasonCode, v.response, v.responseCode, line.id, p.id);
    db.prepare('DELETE FROM treatment_agents WHERE line_id=?').run(line.id);
    insertTreatmentAgents(line.id, v.agents);
    if (req.body && (req.body.syncMedications === true || req.body.syncMedications === 1 ||
        req.body.syncMedications === '1' || req.body.syncMedications === 'true')) {
      syncResult = syncLineMedications(p, { id: line.id, start: v.start, end: v.end }, v.agents, req.user.username);
    }
  })();
  logAudit(req.user.username, 'UPDATE_TREATMENT_LINE', p.id + ' #' + line.id + ' 第' + v.lineNo + '线 ' + v.regimen);
  res.json(Object.assign(buildPatient(getP(p.id)), { sync: syncResult }));
});

/* 一次建立“治疗线 + 治疗段 + 药物”，避免指南方案只落一个空段。
   这是治疗选择向导的唯一写入口；旧 /episodes /treatment-lines 仍保留兼容。 */
app.post('/api/patients/:id/treatment-plans', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const b = req.body || {};
  const lineV = validateTreatmentLineBody({
    lineNo: b.lineNo, setting: b.setting, regimen: b.regimen, startDate: b.startDate,
    endDate: b.endDate, stopReason: b.stopReason, stopReasonCode: b.stopReasonCode,
    response: b.response, responseCode: b.responseCode, agents: b.agents || []
  }, p.birth_date);
  if (lineV.error) return res.status(400).json({ error: lineV.error });
  { const a = assertAliveForRecord(p, lineV.start, '治疗开始'); if (a) return res.status(400).json({ error: a }); }
  const dup = db.prepare('SELECT id FROM treatment_lines WHERE patient_id=? AND line_no=?').get(p.id, lineV.lineNo);
  if (dup) return res.status(400).json({ error: '该患者已有第 ' + lineV.lineNo + ' 线治疗，请先编辑或删除原记录' });
  const epV = validateEpisodeInput({
    episodeType: b.episodeType || 'systemic', templateCode: b.templateCode || 'SYSTEMIC',
    label: b.label || b.regimen, intent: b.intent || 'radical', startDate: b.startDate,
    endDate: b.endDate || null, status: b.status || (b.endDate ? 'completed' : 'active'),
    stopReasonCode: b.stopReasonCode || '', guidelineScenario: b.guidelineScenario || '',
    guidelineOptionId: b.guidelineOptionId || '', recommendationLevel: b.recommendationLevel || '',
    guidelineRef: b.guidelineRef || '', notes: b.deviationReason || b.notes || ''
  });
  if (!epV.ok) return res.status(400).json({ error: epV.error });
  { const a = assertAliveForRecord(p, epV.value.startDate, '治疗段开始'); if (a) return res.status(400).json({ error: a }); }
  const tpl = templateByCode(epV.value.templateCode);
  const medIns = db.prepare(`INSERT INTO medication_records
    (patient_id,category,drug_name,start_date,end_date,dose,schedule,line_id,source,notes,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const catOf = t => ({ adt: 'adt', arpi: 'arpi', chemo: 'chemo', parpi: 'parpi', nuc: 'nuc', bone: 'bone', support: 'support' }[t] || 'other');
  const out = db.transaction(() => {
    const line = db.prepare(`INSERT INTO treatment_lines
      (patient_id,line_no,setting,regimen,start_date,end_date,stop_reason,stop_reason_code,response,response_code,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, lineV.lineNo, lineV.setting, lineV.regimen, lineV.start, lineV.end,
        lineV.stopReason, lineV.stopReasonCode, lineV.response, lineV.responseCode,
        req.user.username, new Date().toISOString());
    insertTreatmentAgents(line.lastInsertRowid, lineV.agents);
    const ep = db.prepare(`INSERT INTO treatment_episodes
      (patient_id,episode_type,template_code,label,intent,line_id,guideline_scenario,guideline_option_id,
       recommendation_level,guideline_ref,start_date,end_date,status,stop_reason_code,followup_interval_days,source,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, epV.value.episodeType, epV.value.templateCode, epV.value.label || lineV.regimen,
        epV.value.intent, line.lastInsertRowid, epV.value.guidelineScenario, epV.value.guidelineOptionId,
        epV.value.recommendationLevel, epV.value.guidelineRef, epV.value.startDate, epV.value.endDate,
        epV.value.status, epV.value.stopReasonCode,
        epV.value.followupIntervalDays == null ? (tpl ? tpl.intervalMonths * 30 : null) : epV.value.followupIntervalDays,
        'manual', epV.value.notes, req.user.username, new Date().toISOString());
    let meds = 0;
    const comps = Array.isArray(b.components) ? b.components.slice(0, 12) : [];
    for (const c of comps) {
      const drug = String((c && (c.drug || c.label)) || '').trim().slice(0, 120);
      if (!drug) continue;
      const s = normDate(c.startDate) || lineV.start;
      const e = c.endDate ? normDate(c.endDate) : lineV.end;
      if (!s || (e && e < s)) continue;
      medIns.run(p.id, catOf(c.type), drug, s, e, String(c.dose || '').slice(0, 80),
        String(c.schedule || '').slice(0, 80), line.lastInsertRowid, 'manual',
        b.deviationReason || '', req.user.username, new Date().toISOString());
      meds++;
    }
    return { lineId: line.lastInsertRowid, episodeId: ep.lastInsertRowid, meds };
  })();
  logAudit(req.user.username, 'ADD_TREATMENT_PLAN',
    p.id + ' 第' + lineV.lineNo + '线 ' + lineV.regimen + ' #line=' + out.lineId + ' #ep=' + out.episodeId + ' meds=' + out.meds);
  res.json(Object.assign({ ok: true }, out, buildPatient(getP(p.id))));
});

app.delete('/api/patients/:id/treatment-lines/:lid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const line = db.prepare('SELECT * FROM treatment_lines WHERE id=? AND patient_id=?').get(req.params.lid, p.id);
  if (!line) return res.status(404).json({ error: '治疗线不存在' });
  db.transaction(() => {
    db.prepare('UPDATE medication_records SET line_id=NULL WHERE patient_id=? AND line_id=?').run(p.id, line.id);
    db.prepare('DELETE FROM treatment_lines WHERE id=? AND patient_id=?').run(line.id, p.id);
  })();
  logAudit(req.user.username, 'DELETE_TREATMENT_LINE', p.id + ' #' + line.id + ' 第' + line.line_no + '线 ' + line.regimen);
  res.json(buildPatient(getP(p.id)));
});

app.post('/api/patients/:id/clinical-records', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateClinicalRecordBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.date, '监测日期'); if (a) return res.status(400).json({ error: a }); }
  const info = db.prepare(`INSERT INTO clinical_records
      (patient_id,category,item,rec_date,value,unit,status,note,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, v.category, v.item, v.date, v.value, v.unit, v.status, v.note,
         req.user.username, new Date().toISOString());
  logAudit(req.user.username, 'ADD_CLINICAL_RECORD', p.id + ' ' + v.category + ' ' + v.item + '=' + (v.value == null ? (v.status || '') : v.value));
  res.json(buildPatient(getP(p.id)));
});

app.put('/api/patients/:id/clinical-records/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM clinical_records WHERE id=? AND patient_id=?').get(req.params.rid, p.id);
  if (!r) return res.status(404).json({ error: '监测记录不存在' });
  const v = validateClinicalRecordBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.date, '监测日期'); if (a) return res.status(400).json({ error: a }); }
  db.prepare(`UPDATE clinical_records SET category=?,item=?,rec_date=?,value=?,unit=?,status=?,note=?
              WHERE id=? AND patient_id=?`)
    .run(v.category, v.item, v.date, v.value, v.unit, v.status, v.note, r.id, p.id);
  logAudit(req.user.username, 'UPDATE_CLINICAL_RECORD', p.id + ' #' + r.id + ' ' + v.item);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/clinical-records/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const r = db.prepare('SELECT * FROM clinical_records WHERE id=? AND patient_id=?').get(req.params.rid, p.id);
  if (!r) return res.status(404).json({ error: '监测记录不存在' });
  db.prepare('DELETE FROM clinical_records WHERE id=? AND patient_id=?').run(r.id, p.id);
  logAudit(req.user.username, 'DELETE_CLINICAL_RECORD', p.id + ' #' + r.id + ' ' + r.item);
  res.json(buildPatient(getP(p.id)));
});

/* ================= 普通化验 lab_values（P1-12） ================= */
app.post('/api/patients/:id/lab-values', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateLabValueBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.date, '化验日期'); if (a) return res.status(400).json({ error: a }); }
  const d = v.value;
  const info = db.transaction(() => {
    const r = db.prepare(`INSERT INTO lab_values
      (patient_id,rec_date,item_code,item_label,value,unit,lab,method,ref_range,flag,note,source,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, d.date, d.itemCode, d.itemLabel, d.value, d.unit, d.lab, d.method, d.refRange, d.flag, d.note,
           'manual', req.user.username, new Date().toISOString());
    rebuildLabEvent(p.id, d.date, req.user.username);
    return r;
  })();
  logAudit(req.user.username, 'ADD_LAB_VALUE', p.id + ' ' + d.date + ' ' + d.itemCode + '=' + (d.value == null ? '—' : d.value));
  res.json(buildPatient(getP(p.id)));
});

app.put('/api/patients/:id/lab-values/:vid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM lab_values WHERE id=? AND patient_id=?').get(req.params.vid, p.id);
  if (!old) return res.status(404).json({ error: '化验记录不存在' });
  const v = validateLabValueBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.date, '化验日期'); if (a) return res.status(400).json({ error: a }); }
  const d = v.value;
  db.transaction(() => {
    db.prepare(`UPDATE lab_values SET rec_date=?,item_code=?,item_label=?,value=?,unit=?,lab=?,method=?,ref_range=?,flag=?,note=?
                WHERE id=? AND patient_id=?`)
      .run(d.date, d.itemCode, d.itemLabel, d.value, d.unit, d.lab, d.method, d.refRange, d.flag, d.note, old.id, p.id);
    rebuildLabEvent(p.id, old.rec_date, req.user.username);
    rebuildLabEvent(p.id, d.date, req.user.username);
  })();
  logAudit(req.user.username, 'UPDATE_LAB_VALUE', p.id + ' #' + old.id + ' ' + d.itemCode);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/lab-values/:vid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM lab_values WHERE id=? AND patient_id=?').get(req.params.vid, p.id);
  if (!old) return res.status(404).json({ error: '化验记录不存在' });
  db.transaction(() => {
    db.prepare('DELETE FROM lab_values WHERE id=? AND patient_id=?').run(old.id, p.id);
    rebuildLabEvent(p.id, old.rec_date, req.user.username);
  })();
  logAudit(req.user.username, 'DELETE_LAB_VALUE', p.id + ' #' + old.id + ' ' + old.item_code);
  res.json(buildPatient(getP(p.id)));
});

/* ================= 科研数据：样本 / 基因组 / IHC ================= */
function specimenBelongsTo(sid, pid) {
  if (sid == null || sid === '') return null;
  return db.prepare('SELECT id FROM specimens WHERE id=? AND patient_id=?').get(sid, pid) || false;
}

app.post('/api/patients/:id/specimens', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateSpecimenBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.collectionDate, '采样日期'); if (a) return res.status(400).json({ error: a }); }
  if (v.value.biobankId) {
    const dup = db.prepare('SELECT id FROM specimens WHERE biobank_id=?').get(v.value.biobankId);
    if (dup) return res.status(400).json({ error: '该生物样本库编号已存在' });
  }
  dbInsertRow('specimens', Object.assign({
    patient_id: p.id, sample_type: v.value.sampleType, collection_date: v.value.collectionDate,
    timepoint: v.value.timepoint, treatment_status: v.value.treatmentStatus, storage: v.value.storage,
    tumor_cell_pct: v.value.tumorCellPct, nucleic_quality: v.value.nucleicQuality,
    library_id: v.value.libraryId, biobank_id: v.value.biobankId, notes: v.value.notes,
    created_by: req.user.username, created_at: new Date().toISOString()
  }));
  logAudit(req.user.username, 'ADD_SPECIMEN', p.id + ' ' + v.value.sampleType + ' ' + v.value.collectionDate);
  res.json(buildPatient(getP(p.id)));
});

app.put('/api/patients/:id/specimens/:sid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const row = db.prepare('SELECT * FROM specimens WHERE id=? AND patient_id=?').get(req.params.sid, p.id);
  if (!row) return res.status(404).json({ error: '样本不存在' });
  const v = validateSpecimenBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.collectionDate, '采样日期'); if (a) return res.status(400).json({ error: a }); }
  if (v.value.biobankId) {
    const dup = db.prepare('SELECT id FROM specimens WHERE biobank_id=? AND id<>?').get(v.value.biobankId, row.id);
    if (dup) return res.status(400).json({ error: '该生物样本库编号已存在' });
  }
  dbUpdateRow('specimens', {
    sample_type: v.value.sampleType, collection_date: v.value.collectionDate,
    timepoint: v.value.timepoint, treatment_status: v.value.treatmentStatus, storage: v.value.storage,
    tumor_cell_pct: v.value.tumorCellPct, nucleic_quality: v.value.nucleicQuality,
    library_id: v.value.libraryId, biobank_id: v.value.biobankId, notes: v.value.notes
  }, row.id);
  logAudit(req.user.username, 'UPDATE_SPECIMEN', p.id + ' #' + row.id);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/specimens/:sid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const row = db.prepare('SELECT * FROM specimens WHERE id=? AND patient_id=?').get(req.params.sid, p.id);
  if (!row) return res.status(404).json({ error: '样本不存在' });
  db.prepare('DELETE FROM specimens WHERE id=?').run(row.id);
  logAudit(req.user.username, 'DELETE_SPECIMEN', p.id + ' #' + row.id);
  res.json(buildPatient(getP(p.id)));
});

app.post('/api/patients/:id/genomic-tests', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateGenomicBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.testDate, '基因检测日期'); if (a) return res.status(400).json({ error: a }); }
  const sid = req.body.specimenId == null || req.body.specimenId === '' ? null : Number(req.body.specimenId);
  if (sid != null && !specimenBelongsTo(sid, p.id)) return res.status(400).json({ error: '关联样本不存在' });
  dbInsertRow('genomic_tests', Object.assign({
    patient_id: p.id, specimen_id: sid, test_type: v.value.testType, test_date: v.value.testDate,
    lab: v.value.lab, platform: v.value.platform, genes: v.value.genes,
    hrr_status: v.value.hrrStatus, msi_status: v.value.msiStatus, tmb_value: v.value.tmbValue,
    ar_status: v.value.arStatus, tp53_status: v.value.tp53Status,
    pten_status: v.value.ptenStatus, rb1_status: v.value.rb1Status,
    result_summary: v.value.resultSummary, notes: v.value.notes,
    created_by: req.user.username, created_at: new Date().toISOString()
  }));
  logAudit(req.user.username, 'ADD_GENOMIC', p.id + ' ' + v.value.testType + ' ' + v.value.testDate);
  res.json(buildPatient(getP(p.id)));
});

app.put('/api/patients/:id/genomic-tests/:gid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const row = db.prepare('SELECT * FROM genomic_tests WHERE id=? AND patient_id=?').get(req.params.gid, p.id);
  if (!row) return res.status(404).json({ error: '基因检测记录不存在' });
  const v = validateGenomicBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.testDate, '基因检测日期'); if (a) return res.status(400).json({ error: a }); }
  const sid = req.body.specimenId == null || req.body.specimenId === '' ? null : Number(req.body.specimenId);
  if (sid != null && !specimenBelongsTo(sid, p.id)) return res.status(400).json({ error: '关联样本不存在' });
  dbUpdateRow('genomic_tests', {
    specimen_id: sid, test_type: v.value.testType, test_date: v.value.testDate,
    lab: v.value.lab, platform: v.value.platform, genes: v.value.genes,
    hrr_status: v.value.hrrStatus, msi_status: v.value.msiStatus, tmb_value: v.value.tmbValue,
    ar_status: v.value.arStatus, tp53_status: v.value.tp53Status,
    pten_status: v.value.ptenStatus, rb1_status: v.value.rb1Status,
    result_summary: v.value.resultSummary, notes: v.value.notes
  }, row.id);
  logAudit(req.user.username, 'UPDATE_GENOMIC', p.id + ' #' + row.id);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/genomic-tests/:gid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const row = db.prepare('SELECT * FROM genomic_tests WHERE id=? AND patient_id=?').get(req.params.gid, p.id);
  if (!row) return res.status(404).json({ error: '基因检测记录不存在' });
  db.prepare('DELETE FROM genomic_tests WHERE id=?').run(row.id);
  logAudit(req.user.username, 'DELETE_GENOMIC', p.id + ' #' + row.id);
  res.json(buildPatient(getP(p.id)));
});

app.post('/api/patients/:id/ihc-results', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateIhcBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.testDate, 'IHC 日期'); if (a) return res.status(400).json({ error: a }); }
  const sid = req.body.specimenId == null || req.body.specimenId === '' ? null : Number(req.body.specimenId);
  if (sid != null && !specimenBelongsTo(sid, p.id)) return res.status(400).json({ error: '关联样本不存在' });
  dbInsertRow('ihc_results', Object.assign({
    patient_id: p.id, specimen_id: sid, marker: v.value.marker, result: v.value.result,
    percent: v.value.percent, intensity: v.value.intensity, test_date: v.value.testDate,
    lab: v.value.lab, notes: v.value.notes,
    created_by: req.user.username, created_at: new Date().toISOString()
  }));
  logAudit(req.user.username, 'ADD_IHC', p.id + ' ' + v.value.marker + ' ' + v.value.result);
  res.json(buildPatient(getP(p.id)));
});

app.put('/api/patients/:id/ihc-results/:iid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const row = db.prepare('SELECT * FROM ihc_results WHERE id=? AND patient_id=?').get(req.params.iid, p.id);
  if (!row) return res.status(404).json({ error: 'IHC 记录不存在' });
  const v = validateIhcBody(req.body, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  { const a = assertAliveForRecord(p, v.value.testDate, 'IHC 日期'); if (a) return res.status(400).json({ error: a }); }
  const sid = req.body.specimenId == null || req.body.specimenId === '' ? null : Number(req.body.specimenId);
  if (sid != null && !specimenBelongsTo(sid, p.id)) return res.status(400).json({ error: '关联样本不存在' });
  dbUpdateRow('ihc_results', {
    specimen_id: sid, marker: v.value.marker, result: v.value.result,
    percent: v.value.percent, intensity: v.value.intensity, test_date: v.value.testDate,
    lab: v.value.lab, notes: v.value.notes
  }, row.id);
  logAudit(req.user.username, 'UPDATE_IHC', p.id + ' #' + row.id);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/ihc-results/:iid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const row = db.prepare('SELECT * FROM ihc_results WHERE id=? AND patient_id=?').get(req.params.iid, p.id);
  if (!row) return res.status(404).json({ error: 'IHC 记录不存在' });
  db.prepare('DELETE FROM ihc_results WHERE id=?').run(row.id);
  logAudit(req.user.username, 'DELETE_IHC', p.id + ' #' + row.id);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/outcomes/:oid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  if (!deleteOutcomeAndReset(Number(req.params.oid), p.id, req.user.username)) {
    return res.status(404).json({ error: '结局记录不存在' });
  }
  res.json(buildPatient(getP(p.id)));
});

/* ================= v13：指南目录 / 治疗段 / 就诊 / 毒性 ================= */
app.get('/api/catalog', auth(), (req, res) => {
  res.json(getCatalog());
});

function getEpisodeOf(pid, eid) {
  return db.prepare('SELECT * FROM treatment_episodes WHERE id=? AND patient_id=?').get(eid, pid) || null;
}
function getVisitOf(pid, vid) {
  return db.prepare('SELECT * FROM visits WHERE id=? AND patient_id=?').get(vid, pid) || null;
}
function defaultItemsForTemplate(templateCode) {
  const t = templateByCode(templateCode);
  if (!t) return [];
  const labelOf = {
    visit_date: '就诊日期', psa: 'PSA', testosterone: '血清睾酮', imaging: '影像学',
    response: '疗效', urinary_incontinence: '尿失禁', erectile_dysfunction: '勃起障碍',
    hematuria: '血尿', proctitis: '直肠炎', hot_flashes: '潮热', metabolic_syndrome: '代谢综合征',
    cognitive_impairment: '认知障碍', osteoporosis: '骨质疏松', anemia: '贫血',
    nausea: '恶心', vomiting: '呕吐', diarrhea: '腹泻', peripheral_neuropathy: '外周神经病变',
    myelosuppression: '骨髓抑制', fluid_retention: '液体潴留', allergy: '过敏',
    cycle_no: '周期号', cycle_date: '周期日期', regimen: '方案', dose: '剂量', labs: '血常规/肝肾功能',
    ecog: 'ECOG', dre: 'DRE', mri: 'mpMRI', biopsy: '重复活检', symptoms: '症状/疼痛', notes: '备注'
  };
  const out = [];
  (t.core || []).forEach(code => {
    if (['visit_date', 'response', 'cycle_date'].includes(code)) return;
    out.push({ code, label: labelOf[code] || code, status: 'pending' });
  });
  (t.due || []).forEach(d => out.push({ code: d.code, label: d.label, status: 'pending', due: true }));
  return out;
}
function insertVisitItem(visitId, rowId, item, source) {
  if (!item || !item.code) return;
  const exists = db.prepare('SELECT id FROM visit_items WHERE visit_id=? AND IFNULL(episode_row_id,0)=? AND item_code=?')
    .get(visitId, rowId || 0, item.code);
  if (exists) {
    db.prepare('UPDATE visit_items SET status=?, reason=?, item_label=? WHERE id=?')
      .run(item.status || 'pending', item.reason || '', item.label || item.code, exists.id);
    return exists.id;
  }
  const r = db.prepare(`INSERT INTO visit_items(visit_id,episode_row_id,item_code,item_label,status,reason,due_date,source,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(visitId, rowId || null, item.code, item.label || item.code, item.status || 'pending',
         item.reason || '', item.dueDate || null, source || 'manual', new Date().toISOString());
  return r.lastInsertRowid;
}
function insertAdverseEvent(pid, visitId, rowId, episodeId, chemoCycleId, ae, actor) {
  const v = validateAdverseEventInput(ae);
  if (!v.ok) throw new Error(v.error);
  let grade = v.value.grade;
  let basis = v.value.gradeBasis;
  if (v.value.termCode === 'myelosuppression' && ae.labs) {
    const comp = computeMyelosuppressionGrade(ae.labs);
    if (comp) { grade = comp.grade; basis = comp.basis; }
  }
  const existing = rowId
    ? db.prepare('SELECT id FROM adverse_events WHERE episode_row_id=? AND term_code=?').get(rowId, v.value.termCode)
    : (chemoCycleId ? db.prepare('SELECT id FROM adverse_events WHERE chemo_cycle_id=? AND term_code=?').get(chemoCycleId, v.value.termCode) : null);
  if (existing) {
    db.prepare(`UPDATE adverse_events SET grade=?, grade_basis=?, onset_date=?, resolution_date=?, recovery_status=?,
                aux_meds=?, management=?, action=?, causality=?, notes=?, visit_id=?, episode_id=?
                WHERE id=?`)
      .run(grade, basis, v.value.onsetDate, v.value.resolutionDate, v.value.recoveryStatus,
           v.value.auxMeds, v.value.management, v.value.action, v.value.causality, v.value.notes,
           visitId || null, episodeId || null, existing.id);
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO adverse_events
    (patient_id,visit_id,episode_row_id,chemo_cycle_id,episode_id,term_code,term_label,grade,ctcae_version,
     grade_basis,onset_date,resolution_date,recovery_status,aux_meds,management,action,causality,notes,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(pid, visitId || null, rowId || null, chemoCycleId || null, episodeId || null,
         v.value.termCode, v.value.termLabel, grade, v.value.ctcaeVersion, basis,
         v.value.onsetDate, v.value.resolutionDate, v.value.recoveryStatus, v.value.auxMeds,
         v.value.management, v.value.action, v.value.causality, v.value.notes, actor, new Date().toISOString());
  return r.lastInsertRowid;
}
function saveVisitRow(pid, visitId, ep, actor) {
  const epRow = getEpisodeOf(pid, ep.episodeId);
  if (!epRow) throw new Error('治疗段不存在或不属于该患者');
  const v = validateRowInput(ep);
  if (!v.ok) throw new Error(v.error);
  const max = db.prepare('SELECT MAX(visit_no) AS m FROM visit_episode_rows WHERE episode_id=?').get(epRow.id).m || 0;
  const existing = db.prepare('SELECT id, visit_no FROM visit_episode_rows WHERE visit_id=? AND episode_id=? AND row_type=?')
    .get(visitId, epRow.id, v.value.rowType);
  const visitNo = v.value.visitNo || (existing ? existing.visit_no : (max + 1));
  let rowId;
  if (existing) {
    rowId = existing.id;
    db.prepare(`UPDATE visit_episode_rows SET visit_no=?, overall_response=?, response_basis=?, psa_response=?,
                imaging_response=?, clinical_response=?, ecog=?, pain_nrs=?, symptom_status=?, summary=?, notes=?, next_visit_date=?
                WHERE id=?`)
      .run(visitNo, v.value.overallResponse, v.value.responseBasis, v.value.psaResponse,
           v.value.imagingResponse, v.value.clinicalResponse, v.value.ecog, v.value.painNrs,
           v.value.symptomStatus, v.value.summary, v.value.notes, v.value.nextVisitDate, rowId);
  } else {
    const r = db.prepare(`INSERT INTO visit_episode_rows
      (visit_id,episode_id,visit_no,row_type,overall_response,response_basis,psa_response,imaging_response,
       clinical_response,ecog,pain_nrs,symptom_status,summary,notes,next_visit_date,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(visitId, epRow.id, visitNo, v.value.rowType, v.value.overallResponse, v.value.responseBasis,
           v.value.psaResponse, v.value.imagingResponse, v.value.clinicalResponse, v.value.ecog,
           v.value.painNrs, v.value.symptomStatus, v.value.summary, v.value.notes, v.value.nextVisitDate,
           new Date().toISOString());
    rowId = r.lastInsertRowid;
  }
  /* 默认执行清单：有模板时生成；前端显式传 items 则用前端的 */
  /* 默认执行清单：仅新建行时生成；已有行不覆盖医生已标记的状态。
     前端显式传 items 时以传入为准。 */
  const explicitItems = Array.isArray(ep.items) && ep.items.length;
  const items = explicitItems ? ep.items : (existing ? [] : defaultItemsForTemplate(epRow.template_code));
  items.forEach(it => insertVisitItem(visitId, rowId, it, explicitItems ? 'manual' : 'template'));
  (ep.adverseEvents || []).forEach(ae => insertAdverseEvent(pid, visitId, rowId, epRow.id, null, ae, actor));
  return rowId;
}


/* 影像：既可从新版就诊向导直接录入，也可走旧版事件表单；
   统一写 imaging_studies + 时间轴投影，并绑定 visit/episode。 */
function imagingEventType(modality) {
  return ({
    mpMRI: '多参数磁共振(mpMRI)', MRI: '腹盆腔MRI', CT: '腹盆腔CT',
    PSMA_PET: 'PSMA PET-CT', PSMA_PET_MRI: 'PSMA PET-MRI',
    bone_scan: '骨扫描(ECT)', choline_pet: '胆碱PET-CT'
  })[modality] || '影像学检查';
}
function createImagingForVisit(p, body, user, visitId, episodeId) {
  const v = validateImagingBody(body, p.birth_date);
  if (v.error) throw new Error(v.error);
  const d = v.value;
  const type = imagingEventType(d.modality);
  const ev = db.prepare(`INSERT INTO timeline_events
    (patient_id,event_date,event_type,notes,visit_id,episode_id,created_by)
    VALUES(?,?,?,?,?,?,?)`)
    .run(p.id, d.studyDate, type, String(d.notes || '').slice(0, 1000), visitId || null, episodeId || null, user);
  const id = saveImagingForEvent(p.id, ev.lastInsertRowid, d, user);
  db.prepare('UPDATE imaging_studies SET visit_id=?,episode_id=? WHERE id=?').run(visitId || null, episodeId || null, id);
  return { id, eventId: ev.lastInsertRowid, studyDate: d.studyDate, modality: d.modality };
}

/* 结构化记录修正：病理/影像/放疗/结局。旧版只能通过事件编辑，新版直接改子表，
   并同步父事件日期/类型，避免父子不一致。 */
function updateStructuredEventDate(pid, eid, date, type) {
  if (!eid || !date) return;
  const t = type ? String(type).slice(0, 80) : null;
  if (t) db.prepare('UPDATE timeline_events SET event_date=?, event_type=? WHERE id=? AND patient_id=?').run(date, t, eid, pid);
  else db.prepare('UPDATE timeline_events SET event_date=? WHERE id=? AND patient_id=?').run(date, eid, pid);
}

app.put('/api/patients/:id/pathology/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM pathology_reports WHERE id=? AND patient_id=?').get(req.params.rid, p.id);
  if (!old) return res.status(404).json({ error: '病理记录不存在' });
  const body = req.body || {};
  const data = body.data || body;
  const v = validatePathologyBody(Object.assign({}, data, { reportDate: data.reportDate || old.report_date }), p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  const out = db.transaction(() => {
    updateStructuredEventDate(p.id, old.event_id, v.value.reportDate, body.eventType || '前列腺穿刺活检病理报告');
    return savePathologyForEvent(p.id, old.event_id, v.value, req.user.username);
  })();
  if (out && out.error) return res.status(400).json({ error: out.error });
  logAudit(req.user.username, 'UPDATE_PATHOLOGY', p.id + ' #' + old.id);
  res.json({ ok: true, id: out });
});

app.delete('/api/patients/:id/pathology/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM pathology_reports WHERE id=? AND patient_id=?').get(req.params.rid, p.id);
  if (!old) return res.status(404).json({ error: '病理记录不存在' });
  db.transaction(() => {
    db.prepare('DELETE FROM pathology_reports WHERE id=? AND patient_id=?').run(old.id, p.id);
    if (old.event_id) db.prepare('DELETE FROM timeline_events WHERE id=? AND patient_id=?').run(old.event_id, p.id);
  })();
  logAudit(req.user.username, 'DELETE_PATHOLOGY', p.id + ' #' + old.id);
  res.json({ ok: true });
});

app.put('/api/patients/:id/imaging/:iid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM imaging_studies WHERE id=? AND patient_id=?').get(req.params.iid, p.id);
  if (!old) return res.status(404).json({ error: '影像记录不存在' });
  const data = (req.body && (req.body.data || req.body)) || {};
  const v = validateImagingBody(Object.assign({}, data, { studyDate: data.studyDate || old.study_date }), p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  db.transaction(() => {
    updateStructuredEventDate(p.id, old.event_id, v.value.studyDate, (req.body && req.body.eventType) || null);
    saveImagingForEvent(p.id, old.event_id, v.value, req.user.username);
  })();
  logAudit(req.user.username, 'UPDATE_IMAGING', p.id + ' #' + old.id);
  res.json({ ok: true, id: old.id });
});

app.delete('/api/patients/:id/imaging/:iid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM imaging_studies WHERE id=? AND patient_id=?').get(req.params.iid, p.id);
  if (!old) return res.status(404).json({ error: '影像记录不存在' });
  db.transaction(() => {
    db.prepare('DELETE FROM imaging_studies WHERE id=? AND patient_id=?').run(old.id, p.id);
    if (old.event_id) db.prepare('DELETE FROM timeline_events WHERE id=? AND patient_id=?').run(old.event_id, p.id);
  })();
  logAudit(req.user.username, 'DELETE_IMAGING', p.id + ' #' + old.id);
  res.json({ ok: true });
});

app.put('/api/patients/:id/radiation/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM radiation_records WHERE id=? AND patient_id=?').get(req.params.rid, p.id);
  if (!old) return res.status(404).json({ error: '放疗记录不存在' });
  const data = (req.body && (req.body.data || req.body)) || {};
  const v = validateRadiationBody(Object.assign({}, data, { startDate: data.startDate || old.start_date }), p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  db.transaction(() => {
    updateStructuredEventDate(p.id, old.event_id, v.value.startDate, (req.body && req.body.eventType) || null);
    saveRadiationForEvent(p.id, old.event_id, v.value, req.user.username);
  })();
  logAudit(req.user.username, 'UPDATE_RADIATION', p.id + ' #' + old.id);
  res.json({ ok: true, id: old.id });
});

app.delete('/api/patients/:id/radiation/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM radiation_records WHERE id=? AND patient_id=?').get(req.params.rid, p.id);
  if (!old) return res.status(404).json({ error: '放疗记录不存在' });
  db.transaction(() => {
    db.prepare('DELETE FROM radiation_records WHERE id=? AND patient_id=?').run(old.id, p.id);
    if (old.event_id) db.prepare('DELETE FROM timeline_events WHERE id=? AND patient_id=?').run(old.event_id, p.id);
  })();
  logAudit(req.user.username, 'DELETE_RADIATION', p.id + ' #' + old.id);
  res.json({ ok: true });
});

app.put('/api/patients/:id/outcomes/:oid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM patient_outcomes WHERE id=? AND patient_id=?').get(req.params.oid, p.id);
  if (!old) return res.status(404).json({ error: '结局记录不存在' });
  const data = (req.body && (req.body.data || req.body)) || {};
  const v = validateOutcomeBody(Object.assign({}, data, { eventDate: data.eventDate || old.event_date }), p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });
  if (old.event_id) updateStructuredEventDate(p.id, old.event_id, v.value.eventDate, (req.body && req.body.eventType) || old.outcome_type);
  const out = saveOutcomeForEvent(p.id, old.event_id, v.value, req.user.username);
  if (out && out.error) return res.status(400).json({ error: out.error });
  logAudit(req.user.username, 'UPDATE_OUTCOME', p.id + ' #' + old.id);
  res.json({ ok: true, id: old.id });
});

app.post('/api/patients/:id/imaging', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const b = req.body || {};
  const visitId = b.visitId == null ? null : Number(b.visitId);
  const episodeId = b.episodeId == null ? null : Number(b.episodeId);
  if (visitId && !getVisitOf(p.id, visitId)) return res.status(400).json({ error: '就诊不存在' });
  if (episodeId && !getEpisodeOf(p.id, episodeId)) return res.status(400).json({ error: '治疗段不存在' });
  const alive = assertAliveForRecord(p, normDate(b.studyDate), '影像日期');
  if (alive) return res.status(400).json({ error: alive });
  try {
    const out = db.transaction(() => createImagingForVisit(p, b, req.user.username, visitId, episodeId))();
    logAudit(req.user.username, 'ADD_IMAGING', p.id + ' #' + out.id + ' ' + out.modality);
    res.json({ ok: true, ...out, imagingStudies: db.prepare('SELECT * FROM imaging_studies WHERE patient_id=? ORDER BY study_date,id').all(p.id).map(r => ({
      id: r.id, visitId: r.visit_id || null, episodeId: r.episode_id || null, modality: r.modality, studyDate: r.study_date,
      pirads: r.pirads, lesionCount: r.lesion_count, metastaticSites: r.metastatic_sites, psmaSuvmax: r.psma_suvmax,
      recist: r.recist, notes: r.notes || ''
    })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});


/* 可选回填：把历史事件/测量的日期聚合成“历史就诊”，并按治疗段生成随访行。
   不伪造疗效/毒性；只建容器并绑定已有记录，可重复执行（已有日期跳过）。
   不自动在启动时跑：避免把 64 例的历史噪声一次性灌进新表；由医生按患者触发。 */
app.post('/api/patients/:id/visits/backfill', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const dates = new Set();
  const addDates = (rows, col) => rows.forEach(r => { if (r[col]) dates.add(r[col]); });
  addDates(db.prepare('SELECT DISTINCT event_date FROM timeline_events WHERE patient_id=?').all(p.id), 'event_date');
  addDates(db.prepare('SELECT DISTINCT rec_date FROM psa_records WHERE patient_id=?').all(p.id), 'rec_date');
  addDates(db.prepare('SELECT DISTINCT rec_date FROM testosterone_records WHERE patient_id=?').all(p.id), 'rec_date');
  addDates(db.prepare('SELECT DISTINCT rec_date FROM lab_values WHERE patient_id=?').all(p.id), 'rec_date');
  addDates(db.prepare('SELECT DISTINCT rec_date FROM clinical_records WHERE patient_id=?').all(p.id), 'rec_date');
  addDates(db.prepare('SELECT DISTINCT study_date FROM imaging_studies WHERE patient_id=?').all(p.id), 'study_date');
  addDates(db.prepare('SELECT DISTINCT report_date FROM pathology_reports WHERE patient_id=?').all(p.id), 'report_date');
  addDates(db.prepare('SELECT DISTINCT event_date FROM patient_outcomes WHERE patient_id=?').all(p.id), 'event_date');
  const sorted = [...dates].filter(d => normDate(d)).sort();
  let createdVisits = 0, linked = 0, createdRows = 0;
  const tx = db.transaction(() => {
    for (const d of sorted) {
      let v = db.prepare('SELECT * FROM visits WHERE patient_id=? AND visit_date=? ORDER BY id LIMIT 1').get(p.id, d);
      if (!v) {
        const r = db.prepare(`INSERT INTO visits
          (patient_id,visit_date,visit_type,department,physician,chief_complaint,summary,next_plan,source,status,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(p.id, d, 'other', '', '', '', '历史记录回填（疗效/毒性/小结待补）', '', 'backfill', 'final', req.user.username, new Date().toISOString(), new Date().toISOString());
        v = { id: r.lastInsertRowid, visit_date: d };
        createdVisits++;
      }
      const link = (table, col) => {
        const r = db.prepare('UPDATE ' + table + ' SET visit_id=? WHERE patient_id=? AND ' + col + '=? AND visit_id IS NULL').run(v.id, p.id, d);
        linked += r.changes;
      };
      link('psa_records', 'rec_date'); link('testosterone_records', 'rec_date');
      link('lab_values', 'rec_date'); link('clinical_records', 'rec_date');
      link('imaging_studies', 'study_date'); link('pathology_reports', 'report_date');
      link('patient_outcomes', 'event_date'); link('timeline_events', 'event_date');
      const eps = db.prepare(`SELECT * FROM treatment_episodes WHERE patient_id=? AND start_date<=? AND (end_date IS NULL OR end_date>=?) ORDER BY start_date`).all(p.id, d, d);
      for (const ep of eps) {
        const exists = db.prepare(`SELECT id FROM visit_episode_rows WHERE visit_id=? AND episode_id=? AND row_type='followup'`).get(v.id, ep.id);
        if (exists) continue;
        const max = db.prepare('SELECT MAX(visit_no) AS m FROM visit_episode_rows WHERE episode_id=?').get(ep.id).m || 0;
        db.prepare(`INSERT INTO visit_episode_rows
          (visit_id,episode_id,visit_no,row_type,overall_response,response_basis,psa_response,imaging_response,clinical_response,summary,notes,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(v.id, ep.id, max + 1, 'followup', 'NA', 'none', 'NA', 'NA', 'NA', '', '历史回填：疗效/毒性待补', new Date().toISOString());
        createdRows++;
      }
    }
  });
  tx();
  logAudit(req.user.username, 'BACKFILL_VISITS', p.id + ' visits=' + createdVisits + ' rows=' + createdRows + ' linked=' + linked);
  res.json({ ok: true, dates: sorted.length, createdVisits, createdRows, linked });
});

app.post('/api/patients/:id/visits/:vid/attach', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = getVisitOf(p.id, req.params.vid);
  if (!v) return res.status(404).json({ error: '就诊不存在' });
  const b = req.body || {};
  const type = String(b.type || '');
  const id = Number(b.id);
  const map = {
    imaging: ['imaging_studies', '影像'], pathology: ['pathology_reports', '病理'],
    radiation: ['radiation_records', '放疗'], outcome: ['patient_outcomes', '结局'],
    event: ['timeline_events', '事件'], psa: ['psa_records', 'PSA'],
    testo: ['testosterone_records', '睾酮'], lab: ['lab_values', '化验'],
    clinical: ['clinical_records', '临床监测']
  };
  const hit = map[type];
  if (!hit || !Number.isInteger(id)) return res.status(400).json({ error: '关联类型或 id 不合法' });
  const row = db.prepare('SELECT id FROM ' + hit[0] + ' WHERE id=? AND patient_id=?').get(id, p.id);
  if (!row) return res.status(404).json({ error: hit[1] + '记录不存在' });
  db.prepare('UPDATE ' + hit[0] + ' SET visit_id=? WHERE id=? AND patient_id=?').run(v.id, id, p.id);
  if (type === 'imaging' || type === 'pathology' || type === 'radiation' || type === 'outcome') {
    const rec = db.prepare('SELECT event_id FROM ' + hit[0] + ' WHERE id=?').get(id);
    if (rec && rec.event_id) db.prepare('UPDATE timeline_events SET visit_id=? WHERE id=? AND patient_id=?').run(v.id, rec.event_id, p.id);
  }
  logAudit(req.user.username, 'ATTACH_TO_VISIT', p.id + ' ' + hit[1] + '#' + id + ' → visit#' + v.id);
  res.json({ ok: true, visit: visitsWithChildren(p, [getVisitOf(p.id, v.id)])[0] });
});

app.get('/api/patients/:id/episodes', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  res.json(db.prepare('SELECT * FROM treatment_episodes WHERE patient_id=? ORDER BY start_date, id').all(p.id).map(episodeApi));
});

app.post('/api/patients/:id/episodes', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateEpisodeInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { a } = { a: assertAliveForRecord(p, v.value.startDate, '治疗段开始日期') };
  if (a) return res.status(400).json({ error: a });
  if (v.value.lineId != null && !db.prepare('SELECT id FROM treatment_lines WHERE id=? AND patient_id=?').get(v.value.lineId, p.id)) {
    return res.status(400).json({ error: '关联的治疗线不存在' });
  }
  const op = v.value.guidelineOptionId ? optionById(v.value.guidelineOptionId) : null;
  const tpl = templateByCode(v.value.templateCode);
  const d = v.value;
  const r = db.prepare(`INSERT INTO treatment_episodes
    (patient_id,episode_type,template_code,label,intent,line_id,guideline_scenario,guideline_option_id,
     recommendation_level,guideline_ref,start_date,end_date,status,stop_reason_code,followup_interval_days,source,notes,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, d.episodeType, d.templateCode, d.label || (op && op.label) || (tpl && tpl.label) || d.templateCode,
         d.intent, d.lineId, d.guidelineScenario || (op && op.scenario) || '',
         d.guidelineOptionId, d.recommendationLevel || (op && op.level) || '', d.guidelineRef || (op && op.source) || '',
         d.startDate, d.endDate, d.status, d.stopReasonCode,
         d.followupIntervalDays == null ? (tpl ? tpl.intervalMonths * 30 : null) : d.followupIntervalDays,
         'manual', d.notes, req.user.username, new Date().toISOString());
  logAudit(req.user.username, 'ADD_EPISODE', p.id + ' #' + r.lastInsertRowid + ' ' + d.templateCode);
  res.json({ ok: true, id: r.lastInsertRowid, episodes: db.prepare('SELECT * FROM treatment_episodes WHERE patient_id=? ORDER BY start_date,id').all(p.id).map(episodeApi) });
});

app.put('/api/patients/:id/episodes/:eid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = getEpisodeOf(p.id, req.params.eid);
  if (!old) return res.status(404).json({ error: '治疗段不存在' });
  const body = Object.assign({}, episodeApi(old), req.body || {});
  const v = validateEpisodeInput(body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.value;
  db.prepare(`UPDATE treatment_episodes SET episode_type=?,template_code=?,label=?,intent=?,line_id=?,guideline_scenario=?,
              guideline_option_id=?,recommendation_level=?,guideline_ref=?,start_date=?,end_date=?,status=?,stop_reason_code=?,
              followup_interval_days=?,notes=? WHERE id=? AND patient_id=?`)
    .run(d.episodeType, d.templateCode, d.label, d.intent, d.lineId, d.guidelineScenario, d.guidelineOptionId,
         d.recommendationLevel, d.guidelineRef, d.startDate, d.endDate, d.status, d.stopReasonCode,
         d.followupIntervalDays, d.notes, old.id, p.id);
  logAudit(req.user.username, 'UPDATE_EPISODE', p.id + ' #' + old.id);
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/episodes/:eid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = getEpisodeOf(p.id, req.params.eid);
  if (!old) return res.status(404).json({ error: '治疗段不存在' });
  db.prepare('DELETE FROM treatment_episodes WHERE id=? AND patient_id=?').run(old.id, p.id);
  logAudit(req.user.username, 'DELETE_EPISODE', p.id + ' #' + old.id);
  res.json({ ok: true });
});

/* ---- 就诊 ---- */
function visitsWithChildren(p, rows) {
  const ids = rows.map(v => v.id);
  if (!ids.length) return [];
  const qs = ids.map(() => '?').join(',');
  const allRows = db.prepare(`SELECT * FROM visit_episode_rows WHERE visit_id IN (${qs}) ORDER BY visit_no,id`).all(...ids);
  const allItems = db.prepare(`SELECT * FROM visit_items WHERE visit_id IN (${qs}) ORDER BY id`).all(...ids);
  const allAes = db.prepare(`SELECT * FROM adverse_events WHERE visit_id IN (${qs}) ORDER BY id`).all(...ids);
  return rows.map(v => {
    const o = visitApi(v);
    o.rows = allRows.filter(r => r.visit_id === v.id).map(r => Object.assign(rowApi(r), { visitDate: v.visit_date }));
    o.items = allItems.filter(i => i.visit_id === v.id).map(itemApi);
    o.adverseEvents = allAes.filter(a => a.visit_id === v.id).map(aeApi);
    return o;
  });
}

app.get('/api/patients/:id/visits', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const episodeId = req.query.episodeId ? Number(req.query.episodeId) : null;
  let where = 'patient_id=?', args = [p.id];
  if (episodeId) {
    where += ' AND id IN (SELECT visit_id FROM visit_episode_rows WHERE episode_id=?)';
    args.push(episodeId);
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM visits WHERE ' + where).get(...args).n;
  const rows = db.prepare(`SELECT * FROM visits WHERE ${where} ORDER BY visit_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, visits: visitsWithChildren(p, rows) });
});

app.get('/api/patients/:id/visits/:vid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = getVisitOf(p.id, req.params.vid);
  if (!v) return res.status(404).json({ error: '就诊不存在' });
  res.json(visitsWithChildren(p, [v])[0]);
});

app.post('/api/patients/:id/visits', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateVisitInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const alive = assertAliveForRecord(p, v.value.visitDate, '就诊日期');
  if (alive) return res.status(400).json({ error: alive });
  const b = req.body || {};
  const epInputs = Array.isArray(b.episodes) ? b.episodes : [];
  for (const ep of epInputs) {
    if (!getEpisodeOf(p.id, ep.episodeId)) return res.status(400).json({ error: '治疗段不存在或不属于该患者' });
  }
  try {
    const result = db.transaction(() => {
      const r = db.prepare(`INSERT INTO visits
        (patient_id,visit_date,visit_type,department,physician,chief_complaint,ecog,pain_nrs,summary,next_plan,next_visit_date,
         mdt_participants,mdt_conclusion,source,status,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(p.id, v.value.visitDate, v.value.visitType, v.value.department, v.value.physician,
             v.value.chiefComplaint, v.value.ecog, v.value.painNrs, v.value.summary, v.value.nextPlan,
             v.value.nextVisitDate, v.value.mdtParticipants, v.value.mdtConclusion, 'manual', v.value.status,
             req.user.username, new Date().toISOString(), new Date().toISOString());
      const visitId = r.lastInsertRowid;
      const rowIds = [];
      epInputs.forEach(ep => rowIds.push(saveVisitRow(p.id, visitId, ep, req.user.username)));
      /* 同一就诊内直接录 PSA/睾酮/化验：仍写既有记录表，时间轴镜像同步绑定 visit_id。 */
      (Array.isArray(b.psa) ? b.psa : []).forEach(x => {
        const date = normDate(x.date) || v.value.visitDate;
        const val = parsePsaValue(x.val != null ? x.val : x.value);
        if (!date || val === null) throw new Error('PSA 数值或日期不合法');
        const below = x.belowLod ? 1 : 0;
        const lod = below ? parsePsaValue(x.lod) : null;
        if (below && (lod === null || lod <= 0)) throw new Error('低于检测下限时必须填写大于0的下限值');
        const rec = db.prepare(`INSERT INTO psa_records(patient_id,rec_date,value,is_initial,created_by,is_below_lod,lod_value,visit_id)
                                VALUES(?,?,?,?,?,?,?,?)`)
          .run(p.id, date, val, 0, req.user.username, below, below ? lod : null, visitId);
        const eid = ensurePsaMirrorEvent(p.id, rec.lastInsertRowid, date, 0, req.user.username, '');
        db.prepare('UPDATE timeline_events SET visit_id=? WHERE id=?').run(visitId, eid);
      });
      (Array.isArray(b.testo) ? b.testo : []).forEach(x => {
        const date = normDate(x.date) || v.value.visitDate;
        const entered = parsePsaValue(x.val != null ? x.val : x.value);
        const unit = String(x.unit || 'ng/dl') === 'nmol/L' ? 'nmol/L' : 'ng/dl';
        if (!date || entered === null) throw new Error('睾酮数值或日期不合法');
        const val = unit === 'nmol/L' ? Math.round(entered * 28.84 * 100) / 100 : Math.round(entered * 100) / 100;
        const rec = db.prepare(`INSERT INTO testosterone_records
          (patient_id,rec_date,value,unit,entered_value,assay_method,lab,sample_time,created_by,is_initial,visit_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(p.id, date, val, unit, entered, x.assayMethod || '', x.lab || '', x.sampleTime || '', req.user.username, x.initial ? 1 : 0, visitId);
        const eid = ensureTestoMirrorEvent(p.id, rec.lastInsertRowid, date, val, req.user.username, '');
        db.prepare('UPDATE timeline_events SET visit_id=? WHERE id=?').run(visitId, eid);
      });
      (Array.isArray(b.labs) ? b.labs : []).forEach(x => {
        const lv = validateLabValueBody(Object.assign({}, x, { date: normDate(x.date) || v.value.visitDate }), p.birth_date);
        if (lv.error) throw new Error(lv.error);
        db.prepare(`INSERT INTO lab_values
          (patient_id,rec_date,item_code,item_label,value,unit,lab,method,ref_range,flag,note,source,created_by,created_at,visit_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(p.id, lv.value.date, lv.value.itemCode, lv.value.itemLabel, lv.value.value, lv.value.unit,
               lv.value.lab, lv.value.method, lv.value.refRange, lv.value.flag, lv.value.note,
               'manual', req.user.username, new Date().toISOString(), visitId);
      });
      const labDates = [...new Set((Array.isArray(b.labs) ? b.labs : []).map(x => normDate(x.date) || v.value.visitDate))];
      labDates.forEach(d => {
        rebuildLabEvent(p.id, d, req.user.username);
        db.prepare('UPDATE timeline_events SET visit_id=? WHERE patient_id=? AND event_date=? AND event_type=?')
          .run(visitId, p.id, d, LAB_EVENT_TYPE);
      });
      /* 本次影像：一次可录多条；写 imaging_studies + 事件投影并绑定就诊 */
      (Array.isArray(b.imaging) ? b.imaging : []).forEach(x => {
        createImagingForVisit(p, Object.assign({}, x, { visitId: undefined }), req.user.username, visitId,
          x.episodeId || (epInputs[0] && epInputs[0].episodeId) || null);
      });
      return { visitId, rowIds };
    })();
    logAudit(req.user.username, 'ADD_VISIT', p.id + ' #' + result.visitId + ' rows=' + result.rowIds.length);
    res.json({ ok: true, ...result, visit: visitsWithChildren(p, [getVisitOf(p.id, result.visitId)])[0] });
  } catch (e) {
    res.status(400).json({ error: e.message || '就诊保存失败' });
  }
});

app.put('/api/patients/:id/visits/:vid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = getVisitOf(p.id, req.params.vid);
  if (!old) return res.status(404).json({ error: '就诊不存在' });
  const v = validateVisitInput(Object.assign({}, visitApi(old), req.body || {}));
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.value;
  db.prepare(`UPDATE visits SET visit_date=?,visit_type=?,department=?,physician=?,chief_complaint=?,ecog=?,pain_nrs=?,
              summary=?,next_plan=?,next_visit_date=?,mdt_participants=?,mdt_conclusion=?,status=?,updated_at=?
              WHERE id=? AND patient_id=?`)
    .run(d.visitDate, d.visitType, d.department, d.physician, d.chiefComplaint, d.ecog, d.painNrs,
         d.summary, d.nextPlan, d.nextVisitDate, d.mdtParticipants, d.mdtConclusion, d.status,
         new Date().toISOString(), old.id, p.id);
  logAudit(req.user.username, 'UPDATE_VISIT', p.id + ' #' + old.id);
  res.json(visitsWithChildren(p, [getVisitOf(p.id, old.id)])[0]);
});

app.delete('/api/patients/:id/visits/:vid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = getVisitOf(p.id, req.params.vid);
  if (!old) return res.status(404).json({ error: '就诊不存在' });
  db.prepare('DELETE FROM visits WHERE id=? AND patient_id=?').run(old.id, p.id);
  logAudit(req.user.username, 'DELETE_VISIT', p.id + ' #' + old.id);
  res.json({ ok: true });
});

app.post('/api/patients/:id/visit-rows', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const b = req.body || {};
  const v = getVisitOf(p.id, b.visitId);
  if (!v) return res.status(404).json({ error: '就诊不存在' });
  try {
    const rowId = db.transaction(() => saveVisitRow(p.id, v.id, b, req.user.username))();
    logAudit(req.user.username, 'SAVE_VISIT_ROW', p.id + ' visit#' + v.id + ' row#' + rowId);
    res.json({ ok: true, rowId, visit: visitsWithChildren(p, [getVisitOf(p.id, v.id)])[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/patients/:id/visit-rows/:rid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM visit_episode_rows WHERE id=? AND episode_id IN (SELECT id FROM treatment_episodes WHERE patient_id=?)')
    .get(req.params.rid, p.id);
  if (!old) return res.status(404).json({ error: '就诊行不存在' });
  const b = Object.assign({}, rowApi(old), req.body || {}, { episodeId: old.episode_id, visitId: old.visit_id });
  try {
    const rowId = db.transaction(() => saveVisitRow(p.id, old.visit_id, b, req.user.username))();
    logAudit(req.user.username, 'UPDATE_VISIT_ROW', p.id + ' #' + old.id);
    res.json({ ok: true, rowId, visit: visitsWithChildren(p, [getVisitOf(p.id, old.visit_id)])[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/patients/:id/adverse-events', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const b = req.body || {};
  if (b.visitId && !getVisitOf(p.id, b.visitId)) return res.status(400).json({ error: '就诊不存在' });
  if (b.episodeId && !getEpisodeOf(p.id, b.episodeId)) return res.status(400).json({ error: '治疗段不存在' });
  try {
    const id = db.transaction(() => insertAdverseEvent(p.id, b.visitId, b.episodeRowId, b.episodeId, b.chemoCycleId, b, req.user.username))();
    logAudit(req.user.username, 'ADD_AE', p.id + ' #' + id + ' ' + b.termCode);
    res.json({ ok: true, id, adverseEvents: db.prepare('SELECT * FROM adverse_events WHERE patient_id=? ORDER BY id').all(p.id).map(aeApi) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/patients/:id/adverse-events/:aid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM adverse_events WHERE id=? AND patient_id=?').get(req.params.aid, p.id);
  if (!old) return res.status(404).json({ error: '不良事件不存在' });
  const b = Object.assign({}, aeApi(old), req.body || {});
  try {
    insertAdverseEvent(p.id, old.visit_id, old.episode_row_id, old.episode_id, old.chemo_cycle_id, b, req.user.username);
    logAudit(req.user.username, 'UPDATE_AE', p.id + ' #' + old.id);
    res.json({ ok: true, adverseEvents: db.prepare('SELECT * FROM adverse_events WHERE patient_id=? ORDER BY id').all(p.id).map(aeApi) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/patients/:id/adverse-events/:aid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const old = db.prepare('SELECT * FROM adverse_events WHERE id=? AND patient_id=?').get(req.params.aid, p.id);
  if (!old) return res.status(404).json({ error: '不良事件不存在' });
  db.prepare('DELETE FROM adverse_events WHERE id=?').run(old.id);
  logAudit(req.user.username, 'DELETE_AE', p.id + ' #' + old.id);
  res.json({ ok: true });
});

app.put('/api/patients/:id/visit-items/:iid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const item = db.prepare(`SELECT i.* FROM visit_items i JOIN visits v ON v.id=i.visit_id
                           WHERE i.id=? AND v.patient_id=?`).get(req.params.iid, p.id);
  if (!item) return res.status(404).json({ error: '就诊项目不存在' });
  const status = String((req.body || {}).status || 'pending');
  if (!['pending', 'done', 'not_done', 'deferred', 'not_applicable'].includes(status)) return res.status(400).json({ error: '项目状态不合法' });
  db.prepare('UPDATE visit_items SET status=?, reason=? WHERE id=?').run(status, String((req.body || {}).reason || '').slice(0, 500), item.id);
  res.json({ ok: true });
});

/* ---- 手术实施 / 化疗周期 / 给药日志 ---- */
app.post('/api/patients/:id/surgery', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const b = req.body || {};
  const ep = getEpisodeOf(p.id, b.episodeId);
  if (!ep) return res.status(400).json({ error: '治疗段不存在' });
  const v = validateSurgeryInput(b);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.value;
  const existing = db.prepare('SELECT id FROM surgery_records WHERE episode_id=?').get(ep.id);
  if (existing) {
    db.prepare(`UPDATE surgery_records SET surgery_date=?,surgeon=?,procedure=?,approach=?,nerve_sparing=?,ln_dissection=?,
      ln_examined_left=?,ln_positive_left=?,ln_examined_right=?,ln_positive_right=?,catheter_days=?,drain_days=?,
      complications_json=?,complication_management=?,conversion=?,blood_loss_ml=?,hospital_days=?,notes=? WHERE id=?`)
      .run(d.surgeryDate, d.surgeon, d.procedure, d.approach, d.nerveSparing, d.lnDissection,
           d.lnExaminedLeft, d.lnPositiveLeft, d.lnExaminedRight, d.lnPositiveRight, d.catheterDays,
           d.drainDays, JSON.stringify(d.complications), d.complicationManagement, d.conversion,
           d.bloodLossMl, d.hospitalDays, d.notes, existing.id);
  } else {
    db.prepare(`INSERT INTO surgery_records
      (patient_id,episode_id,surgery_date,surgeon,procedure,approach,nerve_sparing,ln_dissection,
       ln_examined_left,ln_positive_left,ln_examined_right,ln_positive_right,catheter_days,drain_days,
       complications_json,complication_management,conversion,blood_loss_ml,hospital_days,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, ep.id, d.surgeryDate, d.surgeon, d.procedure, d.approach, d.nerveSparing, d.lnDissection,
           d.lnExaminedLeft, d.lnPositiveLeft, d.lnExaminedRight, d.lnPositiveRight, d.catheterDays,
           d.drainDays, JSON.stringify(d.complications), d.complicationManagement, d.conversion,
           d.bloodLossMl, d.hospitalDays, d.notes, req.user.username, new Date().toISOString());
  }
  logAudit(req.user.username, 'SAVE_SURGERY', p.id + ' episode#' + ep.id);
  res.json({ ok: true, surgeryRecords: db.prepare('SELECT * FROM surgery_records WHERE patient_id=? ORDER BY surgery_date').all(p.id).map(surgeryApi) });
});

app.post('/api/patients/:id/episodes/:eid/chemo-cycles', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const ep = getEpisodeOf(p.id, req.params.eid);
  if (!ep) return res.status(404).json({ error: '治疗段不存在' });
  const v = validateChemoCycleInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.value;
  try {
    const r = db.prepare(`INSERT INTO chemo_cycles
      (patient_id,episode_id,line_id,cycle_no,cycle_date,regimen,agents_json,bsa,planned_dose,actual_dose,
       dose_reduction_pct,delay_days,delay_reason,gcsf,ecog,next_cycle_date,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, ep.id, ep.line_id, d.cycleNo, d.cycleDate, d.regimen, JSON.stringify(d.agents || []),
           d.bsa, d.plannedDose, d.actualDose, d.doseReductionPct, d.delayDays, d.delayReason,
           d.gcsf, d.ecog, d.nextCycleDate, d.notes, req.user.username, new Date().toISOString());
    const cycleId = r.lastInsertRowid;
    (Array.isArray(req.body.adverseEvents) ? req.body.adverseEvents : []).forEach(ae =>
      insertAdverseEvent(p.id, null, null, ep.id, cycleId, ae, req.user.username));
    logAudit(req.user.username, 'ADD_CHEMO_CYCLE', p.id + ' ep#' + ep.id + ' C' + d.cycleNo);
    res.json({ ok: true, id: cycleId, cycles: db.prepare('SELECT * FROM chemo_cycles WHERE patient_id=? ORDER BY cycle_date,cycle_no').all(p.id).map(chemoApi) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/patients/:id/medication-administrations', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const b = req.body || {};
  const date = normDate(b.adminDate);
  if (!date) return res.status(400).json({ error: '给药日期格式不正确' });
  if (date > todayIso()) return res.status(400).json({ error: '给药日期不能晚于今天' });
  const drug = String(b.drug || '').trim();
  if (!drug) return res.status(400).json({ error: '请填写药物' });
  const medId = b.medicationId == null ? null : Number(b.medicationId);
  if (medId && !db.prepare('SELECT id FROM medication_records WHERE id=? AND patient_id=?').get(medId, p.id)) {
    return res.status(400).json({ error: '关联用药记录不存在' });
  }
  const ep = b.episodeId ? getEpisodeOf(p.id, b.episodeId) : null;
  const r = db.prepare(`INSERT INTO medication_administrations
    (patient_id,medication_id,episode_id,admin_date,drug,dose,route,site,lot,next_due_date,notes,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, medId, ep ? ep.id : null, date, drug, String(b.dose || ''), String(b.route || ''),
         String(b.site || ''), String(b.lot || ''), normDate(b.nextDueDate), String(b.notes || ''),
         req.user.username, new Date().toISOString());
  logAudit(req.user.username, 'ADD_MED_ADMIN', p.id + ' ' + date + ' ' + drug);
  res.json({ ok: true, id: r.lastInsertRowid, administrations: db.prepare('SELECT * FROM medication_administrations WHERE patient_id=? ORDER BY admin_date,id').all(p.id).map(adminApi) });
});

/* ---- 合并症 / 疾病状态 ---- */
app.post('/api/patients/:id/comorbidities', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateComorbidityInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.value;
  const existing = db.prepare('SELECT id FROM comorbidities WHERE patient_id=? AND disease_code=?').get(p.id, d.diseaseCode);
  if (existing) {
    db.prepare(`UPDATE comorbidities SET system=?,disease_label=?,status=?,severity=?,diagnosed_date=?,notes=?,source='manual' WHERE id=?`)
      .run(d.system, d.diseaseLabel, d.status, d.severity, d.diagnosedDate, d.notes, existing.id);
  } else {
    db.prepare(`INSERT INTO comorbidities(patient_id,system,disease_code,disease_label,status,severity,diagnosed_date,notes,source,created_by,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, d.system, d.diseaseCode, d.diseaseLabel, d.status, d.severity, d.diagnosedDate, d.notes, 'manual', req.user.username, new Date().toISOString());
  }
  logAudit(req.user.username, 'SAVE_COMORBIDITY', p.id + ' ' + d.diseaseCode);
  res.json({ ok: true, comorbidities: db.prepare('SELECT * FROM comorbidities WHERE patient_id=? ORDER BY system,disease_code').all(p.id).map(comorbidityApi) });
});

app.post('/api/patients/:id/disease-states', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateDiseaseStateInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.value;
  const makeCurrent = req.body && req.body.isCurrent !== false;
  db.transaction(() => {
    if (makeCurrent) {
      db.prepare("UPDATE disease_states SET is_current=0,superseded_at=? WHERE patient_id=? AND is_current=1")
        .run(new Date().toISOString(), p.id);
    }
    db.prepare(`INSERT INTO disease_states(patient_id,state_code,state_label,since_date,basis,evidence_json,status,confirmed_by,confirmed_at,is_current)
                VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, d.stateCode, d.stateLabel, d.sinceDate, d.basis, d.evidenceJson, d.status,
           req.user.username, new Date().toISOString(), makeCurrent ? 1 : 0);
  })();
  logAudit(req.user.username, 'ADD_DISEASE_STATE', p.id + ' ' + d.stateCode);
  res.json({ ok: true, diseaseStates: db.prepare('SELECT * FROM disease_states WHERE patient_id=? ORDER BY since_date,id').all(p.id).map(stateApi) });
});

app.get('/api/patients/:id/workspace', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  res.json(buildWorkspace(p));
});


const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 10) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },   // 单张 ≤15MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('只能上传图片文件'));
    cb(null, true);
  }
});

app.post('/api/patients/:id/reports', auth(), upload.array('reports', 10), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const today = new Date().toISOString().slice(0, 10);
  const stmt = db.prepare(`INSERT INTO reports(patient_id,filename,stored_name,upload_date,uploaded_by)
                           VALUES(?,?,?,?,?)`);
  db.transaction(() => {
    (req.files || []).forEach(f => {
      const info = stmt.run(p.id, f.originalname, f.filename, today, req.user.username);
      registerFileAsset({ patientId: p.id, source: 'report', sourceId: info.lastInsertRowid,
        storedName: f.filename, filename: f.originalname, mime: f.mimetype || '', bytes: f.size || 0,
        createdBy: req.user.username });
    });
  })();
  logAudit(req.user.username, 'UPLOAD_REPORT', p.id + ' ×' + (req.files || []).length);
  res.json(buildPatient(getP(p.id)));
});

/* 图片读取走鉴权接口，防止公开URL泄露病历。
   还必须校验报告所属患者的归属，否则任意登录用户猜到 rid 即可读取他人病历图片。 */
app.get('/api/reports/:rid/file', auth(), (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.rid);
  if (!r) return res.status(404).send('Not found');
  if (!requireOwn(req, res, getP(r.patient_id))) return;
  const fp = path.join(uploadDir, r.stored_name);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.sendFile(fp);
});

app.delete('/api/reports/:rid', auth(), (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.rid);
  if (!r) return res.status(404).json({ error: '报告不存在' });
  if (!requireOwn(req, res, getP(r.patient_id))) return;
  db.prepare('DELETE FROM reports WHERE id=?').run(r.id);
  removeFileAsset('report', r.id);
  try { fs.unlinkSync(path.join(uploadDir, r.stored_name)); } catch (e) {}
  logAudit(req.user.username, 'DELETE_REPORT', '#' + r.id + ' (' + r.patient_id + ')');
  res.json({ ok: true });
});

/* P2-15：统一文件列表与鉴权下载；原接口保留兼容。 */
app.get('/api/patients/:id/files', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const rows = db.prepare(`SELECT id, source, source_id, stored_name, filename, mime, bytes, sha256, created_by, created_at
                           FROM file_assets WHERE patient_id=? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`).all(p.id);
  res.json(rows.map(r => ({
    id: r.id, source: r.source, sourceId: r.source_id, filename: r.filename || '',
    mime: r.mime || '', bytes: r.bytes || 0, sha256: r.sha256 || '',
    createdBy: r.created_by || '', createdAt: r.created_at || '',
    url: '/api/files/' + r.id
  })));
});

app.get('/api/files/:aid', auth(), (req, res) => {
  const a = db.prepare('SELECT * FROM file_assets WHERE id=? AND deleted_at IS NULL').get(req.params.aid);
  if (!a) return res.status(404).send('Not found');
  if (!a.patient_id) return res.status(403).send('Forbidden');
  if (!requireOwn(req, res, getP(a.patient_id))) return;
  const fp = path.join(uploadDir, a.stored_name);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.sendFile(fp);
});

/* ================= 诊疗时间轴事件 =================
   事件是患者病程的一手记录，手术日期由其中的手术事件反推（syncSurgDate），
   因此每次增删改都必须在同一事务内重算 surg_date，否则两者会脱节。 */

/* 取出事件对应的患者行；事件不存在或不属于该患者时返回 null。
   带 patientId 是为了防止跨患者改事件：/events/:eid 里的 eid 若不做归属比对，
   拿到别人患者的事件 id 就能改到另一个患者的病程上。 */
function getEventOwned(eid, patientId) {
  const e = db.prepare('SELECT * FROM timeline_events WHERE id=?').get(eid);
  if (!e || String(e.patient_id) !== String(patientId)) return null;
  return e;
}

/* 清理 multer 已落盘但请求被拒的文件。
   upload.array 在 requireOwn 之前执行，鉴权失败时文件已经写到 uploads/，
   不删就是一批永远无人引用的孤儿图片。 */
function discardUploadedFiles(files) {
  (files || []).forEach(f => { try { fs.unlinkSync(path.join(uploadDir, f.filename)); } catch (e) {} });
}

/* ---------- 结构化记录通用写入 ---------- */
function dbInsertRow(table, obj) {
  const keys = Object.keys(obj);
  const sql = 'INSERT INTO ' + table + ' (' + keys.join(',') + ') VALUES (' +
    keys.map(() => '?').join(',') + ')';
  return db.prepare(sql).run(keys.map(k => obj[k])).lastInsertRowid;
}
function dbUpdateRow(table, obj, id) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  const sql = 'UPDATE ' + table + ' SET ' + keys.map(k => k + '=?').join(',') + ' WHERE id=?';
  db.prepare(sql).run(keys.map(k => obj[k]).concat([id]));
}
function gleasonText(p, s) {
  if (p == null || s == null) return '';
  return p + '+' + s + '=' + (p + s);
}

function structuredDefaults(kind, type, date) {
  const base = Object.assign({}, STRUCTURED_DEFAULT_FIELDS[kind] || {});
  if (kind === 'pathology') {
    if (type === '手术病理报告') base.specimenType = 'RP';
    else if (type === '前列腺电切病理报告') base.specimenType = 'TURP';
    else if (type === '病理亚型复核(DAC/IDC-P/NEPC)') base.specimenType = 'review';
    else if (type === '前列腺穿刺活检病理报告' || type === '前列腺穿刺活检' || type === '穿刺病理报告') base.specimenType = 'biopsy';
    base.reportDate = date;
  } else if (kind === 'imaging') {
    if (type === '多参数磁共振(mpMRI)') base.modality = 'mpMRI';
    else if (type === 'PSMA PET-CT') base.modality = 'PSMA_PET';
    else if (type === 'PSMA PET-MRI') base.modality = 'PSMA_PET_MRI';
    else if (type === '骨扫描(ECT)') base.modality = 'bone_scan';
    else if (type === '胸部CT' || type === '腹盆腔CT') base.modality = 'CT';
    else if (type === '腹盆腔MRI') base.modality = 'MRI';
    else if (type === '胆碱PET-CT') base.modality = 'choline_pet';
    base.studyDate = date;
  } else if (kind === 'radiation') {
    if (type === '近距离放疗/粒子植入') base.rtType = 'brachy';
    base.startDate = date;
  } else if (kind === 'outcome') {
    if (type === '生化复发确认') base.outcomeType = 'BCR';
    else if (type === '去势抵抗确认') base.outcomeType = 'CRPC';
    else if (type === '转移确认') base.outcomeType = 'metastasis';
    else if (type === '终止随访/死亡') base.outcomeType = 'death';
    else if (type === '失访确认') base.outcomeType = 'lost';
    base.eventDate = date;
  }
  return base;
}

function validateStructuredForEvent(kind, type, raw, birth, date) {
  const expected = structuredKindOfEvent(type);
  if (!expected) return { error: '该事件类型不支持结构化字段' };
  if (kind !== expected) return { error: '结构化类型与事件类型不匹配' };
  const data = Object.assign({}, structuredDefaults(kind, type, date), raw || {});
  if (kind === 'outcome') {
    /* P1-04：结局类型由事件类型唯一决定，前端锁定 + 服务端强制，
       不允许“生化复发确认”带 death 结局，反之亦然。 */
    const expectedOutcome = OUTCOME_BY_EVENT[type];
    if (!expectedOutcome) return { error: '该事件类型没有对应的结局类型' };
    if (raw && raw.outcomeType && raw.outcomeType !== expectedOutcome) {
      return { error: '结局类型必须与事件类型一致：' + type + ' → ' + expectedOutcome };
    }
    data.outcomeType = expectedOutcome;
  }
  if (kind === 'pathology') return validatePathologyBody(data, birth);
  if (kind === 'imaging') return validateImagingBody(data, birth);
  if (kind === 'radiation') return validateRadiationBody(data, birth);
  if (kind === 'outcome') return validateOutcomeBody(data, birth);
  return { error: '未知的结构化类型' };
}

/* ---- 病理主档来源 ----
   P0-01：临床 Gleason 只取医生明确勾选 primary 的活检；pTNM 只取 primary RP/TURP。
   非主要病理只进病理列表，不参与主档同步。删除/取消 primary 时先回退手工留底值。 */
function pickBiopsyReport(pid) {
  /* P0-01：只有明确勾选 primary 的活检才能改主档 Gleason。
     非主要报告只进病理列表，不再参与主档同步或临床风险。 */
  return db.prepare(`SELECT * FROM pathology_reports
                      WHERE patient_id=? AND specimen_type='biopsy' AND is_primary=1
                        AND gleason_primary IS NOT NULL AND gleason_secondary IS NOT NULL
                      ORDER BY report_date DESC, id DESC LIMIT 1`).get(pid) || null;
}
function pickPrimaryPostopReport(pid) {
  return db.prepare(`SELECT * FROM pathology_reports
                      WHERE patient_id=? AND is_primary=1 AND specimen_type IN ('RP','TURP')
                      ORDER BY report_date DESC, id DESC LIMIT 1`).get(pid) || null;
}
function resyncPathologyDerived(pid, actor) {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(pid);
  if (!p) return { changed: 0 };
  const biopsy = pickBiopsyReport(pid);
  const rp = pickPrimaryPostopReport(pid);
  const sets = [], vals = [], changes = [];
  const curGleasonSource = p.gleason_source || '';

  if (biopsy) {
    const gleason = gleasonText(biopsy.gleason_primary, biopsy.gleason_secondary);
    const src = 'pathology:' + biopsy.id;
    /* 首次用 primary 病理覆盖前，把手里的手工值留底；已有留底则不覆盖。 */
    if (!curGleasonSource.startsWith('pathology:') && p.gleason && !p.gleason_manual) {
      sets.push('gleason_manual=?'); vals.push(p.gleason);
    }
    if ((p.gleason || '') !== gleason) {
      sets.push('gleason=?'); vals.push(gleason);
      changes.push('Gleason ' + (p.gleason || '空') + '→' + gleason);
    }
    if (curGleasonSource !== src) { sets.push('gleason_source=?'); vals.push(src); }
  } else if (curGleasonSource.startsWith('pathology:')) {
    const manual = p.gleason_manual || '';
    if (manual) {
      sets.push('gleason=?'); vals.push(manual);
      sets.push('gleason_source=?'); vals.push('manual');
      changes.push('Gleason ' + (p.gleason || '空') + '→' + manual + '（primary 病理已删除/取消，恢复手工值）');
    } else {
      if (p.gleason) { sets.push('gleason=?'); vals.push(''); changes.push('Gleason ' + p.gleason + '→空（无 primary 活检来源）'); }
      sets.push('gleason_source=?'); vals.push('');
    }
  }

  const ptnm = rp ? String(rp.ptnm || '') : '';
  const ptnmSource = rp && ptnm ? ('pathology:' + rp.id) : '';
  const curPtnmSource = p.pathologic_stage_source || '';
  if (rp && ptnm) {
    if (!curPtnmSource.startsWith('pathology:') && p.pathologic_stage && !p.pathologic_stage_manual) {
      sets.push('pathologic_stage_manual=?'); vals.push(p.pathologic_stage);
    }
    if ((p.pathologic_stage || '') !== ptnm) {
      sets.push('pathologic_stage=?'); vals.push(ptnm);
      changes.push('pTNM ' + (p.pathologic_stage || '空') + '→' + ptnm);
    }
    if (curPtnmSource !== ptnmSource) { sets.push('pathologic_stage_source=?'); vals.push(ptnmSource); }
  } else if (curPtnmSource.startsWith('pathology:')) {
    const manual = p.pathologic_stage_manual || '';
    if (manual) {
      sets.push('pathologic_stage=?'); vals.push(manual);
      sets.push('pathologic_stage_source=?'); vals.push('manual');
      changes.push('pTNM ' + (p.pathologic_stage || '空') + '→' + manual + '（primary RP/TURP 已删除/取消，恢复手工值）');
    } else {
      if (p.pathologic_stage) { sets.push('pathologic_stage=?'); vals.push(''); changes.push('pTNM ' + p.pathologic_stage + '→空（无 primary RP/TURP 来源）'); }
      sets.push('pathologic_stage_source=?'); vals.push('');
    }
  }

  if (sets.length) {
    vals.push(pid);
    db.prepare('UPDATE patients SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
    logAudit(actor || 'system', 'SYNC_PATHOLOGY_MAIN', pid + '：' + changes.join('；'));
  }
  return { changed: changes.length };
}

/* 启动迁移：只修复“主档 Gleason 等于 RP/TURP、且存在不同活检值”的明确污染；
   同步 source；不删除任何病理记录，不碰无法判断的数据。幂等。 */
function inferPathologySources() {
  let n = 0;
  const rows = db.prepare('SELECT * FROM patients').all();
  rows.forEach(p => {
    /* 旧库只有一个全局 primary（多数是 RP），活检因此被降成非主要。
       若患者只有一份带 Gleason 的活检、且没有任何 primary 活检，
       一次性把它标为 primary（不改数值），让临床风险重新有活检来源。
       多份活检则保持原样，必须由医生明确选择。 */
    const loneBiopsies = db.prepare(`SELECT id FROM pathology_reports
      WHERE patient_id=? AND specimen_type='biopsy'
        AND gleason_primary IS NOT NULL AND gleason_secondary IS NOT NULL`).all(p.id);
    if (loneBiopsies.length === 1 && !pickBiopsyReport(p.id)) {
      db.prepare('UPDATE pathology_reports SET is_primary=1 WHERE id=?').run(loneBiopsies[0].id);
      n++;
    }
    const biopsy = pickBiopsyReport(p.id);
    const postops = db.prepare(`SELECT * FROM pathology_reports
                                 WHERE patient_id=? AND specimen_type IN ('RP','TURP')
                                   AND gleason_primary IS NOT NULL AND gleason_secondary IS NOT NULL`)
      .all(p.id);
    const sets = [], vals = [];
    if (biopsy) {
      const bg = gleasonText(biopsy.gleason_primary, biopsy.gleason_secondary);
      const rpG = postops.map(x => gleasonText(x.gleason_primary, x.gleason_secondary));
      const cur = p.gleason || '';
      /* 迁移也要留手工底值，否则以后取消 primary 时原值无法回退。 */
      if (cur && !p.gleason_manual && !String(p.gleason_source || '').startsWith('pathology:')) {
        sets.push('gleason_manual=?'); vals.push(cur);
      }
      if (cur && cur !== bg && rpG.includes(cur)) {
        sets.push('gleason=?'); vals.push(bg);
        sets.push('gleason_source=?'); vals.push('pathology:' + biopsy.id);
        n++;
      } else if (cur && cur === bg && p.gleason_source !== ('pathology:' + biopsy.id)) {
        sets.push('gleason_source=?'); vals.push('pathology:' + biopsy.id);
      }
    }
    const rp = pickPrimaryPostopReport(p.id);
    if (rp && rp.ptnm && p.pathologic_stage === rp.ptnm && p.pathologic_stage_source !== ('pathology:' + rp.id)) {
      sets.push('pathologic_stage_source=?'); vals.push('pathology:' + rp.id);
    }
    if (sets.length) {
      vals.push(p.id);
      db.prepare('UPDATE patients SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
    }
  });
  return n;
}

function savePathologyForEvent(pid, eid, v, user) {
  const existing = db.prepare('SELECT id FROM pathology_reports WHERE event_id=?').get(eid);
  const row = {
    patient_id: pid, event_id: eid, specimen_type: v.specimenType, report_date: v.reportDate,
    cores_total: v.coresTotal, cores_positive: v.coresPositive, cores_positive_pct: v.coresPositivePct,
    gleason_primary: v.gleasonPrimary, gleason_secondary: v.gleasonSecondary,
    gleason_total: v.gleasonTotal, isup: v.isup, ptnm: v.ptnm,
    margin_status: v.marginStatus, margin_site: v.marginSite,
    ece: v.ece, svi: v.svi, ln_positive: v.lnPositive, ln_examined: v.lnExamined,
    idc_p: v.idcP, cribriform: v.cribriform, dac: v.dac, nepc: v.nepc,
    nepc_detail: v.nepcDetail, pni: v.pni,
    tumor_volume_pct: v.tumorVolumePct, tumor_cell_pct: v.tumorCellPct,
    cores_max_cancer_pct: v.coresMaxCancerPct, histology_type: v.histologyType || '',
    specimen_site: v.specimenSite || '', biopsy_route: v.biopsyRoute || '',
    biopsy_guidance: v.biopsyGuidance || '',
    is_primary: v.isPrimary, notes: v.notes
  };
  if (v.isPrimary) {
    /* 只清同一类标本的旧 primary：活检与 RP/TURP 各自保留一份主要，
       否则标记手术病理主要会把活检主要（临床 Gleason 来源）挤掉。 */
    const scope = v.specimenType === 'biopsy' ? "specimen_type='biopsy'"
      : (v.specimenType === 'RP' || v.specimenType === 'TURP') ? "specimen_type IN ('RP','TURP')"
      : 'specimen_type=?';
    const args = scope.includes('?') ? [pid, v.specimenType] : [pid];
    db.prepare('UPDATE pathology_reports SET is_primary=0 WHERE patient_id=? AND ' + scope).run(...args);
  }
  let id;
  if (existing) { dbUpdateRow('pathology_reports', row, existing.id); id = existing.id; }
  else id = dbInsertRow('pathology_reports', Object.assign(row, { created_by: user, created_at: new Date().toISOString() }));
  resyncPathologyDerived(pid, user);
  return id;
}

function saveImagingForEvent(pid, eid, v, user) {
  const existing = db.prepare('SELECT id FROM imaging_studies WHERE event_id=?').get(eid);
  const row = {
    patient_id: pid, event_id: eid, modality: v.modality, study_date: v.studyDate,
    region: v.region, lesion_count: v.lesionCount, metastatic_sites: v.metastaticSites,
    extra_pelvic: v.extraPelvic, new_lesion: v.newLesion, pirads: v.pirads,
    psma_positive: v.psmaPositive, psma_suvmax: v.psmaSuvmax, psma_lesion_count: v.psmaLesionCount,
    recist: v.recist, pcwg: v.pcwg, flare: v.flare, oligo_status: v.oligoStatus,
    technique: v.technique || '', index_location: v.indexLocation || '', index_size_mm: v.indexSizeMm,
    ece: v.ece, svi: v.svi, prostate_volume_ml: v.prostateVolumeMl,
    dim_transverse_cm: v.dimTransverseCm, dim_ap_cm: v.dimApCm, dim_cranial_cm: v.dimCranialCm,
    ln_short_axis_mm: v.lnShortAxisMm,
    superscan: v.superscan, lung_nodule_count: v.lungNoduleCount, lung_nodule_max_mm: v.lungNoduleMaxMm,
    mi_tnm: v.miTnm || '', psma_rads: v.psmaRads || '', changed_management: v.changedManagement,
    comparison: v.comparison || '',
    is_current: v.isCurrent, notes: v.notes
  };
  if (v.isCurrent) db.prepare('UPDATE imaging_studies SET is_current=0 WHERE patient_id=?').run(pid);
  let id;
  if (existing) { dbUpdateRow('imaging_studies', row, existing.id); id = existing.id; }
  else id = dbInsertRow('imaging_studies', Object.assign(row, { created_by: user, created_at: new Date().toISOString() }));
  if (v.isCurrent) {
    /* P1-03：只同步医生这次明确填写的字段；空值不再把档案里的
       metCount/extraPelvic 清空，也不再把 visceral 1 静默改成 0。
       转移部位为空表示“本次影像未评估部位”，保留档案原三态。 */
    const sets = [], vals = [];
    if (v.lesionCount != null) { sets.push('met_count=?'); vals.push(v.lesionCount); }
    if (v.extraPelvic != null) { sets.push('met_extra_pelvis=?'); vals.push(v.extraPelvic); }
    /* 只有影像明确列出“内脏转移”时才写 visceral_met=1；
       骨/淋巴结影像不能反证“无内脏转移”，因此不在 absence 时写 0，
       避免把未评估伪造成明确阴性（P0-1 同类问题）。 */
    if (listArr(v.metastaticSites).includes('visceral')) {
      sets.push('visceral_met=?'); vals.push(1);
    }
    if (v.oligoStatus) { sets.push('oligo_type=?'); vals.push(v.oligoStatus); }
    if (sets.length) {
      vals.push(pid);
      db.prepare('UPDATE patients SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
    }
  }
  return id;
}

function saveRadiationForEvent(pid, eid, v, user) {
  const existing = db.prepare('SELECT id FROM radiation_records WHERE event_id=?').get(eid);
  const row = {
    patient_id: pid, event_id: eid, rt_type: v.rtType, start_date: v.startDate, end_date: v.endDate,
    dose_gy: v.doseGy, fractions: v.fractions, target: v.target,
    concurrent_adt: v.concurrentAdt, adt_duration_months: v.adtDurationMonths,
    technique: v.technique, toxicity_grade: v.toxicityGrade,
    is_current: v.isCurrent, notes: v.notes
  };
  if (v.isCurrent) db.prepare('UPDATE radiation_records SET is_current=0 WHERE patient_id=?').run(pid);
  let id;
  if (existing) { dbUpdateRow('radiation_records', row, existing.id); id = existing.id; }
  else id = dbInsertRow('radiation_records', Object.assign(row, { created_by: user, created_at: new Date().toISOString() }));
  if (v.isCurrent && v.endDate) db.prepare('UPDATE patients SET rt_end_date=? WHERE id=?').run(v.endDate, pid);
  return id;
}

function saveOutcomeForEvent(pid, eid, v, user) {
  let existing = db.prepare('SELECT * FROM patient_outcomes WHERE event_id=?').get(eid);
  if (!existing && v.outcomeType !== 'metastasis') {
    existing = db.prepare('SELECT * FROM patient_outcomes WHERE patient_id=? AND outcome_type=? ORDER BY id LIMIT 1')
      .get(pid, v.outcomeType);
  }
  if (existing && existing.outcome_type !== v.outcomeType) {
    return { error: '结局类型不可修改；请删除原结局后重新录入' };
  }
  if (v.outcomeType === 'death') {
    const lost = db.prepare("SELECT id FROM patient_outcomes WHERE patient_id=? AND outcome_type='lost' LIMIT 1").get(pid);
    if (lost) return { error: '该患者已有失访结局，不能再录死亡结局；请先删除失访结局' };
    const after = recordsAfterDate(pid, v.eventDate, eid);
    if (after.length) {
      return { error: '死亡日期 ' + v.eventDate + ' 早于已有记录：' + after.slice(0, 5).join('、') +
        '；请先核对/删除这些记录，或更正死亡日期' };
    }
  }
  if (v.outcomeType === 'lost') {
    const death = db.prepare("SELECT id FROM patient_outcomes WHERE patient_id=? AND outcome_type='death' LIMIT 1").get(pid);
    if (death) return { error: '该患者已有死亡结局，不能再录失访结局' };
  }
  const row = {
    patient_id: pid, event_id: eid, outcome_type: v.outcomeType, event_date: v.eventDate,
    subtype: v.subtype, basis: v.basis, psa_value: v.psaValue,
    imaging_negative: v.imagingNegative, metastatic_sites: v.metastaticSites,
    lesion_count: v.lesionCount, oligo_status: v.oligoStatus,
    death_cause: v.deathCause, lost_reason: v.lostReason,
    last_contact_date: v.lastContactDate, note: v.note
  };
  let id;
  if (existing) { dbUpdateRow('patient_outcomes', row, existing.id); id = existing.id; }
  else id = dbInsertRow('patient_outcomes', Object.assign(row, { created_by: user, created_at: new Date().toISOString() }));
  if (v.outcomeType === 'death') {
    db.prepare("UPDATE patients SET followup_status='死亡',last_followup_date=? WHERE id=?").run(v.eventDate, pid);
  } else if (v.outcomeType === 'lost') {
    db.prepare("UPDATE patients SET followup_status='失访',last_followup_date=? WHERE id=?")
      .run(v.lastContactDate || v.eventDate, pid);
  }
  return { id };
}

function existingStructuredKind(eid) {
  if (db.prepare('SELECT id FROM pathology_reports WHERE event_id=?').get(eid)) return 'pathology';
  if (db.prepare('SELECT id FROM imaging_studies WHERE event_id=?').get(eid)) return 'imaging';
  if (db.prepare('SELECT id FROM radiation_records WHERE event_id=?').get(eid)) return 'radiation';
  if (db.prepare('SELECT id FROM patient_outcomes WHERE event_id=?').get(eid)) return 'outcome';
  return null;
}

function deleteOutcomeAndReset(id, pid, user) {
  const o = db.prepare('SELECT * FROM patient_outcomes WHERE id=? AND patient_id=?').get(id, pid);
  if (!o) return false;
  const imgs = o.event_id
    ? db.prepare('SELECT stored_name FROM timeline_images WHERE event_id=?').all(o.event_id)
    : [];
  db.transaction(() => {
    db.prepare('DELETE FROM patient_outcomes WHERE id=?').run(id);
    if (o.event_id) {
      removeFileAssetsForEvent(o.event_id);
      db.prepare('DELETE FROM timeline_events WHERE id=?').run(o.event_id);
    }
  })();
  imgs.forEach(f => { try { fs.unlinkSync(path.join(uploadDir, f.stored_name)); } catch (e) {} });
  if (o.outcome_type === 'death' || o.outcome_type === 'lost') {
    const other = db.prepare("SELECT id FROM patient_outcomes WHERE patient_id=? AND outcome_type IN ('death','lost') AND id<>?").get(pid, id);
    if (!other) db.prepare("UPDATE patients SET followup_status='在访' WHERE id=?").run(pid);
  }
  logAudit(user, 'DELETE_OUTCOME', pid + ' #' + id + ' ' + o.outcome_type);
  return true;
}

app.post('/api/patients/:id/events', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const v = validateEventBody(req.body || {}, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });

  /* 本次就诊里补录的检查/诊断/治疗/随访：允许直接挂到 visit 上，
     这样时间轴、就诊详情和结构化表三处不会各丢一半。 */
  const linkVisitId = (req.body || {}).visitId ? Number(req.body.visitId) : null;
  if (linkVisitId && !getVisitOf(p.id, linkVisitId)) {
    return res.status(400).json({ error: '就诊不存在或不属于该患者' });
  }

  const rawStructured = (req.body || {}).structured;
  let sv = null;
  if (rawStructured) {
    const kind = String(rawStructured.kind || '');
    const check = validateStructuredForEvent(kind, v.type, rawStructured.data || {}, p.birth_date, v.date);
    if (check.error) return res.status(400).json({ error: check.error });
    sv = { kind, value: check.value };
    if (kind === 'outcome' && sv.value.outcomeType !== 'metastasis') {
      const existing = db.prepare('SELECT id FROM patient_outcomes WHERE patient_id=? AND outcome_type=?').get(p.id, sv.value.outcomeType);
      if (existing) return res.status(400).json({ error: '该患者已有 ' + sv.value.outcomeType + ' 结局记录；请编辑原记录，不要重复添加' });
    }
  }

  /* 病理结构化事件只保留一套 Gleason：事件级字段由病理报告派生，
     避免同一事件出现“G 4+5=9 / G 3+3=6”两套互相矛盾的值。 */
  if (sv && sv.kind === 'pathology') {
    v.gleason = sv.value.gleasonPrimary != null
      ? gleasonText(sv.value.gleasonPrimary, sv.value.gleasonSecondary) : '';
    v.stage = sv.value.ptnm || '';
  }
  const deathEvent = !!(sv && sv.kind === 'outcome' && sv.value.outcomeType === 'death');
  { const a = assertAliveForRecord(p, v.date, '事件日期', { deathEvent }); if (a) return res.status(400).json({ error: a }); }

  let newEventId = null;
  const guidedBatch = normGuidedBatch((req.body || {}).guidedBatch);
  try {
    db.transaction(() => {
      const r = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,gleason,stage,is_surgery,notes,guided_batch,created_by)
                            VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(p.id, v.date, v.type, v.gleason, v.stage, v.isSurgery, v.notes, guidedBatch, req.user.username);
      newEventId = r.lastInsertRowid;
      if (linkVisitId) db.prepare('UPDATE timeline_events SET visit_id=? WHERE id=?').run(linkVisitId, newEventId);
      if (sv) {
        if (sv.kind === 'pathology') savePathologyForEvent(p.id, newEventId, sv.value, req.user.username);
        else if (sv.kind === 'imaging') saveImagingForEvent(p.id, newEventId, sv.value, req.user.username);
        else if (sv.kind === 'radiation') saveRadiationForEvent(p.id, newEventId, sv.value, req.user.username);
        else if (sv.kind === 'outcome') {
          const out = saveOutcomeForEvent(p.id, newEventId, sv.value, req.user.username);
          if (out.error) throw new Error(out.error);
        }
        if (linkVisitId) {
          const table = { pathology: 'pathology_reports', imaging: 'imaging_studies', radiation: 'radiation_records', outcome: 'patient_outcomes' }[sv.kind];
          if (table) db.prepare('UPDATE ' + table + ' SET visit_id=? WHERE event_id=?').run(linkVisitId, newEventId);
        }
      }
      syncSurgDate(p.id);
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message || '事件保存失败' });
  }
  logAudit(req.user.username, 'ADD_EVENT', p.id + ' ' + v.date + ' ' + v.type + (sv ? ' [' + sv.kind + ']' : ''));
  /* 额外带出 newEventId：前端添加事件后紧接着要上传图片，
     而图片必须挂到刚创建的这条事件上。不给 id，前端就只能拿事件列表前后对比
     去猜哪条是新的——同一天添加两条同名事件时必然猜错。 */
  res.json(Object.assign(buildPatient(getP(p.id)), { newEventId }));
});
app.put('/api/patients/:id/events/:eid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const e = getEventOwned(req.params.eid, p.id);
  if (!e) return res.status(404).json({ error: '事件不存在' });
  const b = req.body || {};
  /* 结构化化验生成的“化验/监测”摘要事件是投影，不能直接改备注；
     否则会与 lab_values 脱钩。请到「PSA/睾酮 → 化验」面板修改。 */
  if (e.event_type === LAB_EVENT_TYPE && /\[结构化化验\]/.test(String(e.notes || ''))) {
    return res.status(400).json({ error: '该“化验/监测”事件由结构化化验自动生成，请到「化验」面板修改' });
  }
  /* PSA 镜像事件的活动类型不可改：改成别的名字就等于凭空多出一条事件，
     而那条 PSA 记录反而失去了投影，两边彻底对不上。
     日期也不在此改——改期请去「PSA复查记录」区，那边会连带同步镜像事件。
     但允许补 Gleason / 分期 / 挂报告图片：临床上这次复查完全可以附带其他检查结果。 */
  if (e.psa_record_id) {
    if (b.type !== undefined && String(b.type).trim() !== e.event_type) {
      return res.status(400).json({ error: '该事件由 PSA 记录自动生成，活动类型不可修改' });
    }
    if (b.date !== undefined && normDate(b.date) !== e.event_date) {
      return res.status(400).json({ error: '该事件的日期随 PSA 记录联动，请在「PSA复查记录」区修改日期' });
    }
  }
  /* 睾酮/化验镜像同理：类型与日期都由源记录决定，改名等于凭空造事件、
     改期会让节点与记录脱钩。补 Gleason / 分期 / 挂图片仍然允许。 */
  if (e.testo_record_id || e.lab_record_id) {
    const src = e.testo_record_id ? '「血清睾酮」区' : '「化验/监测记录」区';
    if (b.type !== undefined && String(b.type).trim() !== e.event_type) {
      return res.status(400).json({ error: '该事件由' + (e.testo_record_id ? '睾酮' : '化验') + '记录自动生成，活动类型不可修改' });
    }
    if (b.date !== undefined && normDate(b.date) !== e.event_date) {
      return res.status(400).json({ error: '该事件的日期随记录联动，请在' + src + '修改日期' });
    }
  }
  /* 部分更新：未传的字段沿用原值，与 PUT /api/patients/:id 的语义保持一致 */
  const merged = {
    date: b.date !== undefined ? b.date : e.event_date,
    type: b.type !== undefined ? b.type : e.event_type,
    gleason: b.gleason !== undefined ? b.gleason : (e.gleason || ''),
    stage: b.stage !== undefined ? b.stage : (e.stage || ''),
    notes: b.notes !== undefined ? b.notes : (e.notes || '')
  };
  const lastSurgErr = lastSurgeryEventError(p, e, String(merged.type || '').trim());
  if (lastSurgErr) return res.status(400).json({ error: lastSurgErr });
  /* 镜像事件的类型绕过 validateEventBody 的拦截：这里 merged.type 恒等于
     原类型（上面已拦下改名），而该类型正是系统生成类型（PSA/睾酮/化验），
     若不豁免会被自己的校验误杀，导致镜像事件连 Gleason 都补不了。
     is_surgery 一律归零：前端虽已隐藏该复选框，但接口可被直接调用，
     放过就会让 syncSurgDate 把手术日期设成某次复查的日期。 */
  const isMirrorEvent = !!(e.psa_record_id || e.testo_record_id || e.lab_record_id);
  const v = isMirrorEvent
    ? { date: merged.date, type: merged.type, gleason: String(merged.gleason).trim().slice(0, 20),
        stage: String(merged.stage).trim().slice(0, 20), notes: String(merged.notes || '').trim().slice(0, 1000),
        isSurgery: 0 }
    : validateEventBody(merged, p.birth_date);
  if (v.error) return res.status(400).json({ error: v.error });

  const existingKind = existingStructuredKind(e.id);
  const expectedKind = structuredKindOfEvent(v.type);
  const rawStructured = b.structured;
  let sv = null;
  if (rawStructured) {
    const kind = String(rawStructured.kind || '');
    if (existingKind && existingKind !== kind) {
      return res.status(400).json({ error: '该事件已有其他类型的结构化数据，不能直接改类型；请先删除原记录' });
    }
    const check = validateStructuredForEvent(kind, v.type, rawStructured.data || {}, p.birth_date, v.date);
    if (check.error) return res.status(400).json({ error: check.error });
    sv = { kind, value: check.value };
  } else if (existingKind && expectedKind !== existingKind) {
    return res.status(400).json({ error: '该事件已有结构化数据，不能改成其他事件类型；请先删除原记录' });
  }
  if (sv && sv.kind === 'pathology') {
    v.gleason = sv.value.gleasonPrimary != null
      ? gleasonText(sv.value.gleasonPrimary, sv.value.gleasonSecondary) : '';
    v.stage = sv.value.ptnm || '';
  }
  const existingOutcome = db.prepare('SELECT outcome_type FROM patient_outcomes WHERE event_id=?').get(e.id);
  const deathEvent = !!(sv && sv.kind === 'outcome' && sv.value.outcomeType === 'death') ||
    !!(existingOutcome && existingOutcome.outcome_type === 'death');
  { const a = assertAliveForRecord(p, v.date, '事件日期', { deathEvent }); if (a) return res.status(400).json({ error: a }); }

  try {
    db.transaction(() => {
      db.prepare(`UPDATE timeline_events SET event_date=?,event_type=?,gleason=?,stage=?,is_surgery=?,notes=? WHERE id=?`)
        .run(v.date, v.type, v.gleason, v.stage, v.isSurgery, v.notes, e.id);
      if (sv) {
        if (sv.kind === 'pathology') savePathologyForEvent(p.id, e.id, sv.value, req.user.username);
        else if (sv.kind === 'imaging') saveImagingForEvent(p.id, e.id, sv.value, req.user.username);
        else if (sv.kind === 'radiation') saveRadiationForEvent(p.id, e.id, sv.value, req.user.username);
        else if (sv.kind === 'outcome') {
          const out = saveOutcomeForEvent(p.id, e.id, sv.value, req.user.username);
          if (out.error) throw new Error(out.error);
        }
      }
      syncSurgDate(p.id);
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message || '事件更新失败' });
  }
  logAudit(req.user.username, 'UPDATE_EVENT', p.id + ' #' + e.id + ' → ' + v.date + ' ' + v.type + (sv ? ' [' + sv.kind + ']' : ''));
  res.json(buildPatient(getP(p.id)));
});

/* ---- 把某条病程事件里的病理分期/Gleason 显式应用到患者主档 ----
   当前数据模型只有一个 stage/gleason 字段；在尚未拆分 cTNM/pTNM 之前，
   不做静默自动同步，而由医生在事件上确认「以此为准」，避免临床分期被病理结果
   或旧事件意外覆盖。后续拆分 cT/pT 后，这个接口可以改为按字段写入。 */
app.post('/api/patients/:id/events/:eid/apply-staging', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const e = getEventOwned(req.params.eid, p.id);
  if (!e) return res.status(404).json({ error: '事件不存在' });
  if (existingStructuredKind(e.id) === 'pathology') {
    return res.status(400).json({ error: '病理数据由「主要病理」自动同步；请修改病理报告的主要标记，不要手工应用到主档' });
  }
  const stage = String(e.stage || '').trim().slice(0, 20);
  const gleason = String(e.gleason || '').trim().slice(0, 20);
  if (!stage && !gleason) {
    return res.status(400).json({ error: '该事件没有可应用的分期或 Gleason 评分' });
  }
  const oldStage = p.clinical_stage || p.pathologic_stage || p.stage || '';
  const oldGleason = p.gleason || '';
  /* 按事件类型/前缀写对应字段：病理报告→病理分期，临床分期评估→临床分期。
     无前缀时默认按临床分期处理；不再让病理结果覆盖临床风险分层。 */
  let clinicalStage = p.clinical_stage || '';
  let pathologicStage = p.pathologic_stage || '';
  let isPath = false;
  if (stage) {
    isPath = /^p/i.test(stage) || /病理/.test(e.event_type || '');
    if (isPath) pathologicStage = stage;
    else clinicalStage = stage;
  }
  const sets = ['stage=?', 'clinical_stage=?', 'pathologic_stage=?', 'gleason=?'];
  const vals = [stage || p.stage || '', clinicalStage, pathologicStage, gleason || oldGleason];
  if (gleason) { sets.push('gleason_source=?'); vals.push('manual'); }
  if (stage && isPath) { sets.push('pathologic_stage_source=?'); vals.push('manual'); }
  vals.push(p.id);
  db.prepare('UPDATE patients SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
  logAudit(req.user.username, 'APPLY_EVENT_STAGING',
    p.id + ' 事件#' + e.id + '：' + (/^p/i.test(stage) || /病理/.test(e.event_type || '') ? '病理分期' : '临床分期') +
    ' ' + (oldStage || '空') + '→' + (stage || oldStage || '空') +
    '；Gleason ' + (oldGleason || '空') + '→' + (gleason || oldGleason || '空'));
  res.json(buildPatient(getP(p.id)));
});

app.delete('/api/patients/:id/events/:eid', auth(), (req, res) => {
  const p = getP(req.params.id);
  if (!p) return res.status(404).json({ error: '患者不存在' });
  if (!requireOwn(req, res, p)) return;
  const e = getEventOwned(req.params.eid, p.id);
  if (!e) return res.status(404).json({ error: '事件不存在' });
  /* 镜像事件不能单独删：它是某条 PSA 记录的投影，删掉投影而记录还在，
     时间轴上就永久缺了这次复查，医生也不会想到去 PSA 区补。
     要删就删源记录（DELETE /psa/:rid），那边会连带清理镜像事件。 */
  if (e.psa_record_id) {
    return res.status(400).json({ error: '该事件由 PSA 记录自动生成，请在「PSA复查记录」区删除对应记录，事件会一并移除' });
  }
  if (e.testo_record_id || e.lab_record_id) {
    return res.status(400).json({ error: '该事件由' + (e.testo_record_id ? '睾酮' : '化验/监测') + '记录自动生成，请在对应记录区删除记录，事件会一并移除' });
  }
  const out = db.prepare('SELECT id FROM patient_outcomes WHERE event_id=?').get(e.id);
  if (out) {
    return res.status(400).json({ error: '该事件关联了结构化结局记录；请先在详情页删除结局，再删除事件' });
  }
  const lastSurgErr = lastSurgeryEventError(p, e, null);
  if (lastSurgErr) return res.status(400).json({ error: lastSurgErr });
  /* 级联只删 timeline_images 的行，物理文件必须先收集再删，否则留下孤儿图片 */
  const files = db.prepare('SELECT stored_name FROM timeline_images WHERE event_id=?').all(e.id);
  db.transaction(() => {
    removeFileAssetsForEvent(e.id);
    db.prepare('DELETE FROM timeline_events WHERE id=?').run(e.id);
    syncSurgDate(p.id);
    resyncPathologyDerived(p.id, req.user.username);
  })();
  files.forEach(f => { try { fs.unlinkSync(path.join(uploadDir, f.stored_name)); } catch (err) {} });
  logAudit(req.user.username, 'DELETE_EVENT', p.id + ' #' + e.id + ' ' + e.event_type);
  res.json(buildPatient(getP(p.id)));
});

/* ---- 事件附加检查报告图片 ---- */
app.post('/api/patients/:id/events/:eid/images', auth(), upload.array('images', 10), (req, res) => {
  const p = getP(req.params.id);
  if (!p) { discardUploadedFiles(req.files); return res.status(404).json({ error: '患者不存在' }); }
  if (!requireOwn(req, res, p)) { discardUploadedFiles(req.files); return; }
  const e = getEventOwned(req.params.eid, p.id);
  if (!e) { discardUploadedFiles(req.files); return res.status(404).json({ error: '事件不存在' }); }
  const total = db.prepare('SELECT COUNT(*) AS n FROM timeline_images WHERE event_id=?').get(e.id).n;
  if (total + (req.files || []).length > 10) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: '单个事件最多附加 10 张图片' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const stmt = db.prepare(`INSERT INTO timeline_images(event_id,filename,stored_name,upload_date,uploaded_by)
                           VALUES(?,?,?,?,?)`);
  db.transaction(() => {
    (req.files || []).forEach(f => {
      const info = stmt.run(e.id, f.originalname, f.filename, today, req.user.username);
      registerFileAsset({ patientId: p.id, source: 'event_image', sourceId: info.lastInsertRowid,
        storedName: f.filename, filename: f.originalname, mime: f.mimetype || '', bytes: f.size || 0,
        createdBy: req.user.username });
    });
  })();
  logAudit(req.user.username, 'UPLOAD_EVENT_IMAGE', p.id + ' 事件#' + e.id + ' ×' + (req.files || []).length);
  res.json(buildPatient(getP(p.id)));
});

/* 图片读取同样走鉴权接口，不暴露公开 URL。
   归属校验要沿 图片 → 事件 → 患者 这条链走完，
   否则任意登录用户猜到 iid 就能读到别人患者的病历图片。 */
app.get('/api/timeline-images/:iid/file', auth(), (req, res) => {
  const img = db.prepare('SELECT * FROM timeline_images WHERE id=?').get(req.params.iid);
  if (!img) return res.status(404).send('Not found');
  const ev = db.prepare('SELECT patient_id FROM timeline_events WHERE id=?').get(img.event_id);
  if (!ev || !requireOwn(req, res, getP(ev.patient_id))) return;
  const fp = path.join(uploadDir, img.stored_name);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.sendFile(fp);
});

app.delete('/api/timeline-images/:iid', auth(), (req, res) => {
  const img = db.prepare('SELECT * FROM timeline_images WHERE id=?').get(req.params.iid);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  const ev = db.prepare('SELECT patient_id FROM timeline_events WHERE id=?').get(img.event_id);
  if (!ev || !requireOwn(req, res, getP(ev.patient_id))) return;
  db.prepare('DELETE FROM timeline_images WHERE id=?').run(img.id);
  removeFileAsset('event_image', img.id);
  try { fs.unlinkSync(path.join(uploadDir, img.stored_name)); } catch (e) {}
  logAudit(req.user.username, 'DELETE_EVENT_IMAGE', '#' + img.id + ' (事件#' + img.event_id + ')');
  res.json({ ok: true });
});

/* ================= 用户管理（仅管理员） ================= */
app.get('/api/users', auth(true), (req, res) => {
  const rows = db.prepare('SELECT username,display_name,role,created_at,last_login FROM users ORDER BY created_at').all();
  /* 一次性聚合各账号名下患者数，避免逐个账号查库。
     管理员据此判断该把患者改派给谁；created_by 为空的历史数据不计入任何账号。 */
  const owned = new Map(
    db.prepare('SELECT created_by AS u, COUNT(*) AS n FROM patients WHERE created_by IS NOT NULL GROUP BY created_by')
      .all().map(r => [r.u, r.n])
  );
  res.json(rows.map(u => ({
    username: u.username, display: u.display_name, role: u.role,
    created: (u.created_at || '').slice(0, 10), lastLogin: u.last_login,
    patientCount: owned.get(u.username) || 0
  })));
});

app.post('/api/users', auth(true), (req, res) => {
  const { username, display, role, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: '请填写用户名，密码至少6位' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  db.prepare('INSERT INTO users(username,display_name,role,pass_hash,created_at) VALUES(?,?,?,?,?)')
    .run(username, display || username, role === 'admin' ? 'admin' : 'user',
         bcrypt.hashSync(password, 10), new Date().toISOString());
  logAudit(req.user.username, 'CREATE_USER', username);
  res.json({ ok: true });
});

app.put('/api/users/:u/password', auth(true), (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(req.params.u)) {
    return res.status(404).json({ error: '用户不存在' });
  }
  db.prepare('UPDATE users SET pass_hash=? WHERE username=?')
    .run(bcrypt.hashSync(password, 10), req.params.u);
  logAudit(req.user.username, 'RESET_PASSWORD', req.params.u);
  res.json({ ok: true });
});

app.delete('/api/users/:u', auth(true), (req, res) => {
  if (req.params.u === req.user.username) {
    return res.status(400).json({ error: '不能删除当前登录的账号' });
  }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.u);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n <= 1) {
    return res.status(400).json({ error: '至少需保留一个管理员账号' });
  }
  /* 删除账号不会清空其名下患者，但会使这些患者变为「无归属」——
     之后只有 admin 能看到，普通医生再无法访问。因此先要求管理员改派，
     避免一次误删导致整批患者脱离任何医生的管理视图。 */
  const owned = db.prepare('SELECT COUNT(*) AS n FROM patients WHERE created_by=?').get(u.username).n;
  if (owned > 0) {
    return res.status(400).json({
      error: '该账号名下仍有 ' + owned + ' 位患者，请先在「用户管理」中改派患者归属，再删除账号'
    });
  }
  db.prepare('DELETE FROM users WHERE username=?').run(u.username);
  logAudit(req.user.username, 'DELETE_USER', u.username);
  res.json({ ok: true });
});

/* ================= 备份 / 恢复（仅管理员） ================= */
/* v13 备份：把新表按患者分组，保证就诊/治疗段/毒性/合并症可完整往返。
   与 buildPatient.workspace 的区别：这里取全部就诊（workspace 只带最近 12 次）。 */
function buildV13BackupMap() {
  const by = new Map();
  const put = (pid, key, val) => {
    if (!pid) return;
    if (!by.has(pid)) by.set(pid, {
      episodes: [], visits: [], rows: [], items: [], adverseEvents: [],
      surgeryRecords: [], chemoCycles: [], administrations: [], comorbidities: [], diseaseStates: []
    });
    by.get(pid)[key].push(val);
  };
  db.prepare('SELECT * FROM treatment_episodes ORDER BY patient_id,start_date,id').all().forEach(r => put(r.patient_id, 'episodes', episodeApi(r)));
  db.prepare('SELECT * FROM visits ORDER BY patient_id,visit_date,id').all().forEach(r => put(r.patient_id, 'visits', visitApi(r)));
  const visitMeta = new Map(db.prepare('SELECT id,patient_id,visit_date FROM visits').all().map(v => [v.id, v]));
  db.prepare('SELECT * FROM visit_episode_rows ORDER BY visit_id,visit_no,id').all().forEach(r => {
    const v = visitMeta.get(r.visit_id);
    if (v) put(v.patient_id, 'rows', Object.assign(rowApi(r), { visitDate: v.visit_date }));
  });
  db.prepare('SELECT * FROM visit_items ORDER BY visit_id,id').all().forEach(r => {
    const v = visitMeta.get(r.visit_id);
    if (v) put(v.patient_id, 'items', itemApi(r));
  });
  db.prepare('SELECT * FROM adverse_events ORDER BY patient_id,id').all().forEach(r => put(r.patient_id, 'adverseEvents', aeApi(r)));
  db.prepare('SELECT * FROM surgery_records ORDER BY patient_id,surgery_date,id').all().forEach(r => put(r.patient_id, 'surgeryRecords', surgeryApi(r)));
  db.prepare('SELECT * FROM chemo_cycles ORDER BY patient_id,cycle_date,cycle_no,id').all().forEach(r => put(r.patient_id, 'chemoCycles', chemoApi(r)));
  db.prepare('SELECT * FROM medication_administrations ORDER BY patient_id,admin_date,id').all().forEach(r => put(r.patient_id, 'administrations', adminApi(r)));
  db.prepare('SELECT * FROM comorbidities ORDER BY patient_id,system,disease_code').all().forEach(r => put(r.patient_id, 'comorbidities', comorbidityApi(r)));
  db.prepare('SELECT * FROM disease_states ORDER BY patient_id,since_date,id').all().forEach(r => put(r.patient_id, 'diseaseStates', stateApi(r)));
  return by;
}

app.get('/api/backup/export', auth(true), (req, res) => {
  const data = {
    /* version 4：patient 对象新增 events 数组（buildPatient 已带出）。
       version 5：CSCO 2026 对齐——patient 新增 rtEndDate/adtStartDate/lastFollowupDate/
       castration/metCount/metExtraPelvis/visceralMet/oligoType，psa 记录新增 belowLod/lod，
       并新增 testo（睾酮）与 labs（化验/监测）数组。导入端按字段有无兼容旧版本。
       version 6：新增 medications（药物使用记录）数组；旧备份无该字段时按空数组处理。
       version 7：patient 新增 followupStatus（在访/失访/死亡）；testo 记录新增
       unit/enteredVal（录入单位与录入值，value 仍为规范 ng/dl）。
       version 8：clinicalStage/pathologicStage、concomitantMeds、treatmentLines/
       treatmentAgents、clinicalRecords（骨健康/CVD/QoL/监测）、testo 检测方法/实验室/采血时间。
       version 9：病理/影像/放疗/结局/样本/IHC/基因组结构化数组；患者基线/科研合规字段；
       treatmentLines 增加 stopReasonCode/responseCode。
       version 10：labValues 结构化化验；medications 增加 lineId/source。
       version 11：P2 文件索引 files manifest；SBP 归一为 BP_SYS。
       version 12：科研导出/结构化记录继续扩展（历史读取兼容）。
       version 13：治疗段/就诊/就诊行/项目/AE/手术/化疗/给药/合并症/疾病状态；
       patients[].v13 为每患者全量新对象数组，导入时按旧→新 ID 重映射。
       图片仍只导元数据、不含二进制——与 reports 一致，避免 JSON 膨胀到不可用。 */
    type: 'pcd-backup', version: 13,
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.username,
    idCounter: parseInt(db.prepare("SELECT value FROM meta WHERE key='id_counter'").get().value),
    patients: (() => {
      const v13 = buildV13BackupMap();
      return db.prepare('SELECT * FROM patients ORDER BY id').all().map(p => {
        const bp = buildPatient(p);
        delete bp.workspace;
        bp.admissionNo = p.admission_no || '';
        return Object.assign(bp, { v13: v13.get(p.id) || null });
      });
    })(),
    /* P2-15：文件清单，不复制二进制；sha256 用于导入/迁移后核对。 */
    files: db.prepare(`SELECT id, patient_id, source, source_id, stored_name, filename, mime, bytes, sha256
                       FROM file_assets WHERE deleted_at IS NULL ORDER BY id`).all().map(r => ({
      id: r.id, patientId: r.patient_id, source: r.source, sourceId: r.source_id,
      storedName: r.stored_name, filename: r.filename || '', mime: r.mime || '',
      bytes: r.bytes || 0, sha256: r.sha256 || ''
    }))
  };
  logAudit(req.user.username, 'EXPORT_BACKUP', data.patients.length + ' 位患者');
  res.setHeader('Content-Disposition',
    'attachment; filename="pcd-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(data);
});


/* 把 v13 备份中的新对象按患者写回；旧→新 id 用 map 串联，映射不到置 null。 */
function importV13ForPatient(pid, v13, lineIdMap, eventIdMap, owner) {
  if (!v13 || typeof v13 !== 'object') return;
  const now = new Date().toISOString();
  const episodeMap = new Map();
  (v13.episodes || []).forEach(x => {
    const start = normDate(x.startDate);
    if (!start || !x.templateCode) return;
    const r = db.prepare(`INSERT INTO treatment_episodes
      (patient_id,episode_type,template_code,label,intent,line_id,guideline_scenario,guideline_option_id,
       recommendation_level,guideline_ref,start_date,end_date,status,stop_reason_code,followup_interval_days,source,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, String(x.episodeType || 'other'), String(x.templateCode), String(x.label || '').slice(0, 120),
           String(x.intent || 'radical'), x.lineId != null ? (lineIdMap.get(String(x.lineId)) || null) : null,
           String(x.guidelineScenario || ''), String(x.guidelineOptionId || ''), String(x.recommendationLevel || ''),
           String(x.guidelineRef || ''), start, normDate(x.endDate) || null, String(x.status || 'active'),
           String(x.stopReasonCode || ''), Number.isFinite(Number(x.followupIntervalDays)) ? Number(x.followupIntervalDays) : null,
           'import', String(x.notes || '').slice(0, 1000), owner, now);
    if (x.id != null) episodeMap.set(String(x.id), r.lastInsertRowid);
  });
  const visitMap = new Map();
  (v13.visits || []).forEach(x => {
    const d = normDate(x.visitDate);
    if (!d) return;
    const r = db.prepare(`INSERT INTO visits
      (patient_id,visit_date,visit_type,department,physician,chief_complaint,ecog,pain_nrs,summary,next_plan,next_visit_date,
       mdt_participants,mdt_conclusion,source,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, d, String(x.visitType || 'outpatient'), String(x.department || '').slice(0, 60),
           String(x.physician || '').slice(0, 60), String(x.chiefComplaint || '').slice(0, 1000),
           x.ecog == null ? null : Number(x.ecog), x.painNrs == null ? null : Number(x.painNrs),
           String(x.summary || '').slice(0, 4000), String(x.nextPlan || '').slice(0, 2000),
           normDate(x.nextVisitDate) || null, String(x.mdtParticipants || '').slice(0, 500),
           String(x.mdtConclusion || '').slice(0, 2000), 'import', String(x.status || 'final'),
           owner, now, now);
    if (x.id != null) visitMap.set(String(x.id), r.lastInsertRowid);
  });
  const rowMap = new Map();
  (v13.rows || []).forEach(x => {
    const vid = visitMap.get(String(x.visitId));
    const eid = episodeMap.get(String(x.episodeId));
    if (!vid || !eid) return;
    const r = db.prepare(`INSERT INTO visit_episode_rows
      (visit_id,episode_id,visit_no,row_type,overall_response,response_basis,psa_response,imaging_response,
       clinical_response,ecog,pain_nrs,symptom_status,summary,notes,next_visit_date,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(vid, eid, x.visitNo == null ? null : Number(x.visitNo), String(x.rowType || 'followup'),
           String(x.overallResponse || 'NA'), String(x.responseBasis || 'none'), String(x.psaResponse || 'NA'),
           String(x.imagingResponse || 'NA'), String(x.clinicalResponse || 'NA'),
           x.ecog == null ? null : Number(x.ecog), x.painNrs == null ? null : Number(x.painNrs),
           String(x.symptomStatus || ''), String(x.summary || '').slice(0, 4000),
           String(x.notes || '').slice(0, 2000), normDate(x.nextVisitDate) || null, now);
    if (x.id != null) rowMap.set(String(x.id), r.lastInsertRowid);
  });
  (v13.items || []).forEach(x => {
    const vid = visitMap.get(String(x.visitId));
    if (!vid) return;
    db.prepare(`INSERT OR IGNORE INTO visit_items
      (visit_id,episode_row_id,item_code,item_label,status,reason,due_date,linked_table,linked_id,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(vid, x.episodeRowId != null ? (rowMap.get(String(x.episodeRowId)) || null) : null,
           String(x.itemCode || ''), String(x.itemLabel || '').slice(0, 120), String(x.status || 'pending'),
           String(x.reason || '').slice(0, 500), normDate(x.dueDate) || null,
           String(x.linkedTable || ''), x.linkedId == null ? null : Number(x.linkedId), String(x.source || 'import'), now);
  });
  const cycleMap = new Map();
  (v13.chemoCycles || []).forEach(x => {
    const eid = episodeMap.get(String(x.episodeId));
    const d = normDate(x.cycleDate);
    if (!eid || !d) return;
    const r = db.prepare(`INSERT INTO chemo_cycles
      (patient_id,episode_id,line_id,cycle_no,cycle_date,regimen,agents_json,bsa,planned_dose,actual_dose,
       dose_reduction_pct,delay_days,delay_reason,gcsf,ecog,assessment_visit_id,next_cycle_date,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, eid, x.lineId != null ? (lineIdMap.get(String(x.lineId)) || null) : null,
           Number(x.cycleNo) || 1, d, String(x.regimen || '').slice(0, 200), JSON.stringify(x.agents || []),
           x.bsa == null ? null : Number(x.bsa), String(x.plannedDose || ''), String(x.actualDose || ''),
           x.doseReductionPct == null ? null : Number(x.doseReductionPct), x.delayDays == null ? null : Number(x.delayDays),
           String(x.delayReason || ''), x.gcsf ? 1 : 0, x.ecog == null ? null : Number(x.ecog),
           x.assessmentVisitId != null ? (visitMap.get(String(x.assessmentVisitId)) || null) : null,
           normDate(x.nextCycleDate) || null, String(x.notes || '').slice(0, 1000), owner, now);
    if (x.id != null) cycleMap.set(String(x.id), r.lastInsertRowid);
  });
  (v13.adverseEvents || []).forEach(x => {
    const vid = x.visitId != null ? (visitMap.get(String(x.visitId)) || null) : null;
    const rid = x.episodeRowId != null ? (rowMap.get(String(x.episodeRowId)) || null) : null;
    const eid = x.episodeId != null ? (episodeMap.get(String(x.episodeId)) || null) : null;
    const cid = x.chemoCycleId != null ? (cycleMap.get(String(x.chemoCycleId)) || null) : null;
    db.prepare(`INSERT INTO adverse_events
      (patient_id,visit_id,episode_row_id,chemo_cycle_id,episode_id,term_code,term_label,grade,ctcae_version,
       grade_basis,onset_date,resolution_date,recovery_status,aux_meds,management,action,causality,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, vid, rid, cid, eid, String(x.termCode || ''), String(x.termLabel || '').slice(0, 80),
           x.grade == null ? null : Number(x.grade), String(x.ctcaeVersion || 'CTCAE 5.0'),
           String(x.gradeBasis || '').slice(0, 500), normDate(x.onsetDate) || null, normDate(x.resolutionDate) || null,
           String(x.recoveryStatus || 'unknown'), String(x.auxMeds || '').slice(0, 500),
           String(x.management || '').slice(0, 1000), String(x.action || 'none'),
           String(x.causality || ''), String(x.notes || '').slice(0, 1000), owner, now);
  });
  (v13.surgeryRecords || []).forEach(x => {
    const eid = episodeMap.get(String(x.episodeId));
    if (!eid) return;
    db.prepare(`INSERT OR REPLACE INTO surgery_records
      (patient_id,episode_id,event_id,surgery_date,surgeon,procedure,approach,nerve_sparing,ln_dissection,
       ln_examined_left,ln_positive_left,ln_examined_right,ln_positive_right,catheter_days,drain_days,
       complications_json,complication_management,conversion,blood_loss_ml,hospital_days,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, eid, x.eventId != null ? (eventIdMap.get(String(x.eventId)) || null) : null,
           normDate(x.surgeryDate) || normDate(x.startDate) || todayIso(), String(x.surgeon || '').slice(0, 60),
           String(x.procedure || 'RP').slice(0, 60), String(x.approach || '').slice(0, 30),
           String(x.nerveSparing || 'none'), String(x.lnDissection || 'none'),
           x.lnExaminedLeft == null ? null : Number(x.lnExaminedLeft), x.lnPositiveLeft == null ? null : Number(x.lnPositiveLeft),
           x.lnExaminedRight == null ? null : Number(x.lnExaminedRight), x.lnPositiveRight == null ? null : Number(x.lnPositiveRight),
           x.catheterDays == null ? null : Number(x.catheterDays), x.drainDays == null ? null : Number(x.drainDays),
           JSON.stringify(x.complications || []), String(x.complicationManagement || '').slice(0, 1000),
           x.conversion ? 1 : 0, x.bloodLossMl == null ? null : Number(x.bloodLossMl),
           x.hospitalDays == null ? null : Number(x.hospitalDays), String(x.notes || '').slice(0, 1000), owner, now);
  });
  (v13.administrations || []).forEach(x => {
    const eid = x.episodeId != null ? (episodeMap.get(String(x.episodeId)) || null) : null;
    const d = normDate(x.adminDate);
    if (!d || !x.drug) return;
    db.prepare(`INSERT INTO medication_administrations
      (patient_id,medication_id,episode_id,admin_date,drug,dose,route,site,lot,next_due_date,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, null, eid, d, String(x.drug).slice(0, 80), String(x.dose || '').slice(0, 60),
           String(x.route || '').slice(0, 30), String(x.site || '').slice(0, 40), String(x.lot || '').slice(0, 40),
           normDate(x.nextDueDate) || null, String(x.notes || '').slice(0, 500), owner, now);
  });
  (v13.comorbidities || []).forEach(x => {
    if (!x.diseaseCode) return;
    db.prepare(`INSERT OR IGNORE INTO comorbidities
      (patient_id,system,disease_code,disease_label,status,severity,diagnosed_date,notes,source,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, String(x.system || '').slice(0, 40), String(x.diseaseCode).slice(0, 60),
           String(x.diseaseLabel || '').slice(0, 120), String(x.status || 'unknown'),
           String(x.severity || '').slice(0, 20), normDate(x.diagnosedDate) || null,
           String(x.notes || '').slice(0, 1000), 'import', owner, now);
  });
  (v13.diseaseStates || []).forEach(x => {
    const d = normDate(x.sinceDate);
    if (!d || !x.stateCode) return;
    db.prepare(`INSERT INTO disease_states
      (patient_id,state_code,state_label,since_date,basis,evidence_json,status,confirmed_by,confirmed_at,superseded_at,is_current)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, String(x.stateCode), String(x.stateLabel || '').slice(0, 40), d,
           String(x.basis || '').slice(0, 1000), String(x.evidenceJson || '').slice(0, 4000),
           String(x.status || 'confirmed'), String(x.confirmedBy || owner), now,
           x.supersededAt || null, x.isCurrent ? 1 : 0);
  });
}

app.post('/api/backup/import', auth(true), (req, res) => {
  const { data, mode: m } = req.body || {};
  const mode = m === 'merge' ? 'merge' : 'overwrite';
  if (!data || !Array.isArray(data.patients)) {
    return res.status(400).json({ error: '备份文件格式不正确' });
  }
  const added = db.transaction(() => {
    if (mode === 'overwrite') {
      /* 清空顺序要满足外键：先删子表 timeline_images → timeline_events，
         再删 psa/testo/labs/medication/reports，最后删 patients。
         反过来会因外键约束报错。 */
      db.prepare('DELETE FROM ihc_results').run();
      db.prepare('DELETE FROM genomic_tests').run();
      db.prepare('DELETE FROM specimens').run();
      db.prepare('DELETE FROM patient_outcomes').run();
      db.prepare('DELETE FROM radiation_records').run();
      db.prepare('DELETE FROM imaging_studies').run();
      db.prepare('DELETE FROM pathology_reports').run();
      db.prepare('DELETE FROM lab_values').run();
      db.prepare('DELETE FROM file_assets').run();
      db.prepare('DELETE FROM timeline_images').run();
      db.prepare('DELETE FROM timeline_events').run();
      db.prepare('DELETE FROM reports').run();
      db.prepare('DELETE FROM psa_records').run();
      db.prepare('DELETE FROM testosterone_records').run();
      db.prepare('DELETE FROM labs_records').run();
      db.prepare('DELETE FROM medication_records').run();
      /* v13：先删新对象，再删患者；顺序满足外键。 */
      db.prepare('DELETE FROM adverse_events').run();
      db.prepare('DELETE FROM visit_items').run();
      db.prepare('DELETE FROM visit_episode_rows').run();
      db.prepare('DELETE FROM visits').run();
      db.prepare('DELETE FROM chemo_cycles').run();
      db.prepare('DELETE FROM surgery_records').run();
      db.prepare('DELETE FROM medication_administrations').run();
      db.prepare('DELETE FROM comorbidities').run();
      db.prepare('DELETE FROM disease_states').run();
      db.prepare('DELETE FROM treatment_episodes').run();
      db.prepare('DELETE FROM patients').run();
      fs.readdirSync(uploadDir).forEach(f => {
        try { fs.unlinkSync(path.join(uploadDir, f)); } catch (e) {}
      });
    }
    const exist = new Set(db.prepare('SELECT id FROM patients').all().map(r => r.id));
    /* 导入时保留备份里的原始登记人：否则一次导入会把全部患者改归到导入者名下。
       若原登记人账号已不存在或备份无该字段（旧版备份），则留空为「无归属」，
       只有 admin 可见，待管理员在用户管理里改派。 */
    const validUsers = new Set(db.prepare('SELECT username FROM users').all().map(r => r.username));
    const resolveOwner = p => (p.owner && validUsers.has(p.owner)) ? p.owner : null;
    const insP = db.prepare(`INSERT INTO patients(id,name,age,birth_date,diag_date,surg_date,gleason,gleason_source,stage,clinical_stage,pathologic_stage,pathologic_stage_source,treatment,concomitant_meds,status,followup_status,
                 rt_end_date,adt_start_date,last_followup_date,castration_status,
                 met_count,met_extra_pelvis,visceral_met,oligo_type,
                 family_history,family_history_detail,ecog,charlson,bmi,smoking,race,ethnicity,center_id,
                 research_consent,research_consent_date,research_consent_version,data_sharing,data_sharing_scope,data_sharing_date,last_followup_mode,
                 main_symptom,symptom_duration_months,baseline_pain_nrs,birthplace,admission_no,
                 disease_category,dre_result,dre_note,
                 created_at,created_by)
                             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insPsa = db.prepare('INSERT INTO psa_records(patient_id,rec_date,value,is_initial,created_by,is_below_lod,lod_value,free_value,free_below_lod,free_lod_value) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const insTesto = db.prepare('INSERT INTO testosterone_records(patient_id,rec_date,value,unit,entered_value,assay_method,lab,sample_time,created_by) VALUES(?,?,?,?,?,?,?,?,?)');
    const insLab = db.prepare('INSERT INTO labs_records(patient_id,rec_date,item,value,note,created_by) VALUES(?,?,?,?,?,?)');
    const insLabValue = db.prepare(`INSERT INTO lab_values
      (patient_id,rec_date,item_code,item_label,value,unit,lab,method,ref_range,flag,note,source,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insTL = db.prepare(`INSERT INTO treatment_lines
      (patient_id,line_no,setting,regimen,start_date,end_date,stop_reason,stop_reason_code,response,response_code,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insTA = db.prepare(`INSERT INTO treatment_agents(line_id,drug,dose,schedule,start_date,end_date)
      VALUES(?,?,?,?,?,?)`);
    const insCR = db.prepare(`INSERT INTO clinical_records
      (patient_id,category,item,rec_date,value,unit,status,note,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const insMed = db.prepare(`INSERT INTO medication_records
      (patient_id,category,drug_name,start_date,end_date,dose,schedule,line_id,source,notes,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    /* 事件按备份里的顺序插入（备份已按 event_date,id 排好序），
       让自增 id 的先后与临床先后一致，保证 (event_date,id) 排序能还原原顺序。 */
    const insEv = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,gleason,stage,is_surgery,details,notes,guided_batch,created_by)
                              VALUES(?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    for (const p of data.patients) {
      if (mode === 'merge' && exist.has(p.id)) continue;
      /* 旧版备份没有 birth/surgDate 字段：回退为 null，显示时沿用备份里的 age */
      const birth = normDate(p.birth) || null;
      const surg = normDate(p.surgDate) || null;
      const age = birth ? ageFromBirth(birth, normDate(p.date) || null) : (p.age || null);
      const followupStatus = normalizeFollowupStatus(p.followupStatus) || legacyFollowupStatus(String(p.status || ''));
      const rawStage = String(p.stage || '').trim();
      const clinicalStage = String(p.clinicalStage !== undefined
        ? (p.clinicalStage || '')
        : (rawStage && !/^p/i.test(rawStage) ? rawStage : '')).trim().slice(0, 20);
      const pathologicStage = String(p.pathologicStage !== undefined
        ? (p.pathologicStage || '')
        : (rawStage && /^p/i.test(rawStage) ? rawStage : '')).trim().slice(0, 20);
      const stageLegacy = rawStage || clinicalStage || pathologicStage;
      insP.run(p.id, p.name, age, birth, normDate(p.date) || p.date || null, surg,
               p.gleason || '', String(p.gleasonSource || '').slice(0, 40),
               stageLegacy, clinicalStage, pathologicStage, String(p.pathologicStageSource || '').slice(0, 40),
               p.treatment || '', String(p.concomitantMeds || '').slice(0, 1000),
               p.status || PENDING_STATUS,
               followupStatus,
               /* 旧版备份没有这些键/值为空时保持「未评估」null，不伪造 0/false */
               normDate(p.rtEndDate) || null, normDate(p.adtStartDate) || null,
               normDate(p.lastFollowupDate) || null,
               p.castration == null ? null : (p.castration ? 1 : 0),
               (p.metCount == null || p.metCount === '' || !Number.isFinite(Number(p.metCount)))
                 ? null : Math.max(0, Math.round(Number(p.metCount))),
               p.metExtraPelvis == null ? null : (p.metExtraPelvis ? 1 : 0),
               p.visceralMet == null ? null : (p.visceralMet ? 1 : 0),
               normalizeOligoCode(p.oligoType),
               p.familyHistory == null ? null : (p.familyHistory ? 1 : 0),
               String(p.familyHistoryDetail || '').slice(0, 500),
               p.ecog == null ? null : Number(p.ecog),
               p.charlson == null ? null : Number(p.charlson),
               p.bmi == null ? null : Number(p.bmi),
               String(p.smoking || '').slice(0, 20),
               String(p.race || '').slice(0, 40),
               String(p.ethnicity || '').slice(0, 40),
               String(p.centerId || '').slice(0, 40),
               p.researchConsent == null ? null : (p.researchConsent ? 1 : 0),
               normDate(p.researchConsentDate) || null,
               String(p.researchConsentVersion || '').slice(0, 40),
               p.dataSharing == null ? null : (p.dataSharing ? 1 : 0),
               String(p.dataSharingScope || '').slice(0, 200),
               normDate(p.dataSharingDate) || null,
               String(p.lastFollowupMode || '').slice(0, 20),
               String(p.mainSymptom || '').slice(0, 2000),
               (p.symptomDurationMonths == null || p.symptomDurationMonths === '' || !Number.isFinite(Number(p.symptomDurationMonths))) ? null : Number(p.symptomDurationMonths),
               (p.baselinePainNrs == null || p.baselinePainNrs === '' || !Number.isFinite(Number(p.baselinePainNrs))) ? null : Number(p.baselinePainNrs),
               String(p.birthplace || '').slice(0, 120),
               String(p.admissionNo || '').slice(0, 60),
               String(p.diseaseCategory || '').slice(0, 20),
               String(p.dreResult || '').slice(0, 20),
               String(p.dreNote || '').slice(0, 200),
               new Date().toISOString(), resolveOwner(p));
      /* PSA 记录的操作人同样沿用备份原值，缺失时回退为患者归属人，便于审计溯源。
         游离三列：旧备份没有这些字段 → 全为 NULL，与存量记录一致；
         新备份携带 freeVal/freeBelowLod/freeLod 时原样还原（仅接受有限非负数，
         防止坏备份把 NaN/字符串塞进 REAL 列）。 */
      const psaOwner = resolveOwner(p) || req.user.username;
      (p.psa || []).forEach((x, i) => {
        const fv = (x.freeVal != null && Number.isFinite(Number(x.freeVal)) && Number(x.freeVal) >= 0) ? Number(x.freeVal) : null;
        const fb = fv != null && (x.freeBelowLod === true || x.freeBelowLod === 1) ? 1 : 0;
        const fl = fb && x.freeLod != null && Number.isFinite(Number(x.freeLod)) ? Number(x.freeLod) : null;
        insPsa.run(p.id, x.date, x.val, i === 0 ? 1 : 0, psaOwner,
               x.belowLod ? 1 : 0, x.belowLod && x.lod != null ? x.lod : null,
               fv, fb, fb ? fl : null);
      });
      (p.testo || []).forEach(x => {
        const unit = String(x.unit || 'ng/dl') === 'nmol/L' ? 'nmol/L' : 'ng/dl';
        const val = Number(x.val);
        if (!Number.isFinite(val)) return;
        const entered = (x.enteredVal != null && Number.isFinite(Number(x.enteredVal)))
          ? Number(x.enteredVal)
          : (unit === 'nmol/L' ? Math.round(val / 28.84 * 100) / 100 : val);
        insTesto.run(p.id, normDate(x.date) || x.date, val, unit, entered,
          String(x.assayMethod || '').slice(0, 20), String(x.lab || '').slice(0, 60),
          String(x.sampleTime || '').slice(0, 5), psaOwner);
      });
      (p.labs || []).forEach(x => insLab.run(p.id, normDate(x.date) || x.date,
               String(x.item || '').slice(0, 30),
               (x.val != null && Number.isFinite(Number(x.val))) ? Number(x.val) : null,
               String(x.note || '').slice(0, 200), psaOwner));
      /* v6 备份带 medications；旧备份无该字段时为空。
         分类非法、药物为空、日期非法的行跳过，避免污染新表。
         lineId 在治疗线插入后统一回填（旧备份 lineId 为空）。 */
      const medLineQueue = [];
      (p.medications || []).forEach(x => {
        const cat = String(x.category || '').trim();
        if (!MED_CATEGORY_KEYS.has(cat)) return;
        const drug = String(x.drug || x.drugName || '').trim();
        if (!drug) return;
        const start = normDate(x.startDate || x.start_date);
        if (!start) return;
        const rawEnd = x.endDate !== undefined ? x.endDate : x.end_date;
        let end = null;
        if (rawEnd !== undefined && rawEnd !== null && String(rawEnd).trim() !== '') {
          end = normDate(rawEnd);
          if (!end || end < start) return;
        }
        const medInfo = insMed.run(p.id, cat, drug.slice(0, 80), start, end,
          String(x.dose || '').slice(0, 40), String(x.schedule || '').slice(0, 40),
          null, String(x.source || 'manual').slice(0, 20),
          String(x.notes || '').slice(0, 500), psaOwner, new Date().toISOString());
        if (x.lineId != null) medLineQueue.push({ medId: medInfo.lastInsertRowid, oldLineId: String(x.lineId) });
      });
      /* v8 备份带治疗线；旧备份无该字段时为空。 */
      const lineIdMap = new Map();
      (p.treatmentLines || []).forEach(x => {
        const lineNo = Number(x.lineNo);
        if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > 99) return;
        const start = normDate(x.startDate);
        if (!start) return;
        const setting = TREATMENT_SETTINGS.includes(String(x.setting || '')) ? String(x.setting) : '其他';
        const regimen = String(x.regimen || '').trim().slice(0, 200);
        if (!regimen) return;
        let end = null;
        if (x.endDate) { end = normDate(x.endDate); if (!end || end < start) return; }
        const tl = insTL.run(p.id, lineNo, setting, regimen, start, end,
          String(x.stopReason || '').slice(0, 200), String(x.stopReasonCode || '').slice(0, 30),
          String(x.response || '').slice(0, 200), String(x.responseCode || '').slice(0, 20),
          psaOwner, new Date().toISOString());
        if (x.id != null) lineIdMap.set(String(x.id), tl.lastInsertRowid);
        (x.agents || []).forEach(a => {
          const drug = String((a && a.drug) || '').trim().slice(0, 80);
          if (!drug) return;
          insTA.run(tl.lastInsertRowid, drug, String(a.dose || '').slice(0, 80),
            String(a.schedule || '').slice(0, 80), normDate(a.startDate) || null, normDate(a.endDate) || null);
        });
      });
      const linkMedLine = db.prepare('UPDATE medication_records SET line_id=? WHERE id=? AND patient_id=?');
      medLineQueue.forEach(q => {
        const newLine = lineIdMap.get(q.oldLineId);
        if (newLine) linkMedLine.run(newLine, q.medId, p.id);
      });
      /* v8 备份带结构化监测记录。 */
      (p.clinicalRecords || []).forEach(x => {
        const d = normDate(x.date || x.recDate);
        if (!d) return;
        const cat = String(x.category || '').trim();
        if (!CLINICAL_CATEGORIES.includes(cat)) return;
        const item = canonicalClinicalItem(x.item).slice(0, 60);
        if (!item) return;
        insCR.run(p.id, cat, item, d,
          (x.val != null && Number.isFinite(Number(x.val))) ? Number(x.val) : null,
          String(x.unit || '').slice(0, 20), String(x.status || '').slice(0, 10),
          String(x.note || '').slice(0, 500), psaOwner, new Date().toISOString());
      });
      /* v4 备份带 events 则逐条重建；v3 及更早没有该字段，(p.events||[]) 为空，
         手术事件稍后由 backfillSurgeryEvents 依据 surg_date 自动补齐。
         日期非法的事件跳过，避免污染库。 */
      const eventIdMap = new Map();
      (p.events || []).forEach((e, idx) => {
        const d = normDate(e.date);
        if (!d || !e.type) return;
        const type = String(e.type).slice(0, 60);
        const info = insEv.run(p.id, d, type, String(e.gleason || '').slice(0, 20),
                  String(e.stage || '').slice(0, 20), type === RP_EVENT_TYPE ? 1 : 0,
                  typeof e.details === 'string' ? e.details.slice(0, 500) : null,
                  String(e.notes || '').slice(0, 1000), normGuidedBatch(e.guidedBatch), psaOwner);
        const oldId = e.id != null ? String(e.id) : 'idx:' + idx;
        eventIdMap.set(oldId, info.lastInsertRowid);
      });

      /* v10：结构化化验；插入后重建当天“化验/监测”摘要事件。 */
      const labDates = new Set();
      (p.labValues || []).forEach(x => {
        const d = normDate(x.date || x.recDate);
        if (!d) return;
        const code = String(x.itemCode || x.item || '').trim().slice(0, 30);
        if (!code) return;
        insLabValue.run(p.id, d, code, String(x.item || x.itemLabel || code).slice(0, 60),
          (x.value != null && Number.isFinite(Number(x.value))) ? Number(x.value) : null,
          String(x.unit || '').slice(0, 20), String(x.lab || '').slice(0, 60),
          String(x.method || '').slice(0, 40), String(x.refRange || '').slice(0, 80),
          String(x.flag || '').slice(0, 20), String(x.note || '').slice(0, 200),
          'import', psaOwner, new Date().toISOString());
        labDates.add(d);
      });
      labDates.forEach(d => rebuildLabEvent(p.id, d, psaOwner));

      /* v9 结构化记录：eventId 用旧→新映射；映射不到时置 null，避免指向别人的事件。 */
      const eventOf = x => (x.eventId != null && eventIdMap.get(String(x.eventId))) || null;
      let primaryPathSeen = 0;
      (p.pathologyReports || []).forEach(x => {
        const d = normDate(x.reportDate);
        if (!d) return;
        const specimenType = PATH_SPECIMEN_TYPES.includes(String(x.specimenType)) ? String(x.specimenType) : 'unknown';
        const isPrimary = x.isPrimary && !primaryPathSeen ? 1 : 0;
        if (isPrimary) primaryPathSeen = 1;
        dbInsertRow('pathology_reports', {
          patient_id: p.id, event_id: eventOf(x), specimen_type: specimenType, report_date: d,
          cores_total: intOrNull(x.coresTotal), cores_positive: intOrNull(x.coresPositive),
          cores_positive_pct: numOrNull(x.coresPositivePct),
          gleason_primary: intOrNull(x.gleasonPrimary), gleason_secondary: intOrNull(x.gleasonSecondary),
          gleason_total: intOrNull(x.gleasonTotal), isup: intOrNull(x.isup),
          ptnm: String(x.ptnm || '').slice(0, 20),
          margin_status: MARGIN_STATUSES.includes(String(x.marginStatus)) ? String(x.marginStatus) : 'unknown',
          margin_site: String(x.marginSite || '').slice(0, 80),
          ece: triState(x.ece), svi: triState(x.svi),
          ln_positive: intOrNull(x.lnPositive), ln_examined: intOrNull(x.lnExamined),
          idc_p: triState(x.idcP), cribriform: triState(x.cribriform), dac: triState(x.dac),
          nepc: triState(x.nepc), nepc_detail: String(x.nepcDetail || '').slice(0, 200),
          pni: triState(x.pni), tumor_volume_pct: numOrNull(x.tumorVolumePct),
          tumor_cell_pct: numOrNull(x.tumorCellPct),
          cores_max_cancer_pct: numOrNull(x.coresMaxCancerPct),
          histology_type: String(x.histologyType || '').slice(0, 20),
          specimen_site: String(x.specimenSite || '').slice(0, 80),
          biopsy_route: String(x.biopsyRoute || '').slice(0, 20),
          biopsy_guidance: String(x.biopsyGuidance || '').slice(0, 20),
          is_primary: isPrimary,
          notes: String(x.notes || '').slice(0, 1000),
          created_by: psaOwner, created_at: new Date().toISOString()
        });
      });

      let currentImgSeen = 0;
      (p.imagingStudies || []).forEach(x => {
        const d = normDate(x.studyDate);
        if (!d) return;
        const isCurrent = x.isCurrent && !currentImgSeen ? 1 : 0;
        if (isCurrent) currentImgSeen = 1;
        dbInsertRow('imaging_studies', {
          patient_id: p.id, event_id: eventOf(x),
          modality: IMAGING_MODALITIES.includes(String(x.modality)) ? String(x.modality) : 'other',
          study_date: d, region: String(x.region || '').slice(0, 80),
          lesion_count: intOrNull(x.lesionCount),
          metastatic_sites: listArr(x.metastaticSites).filter(s => MET_SITES.includes(s)).join(','),
          extra_pelvic: triState(x.extraPelvic), new_lesion: triState(x.newLesion),
          pirads: intOrNull(x.pirads), psma_positive: triState(x.psmaPositive),
          psma_suvmax: numOrNull(x.psmaSuvmax), psma_lesion_count: intOrNull(x.psmaLesionCount),
          recist: RECIST_VALUES.includes(String(x.recist || '')) ? String(x.recist || '') : '',
          pcwg: PCWG_VALUES.includes(String(x.pcwg || '')) ? String(x.pcwg || '') : '',
          flare: triState(x.flare), oligo_status: String(x.oligoStatus || '').slice(0, 20),
          technique: String(x.technique || '').slice(0, 120),
          index_location: String(x.indexLocation || '').slice(0, 120),
          index_size_mm: numOrNull(x.indexSizeMm),
          ece: triState(x.ece), svi: triState(x.svi),
          prostate_volume_ml: numOrNull(x.prostateVolumeMl),
          dim_transverse_cm: numOrNull(x.dimTransverseCm),
          dim_ap_cm: numOrNull(x.dimApCm),
          dim_cranial_cm: numOrNull(x.dimCranialCm),
          ln_short_axis_mm: numOrNull(x.lnShortAxisMm),
          superscan: triState(x.superscan),
          lung_nodule_count: intOrNull(x.lungNoduleCount),
          lung_nodule_max_mm: numOrNull(x.lungNoduleMaxMm),
          mi_tnm: String(x.miTnm || '').slice(0, 40),
          psma_rads: String(x.psmaRads || '').slice(0, 10),
          changed_management: triState(x.changedManagement),
          comparison: String(x.comparison || '').slice(0, 20),
          is_current: isCurrent, notes: String(x.notes || '').slice(0, 1000),
          created_by: psaOwner, created_at: new Date().toISOString()
        });
      });

      let currentRtSeen = 0;
      (p.radiationRecords || []).forEach(x => {
        const d = normDate(x.startDate);
        if (!d) return;
        const end = x.endDate ? normDate(x.endDate) : null;
        if (x.endDate && (!end || end < d)) return;
        const isCurrent = x.isCurrent && !currentRtSeen ? 1 : 0;
        if (isCurrent) currentRtSeen = 1;
        dbInsertRow('radiation_records', {
          patient_id: p.id, event_id: eventOf(x),
          rt_type: RT_TYPES.includes(String(x.rtType)) ? String(x.rtType) : 'other',
          start_date: d, end_date: end, dose_gy: numOrNull(x.doseGy), fractions: intOrNull(x.fractions),
          target: RT_TARGETS.includes(String(x.target || '')) ? String(x.target || '') : '',
          concurrent_adt: triState(x.concurrentAdt), adt_duration_months: numOrNull(x.adtDurationMonths),
          technique: String(x.technique || '').slice(0, 80), toxicity_grade: String(x.toxicityGrade || '').slice(0, 20),
          is_current: isCurrent, notes: String(x.notes || '').slice(0, 1000),
          created_by: psaOwner, created_at: new Date().toISOString()
        });
      });

      (p.outcomes || []).forEach(x => {
        const d = normDate(x.eventDate);
        if (!d || !OUTCOME_TYPES.includes(String(x.outcomeType))) return;
        dbInsertRow('patient_outcomes', {
          patient_id: p.id, event_id: eventOf(x), outcome_type: String(x.outcomeType), event_date: d,
          subtype: String(x.subtype || '').slice(0, 30), basis: String(x.basis || '').slice(0, 20),
          psa_value: numOrNull(x.psaValue), imaging_negative: triState(x.imagingNegative),
          metastatic_sites: listArr(x.metastaticSites).filter(s => MET_SITES.includes(s)).join(','),
          lesion_count: intOrNull(x.lesionCount), oligo_status: String(x.oligoStatus || '').slice(0, 20),
          death_cause: String(x.deathCause || '').slice(0, 30), lost_reason: String(x.lostReason || '').slice(0, 200),
          last_contact_date: normDate(x.lastContactDate) || null, note: String(x.note || '').slice(0, 1000),
          created_by: psaOwner, created_at: new Date().toISOString()
        });
      });

      const specimenIdMap = new Map();
      (p.specimens || []).forEach(x => {
        const d = normDate(x.collectionDate);
        if (!d || !SAMPLE_TYPES.includes(String(x.sampleType))) return;
        const info = dbInsertRow('specimens', {
          patient_id: p.id, sample_type: String(x.sampleType), collection_date: d,
          timepoint: String(x.timepoint || '').slice(0, 20), treatment_status: String(x.treatmentStatus || '').slice(0, 20),
          storage: String(x.storage || '').slice(0, 20), tumor_cell_pct: numOrNull(x.tumorCellPct),
          nucleic_quality: String(x.nucleicQuality || '').slice(0, 60), library_id: String(x.libraryId || '').slice(0, 60),
          biobank_id: String(x.biobankId || '').slice(0, 60), notes: String(x.notes || '').slice(0, 1000),
          created_by: psaOwner, created_at: new Date().toISOString()
        });
        if (x.id != null) specimenIdMap.set(String(x.id), info);
      });
      const specimenOf = x => (x.specimenId != null && specimenIdMap.get(String(x.specimenId))) || null;

      (p.genomicTests || []).forEach(x => {
        const d = normDate(x.testDate);
        if (!d || !['germline', 'somatic'].includes(String(x.testType))) return;
        dbInsertRow('genomic_tests', {
          patient_id: p.id, specimen_id: specimenOf(x), test_type: String(x.testType), test_date: d,
          lab: String(x.lab || '').slice(0, 60), platform: String(x.platform || '').slice(0, 60),
          genes: String(x.genes || '').slice(0, 200), hrr_status: String(x.hrrStatus || '').slice(0, 30),
          msi_status: String(x.msiStatus || '').slice(0, 20), tmb_value: numOrNull(x.tmbValue),
          ar_status: String(x.arStatus || '').slice(0, 30), tp53_status: String(x.tp53Status || '').slice(0, 30),
          pten_status: String(x.ptenStatus || '').slice(0, 30), rb1_status: String(x.rb1Status || '').slice(0, 30),
          result_summary: String(x.resultSummary || '').slice(0, 1000), notes: String(x.notes || '').slice(0, 1000),
          created_by: psaOwner, created_at: new Date().toISOString()
        });
      });

      (p.ihcResults || []).forEach(x => {
        if (!IHC_MARKERS.includes(String(x.marker))) return;
        dbInsertRow('ihc_results', {
          patient_id: p.id, specimen_id: specimenOf(x), marker: String(x.marker),
          result: String(x.result || '').slice(0, 20), percent: numOrNull(x.percent),
          intensity: String(x.intensity || '').slice(0, 20), test_date: normDate(x.testDate) || null,
          lab: String(x.lab || '').slice(0, 60), notes: String(x.notes || '').slice(0, 1000),
          created_by: psaOwner, created_at: new Date().toISOString()
        });
      });

      /* v13：治疗段/就诊/毒性等新对象；旧备份无 v13 字段时跳过。 */
      if (p.v13) importV13ForPatient(p.id, p.v13, lineIdMap, eventIdMap, psaOwner);
      n++;
    }
    if (data.idCounter) {
      const cur = parseInt(db.prepare("SELECT value FROM meta WHERE key='id_counter'").get().value) || 0;
      db.prepare("UPDATE meta SET value=? WHERE key='id_counter'").run(String(Math.max(cur, data.idCounter)));
    }
    /* 旧版备份（无 events）导入后，surg_date 仍是孤岛：这里补成手术事件，
       与新库口径统一。已在 events 里带过手术事件的不会被重复插入（函数内已去重）。 */
    backfillSurgeryEvents();
    /* PSA 镜像同样要在导入后收敛：v4 备份的事件与记录都重建了但绑定丢失，
       v3 备份压根没有 PSA 事件——两种情况都靠这里配对/补建，
       保证「每条 PSA 记录在时间轴上都有一个节点」这条不变量对导入数据也成立。 */
    const mirror = syncPsaMirrorEvents();
    if (mirror.stray) {
      console.warn('⚠ 导入后有 ' + mirror.stray + ' 条 PSA 类事件未对应任何 PSA 记录');
    }
    const recMirror = syncRecordMirrorEvents();
    if (recMirror.pruned) {
      console.warn('⚠ 导入后清理了 ' + recMirror.pruned + ' 条悬空睾酮/化验镜像事件');
    }
    /* 旧备份里的 labs 数组先由 syncRecordMirrorEvents 生成镜像，再立即合并为事件备注；
       这样导入旧备份不会重新制造第二套化验模型。 */
    const mergedLabs = mergeLabsIntoEvents();
    if (mergedLabs.labs) {
      console.log('🔧 导入时已将 ' + mergedLabs.labs + ' 条旧化验合并为 ' +
        mergedLabs.groups + ' 个病程事件');
    }
    return n;
  })();
  backfillFileAssets();
  logAudit(req.user.username, 'IMPORT_BACKUP', mode + ' 模式，导入 ' + added + ' 位患者');
  res.json({ ok: true, added, mode });
});

/* 审计日志（管理员） */
app.get('/api/audit', auth(true), (req, res) => {
  res.json(db.prepare('SELECT ts,username,action,detail FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

/* ================= AI 病历登记 =================
   独立模块，注入既有辅助函数以复用同一套业务规则（单位换算、
   镜像事件、用药冲突、手术日期同步），避免出现第二套逻辑。
   未配置 DASHSCOPE_API_KEY 时自动进入离线演练模式，不发任何网络请求。
   注意：必须在错误处理中间件之前注册，否则模块内抛出的异常不会被捕获。 */
registerAiIntake({
  app, db, auth, uploadDir,
  h: {
    normDate, parsePsaValue, assertNotFuture, assertAliveForRecord,
    ensurePsaMirrorEvent, ensureTestoMirrorEvent,
    validateEventBody, validateMedicationBody, findMedicationConflict, syncSurgDate,
    validatePathologyBody, validateImagingBody, validateRadiationBody, validateOutcomeBody,
    savePathologyForEvent, saveImagingForEvent, saveRadiationForEvent, saveOutcomeForEvent,
    validateLabValueBody, validateClinicalRecordBody, rebuildLabEvent, syncLineMedications,
    validateTreatmentLineBody, insertTreatmentAgents, registerFileAsset,
    saveVisitRow, insertAdverseEvent, getVisitOf, getEpisodeOf,
    logAudit, getP, buildPatient, nextPatientId, requireOwn,
    canAccess, isAdmin, numOrNull, ageFromBirth, LAB_EVENT_TYPE, RP_EVENT_TYPE
  }
});

backfillFileAssets();

/* ================= 错误处理与启动 ================= */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

/* 默认只监听本机回环地址：外部流量必须经 Nginx 反向代理进入，
   从而保证 TLS 终结、真实 IP 传递（限流依赖）与统一防护都在 Nginx 层生效。
   若绑定全部网卡，一旦安全组或 ufw 放开 3000，应用即被明文直连，
   JWT 令牌与登录口令将绕过 HTTPS 裸传。特殊场景可用 HOST 环境变量显式覆盖。 */
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  /* 注意：deploy.sh 用 STARTUP_MARK="服务已启动" 校验启动成功，改动本行文案时必须保留该子串 */
  console.log('🏥 XX医院前列腺癌数据库服务已启动');
  console.log('   监听: ' + HOST + ':' + PORT + (HOST === '127.0.0.1' ? '（仅本机，外部经 Nginx 访问）' : ''));
  console.log('   数据库: ' + dbFile);
  console.log('   患者数: ' + db.prepare('SELECT COUNT(*) AS n FROM patients').get().n);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
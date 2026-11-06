/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * 化验/监测统一目录（P1-12）
 *
 * 一个项目只进一张表：
 *   - target='lab'      -> lab_values
 *   - target='clinical' -> clinical_records（带 category）
 *   - reject='psa'/'testosterone' -> 必须走 psa_records/testosterone_records
 *
 * 该文件同时被 server.js 与 lib/ai-intake.mjs 引用，避免前后端/提示词各写一套。
 * 前端 public/index.html 只需要一份用于下拉展示的轻量副本（见 renderLabPanel）。
 * ========================================================= */

export const LAB_ITEMS = [
  /* 普通化验 -> lab_values */
  { code: 'CREAT', label: '肌酐', unit: 'μmol/L', target: 'lab', aliases: ['肌酐', '血肌酐', 'scr', 'creatinine'] },
  { code: 'EGFR', label: 'eGFR', unit: 'mL/min/1.73m²', target: 'lab', aliases: ['egfr', '肾小球滤过率', '估算肾小球滤过率'] },
  { code: 'CA', label: '血钙', unit: 'mmol/L', target: 'lab', aliases: ['钙', '血钙', 'ca'] },
  { code: 'GLU', label: '空腹血糖', unit: 'mmol/L', target: 'lab', aliases: ['血糖', '空腹血糖', 'glu'] },
  { code: 'TC', label: '总胆固醇', unit: 'mmol/L', target: 'lab', aliases: ['总胆固醇', 'tc', '胆固醇'] },
  { code: 'TG', label: '甘油三酯', unit: 'mmol/L', target: 'lab', aliases: ['甘油三酯', 'tg'] },
  { code: 'HB', label: '血红蛋白', unit: 'g/L', target: 'lab', aliases: ['血红蛋白', '血色素', 'hb', 'hemoglobin'] },
  { code: 'WBC', label: '白细胞计数', unit: '×10^9/L', target: 'lab', aliases: ['白细胞', '白细胞计数', 'wbc'] },
  { code: 'ANC', label: '中性粒细胞绝对计数', unit: '×10^9/L', target: 'lab', aliases: ['anc', '中性粒细胞', '中性粒细胞绝对计数', '中性粒细胞计数'] },
  { code: 'PLT', label: '血小板计数', unit: '×10^9/L', target: 'lab', aliases: ['血小板', '血小板计数', 'plt'] },
  { code: 'ALT', label: 'ALT', unit: 'U/L', target: 'lab', aliases: ['alt', '谷丙转氨酶', '丙氨酸氨基转移酶', 'sgpt'] },
  { code: 'AST', label: 'AST', unit: 'U/L', target: 'lab', aliases: ['ast', '谷草转氨酶', '天门冬氨酸氨基转移酶', 'sgot'] },
  { code: 'ALP', label: 'ALP', unit: 'U/L', target: 'lab', aliases: ['alp', '碱性磷酸酶'] },
  { code: 'GGT', label: 'GGT', unit: 'U/L', target: 'lab', aliases: ['ggt', 'γ-谷氨酰转肽酶', '谷氨酰转肽酶'] },
  { code: 'LDH', label: 'LDH', unit: 'U/L', target: 'lab', aliases: ['ldh', '乳酸脱氢酶'] },
  { code: 'ALB', label: '白蛋白', unit: 'g/L', target: 'lab', aliases: ['白蛋白', 'alb', 'albumin'] },
  { code: 'TBIL', label: '总胆红素', unit: 'μmol/L', target: 'lab', aliases: ['总胆红素', 'tbil', '胆红素'] },
  { code: 'CTC', label: 'CTC', unit: '个/7.5mL', target: 'lab', aliases: ['ctc', '循环肿瘤细胞'] },
  { code: 'CEA', label: 'CEA', unit: 'ng/mL', target: 'lab', aliases: ['cea', '癌胚抗原'] },
  { code: 'CGA', label: 'CGA', unit: 'ng/mL', target: 'lab', aliases: ['cga', '嗜铬粒蛋白a'] },
  { code: 'NSE', label: 'NSE', unit: 'ng/mL', target: 'lab', aliases: ['nse', '神经元特异性烯醇化酶'] },

  /* 监测/QoL -> clinical_records */
  { code: 'DEXA_T', label: '骨密度T值', unit: 'T', target: 'clinical', category: 'bone', aliases: ['dexa', '骨密度', '骨密度t值', 't值', 't-score'] },
  { code: 'FRAX_HIP', label: 'FRAX髋部10年风险', unit: '%', target: 'clinical', category: 'bone', aliases: ['frax', 'frax髋部', '髋部骨折风险'] },
  { code: 'FRAX_MAJOR', label: 'FRAX主要骨质疏松骨折风险', unit: '%', target: 'clinical', category: 'bone', aliases: ['frax主要', '主要骨质疏松性骨折'] },
  { code: 'CALCIUM_VITD', label: '钙/维生素D', unit: '', target: 'clinical', category: 'bone', aliases: ['钙+维生素d', '钙/维生素d'] },
  { code: 'ANTIRESORPTIVE', label: '抗骨吸收药', unit: '', target: 'clinical', category: 'bone', aliases: ['抗骨吸收药'] },
  { code: 'DENTAL', label: '口腔评估', unit: '', target: 'clinical', category: 'bone', aliases: ['口腔评估'] },
  { code: 'BP_SYS', label: '收缩压', unit: 'mmHg', target: 'clinical', category: 'cardio', aliases: ['收缩压', 'sbp', '血压收缩'] },
  { code: 'BP_DIA', label: '舒张压', unit: 'mmHg', target: 'clinical', category: 'cardio', aliases: ['舒张压', 'dbp', '血压舒张'] },
  { code: 'LDL', label: 'LDL-C', unit: 'mmol/L', target: 'clinical', category: 'cardio', aliases: ['ldl', 'ldl-c', '低密度脂蛋白'] },
  { code: 'HBA1C', label: 'HbA1c', unit: '%', target: 'clinical', category: 'cardio', aliases: ['hba1c', '糖化血红蛋白'] },
  { code: 'BMI', label: 'BMI', unit: 'kg/m²', target: 'clinical', category: 'cardio', aliases: ['bmi', '体质指数'] },
  { code: 'SMOKING', label: '吸烟', unit: '', target: 'clinical', category: 'cardio', aliases: ['吸烟', '吸烟史'] },
  { code: 'CVD_HISTORY', label: 'CVD 病史', unit: '', target: 'clinical', category: 'cardio', aliases: ['cvd', '心血管病史'] },
  { code: 'IPSS', label: 'IPSS 排尿评分', unit: '分', target: 'clinical', category: 'qol', aliases: ['ipss', '排尿评分'] },
  { code: 'IIEF5', label: 'IIEF-5', unit: '分', target: 'clinical', category: 'qol', aliases: ['iief-5', 'iief5', '性功能评分'] },
  { code: 'EPIC26', label: 'EPIC-26', unit: '分', target: 'clinical', category: 'qol', aliases: ['epic-26', 'epic26'] },
  { code: 'PAIN_NRS', label: '疼痛NRS', unit: '分', target: 'clinical', category: 'qol', aliases: ['nrs', '疼痛nrs', '疼痛评分'] },
  { code: 'GAD2', label: 'GAD-2', unit: '分', target: 'clinical', category: 'qol', aliases: ['gad-2', 'gad2'] },
  { code: 'PHQ2', label: 'PHQ-2', unit: '分', target: 'clinical', category: 'qol', aliases: ['phq-2', 'phq2'] },
  { code: 'ECOG', label: 'ECOG', unit: '分', target: 'clinical', category: 'qol', aliases: ['ecog', '体能评分'] }
];

const ALIAS = new Map();
for (const item of LAB_ITEMS) {
  ALIAS.set(item.code.toLowerCase(), item);
  ALIAS.set(item.label.toLowerCase(), item);
  for (const a of item.aliases || []) ALIAS.set(String(a).toLowerCase().replace(/\s+/g, ''), item);
}

const REJECT = [
  { re: /总psa|t-psa|tpsa|游离psa|f-psa|fpsa|前列腺特异抗原|free psa|^psa$/i, kind: 'psa' },
  { re: /睾酮|testosterone/i, kind: 'testosterone' }
];

export function resolveLabItem(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  for (const r of REJECT) if (r.re.test(s)) return { reject: r.kind };
  const key = s.toLowerCase().replace(/\s+/g, '');
  const hit = ALIAS.get(key) || ALIAS.get(s.toLowerCase());
  if (hit) return hit;
  /* 未收录项目：仍允许写入 lab_values，使用清洗后的项目名作为 code。
     这样不会把“新化验项目”静默丢掉；UI 按 label 展示。 */
  return { code: s.slice(0, 30).toUpperCase(), label: s.slice(0, 60), unit: '', target: 'lab', aliases: [] };
}

export function labItemByCode(code) {
  return LAB_ITEMS.find(x => x.code === code) || null;
}

/* 临床监测项目的历史别名：SBP/DBP 是旧目录，BP_SYS/BP_DIA 是当前目录。
   P2-18：写入、导入、AI 采纳都先归一化；启动迁移再把历史行改过来。 */
export function canonicalClinicalItem(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const resolved = resolveLabItem(s);
  if (resolved && !resolved.reject && resolved.target === 'clinical') return resolved.code;
  return s;
}

export function labTargetLabel(item) {
  if (!item) return '';
  return item.target === 'clinical' ? ('临床监测 · ' + (item.category || '')) : '普通化验';
}

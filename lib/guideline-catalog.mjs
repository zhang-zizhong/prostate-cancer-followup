/* =========================================================
 * 前列腺癌诊疗指南目录（CSCO 2026 · 四图总览）
 * ---------------------------------------------------------
 * 本文件是「治疗选项 / 随访模板 / 毒性分级 / 药物剂量 / 合并症」
 * 的唯一来源。前端通过 GET /api/catalog 读取，服务端校验也读这里。
 *
 * 设计原则：
 *  1. 目录只描述「指南允许什么」，不描述「这个患者做了什么」；
 *     患者数据在 treatment_episodes / visits / adverse_events 等表。
 *  2. 每个治疗选项都带 figure / scenario / level / source，
 *     方便页面显示「为什么推荐」和导出时做指南一致性分析。
 *  3. 记录册的四个治疗段、18/21 项合并症、16 个毒性术语全部在这里，
 *     页面不再硬编码第二套列表。
 *  4. 记录册原文写「18 个具名合并症」，但 p2 实拍页实际列出 21 个勾选项；
 *     这里按实拍页列全 21 项，并在 note 中标明差异。
 * ========================================================= */

export const CATALOG_VERSION = '2026.11.04-v1';

/* ---------------- 四图元数据 ---------------- */
export const FIGURES = [
  {
    id: 'fig1', title: '图一 · 局限期治疗与复发', short: '局限期',
    chapters: '第 5–6 章', nodes: 75,
    source: 'CSCO 2026 图一（5.5/5.6/6.1–6.3）',
    ref: '.archify/overview-prostate-20261104-025500/前列腺癌诊疗路径_总览.html#sec-d1'
  },
  {
    id: 'fig2', title: '图二 · 转移、去势抵抗与亚型', short: '转移/CRPC',
    chapters: '第 7–9 章', nodes: 102,
    source: 'CSCO 2026 图二（第 7–9 章）',
    ref: '.archify/overview-prostate-20261104-025500/前列腺癌诊疗路径_总览.html#sec-d2'
  },
  {
    id: 'fig3', title: '图三 · 筛查、诊断与分期', short: '诊断',
    chapters: '第 1–4 章', nodes: 48,
    source: 'CSCO 2026 图三（第 1–4 章）',
    ref: '.archify/overview-prostate-20261104-025500/前列腺癌诊疗路径_总览.html#sec-d3'
  },
  {
    id: 'fig4', title: '图四 · 随访、并发症与用药', short: '随访',
    chapters: '第 10–11 章', nodes: 61,
    source: 'CSCO 2026 图四（第 10–11 章）',
    ref: '.archify/overview-prostate-20261104-025500/前列腺癌诊疗路径_总览.html#sec-d4'
  }
];

/* ---------------- 疾病状态机（图三/图一/图二共用） ---------------- */
export const DISEASE_STATES = [
  { code: 'S0', label: '已建档', definition: '只有 PSA + DRE，无结论', enters: '新建档案' },
  { code: 'S1', label: '疑癌待查', definition: '有穿刺/影像指征，未取材', enters: 'S0 触发指征' },
  { code: 'S2', label: '待诊断', definition: '有病理或影像，未完成分期/分层', enters: 'S1 出结果；S6 再评估；TURP 偶发癌' },
  { code: 'S3', label: '已确诊待治疗', definition: '有诊断 + 分期 + 风险', enters: 'S2 完成' },
  { code: 'S4', label: '治疗中', definition: '有在程治疗线', enters: 'S3 启动治疗' },
  { code: 'S5', label: '随访中', definition: '治疗结束或主动监测', enters: 'S4 完成' },
  { code: 'S6', label: '可疑复发', definition: 'PSA 上升或影像可疑，未达判定标准', enters: 'S5 复查异常' },
  { code: 'S7', label: '复发/进展', definition: 'BCR / CRPC / 转移已确认', enters: 'S2 或 S6 确认' },
  { code: 'S8', label: '终止', definition: '死亡 / 失访 / 转院', enters: '任一状态' },
  { code: 'B1', label: '良性·检查', definition: 'BPH/前列腺炎检查', enters: 'S0 排除癌' },
  { code: 'B2', label: '良性·诊断', definition: 'BPH/前列腺炎/HGPIN', enters: 'B1 出结果' },
  { code: 'B3', label: '良性·治疗', definition: '药物/手术', enters: 'B2 完成' },
  { code: 'B4', label: '良性·随访', definition: 'IPSS/PSA/体积/Qmax 随访', enters: 'B3 完成' }
];

/* ---------------- CSCO 2026 危险分层 ---------------- */
export const RISK_STRATA = [
  { code: 'low', label: '低危', criteria: 'cT1–2a 且 ISUP 1 且 PSA<10', figure: 'fig1', row: '低危' },
  { code: 'favorable_intermediate', label: '中危（有利）', criteria: '1 个中危因素 + ISUP 1–2 + 穿刺阳性 <50%', figure: 'fig1', row: '中危' },
  { code: 'unfavorable_intermediate', label: '中危（不利）', criteria: '2–3 个中危因素，或 ISUP 3，或穿刺阳性 ≥50%', figure: 'fig1', row: '中危' },
  { code: 'high', label: '高危', criteria: '不达极高危，且 cT3–4 / ISUP 4–5 / PSA>20 任一', figure: 'fig1', row: '高危/极高危' },
  { code: 'very_high', label: '极高危', criteria: 'cT3–4、ISUP 4–5、PSA>40 中至少 2 项', figure: 'fig1', row: '高危/极高危' },
  { code: 'cN1', label: '区域淋巴结转移', criteria: 'cN1M0', figure: 'fig1', row: 'cN1M0' },
  { code: 'M1', label: '初诊即转移', criteria: 'de novo M1', figure: 'fig2', row: 'mHSPC' }
];

/* ---------------- 场景 ---------------- */
/* state: 该场景对应的疾病状态；derived: 自动判断所需字段说明 */
export const SCENARIOS = [
  { key: 'localized_low', figure: 'fig1', group: '局限期', label: '局限期 · 低危', state: 'S3', derived: 'cT1–2a + ISUP 1 + PSA<10' },
  { key: 'localized_favorable_intermediate', figure: 'fig1', group: '局限期', label: '局限期 · 中危（有利）', state: 'S3', derived: '1 个中危因素 + ISUP 1–2 + 穿刺阳性 <50%' },
  { key: 'localized_unfavorable_intermediate', figure: 'fig1', group: '局限期', label: '局限期 · 中危（不利）', state: 'S3', derived: '2–3 个中危因素 / ISUP 3 / 穿刺阳性 ≥50%' },
  { key: 'localized_high', figure: 'fig1', group: '局限期', label: '局限期 · 高危', state: 'S3', derived: 'cT3–4 / ISUP 4–5 / PSA>20 且未达极高危' },
  { key: 'localized_very_high', figure: 'fig1', group: '局限期', label: '局限期 · 极高危', state: 'S3', derived: '极高危三项中 ≥2 项' },
  { key: 'cN1', figure: 'fig1', group: '局限期', label: '区域淋巴结转移 cN1M0', state: 'S3', derived: '影像/病理 N1，M0' },
  { key: 'post_op_pN0_no_adverse', figure: 'fig1', group: '术后', label: '术后 · pN0 无不良病理', state: 'S5', derived: 'RP 病理 pN0，切缘阴性、无 ECE/SVI' },
  { key: 'post_op_pN0_adverse', figure: 'fig1', group: '术后', label: '术后 · pN0 有不良病理', state: 'S5', derived: 'RP 病理 pN0，切缘阳性/ECE/SVI 任一' },
  { key: 'post_op_pN1_low', figure: 'fig1', group: '术后', label: '术后 · pN1（1–2 枚）', state: 'S5', derived: 'RP 病理 pN1，阳性淋巴结 1–2 枚' },
  { key: 'post_op_pN1_high', figure: 'fig1', group: '术后', label: '术后 · pN1 高危', state: 'S5', derived: 'RP 病理 pN1，高危特征' },
  { key: 'bcr_post_rp_no_met', figure: 'fig1', group: '复发', label: 'RP 后生化复发 · 无转移', state: 'S7', derived: 'RP 后连续 2 次 PSA≥0.1，传统影像阴性' },
  { key: 'bcr_post_rp_met', figure: 'fig1', group: '复发', label: 'RP 后复发 · 有转移', state: 'S7', derived: 'RP 后 BCR + 影像转移' },
  { key: 'bcr_post_rt_psadt_low', figure: 'fig1', group: '复发', label: 'RT 后复发 · PSADT≤9 月', state: 'S7', derived: '放疗后 nadir+2，PSADT≤9 月' },
  { key: 'bcr_post_rt_psadt_high', figure: 'fig1', group: '复发', label: 'RT 后复发 · PSADT>9 月', state: 'S7', derived: '放疗后 nadir+2，PSADT>9 月' },
  { key: 'bcr_post_rt_psadt_unknown', figure: 'fig1', group: '复发', label: 'RT 后复发 · PSADT 待补', state: 'S7', derived: '放疗后 nadir+2，但 PSA 序列不足，无法计算 PSADT' },
  { key: 'oligo_progression', figure: 'fig1', group: '复发', label: '观察/ADT 进展 · 寡转移', state: 'S7', derived: '传统影像 1–5 处，适合 MDT' },
  { key: 'mHSPC_sync_low', figure: 'fig2', group: 'mHSPC', label: 'mHSPC · 同时性低瘤/寡转移', state: 'S4', derived: '初诊 M1 + 低瘤负荷/寡转移' },
  { key: 'mHSPC_meta_low', figure: 'fig2', group: 'mHSPC', label: 'mHSPC · 异时性低瘤/寡转移', state: 'S4', derived: '治疗后出现 M1 + 低瘤负荷/寡转移' },
  { key: 'mHSPC_high', figure: 'fig2', group: 'mHSPC', label: 'mHSPC · 高瘤负荷', state: 'S4', derived: '内脏转移，或 ≥4 骨转移且 ≥1 处在盆腔/脊柱外' },
  { key: 'mHSPC_burden_unknown', figure: 'fig2', group: 'mHSPC', label: 'mHSPC · 瘤负荷未评估', state: 'S4', derived: '缺转移灶数量/是否盆腔外/内脏转移，先补负荷再选方案' },
  { key: 'nmCRPC', figure: 'fig2', group: 'CRPC', label: 'nmCRPC', state: 'S4', derived: '睾酮<50 + PSA 进展，传统影像阴性' },
  { key: 'mCRPC_1L', figure: 'fig2', group: 'CRPC', label: 'mCRPC · 未经 ARPI 一线', state: 'S4', derived: 'mCRPC 且未用过 ARPI' },
  { key: 'mCRPC_2L_arpi_fail', figure: 'fig2', group: 'CRPC', label: 'mCRPC · ARPI 失败未化疗', state: 'S4', derived: 'mCRPC，ARPI 失败，未化疗' },
  { key: 'mCRPC_2L_arpi_chemo_fail', figure: 'fig2', group: 'CRPC', label: 'mCRPC · ARPI+化疗失败', state: 'S4', derived: 'mCRPC，ARPI 和化疗均失败' },
  { key: 'mCRPC_any', figure: 'fig2', group: 'CRPC', label: 'mCRPC · 无论既往用药', state: 'S4', derived: 'mCRPC 特定情况' },
  { key: 'bone_events', figure: 'fig2', group: '支持', label: '骨相关事件 · 全程管理', state: 'S4', derived: '骨痛/病理性骨折/脊髓压迫/骨转移' },
  { key: 'subtype_dac', figure: 'fig2', group: '亚型', label: '导管腺癌 DAC', state: 'S3', derived: '病理 histology_type=ductal' },
  { key: 'subtype_idcp', figure: 'fig2', group: '亚型', label: '导管内癌 IDC-P', state: 'S3', derived: '病理 idc_p=1' },
  { key: 'subtype_nepc', figure: 'fig2', group: '亚型', label: '神经内分泌癌 NEPC', state: 'S3', derived: '病理 nepc=1 / 神经内分泌分化' },
  { key: 'subtype_mesenchymal', figure: 'fig2', group: '亚型', label: '间叶源性肿瘤', state: 'S3', derived: '病理间叶源性（平滑肌肉瘤等）' }
];

/* ---------------- 组件与选项辅助 ---------------- */
const ADT = {
  type: 'adt', drugClass: 'LHRH 激动剂/拮抗剂或手术去势',
  choices: ['戈舍瑞林', '亮丙瑞林', '曲普瑞林', '地加瑞克', '手术去势']
};
const ARPI = {
  type: 'arpi', drugClass: '新型内分泌治疗',
  choices: ['阿比特龙+泼尼松', '恩扎卢胺', '阿帕他胺', '达罗他胺', '瑞维鲁胺', '氘恩扎卢胺']
};
const DOC = { type: 'chemo', drug: '多西他赛', dose: '75mg/m² q3w' };
const RT = { type: 'rt', label: '放射治疗' };
const RP = { type: 'surgery', procedure: '根治性前列腺切除术' };
const AS = { type: 'surveillance', mode: 'active_surveillance' };
const WW = { type: 'surveillance', mode: 'watchful_waiting' };
const OBS = { type: 'surveillance', mode: 'observation' };

function opt(id, scenario, label, level, extra = {}) {
  return {
    id, scenario, label, level,
    figure: extra.figure || (String(scenario).startsWith('localized') || String(scenario).startsWith('cN1') || String(scenario).startsWith('post_op') || String(scenario).startsWith('bcr_post_rp') || String(scenario).startsWith('bcr_post_rt') || String(scenario).startsWith('oligo') ? 'fig1' : 'fig2'),
    components: extra.components || [],
    prerequisites: extra.prerequisites || [],
    monitoring: extra.monitoring || '',
    source: extra.source || '',
    evidence: extra.evidence || '',
    availability: extra.availability || 'center',
    note: extra.note || '',
    tags: extra.tags || []
  };
}

/* ---------------- 图一：局限期 ---------------- */
const FIG1_OPTIONS = [
  /* 低危 */
  opt('loc_low_as', 'localized_low', '主动监测（AS）', 'I/1A', {
    components: [AS], source: '图一 · 低危 · 5.5',
    prerequisites: ['预期寿命≥10 年', 'ISUP 1（ISUP 3 不做 AS）'],
    monitoring: 'PSA 每 6 月、DRE 每 12 月、mpMRI 每 12 月、重复活检每 2–3 年'
  }),
  opt('loc_low_ww', 'localized_low', '观察等待（WW）', 'I/1B', {
    components: [WW], source: '图一 · 低危 · 5.5',
    prerequisites: ['预期寿命<10 年或无症状'], monitoring: 'PSA/症状，按需'
  }),
  opt('loc_low_rp', 'localized_low', '根治性前列腺切除（RP）', 'I/1A', {
    components: [RP], source: '图一 · 低危 · 5.5', monitoring: '术后 6–12 周 PSA，之后 3–6 月'
  }),
  opt('loc_low_rt', 'localized_low', '放射治疗（RT）', 'I/1A', {
    components: [RT], source: '图一 · 低危 · 5.5', monitoring: 'PSA 3–6 月，DRE/影像至少每年'
  }),
  opt('loc_low_focal', 'localized_low', '局灶治疗（HIFU/冷冻/IRE 等）', 'III/3类', {
    components: [{ type: 'focal', procedure: '局灶治疗' }], source: '图一 · 低危 · 5.5',
    note: '仅限低危、选择性患者；需 MDT/临床试验框架'
  }),

  /* 中危 */
  opt('loc_int_rp_plnd', 'localized_favorable_intermediate', 'RP ± 盆腔淋巴结清扫', 'I/1A', {
    components: [RP, { type: 'surgery', procedure: '盆腔淋巴结清扫（按风险）' }], source: '图一 · 中危 · 5.5'
  }),
  opt('loc_int_rt_adt', 'localized_favorable_intermediate', 'RT ± 4–6 月 ADT', 'I/1A', {
    components: [RT, { type: 'adt', drug: 'ADT', durationMonths: 6 }], source: '图一 · 中危 · 5.5'
  }),
  opt('loc_int_focal', 'localized_favorable_intermediate', '局灶治疗', 'II/2B', {
    components: [{ type: 'focal', procedure: '局灶治疗' }], source: '图一 · 中危 · 5.5'
  }),
  opt('loc_int_as', 'localized_favorable_intermediate', '主动监测（选择性）', 'III/3类', {
    components: [AS], source: '图一 · 中危 · 5.5', prerequisites: ['有利中危、极低负荷、患者意愿']
  }),
  opt('loc_int_ww', 'localized_favorable_intermediate', '观察等待', 'II/2B', {
    components: [WW], source: '图一 · 中危 · 5.5', prerequisites: ['预期寿命有限/无症状']
  }),
  opt('loc_int_unf_rp', 'localized_unfavorable_intermediate', 'RP ± 盆腔淋巴结清扫', 'I/1A', {
    components: [RP, { type: 'surgery', procedure: '盆腔淋巴结清扫（按风险）' }], source: '图一 · 中危（不利）· 5.5'
  }),
  opt('loc_int_unf_rt', 'localized_unfavorable_intermediate', 'RT + ADT', 'I/1A', {
    components: [RT, { type: 'adt', drug: 'ADT', durationMonths: 6 }], source: '图一 · 中危（不利）· 5.5'
  }),
  opt('loc_int_unf_rt_brachy', 'localized_unfavorable_intermediate', 'EBRT + LDR/HDR 加量', 'II/2A', {
    components: [RT, { type: 'brachy', label: '近距离放疗加量' }], source: '图一 · 中危（不利）· 5.5'
  }),

  /* 高危/极高危 */
  opt('loc_high_rp_eplnd', 'localized_high', 'RP + 扩大盆腔淋巴结清扫', 'I/1A', {
    components: [RP, { type: 'surgery', procedure: '扩大盆腔淋巴结清扫' }], source: '图一 · 高危 · 5.5'
  }),
  opt('loc_high_rt_adt', 'localized_high', 'RT + ADT 2–3 年', 'I/1A', {
    components: [RT, { type: 'adt', drug: 'ADT', durationMonths: 30 }], source: '图一 · 高危 · 5.5'
  }),
  opt('loc_very_high_rt_adt_abi', 'localized_very_high', 'RT + ADT + 阿比特龙 2 年', 'II/2A', {
    components: [RT, { type: 'adt', drug: 'ADT', durationMonths: 36 }, { type: 'arpi', drug: '阿比特龙+泼尼松', durationMonths: 24 }],
    source: '图一 · 极高危 · 5.5', note: '2026 更新：极高危联合阿比特龙'
  }),
  opt('loc_high_pall_adt', 'localized_high', '姑息性 ADT', 'II/2A', {
    components: [ADT], source: '图一 · 高危 · 5.5', prerequisites: ['预期寿命≤5 年或不宜根治']
  }),
  opt('loc_high_obs', 'localized_high', '观察（无症状）', 'II/2B', {
    components: [OBS], source: '图一 · 高危 · 5.5', prerequisites: ['无症状、预期寿命有限']
  }),

  /* cN1M0 */
  opt('cn1_rp_eplnd', 'cN1', 'RP + ePLND', 'II/2A', {
    components: [RP, { type: 'surgery', procedure: '扩大盆腔淋巴结清扫' }], source: '图一 · cN1M0 · 5.6'
  }),
  opt('cn1_ebrt_adt', 'cN1', 'EBRT + ADT 2–3 年', 'I/1B', {
    components: [RT, { type: 'adt', drug: 'ADT', durationMonths: 30 }], source: '图一 · cN1M0 · 5.6'
  }),
  opt('cn1_ebrt_adt_abi', 'cN1', 'EBRT + ADT + 阿比特龙', 'I/1B', {
    components: [RT, ADT, { type: 'arpi', drug: '阿比特龙+泼尼松', durationMonths: 24 }], source: '图一 · cN1M0 · 5.6'
  }),
  opt('cn1_adt', 'cN1', 'ADT', 'II/2A', { components: [ADT], source: '图一 · cN1M0 · 5.6' }),
  opt('cn1_obs', 'cN1', '观察（≤5 年）', 'II/2B', { components: [OBS], source: '图一 · cN1M0 · 5.6' }),

  /* 术后病理 */
  opt('post_pn0_no_adv_obs', 'post_op_pN0_no_adverse', '观察随访', 'I/1A', {
    components: [OBS], source: '图一 · 术后 pN0 无不良 · 6.1'
  }),
  opt('post_pn0_adv_ebrt_adt', 'post_op_pN0_adverse', 'EBRT ± ADT', 'II/2A', {
    components: [RT, { type: 'adt', drug: 'ADT（按需）' }], source: '图一 · 术后 pN0 有不良 · 6.1'
  }),
  opt('post_pn0_adv_ebrt', 'post_op_pN0_adverse', 'EBRT（辅助/挽救）', 'I/1A', {
    components: [RT], source: '图一 · 术后 pN0 有不良 · 6.1'
  }),
  opt('post_pn1_adt', 'post_op_pN1_low', 'ADT', 'I/1A', { components: [ADT], source: '图一 · 术后 pN1 · 6.1' }),
  opt('post_pn1_adt_ebrt', 'post_op_pN1_low', 'ADT + EBRT', 'II/2A', {
    components: [ADT, RT], source: '图一 · 术后 pN1 · 6.1'
  }),
  opt('post_pn1_low_obs', 'post_op_pN1_low', '观察随访（1–2 枚）', 'I/1B', {
    components: [OBS], source: '图一 · 术后 pN1 1–2 枚 · 6.1'
  }),
  opt('post_pn1_high_adt_abi', 'post_op_pN1_high', 'ADT + 阿比特龙', 'II/2A', {
    components: [ADT, { type: 'arpi', drug: '阿比特龙+泼尼松' }], source: '图一 · 术后 pN1 高危 · 6.1'
  }),

  /* RP 后 BCR */
  opt('bcr_rp_srt', 'bcr_post_rp_no_met', '挽救性放疗（SRT，≥64Gy）', 'I/1A', {
    components: [RT], source: '图一 · 6.1 无转移 · 6.1', prerequisites: ['PSA>0.2 或持续上升', '影像无远处转移']
  }),
  opt('bcr_rp_srt_adt', 'bcr_post_rp_no_met', '挽救性 RT + ADT', 'I/1A', {
    components: [RT, ADT], source: '图一 · 6.1 无转移 · 6.1'
  }),
  opt('bcr_rp_adt', 'bcr_post_rp_no_met', 'ADT', 'II/2A', { components: [ADT], source: '图一 · 6.1 无转移 · 6.1' }),
  opt('bcr_rp_obs', 'bcr_post_rp_no_met', '观察随访', 'II/2A', { components: [OBS], source: '图一 · 6.1 无转移 · 6.1' }),
  opt('bcr_rp_rt_adt_abi_pn1', 'bcr_post_rp_no_met', 'RT + ADT ± 阿比特龙（pN1）', 'II/2B', {
    components: [RT, ADT, { type: 'arpi', drug: '阿比特龙+泼尼松（按需）' }], source: '图一 · 6.1 无转移 · 6.1'
  }),
  opt('bcr_rp_lnd', 'bcr_post_rp_no_met', '挽救性淋巴结清扫 + ADT', 'III/3类', {
    components: [{ type: 'surgery', procedure: '挽救性淋巴结清扫' }, ADT], source: '图一 · 6.1 无转移 · 6.1'
  }),
  opt('bcr_rp_adt_enza', 'bcr_post_rp_no_met', 'ADT + 恩扎卢胺', 'II/2B', {
    components: [ADT, { type: 'arpi', drug: '恩扎卢胺' }], source: '图一 · 6.1 无转移 · 6.1'
  }),
  opt('bcr_rp_adt_apa', 'bcr_post_rp_no_met', 'ADT + 阿帕他胺', 'III/3类', {
    components: [ADT, { type: 'arpi', drug: '阿帕他胺' }], source: '图一 · 6.1 无转移 · 6.1'
  }),
  opt('bcr_rp_met_systemic', 'bcr_post_rp_met', '全身治疗', 'I/1B', {
    components: [ADT, ARPI], source: '图一 · 6.1 有转移 · 6.1'
  }),
  opt('bcr_rp_met_rt', 'bcr_post_rp_met', '转移灶放疗', 'II/2A', {
    components: [{ type: 'rt', target: '转移灶' }], source: '图一 · 6.1 有转移 · 6.1'
  }),
  opt('oligo_mdt', 'oligo_progression', '转移灶定向治疗 / MDT', 'II/2A', {
    components: [{ type: 'mdt', label: 'MDT + 转移灶定向治疗' }], source: '图一 · 观察/ADT 进展 · 6.3'
  }),

  /* RT 后复发 */
  opt('bcr_rt_adt', 'bcr_post_rt_psadt_low', 'ADT', 'II/2A', { components: [ADT], source: '图一 · 6.2 放疗后复发' }),
  opt('bcr_rt_adt_abi_ln', 'bcr_post_rt_psadt_low', 'ADT ± 阿比特龙（淋巴结+）', 'II/2A', {
    components: [ADT, { type: 'arpi', drug: '阿比特龙+泼尼松（按需）' }], source: '图一 · 6.2 放疗后复发'
  }),
  opt('bcr_rt_adt_enza', 'bcr_post_rt_psadt_low', 'ADT + 恩扎卢胺', 'II/2B', {
    components: [ADT, { type: 'arpi', drug: '恩扎卢胺' }], source: '图一 · 6.2 放疗后复发'
  }),
  opt('bcr_rt_local', 'bcr_post_rt_psadt_low', '局部二次治疗（活检阳性）', 'III/3类', {
    components: [{ type: 'focal', procedure: '局部二次治疗' }], source: '图一 · 6.2 放疗后复发'
  }),
  opt('bcr_rt_obs', 'bcr_post_rt_psadt_high', '观察随访（PSADT>9 月）', 'I/1A', {
    components: [OBS], source: '图一 · 6.2 放疗后复发'
  })
];

/* ---------------- 图二：mHSPC ---------------- */
const FIG2_OPTIONS = [
  /* 同时性低瘤/寡转移 */
  opt('mhspc_sync_adt_arpi', 'mHSPC_sync_low', 'ADT + ARPI', 'I/1A', {
    components: [ADT, ARPI], source: '图二 · L1 同时性低瘤 · 7.2',
    note: 'ARPI 可选达罗他胺/阿比特龙/恩扎卢胺/阿帕他胺'
  }),
  opt('mhspc_sync_daro_doc', 'mHSPC_sync_low', 'ADT + 达罗他胺 + 多西他赛', 'I/1A', {
    components: [ADT, { type: 'arpi', drug: '达罗他胺' }, DOC], source: '图二 · L1 同时性低瘤 · 7.2'
  }),
  opt('mhspc_sync_adt_ebrt', 'mHSPC_sync_low', 'ADT + EBRT（原发灶）', 'I/1A', {
    components: [ADT, { type: 'rt', target: '原发灶' }], source: '图二 · L1 同时性低瘤 · 7.2'
  }),
  opt('mhspc_sync_adt_surgery', 'mHSPC_sync_low', 'ADT + 原发灶手术/近距离放疗', 'II/2B', {
    components: [ADT, { type: 'surgery', procedure: '原发灶手术' }], source: '图二 · L1 同时性低瘤 · 7.2'
  }),
  opt('mhspc_sync_adt_bica', 'mHSPC_sync_low', 'ADT + 比卡鲁胺', 'II/2B', {
    components: [ADT, { type: 'endocrine', drug: '比卡鲁胺' }], source: '图二 · L1 同时性低瘤 · 7.2'
  }),
  opt('mhspc_sync_adt_rezvil', 'mHSPC_sync_low', 'ADT + 瑞维鲁胺', 'II/2B', {
    components: [ADT, { type: 'arpi', drug: '瑞维鲁胺' }], source: '图二 · L1 同时性低瘤 · 7.2'
  }),
  opt('mhspc_sync_arpi_lu', 'mHSPC_sync_low', 'ADT + ARPI + ¹⁷⁷Lu-PSMA-617', 'II/1B', {
    components: [ADT, ARPI, { type: 'nuclide', drug: '¹⁷⁷Lu-PSMA-617' }], source: '图二 · L1 同时性低瘤 · 7.2',
    prerequisites: ['PSMA 阳性']
  }),
  opt('mhspc_sync_tala_enza', 'mHSPC_sync_low', 'ADT + 他拉唑帕利 + 恩扎卢胺', 'II/1B', {
    components: [ADT, { type: 'parpi', drug: '他拉唑帕利' }, { type: 'arpi', drug: '恩扎卢胺' }],
    source: '图二 · L1 同时性低瘤 · 7.2', prerequisites: ['HRR 阳性']
  }),
  opt('mhspc_sync_nira_abi', 'mHSPC_sync_low', 'ADT + 尼拉帕利 + 阿比特龙', 'II/1B', {
    components: [ADT, { type: 'parpi', drug: '尼拉帕利' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L1 同时性低瘤 · 7.2', prerequisites: ['BRCA 阳性']
  }),
  opt('mhspc_sync_capiva_abi', 'mHSPC_sync_low', 'ADT + 卡匹色替 + 阿比特龙', 'II/1B', {
    components: [ADT, { type: 'targeted', drug: '卡匹色替' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L1 同时性低瘤 · 7.2', prerequisites: ['PTEN/AKT 通路改变']
  }),
  opt('mhspc_sync_intermittent_adt', 'mHSPC_sync_low', '间歇性 ADT', 'III/2B', {
    components: [ADT], source: '图二 · L1 同时性低瘤 · 7.2'
  }),
  opt('mhspc_sync_adt_cryo', 'mHSPC_sync_low', 'ADT + 冷冻治疗', 'III/3类', {
    components: [ADT, { type: 'focal', procedure: '冷冻治疗' }], source: '图二 · L1 同时性低瘤 · 7.2'
  }),
  opt('mhspc_sync_adt_mono', 'mHSPC_sync_low', 'ADT 单药', 'III/2B', { components: [ADT], source: '图二 · L1 同时性低瘤 · 7.2' }),

  /* 异时性低瘤/寡转移 */
  opt('mhspc_meta_mdt_adt', 'mHSPC_meta_low', '转移灶定向治疗 + ADT', 'I/1A', {
    components: [{ type: 'mdt', label: '转移灶定向治疗' }, ADT], source: '图二 · L2 异时性低瘤 · 7.2',
    prerequisites: ['仅寡转移']
  }),
  opt('mhspc_meta_adt_arpi', 'mHSPC_meta_low', 'ADT + ARPI', 'I/1A', { components: [ADT, ARPI], source: '图二 · L2 异时性低瘤 · 7.2' }),
  opt('mhspc_meta_adt_bica', 'mHSPC_meta_low', 'ADT + 比卡鲁胺', 'II/2B', {
    components: [ADT, { type: 'endocrine', drug: '比卡鲁胺' }], source: '图二 · L2 异时性低瘤 · 7.2'
  }),
  opt('mhspc_meta_adt_rezvil', 'mHSPC_meta_low', 'ADT + 瑞维鲁胺', 'II/2B', {
    components: [ADT, { type: 'arpi', drug: '瑞维鲁胺' }], source: '图二 · L2 异时性低瘤 · 7.2'
  }),
  opt('mhspc_meta_arpi_lu', 'mHSPC_meta_low', 'ADT + ARPI + ¹⁷⁷Lu', 'II/1B', {
    components: [ADT, ARPI, { type: 'nuclide', drug: '¹⁷⁷Lu-PSMA-617' }], source: '图二 · L2 异时性低瘤 · 7.2',
    prerequisites: ['PSMA 阳性']
  }),
  opt('mhspc_meta_tala_enza', 'mHSPC_meta_low', 'ADT + 他拉唑帕利 + 恩扎', 'II/1B', {
    components: [ADT, { type: 'parpi', drug: '他拉唑帕利' }, { type: 'arpi', drug: '恩扎卢胺' }],
    source: '图二 · L2 异时性低瘤 · 7.2', prerequisites: ['HRR 阳性']
  }),
  opt('mhspc_meta_nira_abi', 'mHSPC_meta_low', 'ADT + 尼拉帕利 + 阿比特龙', 'II/1B', {
    components: [ADT, { type: 'parpi', drug: '尼拉帕利' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L2 异时性低瘤 · 7.2', prerequisites: ['BRCA 阳性']
  }),
  opt('mhspc_meta_capiva_abi', 'mHSPC_meta_low', 'ADT + 卡匹色替 + 阿比特龙', 'II/1B', {
    components: [ADT, { type: 'targeted', drug: '卡匹色替' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L2 异时性低瘤 · 7.2', prerequisites: ['PTEN/AKT 通路改变']
  }),

  /* 高瘤负荷 */
  opt('mhspc_high_daro_doc', 'mHSPC_high', 'ADT + 达罗他胺 + 多西他赛', 'I/1A', {
    components: [ADT, { type: 'arpi', drug: '达罗他胺' }, DOC], source: '图二 · L3 高瘤负荷 · 7.2'
  }),
  opt('mhspc_high_abi_doc', 'mHSPC_high', 'ADT + 阿比特龙 + 多西他赛', 'I/1A', {
    components: [ADT, { type: 'arpi', drug: '阿比特龙+泼尼松' }, DOC], source: '图二 · L3 高瘤负荷 · 7.2'
  }),
  opt('mhspc_high_adt_arpi', 'mHSPC_high', 'ADT + ARPI', 'I/1A', { components: [ADT, ARPI], source: '图二 · L3 高瘤负荷 · 7.2' }),
  opt('mhspc_high_doc', 'mHSPC_high', 'ADT + 多西他赛 ± 泼尼松', 'II/1B', {
    components: [ADT, DOC], source: '图二 · L3 高瘤负荷 · 7.2'
  }),
  opt('mhspc_high_rt_abi_doc', 'mHSPC_high', 'ADT + RT + 阿比特龙 ± 多西', 'II/2A', {
    components: [ADT, RT, { type: 'arpi', drug: '阿比特龙+泼尼松' }, DOC], source: '图二 · L3 高瘤负荷 · 7.2'
  }),
  opt('mhspc_high_bica', 'mHSPC_high', 'ADT + 比卡鲁胺', 'II/2B', {
    components: [ADT, { type: 'endocrine', drug: '比卡鲁胺' }], source: '图二 · L3 高瘤负荷 · 7.2'
  }),
  opt('mhspc_high_arpi_lu', 'mHSPC_high', 'ADT + ARPI + ¹⁷⁷Lu', 'II/1B', {
    components: [ADT, ARPI, { type: 'nuclide', drug: '¹⁷⁷Lu-PSMA-617' }], source: '图二 · L3 高瘤负荷 · 7.2',
    prerequisites: ['PSMA 阳性']
  }),
  opt('mhspc_high_tala_enza', 'mHSPC_high', 'ADT + 他拉唑帕利 + 恩扎', 'II/1B', {
    components: [ADT, { type: 'parpi', drug: '他拉唑帕利' }, { type: 'arpi', drug: '恩扎卢胺' }],
    source: '图二 · L3 高瘤负荷 · 7.2', prerequisites: ['HRR 阳性']
  }),
  opt('mhspc_high_nira_abi', 'mHSPC_high', 'ADT + 尼拉帕利 + 阿比特龙', 'II/1B', {
    components: [ADT, { type: 'parpi', drug: '尼拉帕利' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L3 高瘤负荷 · 7.2', prerequisites: ['BRCA 阳性']
  }),
  opt('mhspc_high_capiva_abi', 'mHSPC_high', 'ADT + 卡匹色替 + 阿比特龙', 'II/1B', {
    components: [ADT, { type: 'targeted', drug: '卡匹色替' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L3 高瘤负荷 · 7.2', prerequisites: ['PTEN/AKT 通路改变']
  }),
  opt('mhspc_high_adt_mono', 'mHSPC_high', 'ADT 单药', 'III/2B', { components: [ADT], source: '图二 · L3 高瘤负荷 · 7.2' }),
  opt('mhspc_high_local', 'mHSPC_high', 'ADT + 原发灶局部治疗', 'III/2B', {
    components: [ADT, { type: 'surgery', procedure: '原发灶局部治疗' }], source: '图二 · L3 高瘤负荷 · 7.2'
  }),

  /* nmCRPC */
  opt('nm_daro', 'nmCRPC', '达罗他胺', 'I/1A', { components: [{ type: 'arpi', drug: '达罗他胺' }], source: '图二 · L4 nmCRPC · 8.1' }),
  opt('nm_apa', 'nmCRPC', '阿帕他胺', 'I/1A', { components: [{ type: 'arpi', drug: '阿帕他胺' }], source: '图二 · L4 nmCRPC · 8.1' }),
  opt('nm_enza', 'nmCRPC', '恩扎卢胺', 'I/1A', { components: [{ type: 'arpi', drug: '恩扎卢胺' }], source: '图二 · L4 nmCRPC · 8.1' }),
  opt('nm_obs', 'nmCRPC', '观察（PSADT>10 月）', 'I/1B', { components: [OBS], source: '图二 · L4 nmCRPC · 8.1' }),
  opt('nm_abi', 'nmCRPC', '阿比特龙', 'II/2B', { components: [{ type: 'arpi', drug: '阿比特龙+泼尼松' }], source: '图二 · L4 nmCRPC · 8.1' }),
  opt('nm_other', 'nmCRPC', '其他二线内分泌', 'II/2B', {
    components: [{ type: 'endocrine', drug: '比卡鲁胺等' }], source: '图二 · L4 nmCRPC · 8.1'
  }),
  opt('nm_pet_rt', 'nmCRPC', 'PET/CT 引导转移灶放疗', 'II/2B', {
    components: [{ type: 'rt', target: 'PET/CT 阳性转移灶' }], source: '图二 · L4 nmCRPC · 8.1'
  }),

  /* mCRPC 1L */
  opt('mcrpc1_abi', 'mCRPC_1L', '阿比特龙 / 泼尼松', 'I/1A', {
    components: [{ type: 'arpi', drug: '阿比特龙+泼尼松' }], source: '图二 · L5 mCRPC 一线 · 8.2'
  }),
  opt('mcrpc1_enza', 'mCRPC_1L', '恩扎卢胺', 'I/1A', { components: [{ type: 'arpi', drug: '恩扎卢胺' }], source: '图二 · L5 mCRPC 一线 · 8.2' }),
  opt('mcrpc1_doc', 'mCRPC_1L', '多西他赛', 'I/1A', { components: [DOC], source: '图二 · L5 mCRPC 一线 · 8.2' }),
  opt('mcrpc1_radium', 'mCRPC_1L', '镭-223', 'I/1A', {
    components: [{ type: 'nuclide', drug: '镭-223' }], source: '图二 · L5 mCRPC 一线 · 8.2',
    prerequisites: ['骨转移', '无内脏转移']
  }),
  opt('mcrpc1_olaparib_abi', 'mCRPC_1L', '奥拉帕利 + 阿比特龙', 'I/1A', {
    components: [{ type: 'parpi', drug: '奥拉帕利' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L5 mCRPC 一线 · 8.2', prerequisites: ['BRCA 阳性']
  }),
  opt('mcrpc1_tala_enza', 'mCRPC_1L', '他拉唑帕利 + 恩扎卢胺', 'I/1A', {
    components: [{ type: 'parpi', drug: '他拉唑帕利' }, { type: 'arpi', drug: '恩扎卢胺' }],
    source: '图二 · L5 mCRPC 一线 · 8.2', prerequisites: ['HRR 阳性']
  }),
  opt('mcrpc1_nira_abi', 'mCRPC_1L', '尼拉帕利 + 阿比特龙', 'I/1A', {
    components: [{ type: 'parpi', drug: '尼拉帕利' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L5 mCRPC 一线 · 8.2', prerequisites: ['BRCA 阳性']
  }),
  opt('mcrpc1_radium_enza', 'mCRPC_1L', '镭-223 + 恩扎卢胺', 'I/1A', {
    components: [{ type: 'nuclide', drug: '镭-223' }, { type: 'arpi', drug: '恩扎卢胺' }],
    source: '图二 · L5 mCRPC 一线 · 8.2', prerequisites: ['骨转移', '无内脏转移']
  }),
  opt('mcrpc1_tala_enza_nonhrr', 'mCRPC_1L', '他拉唑帕利 + 恩扎卢胺（非 HRR）', 'II/2A', {
    components: [{ type: 'parpi', drug: '他拉唑帕利' }, { type: 'arpi', drug: '恩扎卢胺' }],
    source: '图二 · L5 mCRPC 一线 · 8.2'
  }),
  opt('mcrpc1_lu_enza', 'mCRPC_1L', '¹⁷⁷Lu-PSMA-617 + 恩扎卢胺', 'II/2A', {
    components: [{ type: 'nuclide', drug: '¹⁷⁷Lu-PSMA-617' }, { type: 'arpi', drug: '恩扎卢胺' }],
    source: '图二 · L5 mCRPC 一线 · 8.2', prerequisites: ['PSMA 阳性']
  }),
  opt('mcrpc1_sipuleucel', 'mCRPC_1L', 'Sipuleucel-T', 'II/1B', {
    components: [{ type: 'immunotherapy', drug: 'Sipuleucel-T' }], source: '图二 · L5 mCRPC 一线 · 8.2',
    availability: 'unavailable_cn', note: '国内未上市；仅临床试验/特殊通道'
  }),
  opt('mcrpc1_rezvil', 'mCRPC_1L', '瑞维鲁胺', 'II/2B', { components: [{ type: 'arpi', drug: '瑞维鲁胺' }], source: '图二 · L5 mCRPC 一线 · 8.2' }),
  opt('mcrpc1_deuter_enza', 'mCRPC_1L', '氘恩扎卢胺', 'II/2B', {
    components: [{ type: 'arpi', drug: '氘恩扎卢胺' }], source: '图二 · L5 mCRPC 一线 · 8.2'
  }),
  opt('mcrpc1_apa', 'mCRPC_1L', '阿帕他胺', 'III/3类', { components: [{ type: 'arpi', drug: '阿帕他胺' }], source: '图二 · L5 mCRPC 一线 · 8.2' }),
  opt('mcrpc1_daro', 'mCRPC_1L', '达罗他胺', 'III/3类', { components: [{ type: 'arpi', drug: '达罗他胺' }], source: '图二 · L5 mCRPC 一线 · 8.2' }),
  opt('mcrpc1_oligo_sbrt_abi', 'mCRPC_1L', '寡转移 SBRT + 阿比特龙', 'III/2B', {
    components: [{ type: 'rt', target: '寡转移灶 SBRT' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L5 mCRPC 一线 · 8.2'
  }),
  opt('mcrpc1_olaparib_abi_3', 'mCRPC_1L', '奥拉帕利 + 阿比特龙（III 类）', 'III/3类', {
    components: [{ type: 'parpi', drug: '奥拉帕利' }, { type: 'arpi', drug: '阿比特龙+泼尼松' }],
    source: '图二 · L5 mCRPC 一线 · 8.2'
  }),

  /* mCRPC 2L ARPI 失败未化疗 */
  opt('mcrpc2_arpi_doc', 'mCRPC_2L_arpi_fail', '多西他赛', 'I/1A', { components: [DOC], source: '图二 · R1 ARPI 失败 · 8.2' }),
  opt('mcrpc2_arpi_olaparib', 'mCRPC_2L_arpi_fail', '奥拉帕利', 'I/1A', {
    components: [{ type: 'parpi', drug: '奥拉帕利' }], source: '图二 · R1 ARPI 失败 · 8.2', prerequisites: ['BRCA 阳性']
  }),
  opt('mcrpc2_arpi_radium', 'mCRPC_2L_arpi_fail', '镭-223', 'I/1A', {
    components: [{ type: 'nuclide', drug: '镭-223' }], source: '图二 · R1 ARPI 失败 · 8.2',
    prerequisites: ['骨转移', '无内脏转移']
  }),
  opt('mcrpc2_arpi_lu', 'mCRPC_2L_arpi_fail', '¹⁷⁷Lu-PSMA-617', 'I/1A', {
    components: [{ type: 'nuclide', drug: '¹⁷⁷Lu-PSMA-617' }], source: '图二 · R1 ARPI 失败 · 8.2', prerequisites: ['PSMA 阳性']
  }),
  opt('mcrpc2_arpi_enza_abi_pred', 'mCRPC_2L_arpi_fail', '恩扎/阿比/泼尼松（换线）', 'II/2A', {
    components: [{ type: 'arpi', drug: '恩扎卢胺/阿比特龙+泼尼松' }], source: '图二 · R1 ARPI 失败 · 8.2'
  }),
  opt('mcrpc2_arpi_sipuleucel', 'mCRPC_2L_arpi_fail', 'Sipuleucel-T', 'II/1B', {
    components: [{ type: 'immunotherapy', drug: 'Sipuleucel-T' }], source: '图二 · R1 ARPI 失败 · 8.2',
    availability: 'unavailable_cn'
  }),
  opt('mcrpc2_arpi_deuter', 'mCRPC_2L_arpi_fail', '氘恩扎卢胺', 'II/2B', {
    components: [{ type: 'arpi', drug: '氘恩扎卢胺' }], source: '图二 · R1 ARPI 失败 · 8.2'
  }),
  opt('mcrpc2_arpi_enza_doc', 'mCRPC_2L_arpi_fail', '恩扎卢胺 + 多西他赛', 'II/2B', {
    components: [{ type: 'arpi', drug: '恩扎卢胺' }, DOC], source: '图二 · R1 ARPI 失败 · 8.2'
  }),
  opt('mcrpc2_arpi_abi_dex', 'mCRPC_2L_arpi_fail', '阿比特龙 / 地塞米松', 'III/3类', {
    components: [{ type: 'arpi', drug: '阿比特龙+地塞米松' }], source: '图二 · R1 ARPI 失败 · 8.2'
  }),

  /* mCRPC 2L ARPI+化疗失败 */
  opt('mcrpc2_chemo_olaparib', 'mCRPC_2L_arpi_chemo_fail', '奥拉帕利', 'I/1B', {
    components: [{ type: 'parpi', drug: '奥拉帕利' }], source: '图二 · R2 ARPI+化疗失败 · 8.2', prerequisites: ['BRCA 阳性']
  }),
  opt('mcrpc2_chemo_lu_soc', 'mCRPC_2L_arpi_chemo_fail', '¹⁷⁷Lu-PSMA-617 + SOC', 'I/1A', {
    components: [{ type: 'nuclide', drug: '¹⁷⁷Lu-PSMA-617' }, { type: 'supportive', drug: 'SOC' }],
    source: '图二 · R2 ARPI+化疗失败 · 8.2', prerequisites: ['PSMA 阳性']
  }),
  opt('mcrpc2_chemo_deuter', 'mCRPC_2L_arpi_chemo_fail', '氘恩扎卢胺', 'I/1A', {
    components: [{ type: 'arpi', drug: '氘恩扎卢胺' }], source: '图二 · R2 ARPI+化疗失败 · 8.2'
  }),
  opt('mcrpc2_chemo_radium', 'mCRPC_2L_arpi_chemo_fail', '镭-223', 'II/1B', {
    components: [{ type: 'nuclide', drug: '镭-223' }], source: '图二 · R2 ARPI+化疗失败 · 8.2',
    prerequisites: ['骨转移', '无内脏转移']
  }),
  opt('mcrpc2_chemo_cabazitaxel', 'mCRPC_2L_arpi_chemo_fail', '卡巴他赛', 'II/1B', {
    components: [{ type: 'chemo', drug: '卡巴他赛', dose: '20–25mg/m² q3w' }], source: '图二 · R2 ARPI+化疗失败 · 8.2'
  }),
  opt('mcrpc2_chemo_doc_retry', 'mCRPC_2L_arpi_chemo_fail', '多西他赛再尝试', 'II/2A', {
    components: [DOC], source: '图二 · R2 ARPI+化疗失败 · 8.2'
  }),
  opt('mcrpc2_chemo_tala', 'mCRPC_2L_arpi_chemo_fail', '他拉唑帕利', 'III/2B', {
    components: [{ type: 'parpi', drug: '他拉唑帕利' }], source: '图二 · R2 ARPI+化疗失败 · 8.2', prerequisites: ['HRR 阳性']
  }),
  opt('mcrpc2_chemo_pembro', 'mCRPC_2L_arpi_chemo_fail', '帕博利珠单抗', 'III/3类', {
    components: [{ type: 'immunotherapy', drug: '帕博利珠单抗' }], source: '图二 · R2 ARPI+化疗失败 · 8.2',
    prerequisites: ['MSI-H/dMMR']
  }),
  opt('mcrpc2_chemo_mitox', 'mCRPC_2L_arpi_chemo_fail', '米托蒽醌/铂类/依托泊苷', 'III/化疗', {
    components: [{ type: 'chemo', drug: '米托蒽醌/铂类/依托泊苷' }], source: '图二 · R2 ARPI+化疗失败 · 8.2'
  }),

  /* 无论既往用药 */
  opt('any_radium', 'mCRPC_any', '镭-223（症状性骨转移）', 'I', {
    components: [{ type: 'nuclide', drug: '镭-223' }], source: '图二 · R3 无论既往用药 · 8.2',
    prerequisites: ['症状性骨转移', '无内脏转移']
  }),
  opt('any_mdt', 'mCRPC_any', 'MDT + 系统治疗（寡转移/寡进展）', 'II', {
    components: [{ type: 'mdt', label: 'MDT + 系统治疗' }], source: '图二 · R3 无论既往用药 · 8.2'
  }),
  opt('any_sipuleucel', 'mCRPC_any', 'Sipuleucel-T（无内脏无症状）', 'II', {
    components: [{ type: 'immunotherapy', drug: 'Sipuleucel-T' }], source: '图二 · R3 无论既往用药 · 8.2',
    availability: 'unavailable_cn'
  }),
  opt('any_pembro', 'mCRPC_any', '帕博利珠单抗（MSI-H/dMMR）', 'III/2B', {
    components: [{ type: 'immunotherapy', drug: '帕博利珠单抗' }], source: '图二 · R3 无论既往用药 · 8.2',
    prerequisites: ['MSI-H/dMMR']
  }),

  /* 骨相关事件 */
  opt('bone_denosumab', 'bone_events', '地舒单抗 120mg q4w', 'I', {
    components: [{ type: 'supportive', drug: '地舒单抗', dose: '120mg q4w' }], source: '图二 · R4 骨相关事件 · 9 章',
    monitoring: '口腔评估、血钙、肾功能'
  }),
  opt('bone_zoledronic', 'bone_events', '唑来膦酸 4mg q12w', 'I', {
    components: [{ type: 'supportive', drug: '唑来膦酸', dose: '4mg q12w' }], source: '图二 · R4 骨相关事件 · 9 章',
    prerequisites: ['CrCl≥30'], monitoring: '口腔评估、肾功能、血钙'
  }),
  opt('bone_narlumosbart', 'bone_events', '纳鲁索拜单抗（国产 RANKL 抑制剂）', 'II', {
    components: [{ type: 'supportive', drug: '纳鲁索拜单抗' }], source: '图二 · R4 骨相关事件 · 9 章'
  }),
  opt('bone_incadronate', 'bone_events', '因卡膦酸二钠 5mg q3–4w', 'II', {
    components: [{ type: 'supportive', drug: '因卡膦酸二钠', dose: '5mg q3–4w' }], source: '图二 · R4 骨相关事件 · 9 章'
  }),
  opt('bone_analgesia', 'bone_events', '镇痛药物（阶梯给药）', '支持', {
    components: [{ type: 'supportive', drug: '镇痛药物' }], source: '图二 · R4 骨相关事件 · 9 章'
  }),
  opt('bone_rt', 'bone_events', '外放射治疗（骨痛/脊髓压迫）', '支持', {
    components: [{ type: 'rt', target: '骨转移灶/脊髓压迫' }], source: '图二 · R4 骨相关事件 · 9 章'
  }),
  opt('bone_surgery', 'bone_events', '骨手术（病理性骨折）', '支持', {
    components: [{ type: 'surgery', procedure: '骨手术' }], source: '图二 · R4 骨相关事件 · 9 章'
  }),

  /* 特定亚型 */
  opt('subtype_dac', 'subtype_dac', '导管腺癌 DAC：综合治疗模式', 'I', {
    components: [{ type: 'mdt', label: 'MDT 综合治疗' }], source: '图二 · R5 特定亚型 · 9 章'
  }),
  opt('subtype_dac_local', 'subtype_dac', 'DAC 局限期：手术 + 放疗 ± 激素', 'II', {
    components: [RP, RT, { type: 'adt', drug: 'ADT（按需）' }], source: '图二 · R5 特定亚型 · 9 章'
  }),
  opt('subtype_dac_adv', 'subtype_dac', 'DAC 进展期：激素/基因突变靶向', 'II', {
    components: [ADT, { type: 'targeted', drug: '按基因突变选择' }], source: '图二 · R5 特定亚型 · 9 章'
  }),
  opt('subtype_idcp', 'subtype_idcp', 'IDC-P：根治性治疗 ± 激素；优先 NHA', 'I', {
    components: [RP, { type: 'adt', drug: 'ADT（按需）' }, ARPI], source: '图二 · R5 特定亚型 · 9 章'
  }),
  opt('subtype_nepc', 'subtype_nepc', 'NEPC：铂类为基础化疗', 'II', {
    components: [{ type: 'chemo', drug: '铂类为基础化疗' }], source: '图二 · R5 特定亚型 · 9 章'
  }),
  opt('subtype_mesenchymal', 'subtype_mesenchymal', '间叶源性肿瘤：手术 + 放疗 + 化疗（VAC）', 'II', {
    components: [{ type: 'mdt', label: 'MDT' }, { type: 'surgery', procedure: '手术' }, RT, { type: 'chemo', drug: 'VAC' }],
    source: '图二 · R5 特定亚型 · 9 章'
  })
];

export const TREATMENT_OPTIONS = FIG1_OPTIONS.concat(FIG2_OPTIONS);

/* ---------------- 随访模板 ---------------- */
/* core: 每次就诊固定列；due: 按间隔到期项；aeTerms: 该段必填分级术语 */
export const FOLLOWUP_TEMPLATES = [
  {
    code: 'RP', label: '根治性前列腺切除术', color: '#2c6e8f', intervalMonths: 3,
    intervalNote: '指南 3–6 月；高复发风险前 5 年每 3 月（图四/第 10 章）。记录册 3 月/页保留为默认。',
    core: ['visit_date', 'psa', 'imaging', 'response', 'urinary_incontinence', 'erectile_dysfunction'],
    due: [
      { code: 'DRE', label: '直肠指检 DRE', everyMonths: 12, level: 'II', source: '图四 · 治愈性随访' },
      { code: 'BONE_SCAN', label: '骨扫描', everyMonths: 12, level: 'II', source: '图四 · 治愈性随访' },
      { code: 'CT_MRI', label: '腹盆腔 CT/MRI', everyMonths: 12, level: 'II', source: '图四 · 治愈性随访' },
      { code: 'DEXA', label: 'DEXA + FRAX', everyMonths: 12, level: 'I', source: '图四 · 骨健康' }
    ],
    aeTerms: ['urinary_incontinence', 'erectile_dysfunction'],
    printRowsPerPage: 6
  },
  {
    code: 'RT', label: '放射治疗', color: '#7d5596', intervalMonths: 3,
    intervalNote: '指南 3–6 月；记录册 1 月/页是纸质容量，不照抄。',
    core: ['visit_date', 'psa', 'imaging', 'response', 'urinary_incontinence', 'hematuria', 'proctitis', 'erectile_dysfunction'],
    due: [
      { code: 'DRE', label: '直肠指检 DRE', everyMonths: 12, level: 'II', source: '图四 · 治愈性随访' },
      { code: 'BONE_SCAN', label: '骨扫描', everyMonths: 12, level: 'II', source: '图四 · 治愈性随访' },
      { code: 'CT_MRI', label: '腹盆腔 CT/MRI', everyMonths: 12, level: 'II', source: '图四 · 治愈性随访' },
      { code: 'DEXA', label: 'DEXA + FRAX', everyMonths: 12, level: 'I', source: '图四 · 骨健康' }
    ],
    aeTerms: ['urinary_incontinence', 'hematuria', 'proctitis', 'erectile_dysfunction'],
    printRowsPerPage: 6
  },
  {
    code: 'ADT', label: '内分泌治疗（ADT）', color: '#a9762c', intervalMonths: 3,
    intervalNote: '指南综合治疗至少 3–6 月；前 6 月睾酮每月，之后每 3 月。',
    core: ['visit_date', 'psa', 'testosterone', 'imaging', 'response', 'hot_flashes', 'metabolic_syndrome', 'cognitive_impairment', 'erectile_dysfunction', 'osteoporosis', 'anemia'],
    due: [
      { code: 'TESTOSTERONE', label: '血清睾酮', everyMonths: 3, level: 'I', source: '图四 · 综合治疗随访' },
      { code: 'METABOLIC', label: '血糖/血脂/血压/肝肾功能/Hb', everyMonths: 6, level: 'I', source: '图四 · 综合治疗随访' },
      { code: 'DEXA', label: 'DEXA + FRAX', everyMonths: 12, level: 'I', source: '图四 · 骨健康' },
      { code: 'BONE_SCAN', label: '骨扫描', everyMonths: 9, level: 'I', source: '图四 · 综合治疗随访' }
    ],
    aeTerms: ['hot_flashes', 'metabolic_syndrome', 'cognitive_impairment', 'erectile_dysfunction', 'osteoporosis', 'anemia', 'bone_pain'],
    printRowsPerPage: 6
  },
  {
    code: 'SYSTEMIC', label: '系统治疗（ARPI/PARPi/核素）', color: '#4f6f8f', intervalMonths: 3,
    intervalNote: '按方案与药物监测；PSA/睾酮/代谢至少 3–6 月。',
    core: ['visit_date', 'psa', 'testosterone', 'imaging', 'response', 'hot_flashes', 'metabolic_syndrome', 'cognitive_impairment', 'erectile_dysfunction', 'osteoporosis', 'anemia'],
    due: [
      { code: 'TESTOSTERONE', label: '血清睾酮', everyMonths: 3, level: 'I', source: '图四 · 综合治疗随访' },
      { code: 'METABOLIC', label: '血糖/血脂/血压/肝肾功能/Hb', everyMonths: 3, level: 'I', source: '图四 · 综合治疗随访' },
      { code: 'DEXA', label: 'DEXA + FRAX', everyMonths: 12, level: 'I', source: '图四 · 骨健康' },
      { code: 'BONE_SCAN', label: '骨扫描', everyMonths: 6, level: 'I', source: '图四 · 综合治疗随访' }
    ],
    aeTerms: ['hot_flashes', 'metabolic_syndrome', 'cognitive_impairment', 'erectile_dysfunction', 'osteoporosis', 'anemia', 'fatigue', 'hypertension', 'liver_toxicity', 'rash', 'bone_pain'],
    printRowsPerPage: 6
  },
  {
    code: 'CHEMO', label: '化疗', color: '#a94a4a', intervalMonths: 1,
    intervalNote: '按周期（q3w）记录；每 5 周期做一次 p97 式评估。',
    core: ['cycle_no', 'cycle_date', 'regimen', 'dose', 'psa', 'labs', 'nausea', 'vomiting', 'diarrhea', 'peripheral_neuropathy', 'myelosuppression', 'fluid_retention', 'allergy', 'ecog'],
    due: [
      { code: 'CBC', label: '血常规（含 ANC）', everyCycles: 1, level: 'I', source: '记录册 p55' },
      { code: 'LFT_RFT', label: '肝功能/肾功能', everyCycles: 1, level: 'I', source: '记录册 p55' },
      { code: 'REASSESS', label: '每 5 周期评估（p97）', everyCycles: 5, level: 'I', source: '记录册 p97' }
    ],
    aeTerms: ['nausea', 'vomiting', 'diarrhea', 'peripheral_neuropathy', 'myelosuppression', 'fluid_retention', 'allergy', 'bone_pain'],
    printRowsPerPage: 2
  },
  {
    code: 'AS', label: '主动监测', color: '#2f8f74', intervalMonths: 6,
    intervalNote: 'PSA 每 6 月、DRE 每 12 月、mpMRI 每 12 月、重复活检每 2–3 年（图一 5.5）。',
    core: ['visit_date', 'psa', 'dre', 'mri', 'biopsy', 'response'],
    due: [
      { code: 'DRE', label: 'DRE', everyMonths: 12, level: 'I', source: '图一 · 主动监测' },
      { code: 'MPMRI', label: 'mpMRI', everyMonths: 12, level: 'II', source: '图一 · 主动监测' },
      { code: 'BIOPSY', label: '重复穿刺活检', everyMonths: 30, level: 'II', source: '图一 · 主动监测' }
    ],
    aeTerms: [],
    printRowsPerPage: 6
  },
  {
    code: 'WW', label: '观察等待', color: '#7c8f8c', intervalMonths: 6,
    intervalNote: '按症状与预期寿命个体化；不追求根治。',
    core: ['visit_date', 'psa', 'symptoms', 'imaging', 'response'],
    due: [],
    aeTerms: [],
    printRowsPerPage: 6
  },
  {
    code: 'OTHER', label: '其它治疗段', color: '#7c8f8c', intervalMonths: 6,
    intervalNote: '局灶治疗、临床试验、支持治疗等；按实际方案设定。',
    core: ['visit_date', 'psa', 'imaging', 'response', 'notes'],
    due: [],
    aeTerms: [],
    printRowsPerPage: 6
  }
];

/* ---------------- 毒性分级字典（记录册 16 项 + 常用药物毒性） ---------------- */
/* maxGrade: 功能毒性 3；器官/危及生命 5；骨髓抑制 4（按实验室计算） */
export const TOXICITY_TERMS = [
  { code: 'urinary_incontinence', label: '尿失禁', aliases: ['尿控'], maxGrade: 3, templates: ['RP', 'RT'], functional: true,
    definitions: [
      { grade: 1, text: '轻微漏尿/偶发，无需尿垫或仅预防性使用' },
      { grade: 2, text: '每日需尿垫，影响日常活动' },
      { grade: 3, text: '严重漏尿，需手术/器械干预（吊带/AUS）' }
    ] },
  { code: 'erectile_dysfunction', label: '勃起障碍', aliases: ['ED', '性功能'], maxGrade: 3, templates: ['RP', 'RT', 'ADT', 'SYSTEMIC'], functional: true,
    definitions: [
      { grade: 1, text: '勃起质量下降，仍可完成性交' },
      { grade: 2, text: '勃起不足以完成性交，PDE5i 有效' },
      { grade: 3, text: '完全不能勃起，药物/器械效果有限' }
    ] },
  { code: 'hematuria', label: '血尿/膀胱炎', aliases: ['膀胱炎'], maxGrade: 5, templates: ['RT'],
    definitions: [
      { grade: 1, text: '镜下血尿/轻度尿路刺激症状' },
      { grade: 2, text: '肉眼血尿/需口服药，不影响日常' },
      { grade: 3, text: '血块/需膀胱冲洗或输血' },
      { grade: 4, text: '危及生命的大出血/需急诊手术' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'proctitis', label: '直肠炎', aliases: ['放射性直肠炎'], maxGrade: 5, templates: ['RT'],
    definitions: [
      { grade: 1, text: '轻度腹泻/便血，无需治疗' },
      { grade: 2, text: '需口服药/局部治疗' },
      { grade: 3, text: '严重便血/贫血/需内镜或输血' },
      { grade: 4, text: '危及生命/需手术' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'hot_flashes', label: '潮热', aliases: ['潮热汗出'], maxGrade: 3, templates: ['ADT', 'SYSTEMIC'], functional: true,
    definitions: [
      { grade: 1, text: '偶发，不影响生活' },
      { grade: 2, text: '每日多次，影响睡眠/活动' },
      { grade: 3, text: '频繁严重，需药物干预/影响依从性' }
    ] },
  { code: 'metabolic_syndrome', label: '代谢综合征', aliases: ['代谢异常'], maxGrade: 5, templates: ['ADT', 'SYSTEMIC'],
    definitions: [
      { grade: 1, text: '单项代谢指标异常' },
      { grade: 2, text: '需口服药控制' },
      { grade: 3, text: '多指标失控/需专科处理' },
      { grade: 4, text: '急性代谢并发症（酮症/高渗/心血管事件）' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'cognitive_impairment', label: '认知障碍', aliases: ['认知功能下降'], maxGrade: 3, templates: ['ADT', 'SYSTEMIC'], functional: true,
    definitions: [
      { grade: 1, text: '轻度记忆/注意力下降，不影响自理' },
      { grade: 2, text: '明显影响日常/工作，需帮助' },
      { grade: 3, text: '严重认知障碍，需监护' }
    ] },
  { code: 'osteoporosis', label: '骨质疏松', aliases: ['骨量减少'], maxGrade: 3, templates: ['ADT', 'SYSTEMIC'], functional: true,
    definitions: [
      { grade: 1, text: '骨量减少（T −1.0～−2.5）' },
      { grade: 2, text: '骨质疏松（T≤−2.5）无骨折' },
      { grade: 3, text: '脆性骨折/需手术' }
    ] },
  { code: 'anemia', label: '贫血', aliases: ['血红蛋白下降'], maxGrade: 5, templates: ['ADT', 'SYSTEMIC'],
    definitions: [
      { grade: 1, text: 'Hb 100–109 g/L' },
      { grade: 2, text: 'Hb 80–99 g/L' },
      { grade: 3, text: 'Hb 65–79 g/L/需输血' },
      { grade: 4, text: 'Hb<65 g/L/危及生命' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'nausea', label: '恶心', aliases: [], maxGrade: 3, templates: ['CHEMO'], functional: true,
    definitions: [
      { grade: 1, text: '食欲下降，无需止吐药' },
      { grade: 2, text: '需口服止吐药，能进食' },
      { grade: 3, text: '需静脉止吐/不能进食' }
    ] },
  { code: 'vomiting', label: '呕吐', aliases: [], maxGrade: 5, templates: ['CHEMO'],
    definitions: [
      { grade: 1, text: '24h 内 1–2 次' },
      { grade: 2, text: '24h 内 3–5 次/需补液' },
      { grade: 3, text: '24h 内 ≥6 次/需静脉补液' },
      { grade: 4, text: '危及生命/需 ICU' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'diarrhea', label: '腹泻', aliases: [], maxGrade: 5, templates: ['CHEMO'],
    definitions: [
      { grade: 1, text: '每日排便次数增加 <4 次' },
      { grade: 2, text: '每日 4–6 次/需口服药' },
      { grade: 3, text: '每日 ≥7 次/需静脉补液' },
      { grade: 4, text: '危及生命/需 ICU' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'peripheral_neuropathy', label: '外周神经病变', aliases: ['周围神经毒性'], maxGrade: 3, templates: ['CHEMO'], functional: true,
    definitions: [
      { grade: 1, text: '轻度麻木/感觉异常，不影响功能' },
      { grade: 2, text: '中度，影响精细动作/需减量' },
      { grade: 3, text: '严重，影响行走/自理' }
    ] },
  { code: 'fluid_retention', label: '液体潴留', aliases: ['体液潴留', '水肿'], maxGrade: 5, templates: ['CHEMO'],
    definitions: [
      { grade: 1, text: '轻度水肿/体重增加 <2kg' },
      { grade: 2, text: '需利尿剂/体重增加 2–5kg' },
      { grade: 3, text: '明显水肿/影响活动' },
      { grade: 4, text: '危及生命（心衰/肺水肿）' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'allergy', label: '过敏反应', aliases: ['过敏'], maxGrade: 5, templates: ['CHEMO'],
    definitions: [
      { grade: 1, text: '轻度皮疹/瘙痒' },
      { grade: 2, text: '荨麻疹/需抗组胺药' },
      { grade: 3, text: '支气管痉挛/需肾上腺素' },
      { grade: 4, text: '过敏性休克/危及生命' },
      { grade: 5, text: '死亡' }
    ] },
  { code: 'myelosuppression', label: '骨髓抑制', aliases: ['骨髓抑制（按实验室）'], maxGrade: 4, templates: ['CHEMO'], computed: true,
    definitions: [
      { grade: 0, text: 'Hb≥110、WBC≥4.0、ANC≥2.0、PLT≥100' },
      { grade: 1, text: 'Hb 100–109 / WBC 3.0–3.9 / ANC 1.5–1.9 / PLT 75–99' },
      { grade: 2, text: 'Hb 80–99 / WBC 2.0–2.9 / ANC 1.0–1.4 / PLT 50–74' },
      { grade: 3, text: 'Hb 65–79 / WBC 1.0–1.9 / ANC 0.5–0.9 / PLT 25–49' },
      { grade: 4, text: 'Hb<65 / WBC<1.0 / ANC<0.5 / PLT<25' }
    ] },
  /* 常用药物特异性毒性（图四药物监测，不是记录册主栏） */
  { code: 'bone_pain', label: '骨痛', aliases: ['疼痛', 'pain', '骨痛'], maxGrade: 3, templates: ['ADT', 'SYSTEMIC', 'CHEMO'], functional: true,
    definitions: [
      { grade: 1, text: '轻度疼痛，不影响日常，未用或偶用镇痛药' },
      { grade: 2, text: '中度疼痛，需规律镇痛，影响部分日常' },
      { grade: 3, text: '重度疼痛，明显限制自理/活动，需强镇痛或局部干预' }
    ] },
  { code: 'fatigue', label: '疲乏', aliases: [], maxGrade: 3, templates: ['SYSTEMIC'], functional: true, drugSpecific: true,
    definitions: [{ grade: 1, text: '轻度，不影响日常' }, { grade: 2, text: '中度，影响部分日常' }, { grade: 3, text: '重度，不能自理' }] },
  { code: 'hypertension', label: '高血压', aliases: [], maxGrade: 4, templates: ['SYSTEMIC'], drugSpecific: true,
    definitions: [{ grade: 1, text: '收缩压 140–159' }, { grade: 2, text: '160–179/需调整药物' }, { grade: 3, text: '≥180/需急诊' }, { grade: 4, text: '高血压危象' }] },
  { code: 'liver_toxicity', label: '肝毒性', aliases: ['肝功能异常'], maxGrade: 4, templates: ['SYSTEMIC'], drugSpecific: true,
    definitions: [{ grade: 1, text: 'ALT/AST 升高 <3×ULN' }, { grade: 2, text: '3–5×ULN' }, { grade: 3, text: '5–20×ULN' }, { grade: 4, text: '>20×ULN/肝衰竭' }] },
  { code: 'rash', label: '皮疹', aliases: [], maxGrade: 4, templates: ['SYSTEMIC'], drugSpecific: true,
    definitions: [{ grade: 1, text: '局限，无需治疗' }, { grade: 2, text: '广泛，需口服药' }, { grade: 3, text: '严重/需系统治疗' }, { grade: 4, text: 'Stevens-Johnson/危及生命' }] }
];

/* ---------------- 合并症词表（记录册 p2 实拍 21 项） ---------------- */
export const COMORBIDITIES = [
  { code: 'hypertension', system: '心血管', label: '高血压', charlson: 0 },
  { code: 'hyperlipidemia', system: '心血管', label: '高血脂', charlson: 0 },
  { code: 'angina', system: '心血管', label: '心绞痛', charlson: 0 },
  { code: 'myocardial_infarction', system: '心血管', label: '心肌梗死', charlson: 1 },
  { code: 'atherosclerosis', system: '心血管', label: '动脉粥样硬化', charlson: 0 },
  { code: 'dementia', system: '神经', label: '老年痴呆', charlson: 1 },
  { code: 'post_stroke', system: '神经', label: '脑溢血后遗症', charlson: 0 },
  { code: 'paralysis', system: '神经', label: '瘫痪', charlson: 2 },
  { code: 'copd', system: '呼吸', label: 'COPD', charlson: 1 },
  { code: 'tuberculosis', system: '呼吸', label: '肺结核', charlson: 0 },
  { code: 'pulmonary_embolism', system: '呼吸', label: '肺血栓', charlson: 0 },
  { code: 'asthma', system: '呼吸', label: '哮喘', charlson: 0 },
  { code: 'liver_disease', system: '消化', label: '肝病', charlson: 0 },
  { code: 'peptic_ulcer', system: '消化', label: '胃溃疡/胃炎', charlson: 0 },
  { code: 'cholecystitis_stones', system: '消化', label: '胆囊炎/胆结石', charlson: 0 },
  { code: 'anemia', system: '血液', label: '贫血', charlson: 0 },
  { code: 'allergic_purpura', system: '血液', label: '过敏性紫癜', charlson: 0 },
  { code: 'platelet_disorder', system: '血液', label: '血小板异常', charlson: 0 },
  { code: 'diabetes', system: '内分泌', label: '糖尿病', charlson: 1 },
  { code: 'hyperthyroidism', system: '内分泌', label: '甲亢', charlson: 0 },
  { code: 'hypothyroidism', system: '内分泌', label: '甲减', charlson: 0 }
];

/* ---------------- 常用药物方案（图四第 11.4 节 + 图二联合方案） ---------------- */
export const DRUG_REGIMENS = [
  { code: 'goserelin', name: '戈舍瑞林', category: 'adt', dose: '3.6mg', schedule: 'q28d / 10.8mg q12w', note: 'LHRH 激动剂；承重骨转移首剂前需抗雄预防闪烁' },
  { code: 'leuprolide', name: '亮丙瑞林', category: 'adt', dose: '3.75mg', schedule: 'q4w', note: 'LHRH 激动剂' },
  { code: 'triptorelin', name: '曲普瑞林', category: 'adt', dose: '3.75/15/22.5mg', schedule: '按剂型', note: 'LHRH 激动剂' },
  { code: 'degarelix', name: '地加瑞克', category: 'adt', dose: '240mg → 80mg', schedule: 'q28d', note: 'LHRH 拮抗剂，无闪烁' },
  { code: 'bicalutamide', name: '比卡鲁胺', category: 'endocrine', dose: '50mg', schedule: 'qd', note: '一代抗雄' },
  { code: 'flutamide', name: '氟他胺', category: 'endocrine', dose: '250mg', schedule: 'tid', note: '一代抗雄' },
  { code: 'abiraterone', name: '阿比特龙', category: 'arpi', dose: '1000mg', schedule: 'qd + 泼尼松 5mg bid', note: '空腹服用；必须联用糖皮质激素' },
  { code: 'enzalutamide', name: '恩扎卢胺', category: 'arpi', dose: '160mg', schedule: 'qd' },
  { code: 'apalutamide', name: '阿帕他胺', category: 'arpi', dose: '240mg', schedule: 'qd' },
  { code: 'darolutamide', name: '达罗他胺', category: 'arpi', dose: '600mg', schedule: 'bid' },
  { code: 'rezvilutamide', name: '瑞维鲁胺', category: 'arpi', dose: '240mg', schedule: 'qd' },
  { code: 'deuterated_enzalutamide', name: '氘恩扎卢胺', category: 'arpi', dose: '按说明书', schedule: 'qd', note: '剂量以本院说明书/方案为准' },
  { code: 'docetaxel', name: '多西他赛', category: 'chemo', dose: '75mg/m²', schedule: 'q3w', note: '联合地塞米松/泼尼松' },
  { code: 'cabazitaxel', name: '卡巴他赛', category: 'chemo', dose: '20–25mg/m²', schedule: 'q3w' },
  { code: 'olaparib', name: '奥拉帕利', category: 'parpi', dose: '300mg', schedule: 'bid', note: '需 HRR/BRCA 状态' },
  { code: 'talazoparib', name: '他拉唑帕利', category: 'parpi', dose: '0.5mg', schedule: 'qd + 恩扎卢胺', note: '需 HRR 状态' },
  { code: 'niraparib', name: '尼拉帕利', category: 'parpi', dose: '200mg', schedule: 'qd + 阿比特龙 1000mg qd', note: '需 BRCA 状态' },
  { code: 'radium223', name: '镭-223', category: 'nuclide', dose: '55kBq/kg', schedule: 'q4w × 6', note: '骨转移；无内脏转移' },
  { code: 'lu177_psma', name: '¹⁷⁷Lu-PSMA-617', category: 'nuclide', dose: '按方案', schedule: '按方案', note: '需 PSMA 阳性' },
  { code: 'denosumab', name: '地舒单抗', category: 'support', dose: '120mg', schedule: 'q4w（骨转移）/ 60mg q6m（骨质疏松）', note: '口腔评估、血钙' },
  { code: 'zoledronic', name: '唑来膦酸', category: 'support', dose: '4mg', schedule: 'q12w（骨转移）/ 5mg/年（骨质疏松）', note: 'CrCl<30 不用；口腔评估' },
  { code: 'incadronate', name: '因卡膦酸二钠', category: 'support', dose: '5mg', schedule: 'q3–4w' },
  { code: 'alendronate', name: '阿仑膦酸', category: 'support', dose: '70mg', schedule: 'qw' },
  { code: 'calcium_vitd', name: '钙 + 维生素 D', category: 'support', dose: '按需', schedule: 'qd', note: 'ADT 全程补充' },
  { code: 'pembrolizumab', name: '帕博利珠单抗', category: 'immunotherapy', dose: '按方案', schedule: '按方案', note: '仅 MSI-H/dMMR' },
  { code: 'sipuleucel', name: 'Sipuleucel-T', category: 'immunotherapy', dose: '按方案', schedule: '按方案', note: '国内未上市' }
];

/* ---------------- 疗效判定 ---------------- */
export const RESPONSE_RULES = [
  { code: 'PSA_PROGRESSION', label: 'PSA 进展', rule: '较最低值 ≥25% 且 ≥2 ng/ml，≥3 周后确认', source: '图四 · 11.3' },
  { code: 'RECIST', label: '软组织 RECIST 1.1', rule: '首次进展 ≥6 周后复查确认', source: '图四 · 11.3' },
  { code: 'BONE_PROGRESSION', label: '骨扫描进展', rule: '≥2 个新病灶，≥6 周后确认', source: '图四 · 11.3' },
  { code: 'CLINICAL', label: '临床症状', rule: '疼痛/镇痛药/生活质量，每 3–4 周评估', source: '图四 · 11.3' },
  { code: 'STOP_RULE', label: '停药原则', rule: 'PSA 与影像 2 项均进展才停用当前治疗；症状进展亦需纳入', source: '图四 · 11.3' },
  { code: 'BCR_RP', label: 'RP 后生化复发', rule: '影像阴性前提下，连续 2 次及以上 PSA≥0.1 ng/ml', source: '图一 · 6.1' },
  { code: 'BCR_RT', label: 'RT 后生化复发', rule: 'PSA 较最低值升高 ≥2 ng/ml（Phoenix）', source: '图一 · 6.2' },
  { code: 'CRPC', label: '去势抵抗', rule: '睾酮<50 ng/dl 且（PSA 间隔 1 周连续 2 次升>50% 且 PSA>1，或影像进展）', source: '图二 · 8.1' }
];

/* ---------------- 图四随访项目参考（用于“全部项目”抽屉） ---------------- */
export const FOLLOWUP_ITEMS = [
  { group: '治愈性治疗后随访', items: [
    { code: 'HISTORY_EXAM', label: '病史 + 体格检查', interval: '3–6 月（高危每 3 月）', level: 'I' },
    { code: 'PSA', label: '血清 PSA', interval: '3–6 月', level: 'I' },
    { code: 'SEXUAL_URINARY', label: '性功能/尿控随访', interval: '同期', level: 'I' },
    { code: 'BONE_SCAN', label: '骨扫描', interval: '至少每年 1 次', level: 'II' },
    { code: 'CT_MRI', label: '腹盆腔 CT/MRI', interval: '至少每年 1 次', level: 'II' },
    { code: 'PET_CT', label: 'PET/CT', interval: '至少每年 1 次', level: 'II' },
    { code: 'DRE', label: '直肠指检 DRE', interval: '至少每年 1 次', level: 'II' },
    { code: 'CTC_CEA_CGA_NSE', label: 'CTC/CEA/CgA/NSE', interval: '定期', level: 'III' }
  ] },
  { group: '综合治疗后随访', items: [
    { code: 'PSA', label: '血清 PSA', interval: '至少 3–6 月', level: 'I' },
    { code: 'CT_MRI', label: '腹盆腔 CT/MRI', interval: '至少 3–6 月', level: 'I' },
    { code: 'PET_CT', label: 'PET/CT', interval: '按需', level: 'I' },
    { code: 'CREAT_HB_LFT', label: '肌酐/血红蛋白/肝功能', interval: '至少 3–6 月', level: 'I' },
    { code: 'TESTOSTERONE', label: '血清睾酮', interval: '与 PSA 同步', level: 'I' },
    { code: 'BONE_SCAN', label: '骨扫描', interval: '按周期', level: 'I' },
    { code: 'METABOLIC', label: '代谢并发症监测', interval: '定期', level: 'I' },
    { code: 'DEXA_FRAX', label: '骨密度 DEXA + FRAX', interval: 'ADT 每 6–12 月', level: 'I' },
    { code: 'CARDIO', label: '心脑血管疾病监测', interval: '定期', level: 'I' }
  ] },
  { group: '术后尿失禁', items: [
    { code: 'URODYNAMICS', label: '尿动力学/24h 尿垫试验', interval: '评估', level: '—' },
    { code: 'PELVIC_FLOOR', label: '盆底肌训练', interval: '首选保守', level: '—' },
    { code: 'STIM', label: '电刺激/体外电磁波', interval: '辅助康复', level: '—' },
    { code: 'CLAMP', label: '阴茎夹/生活方式', interval: '轻中度', level: '—' },
    { code: 'SLING', label: '人工吊带', interval: '中度压力性', level: '—' },
    { code: 'AUS', label: '人工尿道括约肌', interval: '重度/金标准', level: '—' }
  ] },
  { group: '骨健康与代谢', items: [
    { code: 'CALCIUM_VITD', label: '钙 + 维生素 D', interval: '全程', level: '—' },
    { code: 'ZOLEDRONIC_5', label: '唑来膦酸 5mg/年', interval: 'T<−2 或 FRAX>3%', level: '—' },
    { code: 'DENOSUMAB_60', label: '地舒单抗 60mg/6 月', interval: '同上', level: '—' },
    { code: 'ALENDRONATE', label: '阿仑膦酸 70mg/周', interval: '同上', level: '—' },
    { code: 'METABOLIC', label: '血糖/血脂/心脑血管', interval: 'ADT 期间定期', level: '—' }
  ] }
];

/* ---------------- 查询辅助 ---------------- */
export function getCatalog() {
  return {
    version: CATALOG_VERSION,
    figures: FIGURES,
    states: DISEASE_STATES,
    riskStrata: RISK_STRATA,
    scenarios: SCENARIOS,
    treatmentOptions: TREATMENT_OPTIONS,
    followupTemplates: FOLLOWUP_TEMPLATES,
    toxicityTerms: TOXICITY_TERMS,
    comorbidities: COMORBIDITIES,
    drugRegimens: DRUG_REGIMENS,
    responseRules: RESPONSE_RULES,
    followupItems: FOLLOWUP_ITEMS
  };
}

export function optionById(id) {
  return TREATMENT_OPTIONS.find(x => x.id === id) || null;
}

export function optionsForScenario(scenario) {
  return TREATMENT_OPTIONS.filter(x => x.scenario === scenario);
}

export function templateByCode(code) {
  return FOLLOWUP_TEMPLATES.find(x => x.code === code) || null;
}

export function toxicityByCode(code) {
  return TOXICITY_TERMS.find(x => x.code === code) || null;
}

export function comorbidityByCode(code) {
  return COMORBIDITIES.find(x => x.code === code) || null;
}

export function scenarioByKey(key) {
  return SCENARIOS.find(x => x.key === key) || null;
}

export function catalogSummary() {
  return {
    version: CATALOG_VERSION,
    figures: FIGURES.map(f => ({ id: f.id, title: f.title, nodes: f.nodes })),
    scenarios: SCENARIOS.length,
    options: TREATMENT_OPTIONS.length,
    templates: FOLLOWUP_TEMPLATES.length,
    toxicityTerms: TOXICITY_TERMS.length,
    comorbidities: COMORBIDITIES.length,
    drugs: DRUG_REGIMENS.length
  };
}

export default {
  CATALOG_VERSION,
  FIGURES,
  DISEASE_STATES,
  RISK_STRATA,
  SCENARIOS,
  TREATMENT_OPTIONS,
  FOLLOWUP_TEMPLATES,
  TOXICITY_TERMS,
  COMORBIDITIES,
  DRUG_REGIMENS,
  RESPONSE_RULES,
  FOLLOWUP_ITEMS,
  getCatalog,
  optionById,
  optionsForScenario,
  templateByCode,
  toxicityByCode,
  comorbidityByCode,
  scenarioByKey,
  catalogSummary
};

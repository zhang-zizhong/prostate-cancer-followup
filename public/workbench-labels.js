/* 工作台统一临床标签层
 * 只做展示映射，不改数据库里的代码值。
 * 所有页面、弹窗、打印件都应通过 WsLabels.label(kind, value) 取中文。
 */
(function () {
  'use strict';

  const MAPS = {
    episodeStatus: { active: '进行中', completed: '已完成', stopped: '已停止', planned: '计划中' },
    intent: {
      radical: '根治', adjuvant: '辅助', salvage: '挽救', palliative: '姑息',
      neoadjuvant: '新辅助', active_surveillance: '主动监测', watchful_waiting: '观察等待'
    },
    stopReason: {
      progression: '疾病进展', toxicity: '毒性/不耐受', completed: '完成计划',
      patient_choice: '患者选择', other: '其他', unknown: '未记录'
    },
    response: {
      CR: '完全缓解', PR: '部分缓解', SD: '稳定', PD: '进展', NE: '不可评估', NA: '未评估', PSA50: 'PSA 下降≥50%', PSA30: 'PSA 下降≥30%',
      ongoing: '治疗中', path: '术后病理', none: '未评估'
    },
    complication: {
      none: '无', urinary_incontinence: '尿失禁', erectile_dysfunction: '勃起功能障碍',
      lymphocele: '淋巴漏/淋巴囊肿', rectal_injury: '直肠损伤', vascular_injury: '血管损伤',
      ureteral_injury: '输尿管损伤', bladder_neck_stricture: '膀胱颈狭窄',
      anastomotic_leak: '吻合口漏', infection: '感染', other: '其他'
    },
    surgeryApproach: { robot: '机器人辅助', lap: '腹腔镜', open: '开放', other: '其他' },
    nerveSparing: { none: '未保留', left: '保留左侧', right: '保留右侧', bilateral: '双侧保留' },
    lnDissection: { none: '未清扫', standard: '标准清扫', extended: '扩大清扫' },
    specimenType: {
      biopsy: '穿刺活检', RP: '根治性前列腺切除标本', TURP: 'TURP 标本',
      metastasis: '转移灶活检', other: '其他'
    },
    marginStatus: { negative: '阴性', positive: '阳性', unknown: '未评估' },
    histologyType: {
      acinar: '腺泡腺癌', ductal: '导管腺癌', neuroendocrine: '神经内分泌癌',
      mixed: '混合型', other: '其他'
    },
    rtType: { EBRT: '外照射 EBRT', SBRT: 'SBRT', brachy: '近距离放疗', other: '其他' },
    rtTarget: { prostate: '前列腺', pelvis: '盆腔', prostate_pelvis: '前列腺+盆腔', metastasis: '转移灶', other: '其他' },
    imagingModality: {
      MRI: 'MRI', mpMRI: '多参数 MRI', CT: 'CT', PSMA: 'PSMA PET/CT',
      bone_scan: '骨扫描', PET: 'PET/CT', other: '其他'
    },
    comparison: {
      improved: '好转', stable: '稳定', progressed: '进展', new_lesion: '新发',
      mixed: '混合', unknown: '未比较', none: '未比较'
    },
    outcomeType: {
      BCR: '生化复发', CRPC: '去势抵抗', metastasis: '转移', SRE: '骨相关事件',
      death: '死亡', lost: '失访', other: '其他'
    },
    followupMode: { clinic: '门诊', phone: '电话', external: '线上/外院', hospital: '住院', other: '其他' },
    visitType: {
      outpatient: '门诊', inpatient: '住院', phone: '电话', external: '外院',
      mdt: 'MDT', chemo: '化疗', other: '其他'
    },
    medCategory: {
      adt: '去势/ADT', endocrine: '内分泌', arpi: '新型内分泌（ARPI）', chemo: '化疗',
      parpi: 'PARP/靶向', nuc: '核素/免疫', bone: '骨保护', support: '支持治疗', other: '其他'
    },
    comorbidityStatus: { unknown: '未评估', active: '活动/现患', history: '既往', negative: '明确无' },
    clinicalStatus: { '': '未评估', completed: '已完成', abnormal: '异常', normal: '正常', not_done: '未做', pending: '待复查' },
    counselingStatus: { '': '未记录', offered: '已建议', completed: '已完成', declined: '拒绝', unknown: '未知' },
    clinicalCategory: {
      bone: '骨健康', cardio: '心血管代谢', qol: '生活质量', monitor: '药物监测',
      lab: '化验', other: '其他'
    },
    aeRecovery: {
      unknown: '未记录', recovering: '恢复中', recovered: '已恢复', not_recovered: '未恢复'
    },
    diseaseStateStatus: {
      confirmed: '医生确认', suspected: '疑似', ruled_out: '已排除', historical: '历史'
    },
    setting: {
      '新辅助': '新辅助', '辅助': '辅助', '挽救': '挽救', 'mHSPC': 'mHSPC',
      'nmCRPC': 'nmCRPC', 'mCRPC': 'mCRPC', '局限治疗': '局限治疗',
      '主动监测': '主动监测', '观察等待': '观察等待', '其他': '其他'
    },
    tumorBurden: {
      high: '高瘤负荷', low: '低瘤负荷', unknown: '负荷未评估', none: '无转移'
    }
  };

  /* RecordCore 已有更细的字典时优先复用它，避免两套值不一致 */
  function fromRecordCore(kind, value) {
    if (!window.RecordCore) return '';
    const map = {
      specimen: 'SPECIMEN_TYPES', margin: 'MARGIN_STATUS', modality: 'IMAGING_MODALITIES',
      outcome: 'OUTCOME_TYPES', sample: 'SAMPLE_TYPES', timepoint: 'TIMEPOINTS',
      hrr: 'HRR_STATUS', msi: 'MSI_STATUS', ihcResult: 'IHC_RESULTS', ihcIntensity: 'IHC_INTENSITY',
      sampleTreatment: 'TREATMENT_STATUS', storage: 'STORAGE'
    }[kind];
    if (!map || !RecordCore[map] || typeof RecordCore.labelOf !== 'function') return '';
    return RecordCore.labelOf(RecordCore[map], value);
  }

  function label(kind, value) {
    if (value == null || value === '') return '';
    const s = String(value);
    const rc = fromRecordCore(kind, s);
    if (rc && rc !== s) return rc;
    const m = MAPS[kind];
    if (m && Object.prototype.hasOwnProperty.call(m, s)) return m[s];
    return s;
  }

  function options(kind, current, blankLabel) {
    const m = MAPS[kind] || {};
    return Object.keys(m).map(function (v) {
      return '<option value="' + v + '"' + (String(current == null ? '' : current) === v ? ' selected' : '') + '>' + m[v] + '</option>';
    }).join('');
  }

  window.WsLabels = { label: label, options: options, maps: MAPS };
})();

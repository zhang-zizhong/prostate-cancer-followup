# 结构化专病数据字典（2026-10-20）

本文件对应 `public/record-core.js`、`server.js` 中的结构化字段，供录入、统计、备份和后续生物信息学使用。  
字段口径与后续增补见 [data-dictionary-v13.md](data-dictionary-v13.md)。

## 1. 分层

| 层级 | 内容 | 入口 | 详情页 |
|---|---|---|---|
| L1 主线 | 诊断、分期、Gleason/ISUP、风险、当前治疗线、BCR/CRPC/转移/死亡、PSA/睾酮 | 档案、用药、病程-结局、PSA/睾酮 | 顶部摘要 + 疾病主线 + 随访 |
| L2 专科 | 病理、影像、放疗、治疗线历史 | 病程事件、用药 | 治疗暴露 / 病理与分子 / 影像与转移 |
| L3 科研 | 样本、IHC、基因组、库号、知情/共享 | 档案-科研数据 | 病理与分子内的科研子区 |
| L4 支持 | 家族史、ECOG、Charlson、BMI、吸烟、种族 | 档案-基线 | 基线与支持 |

## 2. 表结构

### `patients` 新增列

| 列 | 类型 | 说明 |
|---|---|---|
| `family_history` | INTEGER | NULL 未评估 / 0 无 / 1 有 |
| `family_history_detail` | TEXT | 关系、发病年龄、已知基因 |
| `ecog` | INTEGER | 0–4 |
| `charlson` | INTEGER | 0–50 |
| `bmi` | REAL | 5–80 |
| `smoking` | TEXT | never/former/current/unknown |
| `race` / `ethnicity` | TEXT | 种族/民族 |
| `center_id` | TEXT | 多中心编号 |
| `research_consent` | INTEGER | NULL/0/1 |
| `research_consent_date` / `_version` | TEXT | 知情日期/版本 |
| `data_sharing` | INTEGER | NULL/0/1 |
| `data_sharing_scope` / `_date` | TEXT | 共享范围/日期 |
| `last_followup_mode` | TEXT | clinic/phone/external/hospital/other |

### `pathology_reports`

`id, patient_id, event_id, specimen_type, report_date, cores_total, cores_positive, cores_positive_pct, gleason_primary, gleason_secondary, gleason_total, isup, ptnm, margin_status, margin_site, ece, svi, ln_positive, ln_examined, idc_p, cribriform, dac, nepc, nepc_detail, pni, tumor_volume_pct, tumor_cell_pct, is_primary, notes, created_by, created_at`

- `event_id` 唯一（一个事件一份病理）。
- `is_primary`：活检（biopsy）与手术病理（RP/TURP）**各自最多一份主要**；同一类标本内唯一。只有 primary 活检同步 `patients.gleason`，只有 primary RP/TURP 同步 `patients.pathologic_stage`；非主要报告不改主档。同步前的手工值保存在 `patients.gleason_manual/pathologic_stage_manual`，取消/删除 primary 时回退。
- `specimen_type`：biopsy/RP/TURP/metastasis/review/unknown。
- 三态字段：NULL 未评估 / 0 否 / 1 是。

### `imaging_studies`

`id, patient_id, event_id, modality, study_date, region, lesion_count, metastatic_sites, extra_pelvic, new_lesion, pirads, psma_positive, psma_suvmax, psma_lesion_count, recist, pcwg, flare, oligo_status, is_current, notes, created_by, created_at`

- `metastatic_sites`：逗号分隔的 `bone/lymph_node/visceral/other`。
- `is_current` 每个患者唯一；只有明确选“是”才同步负荷到 `patients.met_count/met_extra_pelvis/visceral_met/oligo_type`。空字段保留档案原值，不把 `visceral_met=1` 静默改成 0。
- `modality`：mpMRI/CT/PSMA_PET/bone_scan/other。

### `radiation_records`

`id, patient_id, event_id, rt_type, start_date, end_date, dose_gy, fractions, target, concurrent_adt, adt_duration_months, technique, toxicity_grade, is_current, notes, created_by, created_at`

- `is_current` 每个患者唯一；保存时同步 `patients.rt_end_date`。
- `rt_type`：EBRT/SBRT/brachy/other；`target`：prostate/pelvis/prostate_pelvis/metastasis/other。

### `patient_outcomes`

`id, patient_id, event_id, outcome_type, event_date, subtype, basis, psa_value, imaging_negative, metastatic_sites, lesion_count, oligo_status, death_cause, lost_reason, last_contact_date, note, created_by, created_at`

- `outcome_type`：BCR/CRPC/metastasis/death/lost。
- BCR/CRPC/death/lost 各限一条；转移可多条。
- 保存时创建/关联时间线事件；death/lost 同步 `followup_status` 和 `last_followup_date`。

### `specimens`

`id, patient_id, sample_type, collection_date, timepoint, treatment_status, storage, tumor_cell_pct, nucleic_quality, library_id, biobank_id, notes, created_by, created_at`

- `sample_type`：tissue_biopsy/tissue_RP/tissue_TURP/tissue_metastasis/blood/urine/ctDNA/other。
- `biobank_id` 唯一（非空）。

### `genomic_tests`

`id, patient_id, specimen_id, test_type, test_date, lab, platform, genes, hrr_status, msi_status, tmb_value, ar_status, tp53_status, pten_status, rb1_status, result_summary, notes, created_by, created_at`

- `test_type`：germline/somatic。
- `hrr_status`：pathogenic/VUS/negative/unknown；`msi_status`：MSI-H/MSS/unknown。

### `ihc_results`

`id, patient_id, specimen_id, marker, result, percent, intensity, test_date, lab, notes, created_by, created_at`

- `marker`：PTEN/ERG/AR/PSMA/KI67/SYN/CGA/CD56/P53/RB1/MSH2/MSH6/PMS2/MLH1/PDL1。
- `result`：positive/negative/lost/retained/equivocal/not_done。

### `treatment_lines` 新增

- `stop_reason_code`：progression/toxicity/completed/patient_choice/other。
- `response_code`：PSA50/PSA30/PR/SD/PD/NE。
- 旧 `stop_reason`/`response` 作为自由文本备注。

## 3. 校验与同步规则

- 日期：`YYYY-MM-DD`；不得早于出生日期；放疗/治疗线结束不得早于开始。
- 病理：Gleason 1–5 且原/次成对；`cores_positive<=cores_total`；`ln_positive<=ln_examined`。
- 影像：PI-RADS 1–5；病灶数/SUVmax ≥0；RECIST/PCWG 受控枚举。
- 结局：BCR/CRPC/death/lost 唯一；`outcome_type` 必须与事件类型一致（BCR↔生化复发确认，CRPC↔去势抵抗确认，metastasis↔转移确认，death↔终止随访/死亡，lost↔失访确认）；lost 必填 `last_contact_date`；death/lost 互斥，且更新随访状态。
- 病理 `is_primary` 只清同标本类型的旧标记；影像/放疗 `is_current` 保存前清同患者旧标记。
- 所有结构化写入均记审计日志；删除事件时病理/影像/放疗级联，结局需先删除结局记录。

## 4. 备份

- 备份版本 **v9**；新增数组：`pathologyReports/imagingStudies/radiationRecords/outcomes/specimens/genomicTests/ihcResults`。
- 导入时建立旧→新 `eventId`/`specimenId` 映射；映射不到置 null 并告警。
- 旧 v8 备份缺少新数组时按空数组处理。

## 5. 与评估报告的三星清单

55 个 ★★★ 数据点的逐项落点见评估报告第 2.2 节；本字典只描述落库结构。  
新增的 IHC/样本层/诊断 PSA/种族/数据字典属于报告 5.1 的 P0 补缺项，不在原 55 行内，但与 55 行共同构成可用的科研数据底座。

## 6. 2026-10-21 修复后的同步与导出规则

### `patients` 来源列

| 列 | 说明 |
|---|---|
| `gleason_source` | `manual` 档案手工输入；`pathology:<id>` 由活检病理同步；空=旧数据未识别 |
| `pathologic_stage_source` | `manual` 档案手工输入；`pathology:<id>` 由 primary RP/TURP 同步；空=旧数据未识别 |

- 临床 Gleason 永远优先取活检（primary 活检优先，否则最近一份）；RP/TURP 的 Gleason 只用于术后复发风险，不覆盖临床 Gleason。
- pTNM 只取 primary RP/TURP；删除/取消 primary 时只回收 source 为 `pathology:` 的字段，不碰手工值。
- 病理结构化事件的事件级 Gleason 由病理报告派生，前端不再单独录入。

### 科研导出（tidy CSV ZIP）

- 入口：数据管理 → 数据备份与恢复 → “导出科研包（tidy CSV ZIP）”。
- 一个实体一张 CSV：`patients/psa/testosterone/pathology/imaging/radiation/outcomes/treatment_lines/treatment_agents/medications/clinical_records/labs/events/specimens/genomic_tests/ihc_results/export_meta`。
- 一行一个对象；病理的 cores、IDC-P、筛状、DAC、PNI、肿瘤含量等均为独立列，不再塞进 `detail`。
- 每个 CSV 带 UTF-8 BOM；布尔写 1/0，缺失写空；code 与 label 分列；ZIP 内附 `README.txt`。

### 日期与死亡校验

- 诊断、PSA、睾酮、事件、病理、影像、放疗、结局、监测、样本、基因、IHC、知情/共享、末次随访等日期不得晚于今天（Asia/Shanghai）。
- “死亡”必须有 `patient_outcomes` 的死亡结局（含死亡日期）；死亡后不得新增晚于死亡日期的临床记录。
- 死亡结局日期不得早于已有记录，否则返回冲突记录清单。

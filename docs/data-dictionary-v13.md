# 结构化数据字典 · v13 补充（2026-11-04）

> 在 [`data-dictionary.md`](data-dictionary.md) 基础上新增，不删除旧表/旧字段。
> 设计依据：记录册 HTML、CSCO 2026 四图总览。
> 目标：把记录册的“治疗段 → 实施 → 评分卡 → 连续随访表”和指南的 286 个节点落到可查询字段。

## 1. 新增对象总览

| 对象 | 表 | 一句话 |
|---|---|---|
| 治疗段 | `treatment_episodes` | 记录册的一段（RP/RT/ADT/SYSTEMIC/CHEMO/AS/WW/OTHER）；可多段并存 |
| 就诊 | `visits` | 一次门诊/住院/电话/MDT；一个日期、一份小结 |
| 就诊-段行 | `visit_episode_rows` | 记录册“一次门诊 = 一段一行”；段内序号、总体疗效/依据 |
| 就诊项目 | `visit_items` | 本次应做/实际做清单；空白不再等于“正常” |
| 不良事件 | `adverse_events` | 每个毒性术语一行；grade NULL=未评估，0=评估为无 |
| 手术实施 | `surgery_records` | 术式/入路/神经保留/左右淋巴结/导管/围手术期并发症 |
| 化疗周期 | `chemo_cycles` | 周期号/剂量/减量/延迟/ECOG/下次周期 |
| 给药日志 | `medication_administrations` | ADT 等注射逐次日期/剂量/下次到期 |
| 合并症 | `comorbidities` | 记录册 p2 实拍 21 项 + other；Charlson 可回算 |
| 疾病状态 | `disease_states` | 医生确认的 S0–S8/B1–B4 快照；自动评估仍在 clinical-core |

参考目录不在患者表：`lib/guideline-catalog.mjs`，通过 `GET /api/catalog` 提供，版本 `2026.11.04-v1`。

## 2. 关键字段

### `treatment_episodes`

`id, patient_id, episode_type, template_code, label, intent, line_id, guideline_scenario, guideline_option_id, recommendation_level, guideline_ref, start_date, end_date, status, stop_reason_code, followup_interval_days, source, notes, created_by, created_at`

- `episode_type`：surgery / radiotherapy / endocrine / systemic / chemo / surveillance / other
- `template_code`：RP / RT / ADT / SYSTEMIC / CHEMO / AS / WW / OTHER
- `intent`：radical / adjuvant / salvage / palliative / neoadjuvant / active_surveillance / watchful_waiting
- `status`：planned / active / completed / stopped
- `line_id` 指向 `treatment_lines`；手术/放疗/AS 可为空。
- `guideline_option_id` 对应目录中的选项；`recommendation_level` 存 I/II/III + 1A/2A/3类。
- `followup_interval_days` 默认由模板生成，可按高危因素调整。

### `visits`

`id, patient_id, visit_date, visit_type, department, physician, chief_complaint, ecog, pain_nrs, summary, next_plan, next_visit_date, mdt_participants, mdt_conclusion, source, status, created_by, created_at, updated_at`

- `visit_type`：baseline / outpatient / inpatient / phone / external / mdt / chemo / other
- `status`：draft / final
- 一个 visit 可覆盖多个 episode；每个 episode 一行。

### `visit_episode_rows`

`id, visit_id, episode_id, visit_no, row_type, overall_response, response_basis, psa_response, imaging_response, clinical_response, ecog, pain_nrs, symptom_status, summary, notes, next_visit_date, created_at`

- `row_type`：baseline / followup / chemo_cycle / chemo_reassessment / unscheduled
- `overall_response`：CR/PR/SD/PD/NE/NA；`response_basis`：psa/imaging/clinical/combined/none
- `UNIQUE(visit_id, episode_id, row_type)`；`visit_no` 段内自增。
- 关键语义：总体疗效必须带依据，避免“用 RECIST 套 ADT”。

### `visit_items`

`id, visit_id, episode_row_id, item_code, item_label, status, reason, due_date, linked_table, linked_id, source, created_at`

- `status`：pending / done / not_done / deferred / not_applicable
- 模板自动生成；结果仍写 PSA/影像/化验/AE 表，本表只记执行状态。

### `adverse_events`

`id, patient_id, visit_id, episode_row_id, chemo_cycle_id, episode_id, term_code, term_label, grade, ctcae_version, grade_basis, onset_date, resolution_date, recovery_status, aux_meds, management, action, causality, notes, created_by, created_at`

- `grade`：NULL=未评估；0=评估为无；1–5=分级。
- 功能毒性封顶 3；器官/危及生命可到 5；骨髓抑制 0–4 由 Hb/WBC/ANC/PLT 计算。
- 同一行/周期同一 term 唯一。

### `surgery_records`

`id, patient_id, episode_id, event_id, surgery_date, surgeon, procedure, approach, nerve_sparing, ln_dissection, ln_examined_left, ln_positive_left, ln_examined_right, ln_positive_right, catheter_days, drain_days, complications_json, complication_management, conversion, blood_loss_ml, hospital_days, pathology_id, notes, created_by, created_at`

### `chemo_cycles`

`id, patient_id, episode_id, line_id, cycle_no, cycle_date, regimen, agents_json, bsa, planned_dose, actual_dose, dose_reduction_pct, delay_days, delay_reason, gcsf, ecog, psa_record_id, assessment_visit_id, next_cycle_date, notes, created_by, created_at`

- `UNIQUE(episode_id, cycle_no)`；第 5/10/15…周期可生成 `chemo_reassessment` 就诊行。

### `medication_administrations`

`id, patient_id, medication_id, episode_id, admin_date, drug, dose, route, site, lot, next_due_date, notes, created_by, created_at`

### `comorbidities`

`id, patient_id, system, disease_code, disease_label, status, severity, diagnosed_date, notes, source, created_by, created_at`

- `status`：active / history / negative / unknown；未评估不等于阴性。
- `UNIQUE(patient_id, disease_code)`；词表 21 项见 `guideline-catalog.mjs`。

### `disease_states`

`id, patient_id, state_code, state_label, since_date, basis, evidence_json, status, confirmed_by, confirmed_at, superseded_at, is_current`

- `state_code`：S0–S8 / B1–B4；`status`：suggested / confirmed / rejected。
- 每个患者最多一条 `is_current=1`；与 `patients.disease_category` 分开。

## 3. 旧表扩展（只加不删）

| 表 | 新增列 | 用途 |
|---|---|---|
| `patients` | `main_symptom, symptom_duration_months, baseline_pain_nrs, birthplace, admission_no` | 记录册 p1；住院号仅掩码显示 |
| `testosterone_records` | `is_initial` | 初始睾酮 |
| `psa_records`/`testosterone_records`/`lab_values`/`clinical_records`/`imaging_studies`/`pathology_reports`/`radiation_records`/`patient_outcomes`/`timeline_events` | `visit_id`, `episode_id` | 把测量/证据挂到就诊/治疗段 |
| `radiation_records` | `purpose, dose_per_fraction, treatment_days, target_testes` | 记录册 p15 + 图四 |
| `genomic_tests` | `counseling_status, counseling_note` | 图三遗传咨询 |
| `patient_outcomes` | `sre_type` | 骨相关事件 |
| `clinical_records` | `visit_id, instrument_code, details_json` | DEXA/FRAX/IPSS/IIEF-5/EPIC-26 等量表 |
| `timeline_events` | `event_code, visit_id, episode_id` | 新代码用稳定 code |

## 4. 三态/空值规则

- 未做/未评估/不适用 ≠ 阴性/正常/0。
- `adverse_events.grade` NULL=未评估，0=评估为无。
- `comorbidities.status` unknown=未评估，negative=明确无。
- `visit_items.status` pending/done/not_done/deferred/not_applicable。
- 影像/检验“未做”必须显式记录，不能留空当阴性。
- 死亡/失访后禁止新增晚于终止日期的记录。

## 5. 备份与导出

- 备份版本 13；每患者增加 `v13` 全量数组（治疗段/就诊/行/项目/AE/手术/化疗/给药/合并症/状态）。
- 科研导出新增 CSV：`treatment_episodes.csv`、`visits.csv`、`visit_episode_rows.csv`、`adverse_events.csv`、`surgery_records.csv`、`chemo_cycles.csv`、`medication_administrations.csv`、`comorbidities.csv`、`disease_states.csv`。
- 缺失语义：空=未录/不适用；grade 空=未评估；布尔 1/0 不混 null。

## 6. 覆盖测试

- `scripts/test-guideline-catalog.mjs`：四图 286 节点元数据、场景/选项/模板/AE/合并症/药物/疗效规则。
- `scripts/test-visit-rules.mjs`：治疗段/就诊/AE/手术/化疗/合并症/状态/骨髓抑制。
- `scripts/test-export-core.mjs`：新增 CSV 与 ZIP。
- `scripts/test-structured-api.mjs`、`scripts/test-ai-intake-fixes.mjs`：现有 API/AI 回归。

## 7. 就诊关联接口（2026-11-04 补充）

- `POST /api/patients/:id/imaging`：新版就诊向导直接录入一条影像；写 `imaging_studies` + 时间轴投影，可带 `visitId/episodeId`。
- `POST /api/patients/:id/visits/:vid/attach`：把已有影像/病理/放疗/结局/事件/PSA/睾酮/化验/临床监测挂到某次就诊；只允许本患者记录。
- `GET /api/patients/:id` 返回的测量/病理/影像/放疗/结局对象已带 `visitId`，用于“未归档检查”与关联展示。
- `POST /api/patients/:id/visits/backfill`：按历史事件/测量日期聚合历史就诊，按治疗段生成随访行；已有日期跳过，不生成 AE/疗效。

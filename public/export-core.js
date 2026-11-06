/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * 前列腺随访 2.0 · 科研导出核心
 * ---------------------------------------------------------
 * 纯函数模块：把患者对象转成 tidy CSV，并打成 store-only ZIP。
 * 浏览器：<script src="/export-core.js"> → window.ExportCore
 * Node：vm.runInNewContext 读取本文件，取 module.exports
 *
 * 设计：
 *   · 一个文件 = 一个实体类型；一行一个对象；每列一个变量。
 *   · 不再把病理/影像字段塞进 detail 字符串。
 *   · 缺失写空；布尔写 1/0；code 与 label 分列。
 * ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ExportCore = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const RC = root && root.RecordCore;
  const CC = root && root.ClinicalCore;
  const labelOf = (listName, v) => {
    if (!RC || !RC[listName]) return v == null ? '' : String(v);
    return RC.labelOf(RC[listName], v);
  };
  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const table = rows => '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const b = v => (v == null ? '' : (v ? 1 : 0));
  const tri = v => (v == null || v === '' ? '' : (v ? 1 : 0));
  const n = v => (v == null || v === '' ? '' : v);
  const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  const sitesText = v => list(v).map(x => labelOf('MET_SITES', x)).join('/');

  function patientRows(patients, opts) {
    const derived = (opts && opts.derived) || (() => ({}));
    const rows = [['patient_id', 'name', 'birth_date', 'diag_date', 'age_at_diag', 'clinical_stage', 'pathologic_stage',
      'clinical_gleason', 'isup', 'risk_strata', 'risk_basis', 'gleason_source', 'pathologic_stage_source',
      'treatment', 'followup_status', 'death_date', 'last_contact', 'ecog', 'charlson', 'bmi', 'smoking',
      'family_history', 'research_consent', 'data_sharing',
      'met_count', 'met_extra_pelvis', 'visceral_met', 'oligo_type', 'tumor_burden', 'tumor_burden_basis',
      'owner', 'created_at']];
    patients.forEach(p => {
      const d = derived(p) || {};
      const death = (p.outcomes || []).find(o => o && o.outcomeType === 'death');
      const lastContact = (CC && CC.lastContact) ? CC.lastContact(p) : '';
      const isup = (CC && CC.isupOf) ? CC.isupOf(p.gleason) : '';
      rows.push([
        p.id, p.name, p.birth, p.date, p.age, p.clinicalStage, p.pathologicStage,
        p.gleason, isup == null ? '' : isup,
        d.risk || '', d.riskBasis || '', p.gleasonSource || '', p.pathologicStageSource || '',
        p.treatment || '', p.followupStatus || '在访', death ? death.eventDate : '', lastContact || '',
        n(p.ecog), n(p.charlson), n(p.bmi), p.smoking || '',
        b(p.familyHistory), b(p.researchConsent), b(p.dataSharing),
        n(p.metCount), tri(p.metExtraPelvis), tri(p.visceralMet), p.oligoType || '',
        d.tumorBurden || '', d.tumorBurdenBasis || '',
        p.owner || '', p.createdAt || ''
      ]);
    });
    return rows;
  }

  function psaRows(patients) {
    const rows = [['patient_id', 'psa_id', 'date', 'value', 'below_lod', 'lod', 'is_initial']];
    patients.forEach(p => (p.psa || []).forEach(x => rows.push([
      p.id, x.id, x.date, n(x.val), b(x.belowLod), n(x.lod), b(x.isInitial)
    ])));
    return rows;
  }

  function testoRows(patients) {
    const rows = [['patient_id', 'testo_id', 'date', 'value_ngdl', 'entered_value', 'unit', 'assay_method', 'lab', 'sample_time']];
    patients.forEach(p => (p.testo || []).forEach(x => rows.push([
      p.id, x.id, x.date, n(x.val), n(x.enteredVal), x.unit || 'ng/dl', x.assayMethod || '', x.lab || '', x.sampleTime || ''
    ])));
    return rows;
  }

  function pathologyRows(patients) {
    const rows = [['patient_id', 'pathology_id', 'event_id', 'specimen_type', 'specimen_label', 'report_date',
      'cores_total', 'cores_positive', 'cores_positive_pct', 'gleason_primary', 'gleason_secondary', 'gleason_total',
      'isup', 'ptnm', 'margin_status', 'margin_site', 'ece', 'svi', 'ln_positive', 'ln_examined',
      'idc_p', 'cribriform', 'dac', 'nepc', 'nepc_detail', 'pni', 'tumor_volume_pct', 'tumor_cell_pct',
      'is_primary', 'notes']];
    patients.forEach(p => (p.pathologyReports || []).forEach(x => rows.push([
      p.id, x.id, x.eventId || '', x.specimenType, labelOf('SPECIMEN_TYPES', x.specimenType), x.reportDate,
      n(x.coresTotal), n(x.coresPositive), n(x.coresPositivePct), n(x.gleasonPrimary), n(x.gleasonSecondary), n(x.gleasonTotal),
      n(x.isup), x.ptnm || '', x.marginStatus || '', x.marginSite || '', b(x.ece), b(x.svi), n(x.lnPositive), n(x.lnExamined),
      b(x.idcP), b(x.cribriform), b(x.dac), b(x.nepc), x.nepcDetail || '', b(x.pni), n(x.tumorVolumePct), n(x.tumorCellPct),
      b(x.isPrimary), x.notes || ''
    ])));
    return rows;
  }

  /* PSAD：与界面/服务端同一口径——检查日期（含当天）之前最近一条 PSA ÷ 体积。
     导出的是"按当前记录重算"的值，不是快照；PSA 更正后重导会同步变化。 */
  function psadAt(psaList, date, volume) {
    const v = n(volume);
    if (v == null || v <= 0) return '';
    const d = String(date || '').slice(0, 10);
    let best = null;
    (psaList || []).forEach(x => {
      const dd = String((x && x.date) || '').slice(0, 10);
      if (!dd || dd > d) return;
      if (!best || dd >= String(best.date).slice(0, 10)) best = x;
    });
    if (!best) return '';
    const psa = n(best.val != null ? best.val : best.value);
    if (psa == null) return '';
    return (Math.round((psa / v) * 100) / 100).toFixed(2);
  }
  function imagingRows(patients) {
    const rows = [['patient_id', 'imaging_id', 'event_id', 'modality', 'modality_label', 'study_date', 'region',
      'lesion_count', 'metastatic_sites', 'metastatic_sites_label', 'extra_pelvic', 'new_lesion', 'pirads',
      'psma_positive', 'psma_suvmax', 'psma_lesion_count', 'recist', 'pcwg', 'flare', 'oligo_status', 'is_current', 'notes',
      'prostate_volume_ml', 'dim_transverse_cm', 'dim_ap_cm', 'dim_cranial_cm', 'psad']];
    patients.forEach(p => (p.imagingStudies || []).forEach(x => rows.push([
      p.id, x.id, x.eventId || '', x.modality, labelOf('IMAGING_MODALITIES', x.modality), x.studyDate, x.region || '',
      n(x.lesionCount), x.metastaticSites || '', sitesText(x.metastaticSites), b(x.extraPelvic), b(x.newLesion), n(x.pirads),
      b(x.psmaPositive), n(x.psmaSuvmax), n(x.psmaLesionCount), x.recist || '', x.pcwg || '', b(x.flare), x.oligoStatus || '', b(x.isCurrent), x.notes || '',
      n(x.prostateVolumeMl), n(x.dimTransverseCm), n(x.dimApCm), n(x.dimCranialCm), psadAt(p.psa, x.studyDate, x.prostateVolumeMl)
    ])));
    return rows;
  }

  function radiationRows(patients) {
    const rows = [['patient_id', 'radiation_id', 'event_id', 'rt_type', 'rt_type_label', 'start_date', 'end_date',
      'dose_gy', 'fractions', 'target', 'target_label', 'concurrent_adt', 'adt_duration_months', 'technique', 'toxicity_grade', 'is_current', 'notes']];
    patients.forEach(p => (p.radiationRecords || []).forEach(x => rows.push([
      p.id, x.id, x.eventId || '', x.rtType, labelOf('RT_TYPES', x.rtType), x.startDate, x.endDate || '',
      n(x.doseGy), n(x.fractions), x.target || '', labelOf('RT_TARGETS', x.target), b(x.concurrentAdt), n(x.adtDurationMonths),
      x.technique || '', x.toxicityGrade || '', b(x.isCurrent), x.notes || ''
    ])));
    return rows;
  }

  function outcomeRows(patients) {
    const rows = [['patient_id', 'outcome_id', 'event_id', 'outcome_type', 'outcome_label', 'event_date', 'subtype', 'basis',
      'psa_value', 'imaging_negative', 'metastatic_sites', 'metastatic_sites_label', 'lesion_count', 'oligo_status',
      'death_cause', 'lost_reason', 'last_contact_date', 'note']];
    patients.forEach(p => (p.outcomes || []).forEach(x => rows.push([
      p.id, x.id, x.eventId || '', x.outcomeType, labelOf('OUTCOME_TYPES', x.outcomeType), x.eventDate, x.subtype || '', x.basis || '',
      n(x.psaValue), b(x.imagingNegative), x.metastaticSites || '', sitesText(x.metastaticSites), n(x.lesionCount), x.oligoStatus || '',
      x.deathCause || '', x.lostReason || '', x.lastContactDate || '', x.note || ''
    ])));
    return rows;
  }

  function treatmentRows(patients) {
    const lines = [['patient_id', 'line_id', 'line_no', 'setting', 'regimen', 'start_date', 'end_date', 'stop_reason', 'stop_reason_code', 'response', 'response_code']];
    const agents = [['patient_id', 'line_id', 'agent_id', 'drug', 'dose', 'schedule', 'start_date', 'end_date']];
    patients.forEach(p => (p.treatmentLines || []).forEach(l => {
      lines.push([p.id, l.id, l.lineNo, l.setting || '', l.regimen || '', l.startDate || '', l.endDate || '',
        l.stopReason || '', l.stopReasonCode || '', l.response || '', l.responseCode || '']);
      (l.agents || []).forEach(a => agents.push([p.id, l.id, a.id, a.drug || '', a.dose || '', a.schedule || '', a.startDate || '', a.endDate || '']));
    }));
    return { lines, agents };
  }

  function medicationRows(patients) {
    const rows = [['patient_id', 'medication_id', 'category', 'drug', 'start_date', 'end_date', 'dose', 'schedule', 'line_id', 'source', 'notes']];
    patients.forEach(p => (p.medications || []).forEach(x => rows.push([p.id, x.id, x.category, x.drug, x.startDate, x.endDate || '', x.dose || '', x.schedule || '', x.lineId || '', x.source || '', x.notes || ''])));
    return rows;
  }

  function clinicalRecordRows(patients) {
    const rows = [['patient_id', 'record_id', 'category', 'item', 'date', 'value', 'unit', 'status', 'note']];
    patients.forEach(p => (p.clinicalRecords || []).forEach(x => rows.push([p.id, x.id, x.category, x.item, x.date, n(x.val), x.unit || '', x.status || '', x.note || ''])));
    return rows;
  }

  function labValueRows(patients) {
    const rows = [['patient_id', 'lab_id', 'date', 'item_code', 'item', 'value', 'unit', 'lab', 'method', 'ref_range', 'flag', 'note', 'source']];
    patients.forEach(p => (p.labValues || []).forEach(x => rows.push([
      p.id, x.id, x.date, x.itemCode, x.item || x.itemCode, n(x.value), x.unit || '',
      x.lab || '', x.method || '', x.refRange || '', x.flag || '', x.note || '', x.source || ''
    ])));
    return rows;
  }

  function eventRows(patients) {
    const rows = [['patient_id', 'event_id', 'date', 'type', 'gleason', 'stage', 'is_surgery', 'psa_record_id', 'testo_record_id', 'lab_record_id', 'structured_kind', 'notes']];
    patients.forEach(p => (p.events || []).forEach(x => rows.push([
      p.id, x.id, x.date, x.type, x.gleason || '', x.stage || '', b(x.isSurgery),
      x.psaRecordId || '', x.testoRecordId || '', x.labRecordId || '',
      x.structured ? x.structured.kind : '', x.notes || ''
    ])));
    return rows;
  }

  function specimenRows(patients) {
    const rows = [['patient_id', 'specimen_id', 'sample_type', 'sample_label', 'collection_date', 'timepoint', 'treatment_status',
      'storage', 'tumor_cell_pct', 'nucleic_quality', 'library_id', 'biobank_id', 'notes']];
    patients.forEach(p => (p.specimens || []).forEach(x => rows.push([
      p.id, x.id, x.sampleType, labelOf('SAMPLE_TYPES', x.sampleType), x.collectionDate, x.timepoint || '', x.treatmentStatus || '',
      x.storage || '', n(x.tumorCellPct), x.nucleicQuality || '', x.libraryId || '', x.biobankId || '', x.notes || ''
    ])));
    return rows;
  }

  function genomicRows(patients) {
    const rows = [['patient_id', 'genomic_id', 'specimen_id', 'test_type', 'test_date', 'lab', 'platform', 'genes',
      'hrr_status', 'msi_status', 'tmb_value', 'ar_status', 'tp53_status', 'pten_status', 'rb1_status', 'result_summary', 'notes']];
    patients.forEach(p => (p.genomicTests || []).forEach(x => rows.push([
      p.id, x.id, x.specimenId || '', x.testType, x.testDate, x.lab || '', x.platform || '', x.genes || '',
      x.hrrStatus || '', x.msiStatus || '', n(x.tmbValue), x.arStatus || '', x.tp53Status || '', x.ptenStatus || '', x.rb1Status || '',
      x.resultSummary || '', x.notes || ''
    ])));
    return rows;
  }

  function ihcRows(patients) {
    const rows = [['patient_id', 'ihc_id', 'specimen_id', 'marker', 'result', 'percent', 'intensity', 'test_date', 'lab', 'notes']];
    patients.forEach(p => (p.ihcResults || []).forEach(x => rows.push([
      p.id, x.id, x.specimenId || '', x.marker, x.result, n(x.percent), x.intensity || '', x.testDate || '', x.lab || '', x.notes || ''
    ])));
    return rows;
  }


  function workspaceOf(p) { return (p && p.workspace) || {}; }

  function episodeRows(patients) {
    const rows = [['patient_id', 'episode_id', 'episode_type', 'template_code', 'label', 'intent', 'line_id',
      'guideline_scenario', 'guideline_option_id', 'recommendation_level', 'guideline_ref', 'start_date', 'end_date',
      'status', 'stop_reason_code', 'followup_interval_days', 'source', 'notes']];
    patients.forEach(p => (workspaceOf(p).episodes || []).forEach(x => rows.push([
      p.id, x.id, x.episodeType, x.templateCode, x.label || '', x.intent || '', x.lineId || '',
      x.guidelineScenario || '', x.guidelineOptionId || '', x.recommendationLevel || '', x.guidelineRef || '',
      x.startDate, x.endDate || '', x.status, x.stopReasonCode || '', x.followupIntervalDays || '', x.source || '', x.notes || ''
    ])));
    return rows;
  }

  function visitRows(patients) {
    const rows = [['patient_id', 'visit_id', 'visit_date', 'visit_type', 'department', 'physician', 'ecog', 'pain_nrs',
      'summary', 'next_plan', 'next_visit_date', 'mdt_participants', 'mdt_conclusion', 'source', 'status']];
    patients.forEach(p => (workspaceOf(p).visits || []).forEach(x => rows.push([
      p.id, x.id, x.visitDate, x.visitType, x.department || '', x.physician || '', x.ecog == null ? '' : x.ecog,
      x.painNrs == null ? '' : x.painNrs, x.summary || '', x.nextPlan || '', x.nextVisitDate || '',
      x.mdtParticipants || '', x.mdtConclusion || '', x.source || '', x.status || ''
    ])));
    return rows;
  }

  function visitRowRows(patients) {
    const rows = [['patient_id', 'row_id', 'visit_id', 'episode_id', 'visit_no', 'row_type', 'overall_response', 'response_basis',
      'psa_response', 'imaging_response', 'clinical_response', 'ecog', 'pain_nrs', 'symptom_status', 'summary', 'notes', 'next_visit_date']];
    patients.forEach(p => (workspaceOf(p).rows || []).forEach(x => rows.push([
      p.id, x.id, x.visitId, x.episodeId, x.visitNo == null ? '' : x.visitNo, x.rowType, x.overallResponse, x.responseBasis,
      x.psaResponse || '', x.imagingResponse || '', x.clinicalResponse || '', x.ecog == null ? '' : x.ecog,
      x.painNrs == null ? '' : x.painNrs, x.symptomStatus || '', x.summary || '', x.notes || '', x.nextVisitDate || ''
    ])));
    return rows;
  }

  function adverseEventRows(patients) {
    const rows = [['patient_id', 'ae_id', 'visit_id', 'episode_row_id', 'chemo_cycle_id', 'episode_id', 'term_code', 'term_label',
      'grade', 'ctcae_version', 'grade_basis', 'onset_date', 'resolution_date', 'recovery_status', 'aux_meds', 'management',
      'action', 'causality', 'notes']];
    patients.forEach(p => (workspaceOf(p).adverseEvents || []).forEach(x => rows.push([
      p.id, x.id, x.visitId || '', x.episodeRowId || '', x.chemoCycleId || '', x.episodeId || '', x.termCode, x.termLabel,
      x.grade == null ? '' : x.grade, x.ctcaeVersion || '', x.gradeBasis || '', x.onsetDate || '', x.resolutionDate || '',
      x.recoveryStatus || '', x.auxMeds || '', x.management || '', x.action || '', x.causality || '', x.notes || ''
    ])));
    return rows;
  }

  function surgeryRows(patients) {
    const rows = [['patient_id', 'surgery_id', 'episode_id', 'surgery_date', 'surgeon', 'procedure', 'approach', 'nerve_sparing',
      'ln_dissection', 'ln_examined_left', 'ln_positive_left', 'ln_examined_right', 'ln_positive_right',
      'catheter_days', 'drain_days', 'complications', 'complication_management', 'conversion', 'blood_loss_ml', 'hospital_days', 'notes']];
    patients.forEach(p => (workspaceOf(p).surgeryRecords || []).forEach(x => rows.push([
      p.id, x.id, x.episodeId || '', x.surgeryDate, x.surgeon || '', x.procedure || '', x.approach || '', x.nerveSparing || '',
      x.lnDissection || '', x.lnExaminedLeft == null ? '' : x.lnExaminedLeft, x.lnPositiveLeft == null ? '' : x.lnPositiveLeft,
      x.lnExaminedRight == null ? '' : x.lnExaminedRight, x.lnPositiveRight == null ? '' : x.lnPositiveRight,
      x.catheterDays == null ? '' : x.catheterDays, x.drainDays == null ? '' : x.drainDays,
      (x.complications || []).join('|'), x.complicationManagement || '', b(x.conversion),
      x.bloodLossMl == null ? '' : x.bloodLossMl, x.hospitalDays == null ? '' : x.hospitalDays, x.notes || ''
    ])));
    return rows;
  }

  function chemoRows(patients) {
    const rows = [['patient_id', 'cycle_id', 'episode_id', 'line_id', 'cycle_no', 'cycle_date', 'regimen', 'agents_json',
      'bsa', 'planned_dose', 'actual_dose', 'dose_reduction_pct', 'delay_days', 'delay_reason', 'gcsf', 'ecog', 'next_cycle_date', 'notes']];
    patients.forEach(p => (workspaceOf(p).chemoCycles || []).forEach(x => rows.push([
      p.id, x.id, x.episodeId, x.lineId || '', x.cycleNo, x.cycleDate, x.regimen || '', JSON.stringify(x.agents || []),
      x.bsa == null ? '' : x.bsa, x.plannedDose || '', x.actualDose || '', x.doseReductionPct == null ? '' : x.doseReductionPct,
      x.delayDays == null ? '' : x.delayDays, x.delayReason || '', b(x.gcsf), x.ecog == null ? '' : x.ecog,
      x.nextCycleDate || '', x.notes || ''
    ])));
    return rows;
  }

  function administrationRows(patients) {
    const rows = [['patient_id', 'administration_id', 'medication_id', 'episode_id', 'admin_date', 'drug', 'dose', 'route', 'site', 'lot', 'next_due_date', 'notes']];
    patients.forEach(p => (workspaceOf(p).administrations || []).forEach(x => rows.push([
      p.id, x.id, x.medicationId || '', x.episodeId || '', x.adminDate, x.drug, x.dose || '', x.route || '', x.site || '', x.lot || '',
      x.nextDueDate || '', x.notes || ''
    ])));
    return rows;
  }

  function comorbidityRows(patients) {
    const rows = [['patient_id', 'comorbidity_id', 'system', 'disease_code', 'disease_label', 'status', 'severity', 'diagnosed_date', 'notes']];
    patients.forEach(p => (workspaceOf(p).comorbidities || []).forEach(x => rows.push([
      p.id, x.id, x.system || '', x.diseaseCode, x.diseaseLabel || '', x.status, x.severity || '', x.diagnosedDate || '', x.notes || ''
    ])));
    return rows;
  }

  function diseaseStateRows(patients) {
    const rows = [['patient_id', 'state_id', 'state_code', 'state_label', 'since_date', 'basis', 'status', 'is_current', 'confirmed_at']];
    patients.forEach(p => (workspaceOf(p).diseaseStates || []).forEach(x => rows.push([
      p.id, x.id, x.stateCode, x.stateLabel || '', x.sinceDate, x.basis || '', x.status, b(x.isCurrent), x.confirmedAt || ''
    ])));
    return rows;
  }

  function buildBundle(patients, opts) {
    const ps = patients || [];
    const tx = treatmentRows(ps);
    const files = [
      { name: 'patients.csv', content: table(patientRows(ps, opts)) },
      { name: 'psa.csv', content: table(psaRows(ps)) },
      { name: 'testosterone.csv', content: table(testoRows(ps)) },
      { name: 'pathology.csv', content: table(pathologyRows(ps)) },
      { name: 'imaging.csv', content: table(imagingRows(ps)) },
      { name: 'radiation.csv', content: table(radiationRows(ps)) },
      { name: 'outcomes.csv', content: table(outcomeRows(ps)) },
      { name: 'treatment_lines.csv', content: table(tx.lines) },
      { name: 'treatment_agents.csv', content: table(tx.agents) },
      { name: 'medications.csv', content: table(medicationRows(ps)) },
      { name: 'clinical_records.csv', content: table(clinicalRecordRows(ps)) },
      { name: 'lab_values.csv', content: table(labValueRows(ps)) },
      { name: 'events.csv', content: table(eventRows(ps)) },
      { name: 'specimens.csv', content: table(specimenRows(ps)) },
      { name: 'genomic_tests.csv', content: table(genomicRows(ps)) },
      { name: 'ihc_results.csv', content: table(ihcRows(ps)) },
      { name: 'treatment_episodes.csv', content: table(episodeRows(ps)) },
      { name: 'visits.csv', content: table(visitRows(ps)) },
      { name: 'visit_episode_rows.csv', content: table(visitRowRows(ps)) },
      { name: 'adverse_events.csv', content: table(adverseEventRows(ps)) },
      { name: 'surgery_records.csv', content: table(surgeryRows(ps)) },
      { name: 'chemo_cycles.csv', content: table(chemoRows(ps)) },
      { name: 'medication_administrations.csv', content: table(administrationRows(ps)) },
      { name: 'comorbidities.csv', content: table(comorbidityRows(ps)) },
      { name: 'disease_states.csv', content: table(diseaseStateRows(ps)) },
      {
        name: 'export_meta.csv',
        content: table([
          ['exported_at', 'app_version', 'dictionary_version', 'patient_count', 'exported_by'],
          [new Date().toISOString(), (opts && opts.appVersion) || '2.0', (opts && opts.dictionaryVersion) || '2026-10-29',
            ps.length, (opts && opts.exportedBy) || '']
        ])
      },
      {
        name: 'README.txt',
        content: [
          '前列腺癌专病数据库 · 科研导出包',
          '导出时间：' + new Date().toISOString(),
          '患者数：' + ps.length,
          '',
          '文件：',
          '  patients.csv          一行一个患者',
          '  psa.csv               一行一条 PSA 记录',
          '  testosterone.csv      一行一条睾酮记录',
          '  pathology.csv         一行一份病理报告（含 cores/IDC-P/筛状/DAC/PNI/肿瘤含量）',
          '  imaging.csv           一行一次影像检查',
          '  radiation.csv         一行一次放疗',
          '  outcomes.csv          一行一条结局',
          '  treatment_lines.csv   一行一条治疗线',
          '  treatment_agents.csv  一行一个治疗药物',
          '  medications.csv       一行一条用药',
          '  clinical_records.csv  一行一条骨健康/代谢/QoL/监测',
          '  lab_values.csv        一行一条结构化普通化验',
          '  events.csv            一行一个时间轴事件',
          '  specimens.csv / genomic_tests.csv / ihc_results.csv',
          '  treatment_episodes.csv 一行一个治疗段（RP/RT/ADT/SYSTEMIC/CHEMO/AS/...）',
          '  visits.csv            一行一次就诊',
          '  visit_episode_rows.csv 一行一次就诊中的一个治疗段（含总体疗效/依据）',
          '  adverse_events.csv    一行一个毒性分级（grade 空=未评估，0=评估为无）',
          '  surgery_records.csv / chemo_cycles.csv / medication_administrations.csv',
          '  comorbidities.csv / disease_states.csv',
          '  export_meta.csv       导出元数据',
          '',
          '缺失语义：空字符串=未录/不适用；布尔值 1=是/有，0=否/无；null 与 unknown 不会混成 0。',
          '编码：UTF-8（每个 CSV 带 BOM，便于 Excel 直接打开）。',
          '注意：风险分层为临床风险（cTNM + 活检 ISUP + 初始 PSA），RP 病理仅用于术后复发风险/随访强度。',
          ''
        ].join('\r\n')
      }
    ];
    return { files, zip: buildZip(files) };
  }

  /* ---------- 最小 store-only ZIP（无第三方依赖） ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
  function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const date = (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }
  function utf8Bytes(str) {
    const s = String(str == null ? '' : str);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }
  function buildZip(files) {
    const enc = (root && root.TextEncoder) ? new root.TextEncoder() : { encode: utf8Bytes };
    const now = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    (files || []).forEach(f => {
      const name = enc.encode(f.name);
      const data = enc.encode(String(f.content == null ? '' : f.content));
      const crc = crc32(data);
      const local = [].concat(
        u32(0x04034B50), u16(20), u16(0x0800), u16(0), u16(now.time), u16(now.date),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)
      );
      const localBytes = new Uint8Array(local.length + name.length + data.length);
      localBytes.set(local, 0);
      localBytes.set(name, local.length);
      localBytes.set(data, local.length + name.length);
      chunks.push(localBytes);
      central.push({ name, crc, size: data.length, offset });
      offset += localBytes.length;
    });
    const centralStart = offset;
    let centralSize = 0;
    central.forEach(c => {
      const entry = [].concat(
        u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0), u16(now.time), u16(now.date),
        u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(c.offset)
      );
      const bytes = new Uint8Array(entry.length + c.name.length);
      bytes.set(entry, 0);
      bytes.set(c.name, entry.length);
      chunks.push(bytes);
      centralSize += bytes.length;
    });
    const end = [].concat(
      u32(0x06054B50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(centralSize), u32(centralStart), u16(0)
    );
    chunks.push(new Uint8Array(end));
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    chunks.forEach(c => { out.set(c, pos); pos += c.length; });
    return out;
  }

  return { buildBundle, buildZip, csvCell, table };
});

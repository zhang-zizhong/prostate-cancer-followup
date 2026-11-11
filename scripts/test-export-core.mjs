/* 科研导出核心验收：tidy CSV + ZIP 可解压 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function load(file) {
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox);
  return sandbox.module.exports;
}
const R = load(new URL('../public/record-core.js', import.meta.url));
const C = load(new URL('../public/clinical-core.js', import.meta.url));
const sandbox = { module: { exports: {} }, console, RecordCore: R, ClinicalCore: C };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(new URL('../public/export-core.js', import.meta.url), 'utf8'), sandbox);
const E = sandbox.module.exports;

const patient = {
  id: 'QA-EXP-01', name: 'QA-导出', birth: '1955-01-01', date: '2025-01-01', age: 70,
  clinicalStage: 'cT2aN0M0', pathologicStage: 'pT3aN0M0', gleason: '4+3=7',
  gleasonSource: 'pathology:1', pathologicStageSource: 'pathology:2', treatment: '根治性手术',
  followupStatus: '在访', ecog: 1, charlson: 2, bmi: 24.5, smoking: 'former',
  familyHistory: true, researchConsent: true, dataSharing: false, owner: 'tester', createdAt: '2025-01-01T00:00:00Z',
  psa: [
    { id: 1, date: '2025-01-01', val: 8, isInitial: true, belowLod: false, lod: null },
    { id: 2, date: '2025-03-01', val: 0.01, isInitial: false, belowLod: true, lod: 0.01 }
  ],
  testo: [{ id: 1, date: '2025-02-01', val: 30, enteredVal: 1.04, unit: 'nmol/L', assayMethod: 'CLIA', lab: '本院', sampleTime: '08:00' }],
  pathologyReports: [{
    id: 1, eventId: 10, specimenType: 'biopsy', reportDate: '2025-01-01', coresTotal: 12, coresPositive: 10,
    coresPositivePct: 83.3, gleasonPrimary: 4, gleasonSecondary: 3, gleasonTotal: 7, isup: 3,
    ptnm: '', marginStatus: 'unknown', marginSite: '', ece: null, svi: null, lnPositive: null, lnExamined: null,
    idcP: 1, cribriform: 0, dac: 0, nepc: 0, nepcDetail: '', pni: 1, tumorVolumePct: 40, tumorCellPct: 70, isPrimary: true, notes: '测试'
  }],
  imagingStudies: [{
    id: 1, eventId: 11, modality: 'PSMA_PET', studyDate: '2025-02-01', region: '全身', lesionCount: 3,
    metastaticSites: 'bone', extraPelvic: 1, newLesion: 1, pirads: null, psmaPositive: 1, psmaSuvmax: 9.2,
    psmaLesionCount: 3, recist: 'SD', pcwg: 'PSA_progression', flare: 0, oligoStatus: 'oligo', isCurrent: true, notes: ''
  }],
  radiationRecords: [], outcomes: [{ id: 1, eventId: 12, outcomeType: 'metastasis', eventDate: '2025-02-01', metastaticSites: 'bone', lesionCount: 3, subtype: '', basis: 'imaging', note: '' }],
  treatmentLines: [{ id: 1, lineNo: 1, setting: 'mHSPC', regimen: 'ADT+阿帕他胺', startDate: '2025-02-01', endDate: null,
    stopReason: '', stopReasonCode: '', response: '', responseCode: '', agents: [{ id: 1, drug: '戈舍瑞林', dose: '3.6mg', schedule: 'q28d', startDate: '2025-02-01', endDate: null }] }],
  medications: [{ id: 1, category: 'support', drug: '钙+维生素D', startDate: '2025-02-01', endDate: null, notes: '' }],
  clinicalRecords: [], labs: [], events: [{ id: 10, date: '2025-01-01', type: '前列腺穿刺活检病理报告', gleason: '4+3=7', stage: '', isSurgery: false, structured: { kind: 'pathology' }, notes: '' }],
  specimens: [], genomicTests: [], ihcResults: [],
  workspace: {
    episodes: [{ id: 1, episodeType: 'surgery', templateCode: 'RP', label: 'RP', intent: 'radical', status: 'completed', startDate: '2025-01-10' }],
    visits: [{ id: 1, visitDate: '2025-03-01', visitType: 'outpatient', summary: '术后复查' }],
    rows: [{ id: 1, visitId: 1, episodeId: 1, visitNo: 1, rowType: 'followup', overallResponse: 'CR', responseBasis: 'psa', psaResponse: 'UNDETECTABLE' }],
    adverseEvents: [{ id: 1, visitId: 1, episodeRowId: 1, episodeId: 1, termCode: 'urinary_incontinence', termLabel: '尿失禁', grade: 1, recoveryStatus: 'recovering' }],
    surgeryRecords: [{ id: 1, episodeId: 1, surgeryDate: '2025-01-10', procedure: 'RP', approach: 'robot', nerveSparing: 'bilateral', complications: [] }],
    chemoCycles: [], administrations: [], comorbidities: [], diseaseStates: []
  }
};

test('科研导出：每个实体一张 tidy CSV，字段独立', () => {
  const bundle = E.buildBundle([patient], { derived: () => ({ risk: '中危(预后不良)', riskBasis: '阳性针数 10/12' }) });
  const names = bundle.files.map(f => f.name);
  for (const n of ['patients.csv', 'psa.csv', 'testosterone.csv', 'pathology.csv', 'imaging.csv', 'radiation.csv',
    'outcomes.csv', 'treatment_lines.csv', 'treatment_agents.csv', 'medications.csv', 'clinical_records.csv',
    'lab_values.csv', 'events.csv', 'specimens.csv', 'genomic_tests.csv', 'ihc_results.csv',
    'treatment_episodes.csv', 'visits.csv', 'visit_episode_rows.csv', 'adverse_events.csv',
    'surgery_records.csv', 'chemo_cycles.csv', 'medication_administrations.csv',
    'comorbidities.csv', 'disease_states.csv', 'export_meta.csv', 'README.txt']) {
    assert.ok(names.includes(n), n);
  }
  const pathCsv = bundle.files.find(f => f.name === 'pathology.csv').content;
  const header = pathCsv.split(/\r?\n/)[0].replace(/^\uFEFF/, '');
  assert.match(header, /cores_total/);
  assert.match(header, /idc_p/);
  assert.match(header, /cribriform/);
  assert.match(header, /pni/);
  assert.match(header, /tumor_cell_pct/);
  assert.equal(header.split(',').includes('detail'), false);
  assert.match(pathCsv, /10,83\.3/);
  const patientsCsv = bundle.files.find(f => f.name === 'patients.csv').content;
  assert.match(patientsCsv, /中危\(预后不良\)/);
  assert.match(patientsCsv, /pathology:1/);
});

test('科研导出：ZIP 是可解压的标准包', () => {
  const bundle = E.buildBundle([patient], {});
  assert.equal(bundle.zip[0], 0x50);
  assert.equal(bundle.zip[1], 0x4B);
  const dir = mkdtempSync(path.join(tmpdir(), 'pcd-export-'));
  const file = path.join(dir, 'export.zip');
  writeFileSync(file, bundle.zip);
  try {
    const out = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
    assert.match(out, /pathology\.csv/);
    assert.match(out, /patients\.csv/);
    assert.match(out, /README\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('科研导出：age_at_diag 是诊断时年龄，不是当前年龄', () => {
  const p = Object.assign({}, patient, { age: 71 });   /* 展示年龄 71，诊断时 70 */
  const bundle = E.buildBundle([p], {});
  const csv = bundle.files.find(f => f.name === 'patients.csv').content;
  const lines = csv.replace(/^/, '').split(/\r?\n/);
  const header = lines[0].split(',');
  const row = lines[1].split(',');
  const idx = header.indexOf('age_at_diag');
  assert.ok(idx >= 0, 'age_at_diag 列存在');
  assert.equal(row[idx], '70', '1955-01-01 出生、2025-01-01 诊断 → 70 岁');
});

test('科研导出：患者级高瘤负荷字段可重建', () => {
  const p = Object.assign({}, patient, {
    metCount: 5, metExtraPelvis: true, visceralMet: true, oligoType: 'widespread'
  });
  const bundle = E.buildBundle([p], { derived: () => ({
    risk: '转移', riskBasis: 'M1', tumorBurden: '高瘤负荷', tumorBurdenBasis: '内脏转移（CHAARTED 高瘤负荷）'
  }) });
  const csv = bundle.files.find(f => f.name === 'patients.csv').content;
  const header = csv.split(/\r?\n/)[0].replace(/^\uFEFF/, '');
  for (const col of ['met_count', 'met_extra_pelvis', 'visceral_met', 'oligo_type', 'tumor_burden', 'tumor_burden_basis']) {
    assert.ok(header.split(',').includes(col), col);
  }
  assert.match(csv, /,5,1,1,widespread,高瘤负荷,/);
});

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate 60 clinically rich prostate-cancer test patients (v13 backup JSON).

The output is a normal /api/backup/export-compatible file.  It deliberately
spans the site's classification surface: risk strata, localized/advanced
disease, BCR, nmCRPC/mCRPC, salvage treatment, rare histology, AEs, surgery,
RT, ADT, ARPI, chemo, PARPi, bone/visceral/oligometastatic disease, death/lost.
"""
from __future__ import annotations
import json, math, random
from datetime import date, timedelta

REF = date(2026, 11, 4)
OUT = "data/test-cohort-60.json"

SURNAMES = list("赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳")
GIVEN = ["建国","志强","明远","伟","建平","国强","军","磊","鹏","杰","涛","斌","超","勇","刚","辉","健","宁","峰","波","浩","凯","亮","旭","阳","冰","松","林","海","江","山","石","成","东","南","北","安","康","瑞","祥","德","文","武","智","慧","清","正","立","新","春","秋","云","龙","虎","振","兴","国华","建华","志明"]
NAMES = [SURNAMES[i % len(SURNAMES)] + GIVEN[(i * 7 + 3) % len(GIVEN)] for i in range(60)]
# Ensure unique names
seen = set(); uniq = []
for i, n in enumerate(NAMES):
    if n in seen:
        n = n + str(i + 1)
    seen.add(n); uniq.append(n)
NAMES = uniq

def iso(d: date) -> str:
    return d.isoformat()

def addm(d: date, months: int) -> date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    # keep day in valid range
    day = min(d.day, [31,29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28,31,30,31,30,31,31,30,31,30,31][m-1])
    return date(y, m, day)

def addd(d: date, days: int) -> date:
    return d + timedelta(days=days)

def cap(d: date) -> date:
    if d > REF - timedelta(days=1):
        return REF - timedelta(days=1)
    return d

TERM_LABEL = {
    'urinary_incontinence':'尿失禁','erectile_dysfunction':'勃起功能障碍','hematuria':'血尿',
    'proctitis':'放射性直肠炎','hot_flashes':'潮热','metabolic_syndrome':'代谢综合征',
    'cognitive_impairment':'认知障碍','osteoporosis':'骨质疏松','anemia':'贫血','fatigue':'疲乏',
    'hypertension':'高血压','liver_toxicity':'肝毒性','rash':'皮疹','nausea':'恶心','vomiting':'呕吐',
    'diarrhea':'腹泻','peripheral_neuropathy':'周围神经病变','myelosuppression':'骨髓抑制',
    'fluid_retention':'体液潴留','allergy':'过敏反应'
}

COMORB = {
    'hypertension':('心血管','高血压'),'hyperlipidemia':('心血管','高血脂'),'angina':('心血管','心绞痛'),
    'myocardial_infarction':('心血管','心肌梗死'),'copd':('呼吸','COPD'),'diabetes':('内分泌','糖尿病'),
    'post_stroke':('神经','脑溢血后遗症'),'peptic_ulcer':('消化','胃溃疡/胃炎'),'anemia':('血液','贫血'),
    'osteoporosis':('骨骼','骨质疏松')
}

class Patient:
    def __init__(self, n: int, scenario: str):
        self.n = n
        self.scenario = scenario
        self.id = f"PC-{100+n}"
        self.name = NAMES[n-1]
        self.age = 0
        self.dx = REF - timedelta(days=365*3)
        self.birth = REF - timedelta(days=365*(n % 25 + 52))
        self.clinical_stage = ''
        self.pathologic_stage = ''
        self.gleason = ''
        self.gleason_source = 'biopsy'
        self.initial_psa = 0
        self.psa = []
        self.testo = []
        self.labs = []
        self.lab_values = []
        self.clinical_records = []
        self.medications = []
        self.treatment_lines = []
        self.events = []
        self.pathology_reports = []
        self.imaging_studies = []
        self.radiation_records = []
        self.outcomes = []
        self.specimens = []
        self.genomic = []
        self.ihc = []
        self.v13 = {'episodes': [], 'visits': [], 'rows': [], 'items': [], 'chemoCycles': [],
                    'adverseEvents': [], 'surgeryRecords': [], 'administrations': [],
                    'comorbidities': [], 'diseaseStates': []}
        self._eid = 0
        self._ep = 0
        self._vid = 0
        self._line = 0
        self._row = 0
        self._cyc = 0
        self._visit_no = {}
        self.status = '稳定'
        self.followup = '在访'
        self.castration = None
        self.met_count = 0
        self.met_extra = 0
        self.visceral = 0
        self.oligo = ''
        self.disease_category = ''
        self.last_visit = None
        self.family_history = False
        self.ecog = 0
        self.charlson = 0
        self.bmi = round(22 + (n % 7) * 0.6, 1)
        self.smoking = '既往' if n % 3 == 0 else ('从不' if n % 2 else '目前')
        self.main_symptom = ['夜尿增多','排尿困难','体检发现PSA升高','下尿路症状','骨痛'][n % 5]
        self.symptom_months = 2 + n % 18
        self.pain = 0
        self.treatment_summary = ''
        self.primary_treatment = ''
        self.last_psa_date = None
        self.adt_start = None
        self.rt_end = None
        self.surg_date = None
        self.states = []
        self.notes = []

    # ---------- records ----------
    def psa_add(self, d: date, val: float, below: bool = False, lod: float = 0.1):
        d = cap(d)
        rec = {'date': iso(d), 'val': round(float(val), 4)}
        if below:
            rec['belowLod'] = True; rec['lod'] = lod
        self.psa.append(rec)
        self.last_psa_date = max(self.last_psa_date or d, d)

    def testo_add(self, d: date, val: float, unit: str = 'ng/dl'):
        d = cap(d)
        self.testo.append({'date': iso(d), 'val': round(float(val), 2), 'unit': unit,
                           'enteredVal': round(float(val), 2), 'assayMethod': '化学发光', 'lab': '检验科'})

    def lab_add(self, d: date, code: str, label: str, val: float, unit: str, ref: str = '', flag: str = ''):
        self.lab_values.append({'date': iso(cap(d)), 'itemCode': code, 'item': label, 'value': round(float(val), 2),
                                'unit': unit, 'refRange': ref, 'flag': flag, 'lab': '检验科'})

    def event(self, d: date, typ: str, notes: str = '', stage: str = '', surgery: bool = False):
        self._eid += 1
        self.events.append({'id': self._eid, 'date': iso(cap(d)), 'type': typ, 'notes': notes,
                            'stage': stage, 'isSurgery': surgery})
        return self._eid

    def pathology(self, d: date, typ: str, specimen: str, gp: int, gs: int, *,
                  is_primary=False, ptnm='', margin='negative', margin_site='', ece=0, svi=0,
                  ln_pos=None, ln_ex=None, cores_total=None, cores_pos=None, cores_pct=None,
                  cores_max_cancer_pct=None, idc_p=0, cribriform=0, dac=0, nepc=0, pni=0,
                  histology='acinar', notes='', tumor_vol=None, specimen_site=''):
        eid = self.event(d, typ, notes)
        total = gp + gs
        isup = 1 if total <= 6 else 2 if total == 7 and gp == 3 else 3 if total == 7 else 4 if total == 8 else 5
        rec = {'id': len(self.pathology_reports)+1, 'eventId': eid, 'specimenType': specimen,
               'reportDate': iso(cap(d)), 'coresTotal': cores_total, 'coresPositive': cores_pos,
               'coresPositivePct': cores_pct, 'coresMaxCancerPct': cores_max_cancer_pct,
               'gleasonPrimary': gp, 'gleasonSecondary': gs, 'gleasonTotal': total, 'isup': isup,
               'ptnm': ptnm, 'marginStatus': margin, 'marginSite': margin_site,
               'ece': ece, 'svi': svi, 'lnPositive': ln_pos, 'lnExamined': ln_ex,
               'idcP': idc_p, 'cribriform': cribriform, 'dac': dac, 'pni': pni, 'nepc': nepc,
               'histologyType': histology, 'specimenSite': specimen_site,
               'tumorVolumePct': tumor_vol, 'isPrimary': bool(is_primary), 'notes': notes}
        self.pathology_reports.append(rec)
        if is_primary:
            self.gleason = f"{gp}+{gs}={total}"
            self.gleason_source = 'biopsy'
        return eid

    def imaging(self, d: date, event_type: str, modality: str, **kw):
        eid = self.event(d, event_type, kw.get('notes',''))
        rec = {'id': len(self.imaging_studies)+1, 'eventId': eid, 'modality': modality,
               'studyDate': iso(cap(d)), 'region': kw.get('region','前列腺/盆腔'),
               'lesionCount': kw.get('lesions'), 'metastaticSites': kw.get('sites',''),
               'extraPelvic': kw.get('extra'), 'newLesion': kw.get('new_lesion'),
               'pirads': kw.get('pirads'), 'psmaPositive': kw.get('psma_positive'),
               'psmaSuvmax': kw.get('suv'), 'psmaLesionCount': kw.get('psma_lesions'),
               'recist': kw.get('recist',''), 'pcwg': kw.get('pcwg',''), 'flare': kw.get('flare'),
               'oligoStatus': kw.get('oligo',''), 'technique': kw.get('technique',''),
               'indexLocation': kw.get('index_location',''), 'indexSizeMm': kw.get('index_size'),
               'ece': kw.get('ece'), 'svi': kw.get('svi'),
               'prostateVolumeMl': kw.get('volume'), 'dimTransverseCm': kw.get('dim_t'),
               'dimApCm': kw.get('dim_ap'), 'dimCranialCm': kw.get('dim_c'),
               'lnShortAxisMm': kw.get('ln_short'), 'superscan': kw.get('superscan'),
               'lungNoduleCount': kw.get('lung_n'), 'lungNoduleMaxMm': kw.get('lung_mm'),
               'miTnm': kw.get('mi_tnm',''), 'psmaRads': kw.get('psma_rads',''),
               'changedManagement': kw.get('changed'), 'comparison': kw.get('comparison',''),
               'isCurrent': kw.get('current', False), 'notes': kw.get('notes','')}
        self.imaging_studies.append(rec)
        return eid

    def radiation(self, d: date, rt_type: str, rt_target: str, dose: float, fractions: int, *,
                  event_type='外照射放疗(EBRT)', end=None, concurrent_adt=True, technique='VMAT',
                  notes='', current=True, toxicity='G1'):
        eid = self.event(d, event_type, notes)
        rec = {'id': len(self.radiation_records)+1, 'eventId': eid, 'rtType': rt_type,
               'startDate': iso(cap(d)), 'endDate': iso(cap(end or addd(d, 40))),
               'doseGy': dose, 'fractions': fractions, 'target': rt_target,
               'concurrentAdt': 1 if concurrent_adt else 0, 'adtDurationMonths': 24 if concurrent_adt else None,
               'technique': technique, 'toxicityGrade': toxicity, 'isCurrent': current,
               'notes': notes}
        self.radiation_records.append(rec)
        self.rt_end = cap(end or addd(d, 40))
        return eid

    def outcome(self, d: date, typ: str, *, subtype='', basis='PSA', psa_value=None,
                sites='', lesions=None, imaging_negative=1, death_cause='', lost_reason='',
                note='', event_type=None):
        eid = self.event(d, event_type or {'BCR':'生化复发确认','CRPC':'去势抵抗确认','metastasis':'转移确认',
                                           'death':'死亡','lost':'失访'}[typ], note)
        rec = {'id': len(self.outcomes)+1, 'eventId': eid, 'outcomeType': typ,
               'eventDate': iso(cap(d)), 'subtype': subtype, 'basis': basis,
               'psaValue': psa_value, 'imagingNegative': imaging_negative,
               'metastaticSites': sites, 'lesionCount': lesions,
               'deathCause': death_cause, 'lostReason': lost_reason,
               'lastContactDate': iso(cap(d)), 'note': note}
        self.outcomes.append(rec)
        if typ == 'BCR':
            if self.status == '稳定': self.status = '生化复发'
        elif typ == 'metastasis':
            self.status = '转移'
            self.met_count = lesions or 1
            if 'bone' in sites: self.met_extra = 1 if 'lymph_node' in sites else 0
            self.visceral = 1 if 'visceral' in sites else 0
        elif typ == 'death':
            self.status = '死亡'; self.followup = '死亡'
        elif typ == 'lost':
            self.followup = '失访'; self.status = '失访'
        return eid

    def line(self, no: int, setting: str, regimen: str, start: date, end: date | None = None, *,
             stop='', stop_code='', response='', response_code='', agents=None):
        self._line += 1
        rec = {'id': self._line, 'lineNo': no, 'setting': setting, 'regimen': regimen,
               'startDate': iso(cap(start)), 'endDate': iso(cap(end)) if end else None,
               'stopReason': stop, 'stopReasonCode': stop_code,
               'response': response, 'responseCode': response_code,
               'agents': agents or []}
        self.treatment_lines.append(rec)
        return self._line

    def episode(self, typ: str, code: str, label: str, start: date, end: date | None = None, *,
                line_id=None, status='completed', intent='radical', scenario='', notes=''):
        self._ep += 1
        rec = {'id': self._ep, 'episodeType': typ, 'templateCode': code, 'label': label,
               'intent': intent, 'lineId': line_id, 'guidelineScenario': scenario,
               'guidelineOptionId': '', 'recommendationLevel': 'I', 'guidelineRef': 'CSCO 2026',
               'startDate': iso(cap(start)), 'endDate': iso(cap(end)) if end else None,
               'status': status, 'stopReasonCode': '', 'followupIntervalDays': 90,
               'notes': notes}
        self.v13['episodes'].append(rec)
        self._visit_no[self._ep] = 0
        return self._ep

    def medicine(self, category: str, drug: str, start: date, end: date | None, *, dose='', schedule='',
                 line_id=None, notes=''):
        self.medications.append({'category': category, 'drug': drug, 'startDate': iso(cap(start)),
                                 'endDate': iso(cap(end)) if end else None, 'dose': dose,
                                 'schedule': schedule, 'lineId': line_id, 'source': 'manual', 'notes': notes})

    def ae(self, term: str, grade: int, *, visit_id=None, row_id=None, episode_id=None, cycle_id=None,
           onset=None, recovery='unknown', auxMeds='', management='', action='none', notes=''):
        self.v13['adverseEvents'].append({'termCode': term, 'termLabel': TERM_LABEL.get(term, term),
            'grade': grade, 'visitId': visit_id, 'episodeRowId': row_id, 'episodeId': episode_id,
            'chemoCycleId': cycle_id, 'onsetDate': iso(cap(onset)) if onset else None,
            'recoveryStatus': recovery, 'auxMeds': auxMeds, 'management': management,
            'action': action, 'notes': notes, 'ctcaeVersion': 'CTCAE 5.0'})

    def visit(self, d: date, summary: str, rows=None, *, visit_type='outpatient', dept='泌尿外科',
              physician='', ecog=None, next_plan='', next_visit=None, mdt=False, items=None, aes=None):
        d = cap(d)
        self._vid += 1
        vid = self._vid
        rec = {'id': vid, 'visitDate': iso(d), 'visitType': 'mdt' if mdt else visit_type,
               'department': dept, 'physician': physician, 'ecog': ecog if ecog is not None else self.ecog,
               'painNrs': self.pain, 'summary': summary, 'nextPlan': next_plan,
               'nextVisitDate': iso(cap(next_visit)) if next_visit else None,
               'mdtParticipants': '泌尿外科、肿瘤内科、放疗科、影像科' if mdt else '',
               'mdtConclusion': 'MDT讨论后按当前方案执行' if mdt else '',
               'status': 'final'}
        self.v13['visits'].append(rec)
        self.last_visit = max(self.last_visit or d, d)
        rows = rows or []
        for r in rows:
            eid = r.get('episodeId')
            if not eid: continue
            self._visit_no[eid] = self._visit_no.get(eid, 0) + 1
            self._row += 1
            rid = self._row
            row = {'id': rid, 'visitId': vid, 'episodeId': eid, 'visitNo': self._visit_no[eid],
                   'rowType': r.get('rowType', 'baseline' if self._visit_no[eid] == 1 else 'followup'),
                   'overallResponse': r.get('overallResponse', 'NA'),
                   'responseBasis': r.get('responseBasis', 'psa'),
                   'psaResponse': r.get('psaResponse', 'NA'),
                   'imagingResponse': r.get('imagingResponse', 'NA'),
                   'clinicalResponse': r.get('clinicalResponse', 'stable'),
                   'ecog': self.ecog, 'painNrs': self.pain,
                   'summary': r.get('summary', ''), 'notes': r.get('notes', ''),
                   'nextVisitDate': iso(cap(next_visit)) if next_visit else None}
            self.v13['rows'].append(row)
            for label, code, status, due in (items or []):
                self.v13['items'].append({'visitId': vid, 'episodeRowId': rid, 'itemCode': code,
                    'itemLabel': label, 'status': status, 'dueDate': iso(cap(due)) if due else None,
                    'source': 'import'})
            if aes:
                for term, grade, extra in aes:
                    self.ae(term, grade, visit_id=vid, row_id=rid, episode_id=eid,
                            onset=d, **extra)
        return vid

    def surgery(self, d: date, episode_id: int, *, approach='机器人', nerve='双侧', ln='扩大',
                complications=None, blood=100, hospital=5, catheter=7):
        d = cap(d)
        eid = self.event(d, '根治性前列腺切除术(RP)', '机器人辅助腹腔镜根治性前列腺切除术', surgery=True)
        self.v13['surgeryRecords'].append({'episodeId': episode_id, 'eventId': eid,
            'surgeryDate': iso(d), 'surgeon': '泌尿外科主刀', 'procedure': 'RP', 'approach': approach,
            'nerveSparing': nerve, 'lnDissection': ln,
            'lnExaminedLeft': 6, 'lnPositiveLeft': 0, 'lnExaminedRight': 6, 'lnPositiveRight': 0,
            'catheterDays': catheter, 'drainDays': 2,
            'complications': complications or [{'code':'urinary_incontinence','grade':1}],
            'complicationManagement': '盆底肌训练', 'conversion': False,
            'bloodLossMl': blood, 'hospitalDays': hospital, 'notes': '术后恢复顺利'})
        self.surg_date = d
        return eid

    def cycle(self, episode_id: int, line_id: int, no: int, d: date, regimen: str, *,
              agents=None, assessment_visit=None, gcsf=False, reduction=0, delay=0, next_d=None):
        self._cyc += 1
        cid = self._cyc
        self.v13['chemoCycles'].append({'id': cid, 'episodeId': episode_id, 'lineId': line_id,
            'cycleNo': no, 'cycleDate': iso(cap(d)), 'regimen': regimen,
            'agents': agents or [], 'bsa': 1.8, 'plannedDose': '75mg/m²', 'actualDose': '75mg/m²',
            'doseReductionPct': reduction, 'delayDays': delay, 'delayReason': '',
            'gcsf': bool(gcsf), 'ecog': self.ecog,
            'assessmentVisitId': assessment_visit,
            'nextCycleDate': iso(cap(next_d)) if next_d else None, 'notes': ''})
        return cid

    def administration(self, episode_id: int, d: date, drug: str, dose: str, *, next_d=None):
        self.v13['administrations'].append({'episodeId': episode_id, 'adminDate': iso(cap(d)),
            'drug': drug, 'dose': dose, 'route': '皮下', 'site': '腹壁', 'lot': 'LOT-2026',
            'nextDueDate': iso(cap(next_d)) if next_d else None, 'notes': ''})

    def comorbidity(self, code: str, *, severity='轻度', status='确诊'):
        if code not in COMORB: return
        sys, label = COMORB[code]
        self.v13['comorbidities'].append({'system': sys, 'diseaseCode': code, 'diseaseLabel': label,
            'status': status, 'severity': severity, 'diagnosedDate': iso(self.dx - timedelta(days=365*5)),
            'notes': ''})

    def state(self, code: str, label: str, since: date, basis: str, *, current=True, evidence=None):
        for s in self.v13['diseaseStates']:
            if s.get('isCurrent'):
                s['isCurrent'] = 0
                s['supersededAt'] = iso(cap(since))
        self.v13['diseaseStates'].append({'stateCode': code, 'stateLabel': label,
            'sinceDate': iso(cap(since)), 'basis': basis,
            'evidenceJson': json.dumps(evidence or {}, ensure_ascii=False),
            'status': 'confirmed', 'isCurrent': 1 if current else 0})

    # ---------- finalize ----------
    def finalize(self):
        self.psa.sort(key=lambda x: x['date'])
        self.testo.sort(key=lambda x: x['date'])
        self.events.sort(key=lambda x: (x['date'], x['id']))
        self.v13['visits'].sort(key=lambda x: (x['visitDate'], x['id']))
        self.v13['rows'].sort(key=lambda x: (x['visitId'], x['id']))
        if self.last_psa_date:
            self.last_visit = max(self.last_visit or self.last_psa_date, self.last_psa_date)
        if self.followup == '在访' and self.last_visit:
            self.last_visit = min(self.last_visit, REF - timedelta(days=1))
        age = REF.year - self.birth.year - ((REF.month, REF.day) < (self.birth.month, self.birth.day))
        p = {
            'id': self.id, 'name': self.name, 'age': age, 'birth': iso(self.birth), 'scenario': self.scenario,
            'date': iso(self.dx), 'surgDate': iso(self.surg_date) if self.surg_date else None,
            'gleason': self.gleason, 'gleasonSource': self.gleason_source,
            'stage': self.clinical_stage or self.pathologic_stage,
            'clinicalStage': self.clinical_stage, 'pathologicStage': self.pathologic_stage,
            'pathologicStageSource': 'RP' if self.pathologic_stage else '',
            'treatment': self.treatment_summary, 'concomitantMeds': '',
            'status': self.status, 'followupStatus': self.followup,
            'castration': self.castration,
            'rtEndDate': iso(self.rt_end) if self.rt_end else None,
            'adtStartDate': iso(self.adt_start) if self.adt_start else None,
            'lastFollowupDate': iso(self.last_visit) if self.last_visit else None,
            'lastFollowupMode': '门诊' if self.followup == '在访' else '',
            'metCount': self.met_count, 'metExtraPelvis': bool(self.met_extra),
            'visceralMet': bool(self.visceral), 'oligoType': self.oligo,
            'familyHistory': 1 if self.family_history else 0,
            'familyHistoryDetail': '父亲前列腺癌' if self.family_history else '',
            'ecog': self.ecog, 'charlson': self.charlson, 'bmi': self.bmi,
            'smoking': self.smoking, 'race': '汉族', 'ethnicity': '汉族',
            'centerId': 'TEST-60', 'researchConsent': 1, 'researchConsentDate': iso(self.dx),
            'researchConsentVersion': 'v1.0', 'dataSharing': 1, 'dataSharingScope': '去标识科研',
            'mainSymptom': self.main_symptom, 'symptomDurationMonths': self.symptom_months,
            'baselinePainNrs': self.pain, 'birthplace': '本地', 'admissionNo': f'TEST{self.n:03d}',
            'diseaseCategory': self.disease_category,
            'dreResult': 'abnormal' if self.initial_psa > 10 else 'normal',
            'dreNote': '可触及质硬结节' if self.initial_psa > 10 else '未触及明显结节',
            'owner': 'local_dev',
            'psa': self.psa, 'testo': self.testo, 'labs': self.labs,
            'labValues': self.lab_values, 'clinicalRecords': self.clinical_records,
            'medications': self.medications, 'treatmentLines': self.treatment_lines,
            'events': self.events, 'pathologyReports': self.pathology_reports,
            'imagingStudies': self.imaging_studies, 'radiationRecords': self.radiation_records,
            'outcomes': self.outcomes, 'specimens': self.specimens,
            'genomicTests': self.genomic, 'ihcResults': self.ihc,
            'v13': self.v13
        }
        return p

# ---------- scenario helpers ----------
def next_line(p):
    return (max([x['lineNo'] for x in p.treatment_lines]) + 1) if p.treatment_lines else 1

def base(p, *, age, dx, cT, gp, gs, psa, pirads=4, cores=None, cores_pos=None, cores_pct=None, sites='', lesions=None,
         visceral=False, extra=False, oligo='', histology='acinar', mdt=False):
    p.age = age
    p.birth = date(REF.year - age, 2 + (p.n % 9), 1 + (p.n % 25))
    if p.birth > dx - timedelta(days=365*35):
        p.birth = dx - timedelta(days=365*45)
    p.dx = dx
    p.initial_psa = psa
    p.clinical_stage = cT
    p.gleason = f"{gp}+{gs}={gp+gs}"
    p.pain = 2 if sites else 0
    p.psa_add(dx - timedelta(days=12), psa)
    p.lab_add(dx - timedelta(days=12), 'ALP', '碱性磷酸酶', 78 + p.n % 40, 'U/L', '40-150')
    p.lab_add(dx - timedelta(days=12), 'Cr', '肌酐', 72 + p.n % 28, 'μmol/L', '57-111')
    p.event(dx - timedelta(days=6), '直肠指检(DRE)', '前列腺可触及质硬结节' if psa > 10 else '未触及明显结节')
    p.testo_add(dx - timedelta(days=12), 420 - (p.n % 12) * 11)
    # baseline MRI
    p.imaging(dx - timedelta(days=2), '多参数磁共振(mpMRI)', 'mpMRI',
              pirads=pirads, lesions=1 if not sites else (lesions or 2), sites=sites,
              volume=32 + p.n % 22, dim_t=3.4, dim_ap=2.8, dim_c=3.1,
              index_location='外周带', index_size=9 + p.n % 8, notes='基线分期')
    # biopsy
    p.pathology(dx + timedelta(days=7), '前列腺穿刺活检病理报告', 'biopsy', gp, gs,
                is_primary=True, cores_total=cores or 12, cores_pos=cores_pos if cores_pos is not None else 6, cores_pct=cores_pct if cores_pct is not None else 50,
                cores_max_cancer_pct=40 + p.n % 30, pni=0 if gp <= 3 else 1,
                idc_p=0, cribriform=1 if gp >= 4 else 0, histology=histology,
                notes='超声引导下经会阴穿刺')
    p.event(dx + timedelta(days=10), '临床分期评估', f'临床分期 {cT}', stage=cT)
    if mdt:
        p.visit(dx + timedelta(days=14), 'MDT 讨论：局限/局部进展期，制定综合治疗计划', mdt=True)
    else:
        p.visit(dx + timedelta(days=14), '初诊：完成 PSA、mpMRI、穿刺病理与临床分期', [])
    # metastatic baseline imaging/proof
    if sites:
        p.imaging(dx + timedelta(days=1), 'PSMA PET-CT', 'PSMA_PET',
                  lesions=lesions or 2, sites=sites, extra=1 if extra else 0,
                  psma_positive=1, suv=8 + p.n % 8, psma_lesions=lesions or 2,
                  mi_tnm='M1b' if 'bone' in sites else 'M1a', notes='基线转移灶')
        p.met_count = lesions or 2
        p.met_extra = 1 if extra else 0
        p.visceral = 1 if visceral else 0
        p.oligo = oligo

def add_baseline_genomics(p, brca=False, msi=False, nepc=False):
    if p.genomic:
        return
    p.genomic.append({'id': len(p.genomic)+1, 'testType': 'germline', 'testDate': iso(p.dx + timedelta(days=20)),
        'lab': '分子病理', 'platform': 'NGS', 'genes': 'BRCA1/BRCA2/ATM/PALB2' if brca else 'HRR panel',
        'hrrStatus': 'pathogenic' if brca else 'negative', 'msiStatus': 'MSI-H' if msi else 'MSS',
        'tmbValue': 18 if msi else 3, 'resultSummary': 'BRCA2 胚系致病突变' if brca else '未检出致病突变',
        'notes': '胚系验证'})
    p.genomic.append({'id': len(p.genomic)+2, 'testType': 'somatic', 'testDate': iso(p.dx + timedelta(days=35)),
        'lab': '分子病理', 'platform': 'NGS', 'genes': 'AR/TP53/PTEN/RB1' + ('/BRCA2' if brca else ''),
        'hrrStatus': 'pathogenic' if brca else 'unknown', 'msiStatus': 'MSI-H' if msi else 'MSS',
        'tmbValue': 20 if msi else 4, 'arStatus': 'amplification' if msi else 'normal',
        'tp53Status': 'mutated' if nepc else 'wildtype', 'ptenStatus': 'loss' if nepc else 'intact',
        'rb1Status': 'loss' if nepc else 'intact', 'resultSummary': '同源重组缺陷' if brca else '体系变异',
        'notes': ''})
    p.ihc.append({'id': len(p.ihc)+1, 'marker': 'PTEN', 'result': 'loss' if nepc else 'retained',
        'percent': 0 if nepc else 80, 'intensity': 'weak' if nepc else 'strong', 'testDate': iso(p.dx + timedelta(days=8)),
        'lab': '病理科', 'notes': ''})
    p.ihc.append({'id': len(p.ihc)+2, 'marker': 'ERG', 'result': 'positive', 'percent': 60,
        'intensity': 'strong', 'testDate': iso(p.dx + timedelta(days=8)), 'lab': '病理科', 'notes': ''})
    if nepc:
        for m in ('SYN','CGA','CD56'):
            p.ihc.append({'id': len(p.ihc)+3, 'marker': m, 'result': 'positive', 'percent': 80,
                'intensity': 'strong', 'testDate': iso(p.dx + timedelta(days=8)), 'lab': '病理科', 'notes': ''})
    p.specimens.append({'id': 1, 'sampleType': 'tissue_biopsy', 'collectionDate': iso(p.dx + timedelta(days=7)),
        'timepoint': 'baseline', 'treatmentStatus': 'pre_treatment', 'tumorCellPct': 60,
        'nucleicQuality': '合格', 'biobankId': f'B{p.n:03d}-01'})
    p.specimens.append({'id': 2, 'sampleType': 'blood', 'collectionDate': iso(p.dx + timedelta(days=7)),
        'timepoint': 'baseline', 'treatmentStatus': 'pre_treatment', 'nucleicQuality': '合格',
        'biobankId': f'B{p.n:03d}-02'})

def do_rp(p, date_rp, *, nerve='双侧', ln='扩大', complications=None, blood=120):
    lnno = next_line(p)
    lid = p.line(lnno, '局限治疗', '根治性前列腺切除术', date_rp, date_rp,
                 response='术后病理', response_code='path', agents=[{'drug':'根治性前列腺切除术','dose':'','schedule':'','startDate':iso(date_rp)}])
    eid = p.episode('surgery', 'RP', '根治性前列腺切除术', date_rp, date_rp, line_id=lid,
                    status='completed', scenario='localized')
    p.primary_treatment = 'RP'
    p.treatment_summary = '第' + str(lnno) + '线 · 根治性前列腺切除术'
    # surgery + RP pathology
    p.surgery(date_rp, eid, approach='机器人', nerve=nerve, ln=ln,
              complications=complications or [{'code':'urinary_incontinence','grade':1}], blood=blood)
    # pathology stage based on clinical stage for consistency
    pT = p.clinical_stage.replace('c','p') if p.clinical_stage.startswith('c') else 'pT2aN0M0'
    if 'T3' in pT or 'T4' in pT:
        margin = 'positive' if p.n % 3 else 'negative'
        ece, svi = 1, 1 if 'T3b' in pT else 0
    else:
        margin = 'negative'; ece, svi = 0, 0
    p.pathology(date_rp + timedelta(days=12), '手术病理报告', 'RP', 4 if p.gleason.startswith('4') else 3,
                4 if p.gleason.startswith('4') else 4, is_primary=False, ptnm=pT,
                margin=margin, ece=ece, svi=svi, ln_pos=0, ln_ex=12,
                cores_total=None, cores_pos=None, notes='根治术后病理')
    p.pathologic_stage = pT
    p.rt_end = None
    p.psa_add(date_rp + timedelta(days=45), 0.02, below=True, lod=0.1)
    p.psa_add(date_rp + timedelta(days=180), 0.01, below=True, lod=0.1)
    p.testo_add(date_rp + timedelta(days=45), 360 - (p.n % 10) * 8)
    p.lab_add(date_rp + timedelta(days=45), 'Hb', '血红蛋白', 128 - p.n % 15, 'g/L', '130-175')
    p.visit(date_rp + timedelta(days=30), '术后 1 月复诊：伤口愈合，排尿控制训练中', [
        {'episodeId': eid, 'overallResponse': 'NA', 'responseBasis': 'clinical', 'psaResponse': 'UNDETECTABLE',
         'summary': '术后恢复，PSA 不可测'}], items=[('PSA复查','PSA','done',date_rp+timedelta(days=90))],
        aes=[('urinary_incontinence', 1, {'management':'盆底肌训练','recovery':'recovering'}),
             ('erectile_dysfunction', 2, {'auxMeds':'PDE5抑制剂','management':'康复训练'})])
    p.visit(date_rp + timedelta(days=120), '术后 4 月：PSA 持续不可测，制定随访计划', [
        {'episodeId': eid, 'overallResponse': 'CR', 'responseBasis': 'psa', 'psaResponse': 'UNDETECTABLE',
         'summary': '生化控制'}], items=[('PSA复查','PSA','done',date_rp+timedelta(days=210)),
         ('DRE','DRE','pending',date_rp+timedelta(days=365))])
    return lid, eid

def do_rt(p, date_rt, *, target='prostate_pelvis', dose=74, fractions=37, adt=True,
          event='外照射放疗(EBRT)', concurrent=True):
    lnno = next_line(p)
    lid = p.line(lnno, '局限治疗' if target == 'prostate' else '其他', '外照射放疗(EBRT)' + ('+ADT' if adt else ''),
                 date_rt, addd(date_rt, 45), response='放疗完成', response_code='rt',
                 agents=[{'drug':'外照射放疗','dose':f'{dose}Gy/{fractions}f','schedule':'VMAT','startDate':iso(date_rt)}])
    eid = p.episode('radiotherapy', 'RT', '根治性放疗' if target != 'metastasis' else '转移灶放疗',
                    date_rt, addd(date_rt, 45), line_id=lid, status='completed', scenario='localized')
    p.primary_treatment = 'RT'
    p.treatment_summary = f'第{lnno}线 · 外照射放疗' + ('+ADT' if adt else '')
    p.radiation(date_rt, 'EBRT', target, dose, fractions, event_type=event,
                concurrent_adt=adt, notes='VMAT 图像引导')
    if adt:
        p.castration = 1
        if not p.adt_start: p.adt_start = date_rt
        p.medicine('adt', '戈舍瑞林', date_rt, addm(date_rt, 24), dose='10.8mg', schedule='q12w', line_id=lid)
        p.administration(eid, date_rt, '戈舍瑞林', '10.8mg', next_d=addm(date_rt, 3))
        p.administration(eid, addm(date_rt, 3), '戈舍瑞林', '10.8mg', next_d=addm(date_rt, 6))
        p.testo_add(date_rt + timedelta(days=30), 18 + p.n % 10)
        p.testo_add(addm(date_rt, 3), 12 + p.n % 8)
    p.psa_add(addd(date_rt, 45), 0.6 + (p.n % 5) * 0.1)
    p.psa_add(addm(date_rt, 4), 0.4 + (p.n % 4) * 0.1)
    p.lab_add(date_rt + timedelta(days=20), 'Cr', '肌酐', 80 + p.n % 20, 'μmol/L', '57-111')
    p.visit(addd(date_rt, 14), '放疗第 2 周：耐受可，尿路刺激症状 G1', [
        {'episodeId': eid, 'overallResponse': 'NA', 'responseBasis': 'clinical', 'summary': '放疗中'}],
        aes=[('urinary_incontinence', 1, {'management':'α受体阻滞剂'}),
             ('proctitis', 1, {'management':'温水坐浴'})])
    p.visit(addm(date_rt, 3), '放疗结束 3 月：PSA 下降，继续 ADT', [
        {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': 'PSA 明显下降'}], items=[('PSA复查','PSA','done',addm(date_rt,6)),
         ('睾酮','TESTOSTERONE','done',addm(date_rt,3))])
    return lid, eid

def start_adt(p, d, regimen='戈舍瑞林', *, line_label='ADT', setting='mHSPC', intent='palliative',
              with_arpi=None, months=24, status='active'):
    lnno = next_line(p)
    full = regimen + ('+阿比特龙' if with_arpi == 'abi' else '+恩扎卢胺' if with_arpi == 'enza' else '')
    lid = p.line(lnno, setting, full, d, None, response='治疗中', response_code='ongoing')
    eid = p.episode('endocrine' if not with_arpi else 'systemic', 'ADT' if not with_arpi else 'SYSTEMIC',
                    line_label, d, None, line_id=lid, status=status, intent=intent, scenario=setting)
    p.castration = 1
    p.adt_start = p.adt_start or d
    p.medicine('adt', '戈舍瑞林', d, addm(d, months), dose='10.8mg', schedule='q12w', line_id=lid)
    p.administration(eid, d, '戈舍瑞林', '10.8mg', next_d=addm(d, 3))
    p.administration(eid, addm(d, 3), '戈舍瑞林', '10.8mg', next_d=addm(d, 6))
    if with_arpi:
        drug = '阿比特龙' if with_arpi == 'abi' else '恩扎卢胺'
        p.medicine('arpi', drug, d, addm(d, months), dose='1000mg qd' if with_arpi == 'abi' else '160mg qd',
                   schedule='qd', line_id=lid, notes='联合泼尼松' if with_arpi == 'abi' else '')
        if with_arpi == 'abi':
            p.medicine('endocrine', '泼尼松', d, addm(d, months), dose='5mg bid', schedule='bid', line_id=lid)
    p.event(d, 'ADT启动' if not with_arpi else ('新型内分泌治疗(阿比特龙+泼尼松)' if with_arpi == 'abi' else '新型内分泌治疗(恩扎卢胺)'),
            '启动' + full)
    p.testo_add(d + timedelta(days=30), 14 + p.n % 8)
    p.testo_add(addm(d, 3), 9 + p.n % 7)
    p.treatment_summary = f'第{lnno}线 · {full}'
    return lid, eid

def start_arpi(p, d, drug='阿比特龙', *, setting='mCRPC', episode_label='ARPI', months=18):
    lnno = next_line(p)
    lid = p.line(lnno, setting, drug, d, None, response='治疗中', response_code='ongoing')
    eid = p.episode('systemic', 'SYSTEMIC', episode_label, d, None, line_id=lid, status='active',
                    intent='palliative', scenario=setting)
    p.medicine('arpi', drug, d, addm(d, months), dose='1000mg qd' if drug == '阿比特龙' else '160mg qd',
               schedule='qd', line_id=lid)
    p.event(d, '新型内分泌治疗(阿比特龙+泼尼松)' if drug == '阿比特龙' else f'新型内分泌治疗({drug})',
            '启动' + drug)
    p.treatment_summary = f'第{lnno}线 · {drug}'
    return lid, eid

def start_chemo(p, d, drug='多西他赛', *, setting='mCRPC', cycles=6, assessment_visit=None):
    lnno = next_line(p)
    lid = p.line(lnno, setting, drug, d, None, response='治疗中', response_code='ongoing')
    eid = p.episode('chemo', 'CHEMO', drug + '化疗', d, None, line_id=lid, status='active',
                    intent='palliative', scenario=setting)
    p.medicine('chemo', drug, d, addm(d, cycles * 3), dose='75mg/m²' if drug == '多西他赛' else '25mg/m²',
               schedule='q3w', line_id=lid)
    p.event(d, drug, f'{drug} 第1周期')
    p.treatment_summary = f'第{lnno}线 · {drug}'
    cids = []
    for i in range(cycles):
        cd = addd(d, i * 21)
        cid = p.cycle(eid, lid, i + 1, cd, drug, agents=[{'drug': drug, 'dose': '75mg/m²' if drug=='多西他赛' else '25mg/m²'}],
                      assessment_visit=assessment_visit if i == 2 else None, gcsf=(i >= 2 and i % 2 == 0),
                      reduction=20 if i >= 3 else 0)
        cids.append(cid)
        p.psa_add(cd - timedelta(days=2), max(0.2, 6.0 - i * 0.8))
        p.lab_add(cd - timedelta(days=2), 'ANC', '中性粒细胞绝对值', 2.8 - i * 0.25, '×10⁹/L', '1.8-6.3')
        p.lab_add(cd - timedelta(days=2), 'Hb', '血红蛋白', 120 - i * 4, 'g/L', '130-175')
    return lid, eid, cids

def progression_bcr(p, d, psa, *, psma=True):
    p.psa_add(d - timedelta(days=2), psa)
    eid = p.outcome(d, 'BCR', subtype='biochemical', basis='PSA', psa_value=psa,
                    note='连续两次 PSA 升高，符合生化复发')
    if psma:
        p.imaging(d + timedelta(days=10), 'PSMA PET-CT', 'PSMA_PET', lesions=0, sites='',
                  psma_positive=0, suv=2.2, mi_tnm='M0', notes='生化复发后分期，未见转移')
    return eid

def progression_crpc(p, d, *, subtype='mCRPC', sites='bone', lesions=2, psa=8.0):
    p.testo_add(d - timedelta(days=20), 12 + p.n % 6)
    p.psa_add(d - timedelta(days=2), psa)
    eid = p.outcome(d, 'CRPC', subtype=subtype, basis='testosterone', psa_value=psa,
                    note='睾酮 <50 ng/dl 且 PSA 进展')
    p.state('mCRPC' if sites else 'nmCRPC', 'mCRPC' if sites else 'nmCRPC', d,
            '去势抵抗：睾酮<50 且 PSA 进展', evidence={'psa': psa})
    p.disease_category = 'mCRPC' if sites else 'nmCRPC'
    if sites:
        p.imaging(d + timedelta(days=7), 'PSMA PET-CT', 'PSMA_PET', lesions=lesions,
                  sites=sites, psma_positive=1, suv=9.2, psma_lesions=lesions,
                  mi_tnm='M1b' if 'bone' in sites else 'M1a', notes='CRPC 再分期')
        p.outcome(d + timedelta(days=7), 'metastasis', subtype='', basis='imaging',
                  sites=sites, lesions=lesions, imaging_negative=0, note='新发转移')
        p.met_count = lesions
        p.status = '转移'
    return eid

def add_mdt(p, d, text='MDT：寡转移/进展，讨论局部与系统治疗顺序'):
    p.visit(d, text, [], mdt=True, visit_type='mdt')

def add_labs_followup(p, d, hb=125, alp=95, cr=88):
    p.lab_add(d, 'Hb', '血红蛋白', hb, 'g/L', '130-175')
    p.lab_add(d, 'ALP', '碱性磷酸酶', alp, 'U/L', '40-150')
    p.lab_add(d, 'Cr', '肌酐', cr, 'μmol/L', '57-111')
    p.lab_add(d, 'LDH', '乳酸脱氢酶', 180 + p.n % 60, 'U/L', '120-250')

def add_standard_comorb(p, n=2):
    codes = ['hypertension','diabetes','copd','hyperlipidemia','angina']
    for c in codes[:max(1, n % 4)]:
        p.comorbidity(c)
    p.charlson = 2 + p.n % 4

# ---------- scenarios ----------
def scenario_as_rp(p, v):
    age = 58 + v * 4 + p.n % 5
    dx = REF - timedelta(days=365 * (2 + v) + 120)
    base(p, age=age, dx=dx, cT='cT1cN0M0', gp=3, gs=3, psa=5.2 + v * 1.1 + (p.n % 4) * 0.3,
         pirads=3, cores=12)
    p.disease_category = ''
    p.visit(dx + timedelta(days=45), '低危局限期，讨论主动监测与根治手术', [
        {'episodeId': None}])
    as_no = next_line(p)
    lid = p.line(as_no, '主动监测', '主动监测', dx + timedelta(days=45), None, response='监测中', response_code='ongoing')
    eid = p.episode('surveillance', 'AS', '主动监测', dx + timedelta(days=45), None, line_id=lid,
                    status='completed', intent='surveillance', scenario='low')
    p.primary_treatment = 'AS'; p.treatment_summary = '第1线 · 主动监测'
    for i in range(4):
        vd = addm(dx + timedelta(days=60), i * 6)
        p.psa_add(vd - timedelta(days=3), 5.6 + i * 0.3 + (p.n % 3) * 0.1)
        p.testo_add(vd - timedelta(days=3), 430 - i * 8)
        if i == 2:
            p.imaging(vd, '多参数磁共振(mpMRI)', 'mpMRI', pirads=4, lesions=1, volume=36,
                      notes='监测中 PI-RADS 4，较前增大')
            p.pathology(vd + timedelta(days=14), '前列腺穿刺活检病理报告', 'biopsy', 3, 4,
                        is_primary=False, cores_total=12, cores_pos=4, cores_pct=33,
                        notes='重复穿刺升级为 GG2')
        p.visit(vd, f'主动监测第{i+1}次：PSA 稳定/缓慢上升，继续观察', [
            {'episodeId': eid, 'overallResponse': 'SD', 'responseBasis': 'psa', 'psaResponse': 'STABLE',
             'summary': '监测中'}], items=[('PSA复查','PSA','done',addm(vd,6)), ('mpMRI','MPMRI','pending',addm(vd,12))])
    rp_date = addm(dx, 26)
    p.visit(rp_date - timedelta(days=20), '重复穿刺升级，患者选择根治性手术', [])
    do_rp(p, rp_date, nerve='双侧', ln='局限')
    p.state('nmHSPC', 'nmHSPC', rp_date, '根治术后，未转移', evidence={'post_rp': True})
    # 2 years later biochemical recurrence in the highest-risk variant
    if v == 3:
        bd = addm(rp_date, 30)
        progression_bcr(p, bd, 0.28 + v * 0.05)
        p.imaging(bd + timedelta(days=14), 'PSMA PET-CT', 'PSMA_PET', lesions=0, sites='', psma_positive=0,
                  suv=2.0, notes='生化复发，PSMA 阴性')
        ln = next_line(p); lid2 = p.line(ln, '挽救', '挽救性放疗+ADT', bd + timedelta(days=30), None,
                                        response='治疗中', response_code='ongoing')
        eid2 = p.episode('radiotherapy', 'RT', '挽救性放疗', bd + timedelta(days=30), addm(bd, 2),
                         line_id=lid2, status='completed', intent='salvage', scenario='salvage')
        p.radiation(bd + timedelta(days=30), 'EBRT', 'prostate_pelvis', 66, 33,
                    event_type='挽救性放疗(EBRT)', concurrent_adt=True)
        p.visit(addm(bd, 6), '挽救性放疗后 PSA 下降，继续 ADT', [
            {'episodeId': eid2, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
             'summary': 'PSA 下降'}], aes=[('hot_flashes', 1, {}), ('fatigue', 2, {})])

def scenario_rp_fav(p, v):
    age = 62 + v * 3 + p.n % 5
    dx = REF - timedelta(days=365 * (3 + v) + 200)
    base(p, age=age, dx=dx, cT='cT1cN0M0', gp=3, gs=4, psa=8.4 + v * 0.3 + (p.n % 3) * 0.12,
         pirads=4, cores=12, cores_pos=3, cores_pct=25)
    p.disease_category = ''
    rp_date = dx + timedelta(days=55)
    do_rp(p, rp_date, nerve='双侧', ln='局限')
    p.state('nmHSPC', 'nmHSPC', rp_date, '根治术后，未转移', evidence={'post_rp': True})
    bd = addm(rp_date, 20 + v * 4)
    progression_bcr(p, bd, 0.22 + v * 0.06)
    p.visit(bd - timedelta(days=5), '术后随访 PSA 上升，考虑生化复发', [
        {'episodeId': 1, 'overallResponse': 'PD', 'responseBasis': 'psa', 'psaResponse': 'PSA_PROGRESSION',
         'summary': 'PSA 上升'}])
    # PSMA and salvage RT
    p.imaging(bd + timedelta(days=7), 'PSMA PET-CT', 'PSMA_PET', lesions=1 if v >= 2 else 0,
              sites='lymph_node' if v >= 2 else '', psma_positive=1 if v >= 2 else 0,
              suv=6.1 if v >= 2 else 2.1, notes='生化复发再分期')
    ln = next_line(p); lid = p.line(ln, '挽救', '挽救性放疗+ADT', bd + timedelta(days=25), None,
                                   response='治疗中', response_code='ongoing')
    eid = p.episode('radiotherapy', 'RT', '挽救性放疗+ADT', bd + timedelta(days=25), addm(bd, 2),
                    line_id=lid, status='completed', intent='salvage', scenario='salvage')
    p.radiation(bd + timedelta(days=25), 'EBRT', 'prostate_pelvis', 66, 33,
                event_type='挽救性放疗(EBRT)', concurrent_adt=True)
    p.castration = 1; p.adt_start = p.adt_start or bd + timedelta(days=25)
    p.medicine('adt', '戈舍瑞林', bd + timedelta(days=25), addm(bd, 26), dose='10.8mg', schedule='q12w', line_id=lid)
    p.administration(eid, bd + timedelta(days=25), '戈舍瑞林', '10.8mg', next_d=addm(bd, 3))
    p.psa_add(addm(bd, 3), 0.08, below=True, lod=0.1)
    p.psa_add(addm(bd, 6), 0.04, below=True, lod=0.1)
    p.testo_add(addm(bd, 3), 16)
    p.visit(addm(bd, 4), '挽救性放疗结束：PSA 下降，继续 ADT', [
        {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': 'PSA 下降'}], aes=[('urinary_incontinence', 1, {}), ('proctitis', 1, {})])
    p.state('nmHSPC', 'nmHSPC', bd + timedelta(days=25), '挽救治疗后未转移', evidence={'salvage': True})
    if v == 3:
        p.visit(addm(bd, 18), 'PSA 再次上升，考虑 ARPI', [])
        start_arpi(p, addm(bd, 20), '恩扎卢胺', setting='nmCRPC' if v < 3 else 'mCRPC')
        p.outcome(addm(bd, 20), 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=1.8,
                  note='去势抵抗，PSMA 新发骨转移')
        p.disease_category = 'mCRPC'

def scenario_rp_unfav(p, v):
    age = 64 + v * 3 + p.n % 4
    dx = REF - timedelta(days=365 * (3 + v) + 300)
    base(p, age=age, dx=dx, cT='cT2cN0M0', gp=4, gs=3, psa=16 + v * 2.5 + (p.n % 4),
         pirads=5, cores=12)
    rp_date = dx + timedelta(days=50)
    do_rp(p, rp_date, nerve='单侧', ln='扩大')
    p.pathologic_stage = 'pT3aN0M0'
    p.state('nmHSPC', 'nmHSPC', rp_date, '高危根治术后，未转移', evidence={'post_rp': True})
    # adjuvant RT + ADT
    art = addm(rp_date, 3)
    p.visit(art - timedelta(days=10), '术后病理 pT3a 切缘阳性，MDT 建议辅助放疗+ADT', [])
    p.add_mdt if False else None
    add_mdt(p, art - timedelta(days=5), 'MDT：pT3a 切缘阳性，辅助放疗联合 ADT')
    ln = next_line(p); lid = p.line(ln, '辅助', '辅助放疗+ADT', art, addm(art, 6), response='完成', response_code='adjuvant')
    eid = p.episode('radiotherapy', 'RT', '辅助放疗+ADT', art, addm(art, 2), line_id=lid,
                    status='completed', intent='adjuvant', scenario='adjuvant')
    p.radiation(art, 'EBRT', 'prostate_pelvis', 66, 33, event_type='辅助放疗(EBRT)', concurrent_adt=True)
    p.castration = 1; p.adt_start = art
    p.medicine('adt', '戈舍瑞林', art, addm(art, 24), dose='10.8mg', schedule='q12w', line_id=lid)
    p.administration(eid, art, '戈舍瑞林', '10.8mg', next_d=addm(art, 3))
    p.testo_add(addm(art, 3), 12)
    p.psa_add(addm(art, 3), 0.05, below=True, lod=0.1)
    p.visit(addm(art, 3), '辅助放疗结束，PSA 不可测，继续 ADT', [
        {'episodeId': eid, 'overallResponse': 'CR', 'responseBasis': 'psa', 'psaResponse': 'UNDETECTABLE',
         'summary': '生化控制'}], aes=[('proctitis', 1, {}), ('hot_flashes', 2, {})])
    if v < 2:
        p.psa_add(addm(art, 12), 0.03, below=True, lod=0.1)
        p.testo_add(addm(art, 12), 13)
        p.visit(addm(art, 12), '辅助治疗后 1 年：PSA 不可测，影像阴性，继续随访', [
            {'episodeId': eid, 'overallResponse': 'CR', 'responseBasis': 'psa', 'psaResponse': 'UNDETECTABLE',
             'summary': '持续生化控制'}], aes=[('hot_flashes', 1, {})])
        p.disease_category = 'nmHSPC'
        return
    # later BCR -> ARPI
    bd = addm(art, 22 + v * 2)
    progression_bcr(p, bd, 0.35 + v * 0.12)
    p.visit(bd, 'ADT 后 PSA 上升，考虑去势抵抗', [])
    start_arpi(p, bd + timedelta(days=15), '阿比特龙', setting='nmCRPC' if v < 2 else 'mCRPC')
    p.outcome(bd + timedelta(days=15), 'CRPC', subtype='mCRPC' if v >= 2 else 'nmCRPC',
              basis='testosterone', psa_value=1.2 + v * 0.4, note='去势抵抗')
    if v >= 2:
        p.disease_category = 'mCRPC'
        p.imaging(bd + timedelta(days=20), 'PSMA PET-CT', 'PSMA_PET', lesions=2, sites='bone',
                  psma_positive=1, suv=7.5, notes='新发骨转移')
        p.outcome(bd + timedelta(days=20), 'metastasis', sites='bone', lesions=2, basis='imaging',
                  imaging_negative=0, note='骨转移')
        p.met_count = 2
    else:
        p.disease_category = 'nmCRPC'
    p.visit(addm(bd, 4), 'ARPI 治疗中，PSA 下降，监测不良反应', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': 'ARPI 治疗中'}],
        aes=[('fatigue', 2, {}), ('hypertension', 1, {})])

def scenario_high_rp(p, v):
    age = 66 + v * 3 + p.n % 4
    dx = REF - timedelta(days=365 * (3 + v) + 240)
    base(p, age=age, dx=dx, cT='cT3aN0M0', gp=4, gs=4, psa=24 + v * 5,
         pirads=5, cores=12, mdt=True)
    rp_date = dx + timedelta(days=60)
    add_mdt(p, rp_date - timedelta(days=7), 'MDT：高危局限期，RP + 扩大淋巴结清扫，术后辅助治疗')
    do_rp(p, rp_date, nerve='单侧', ln='扩大', blood=180,
          complications=[{'code':'urinary_incontinence','grade':2},{'code':'erectile_dysfunction','grade':3}])
    p.pathologic_stage = 'pT3aN1M0' if v >= 1 else 'pT3aN0M0'
    p.state('nmHSPC', 'nmHSPC', rp_date, '高危术后，未远处转移', evidence={'post_rp': True})
    # adjuvant RT + ADT
    art = addm(rp_date, 2)
    p.visit(art - timedelta(days=5), '术后高危，辅助放疗+ADT', [])
    ln = next_line(p); lid = p.line(ln, '辅助', '辅助放疗+ADT', art, addm(art, 24), response='完成', response_code='adjuvant')
    eid = p.episode('radiotherapy', 'RT', '辅助放疗+ADT', art, addm(art, 2), line_id=lid,
                    status='completed', intent='adjuvant', scenario='adjuvant')
    p.radiation(art, 'EBRT', 'prostate_pelvis', 66, 33, event_type='辅助放疗(EBRT)', concurrent_adt=True)
    p.castration = 1; p.adt_start = art
    p.medicine('adt', '戈舍瑞林', art, addm(art, 24), dose='10.8mg', schedule='q12w', line_id=lid)
    p.administration(eid, art, '戈舍瑞林', '10.8mg', next_d=addm(art, 3))
    p.psa_add(addm(art, 3), 0.02, below=True, lod=0.1)
    p.testo_add(addm(art, 3), 15)
    p.visit(addm(art, 3), '辅助治疗结束，PSA 不可测；继续 ADT 与骨健康管理', [
        {'episodeId': eid, 'overallResponse': 'CR', 'responseBasis': 'psa', 'psaResponse': 'UNDETECTABLE',
         'summary': '生化控制'}], aes=[('hot_flashes', 2, {}), ('osteoporosis', 1, {})])
    # progression to mHSPC
    pd = addm(art, 18 + v * 3)
    p.psa_add(pd - timedelta(days=2), 1.8 + v * 0.5)
    p.imaging(pd + timedelta(days=7), 'PSMA PET-CT', 'PSMA_PET', lesions=3, sites='bone,lymph_node',
              extra=1, psma_positive=1, suv=10.2, psma_lesions=3, notes='新发骨/淋巴结转移')
    p.outcome(pd + timedelta(days=7), 'metastasis', sites='bone,lymph_node', lesions=3, basis='imaging',
              imaging_negative=0, note='mHSPC')
    p.disease_category = 'mHSPC'
    p.met_count = 3
    p.status = '转移'
    add_mdt(p, pd + timedelta(days=10), 'MDT：mHSPC，ADT 基础上联合 ARPI')
    ln2 = next_line(p); lid2 = p.line(ln2, 'mHSPC', 'ADT+阿比特龙', pd + timedelta(days=14), None,
                                     response='治疗中', response_code='ongoing')
    eid2 = p.episode('systemic', 'SYSTEMIC', 'ADT+阿比特龙', pd + timedelta(days=14), None,
                     line_id=lid2, status='active', intent='palliative', scenario='mHSPC')
    p.medicine('arpi', '阿比特龙', pd + timedelta(days=14), addm(pd, 18), dose='1000mg qd', schedule='qd', line_id=lid2)
    p.medicine('endocrine', '泼尼松', pd + timedelta(days=14), addm(pd, 18), dose='5mg bid', schedule='bid', line_id=lid2)
    p.psa_add(addm(pd, 3), 0.4)
    p.visit(addm(pd, 4), 'mHSPC 启动 ADT+阿比特龙，PSA 下降', [
        {'episodeId': eid2, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': 'PSA 下降'}], aes=[('fatigue', 1, {}), ('hypertension', 2, {})])
    if v == 3:
        cd = addm(pd, 14)
        p.outcome(cd, 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=6.2, note='进展为 mCRPC')
        p.disease_category = 'mCRPC'
        start_chemo(p, cd + timedelta(days=10), '多西他赛', cycles=4)

def scenario_rt_high(p, v):
    age = 67 + v * 3
    dx = REF - timedelta(days=365 * (3 + v) + 280)
    base(p, age=age, dx=dx, cT='cT3bN0M0', gp=5, gs=4, psa=42 + v * 6,
         pirads=5, cores=12, mdt=True)
    p.state('nmHSPC', 'nmHSPC', dx, '局部进展期，非转移', evidence={'localized': True})
    rt_date = dx + timedelta(days=45)
    do_rt(p, rt_date, target='prostate_pelvis', dose=78, fractions=39, adt=True,
          event='根治性放疗(EBRT)')
    p.visit(addm(rt_date, 9), '放疗+ADT 结束，PSA 0.8，继续 ADT', [
        {'episodeId': 1, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': 'PSA 下降'}], aes=[('proctitis', 2, {}), ('urinary_incontinence', 1, {})])
    # BCR
    bd = addm(rt_date, 20 + v * 4)
    progression_bcr(p, bd, 2.4 + v * 0.7)
    p.visit(bd, '放疗后生化复发，PSMA 分期', [])
    p.imaging(bd + timedelta(days=8), 'PSMA PET-CT', 'PSMA_PET', lesions=1 if v < 2 else 2,
              sites='bone' if v < 2 else 'bone,lymph_node', psma_positive=1, suv=7.8,
              notes='生化复发后再分期')
    if v >= 2:
        p.outcome(bd + timedelta(days=10), 'metastasis', sites='bone,lymph_node', lesions=2,
                  basis='imaging', imaging_negative=0, note='寡转移')
        p.disease_category = 'mHSPC'; p.status = '转移'; p.met_count = 2
        start_adt(p, bd + timedelta(days=14), '戈舍瑞林', line_label='ADT+恩扎卢胺', setting='mHSPC',
                  with_arpi='enza')
    else:
        start_arpi(p, bd + timedelta(days=20), '恩扎卢胺', setting='nmCRPC', episode_label='ARPI')
        p.outcome(bd + timedelta(days=20), 'CRPC', subtype='nmCRPC', basis='testosterone', psa_value=2.8,
                  note='nmCRPC')
        p.disease_category = 'nmCRPC'
    p.visit(addm(bd, 5), '系统治疗中，PSA 下降，耐受可', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '治疗反应'}],
        aes=[('fatigue', 2, {}), ('rash', 1, {})])
    if v == 3:
        cd = addm(bd, 13)
        p.outcome(cd, 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=7.4, note='进展')
        p.disease_category = 'mCRPC'
        start_chemo(p, cd + timedelta(days=8), '多西他赛', cycles=4)

def scenario_mhspc_arpi(p, v):
    age = 64 + v * 4
    dx = REF - timedelta(days=365 * (2 + v) + 160)
    base(p, age=age, dx=dx, cT='cT4N1M1b', gp=5, gs=5, psa=120 + v * 40,
         pirads=5, cores=12, sites='bone', lesions=3 + v, extra=True, mdt=True)
    p.disease_category = 'mHSPC'; p.status = '转移'; p.castration = 1
    p.state('mHSPC', 'mHSPC', dx, '初诊转移性激素敏感', evidence={'de_novo': True})
    ln = next_line(p); lid = p.line(ln, 'mHSPC', 'ADT+阿比特龙', dx + timedelta(days=20), None,
                                   response='治疗中', response_code='ongoing')
    eid = p.episode('systemic', 'SYSTEMIC', 'ADT+阿比特龙', dx + timedelta(days=20), None,
                    line_id=lid, status='active', intent='palliative', scenario='mHSPC')
    p.castration = 1; p.adt_start = dx + timedelta(days=20)
    p.medicine('adt', '戈舍瑞林', dx + timedelta(days=20), addm(dx, 26), dose='10.8mg', schedule='q12w', line_id=lid)
    p.medicine('arpi', '阿比特龙', dx + timedelta(days=20), addm(dx, 26), dose='1000mg qd', schedule='qd', line_id=lid)
    p.medicine('endocrine', '泼尼松', dx + timedelta(days=20), addm(dx, 26), dose='5mg bid', schedule='bid', line_id=lid)
    p.administration(eid, dx + timedelta(days=20), '戈舍瑞林', '10.8mg', next_d=addm(dx, 3))
    p.testo_add(dx + timedelta(days=50), 12)
    p.psa_add(addm(dx, 3), 28 - v * 3)
    p.psa_add(addm(dx, 6), 6.4 - v * 0.8)
    p.visit(dx + timedelta(days=30), 'mHSPC 启动 ADT+阿比特龙，骨保护治疗', [
        {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': 'PSA 快速下降'}], aes=[('hot_flashes', 2, {}), ('fatigue', 2, {}), ('hypertension', 1, {})])
    p.visit(addm(dx, 6), '治疗 6 月：PSA 6.4，影像部分缓解，继续治疗', [
        {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': '持续缓解'}], aes=[('metabolic_syndrome', 1, {}), ('osteoporosis', 1, {})])
    cd = addm(dx, 16 + v * 2)
    p.psa_add(cd - timedelta(days=2), 9.5 + v * 2)
    p.outcome(cd, 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=9.5 + v * 2,
              note='mHSPC 进展为 mCRPC')
    p.disease_category = 'mCRPC'
    p.imaging(cd + timedelta(days=5), 'PSMA PET-CT', 'PSMA_PET', lesions=4, sites='bone',
              extra=1, psma_positive=1, suv=12.4, notes='mCRPC 再分期，骨转移进展')
    add_mdt(p, cd + timedelta(days=8), 'MDT：mCRPC，换用多西他赛')
    start_chemo(p, cd + timedelta(days=12), '多西他赛', cycles=5)
    p.visit(addm(cd, 5), '多西他赛第 3 周期后评估：PSA 下降，骨髓抑制 G2', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '化疗部分缓解'}],
        aes=[('myelosuppression', 2, {'auxMeds':'G-CSF'}), ('peripheral_neuropathy', 1, {})])

def scenario_mhspc_doc(p, v):
    age = 63 + v * 4
    dx = REF - timedelta(days=365 * (2 + v) + 220)
    base(p, age=age, dx=dx, cT='cT3bN1M1b', gp=5, gs=5, psa=95 + v * 30,
         pirads=5, cores=12, sites='bone,lymph_node', lesions=4 + v, extra=True, mdt=True)
    p.disease_category = 'mHSPC'; p.status = '转移'; p.castration = 1
    p.state('mHSPC', 'mHSPC', dx, '初诊高瘤负荷 mHSPC', evidence={'de_novo': True})
    ln = next_line(p); lid = p.line(ln, 'mHSPC', 'ADT+多西他赛', dx + timedelta(days=14), None,
                                   response='治疗中', response_code='ongoing')
    eid = p.episode('chemo', 'CHEMO', 'ADT+多西他赛', dx + timedelta(days=14), None,
                    line_id=lid, status='active', intent='palliative', scenario='mHSPC')
    p.castration = 1; p.adt_start = dx + timedelta(days=14)
    p.medicine('adt', '戈舍瑞林', dx + timedelta(days=14), addm(dx, 24), dose='10.8mg', schedule='q12w', line_id=lid)
    p.administration(eid, dx + timedelta(days=14), '戈舍瑞林', '10.8mg', next_d=addm(dx, 3))
    p.medicine('chemo', '多西他赛', dx + timedelta(days=14), addm(dx, 6), dose='75mg/m²', schedule='q3w', line_id=lid)
    p.visit(dx + timedelta(days=20), '高瘤负荷 mHSPC，启动 ADT+多西他赛', [
        {'episodeId': eid, 'overallResponse': 'NA', 'responseBasis': 'clinical', 'summary': '治疗开始'}],
        aes=[('fatigue', 1, {})])
    for i in range(6):
        cd = addd(dx + timedelta(days=25), i * 21)
        cid = p.cycle(eid, lid, i + 1, cd, '多西他赛', agents=[{'drug':'多西他赛','dose':'75mg/m²'}],
                      assessment_visit=None, gcsf=(i >= 3), reduction=20 if i >= 4 else 0)
        p.psa_add(cd - timedelta(days=2), max(0.5, 55 - i * 8))
        p.lab_add(cd - timedelta(days=2), 'ANC', '中性粒细胞绝对值', 3.0 - i * 0.25, '×10⁹/L', '1.8-6.3')
    p.visit(addm(dx, 5), 'ADT+多西他赛 6 周期完成，PSA 明显下降', [
        {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': '化疗结束，部分缓解'}], aes=[('myelosuppression', 2, {'auxMeds':'G-CSF'}),
         ('peripheral_neuropathy', 2, {}), ('nausea', 1, {})])
    cd = addm(dx, 12 + v * 2)
    p.outcome(cd, 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=12.5 + v * 2,
              note='mHSPC 进展为 mCRPC')
    p.disease_category = 'mCRPC'
    p.imaging(cd + timedelta(days=7), 'PSMA PET-CT', 'PSMA_PET', lesions=6, sites='bone,lymph_node',
              extra=1, psma_positive=1, suv=14.5, notes='mCRPC 再分期')
    start_arpi(p, cd + timedelta(days=12), '恩扎卢胺', setting='mCRPC')
    p.visit(addm(cd, 4), 'mCRPC 二线恩扎卢胺，PSA 下降', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '二线治疗反应'}],
        aes=[('fatigue', 2, {}), ('rash', 1, {})])
    if v == 3:
        sd = addm(cd, 8)
        start_chemo(p, sd, '卡巴他赛', cycles=3)

def scenario_nmcrpc(p, v):
    age = 68 + v * 3
    dx = REF - timedelta(days=365 * (4 + v) + 120)
    base(p, age=age, dx=dx, cT='cT3aN0M0', gp=4, gs=5, psa=32 + v * 6,
         pirads=5, cores=12, mdt=True)
    rp_date = dx + timedelta(days=50)
    do_rp(p, rp_date, nerve='单侧', ln='扩大')
    p.pathologic_stage = 'pT3aN0M0'
    p.state('nmHSPC', 'nmHSPC', rp_date, '根治术后未转移', evidence={'post_rp': True})
    # BCR and ADT
    bd = addm(rp_date, 18 + v * 3)
    progression_bcr(p, bd, 0.4 + v * 0.15)
    p.imaging(bd + timedelta(days=10), 'PSMA PET-CT', 'PSMA_PET', lesions=0, sites='',
              psma_positive=0, suv=2.0, notes='生化复发，未见转移')
    start_adt(p, bd + timedelta(days=15), '戈舍瑞林', line_label='ADT', setting='nmHSPC')
    p.psa_add(addm(bd, 3), 0.2)
    p.psa_add(addm(bd, 6), 0.35)
    p.psa_add(addm(bd, 9), 0.8)
    cd = addm(bd, 10 + v)
    p.outcome(cd, 'CRPC', subtype='nmCRPC', basis='testosterone', psa_value=1.2 + v * 0.3,
              note='nmCRPC：睾酮<50，PSA 连续上升，无影像转移')
    p.disease_category = 'nmCRPC'
    p.state('nmCRPC', 'nmCRPC', cd, '去势抵抗，无影像学转移', evidence={'psa': 1.2 + v * 0.3})
    add_mdt(p, cd + timedelta(days=5), 'MDT：nmCRPC，启动阿帕他胺')
    start_arpi(p, cd + timedelta(days=10), '阿帕他胺', setting='nmCRPC', episode_label='nmCRPC ARPI')
    p.visit(addm(cd, 4), 'nmCRPC 阿帕他胺治疗，PSA 下降', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': 'ARPI 反应'}],
        aes=[('fatigue', 2, {}), ('hypertension', 1, {})])
    md = addm(cd, 14 + v * 2)
    p.outcome(md, 'metastasis', sites='bone', lesions=2, basis='imaging', imaging_negative=0,
              note='nmCRPC 进展为骨转移')
    p.imaging(md + timedelta(days=5), 'PSMA PET-CT', 'PSMA_PET', lesions=2, sites='bone',
              psma_positive=1, suv=8.8, notes='新发骨转移')
    p.disease_category = 'mCRPC'; p.met_count = 2; p.status = '转移'
    start_chemo(p, md + timedelta(days=12), '多西他赛', cycles=4)

def scenario_mcrpc_seq(p, v):
    age = 65 + v * 4
    dx = REF - timedelta(days=365 * (3 + v) + 180)
    base(p, age=age, dx=dx, cT='cT4N1M1b', gp=5, gs=5, psa=140 + v * 50,
         pirads=5, cores=12, sites='bone,visceral' if v == 3 else 'bone',
         lesions=5 + v, extra=True, visceral=(v == 3), mdt=True)
    p.disease_category = 'mHSPC'; p.status = '转移'; p.castration = 1
    p.state('mHSPC', 'mHSPC', dx, '初诊转移性激素敏感', evidence={'de_novo': True})
    start_adt(p, dx + timedelta(days=15), '戈舍瑞林', line_label='ADT+阿比特龙', setting='mHSPC',
              with_arpi='abi')
    p.psa_add(addm(dx, 3), 18)
    p.visit(addm(dx, 4), 'mHSPC 一线 ADT+阿比特龙，PSA 下降', [
        {'episodeId': 1, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': '一线反应'}], aes=[('fatigue', 2, {}), ('hypertension', 1, {})])
    cd = addm(dx, 15 + v * 2)
    p.outcome(cd, 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=10.5 + v * 3,
              note='进展为 mCRPC')
    p.disease_category = 'mCRPC'
    p.imaging(cd + timedelta(days=5), 'PSMA PET-CT', 'PSMA_PET', lesions=7, sites='bone,lymph_node',
              extra=1, visceral=(v == 3), psma_positive=1, suv=15.2, notes='mCRPC 再分期')
    start_arpi(p, cd + timedelta(days=10), '恩扎卢胺', setting='mCRPC')
    p.visit(addm(cd, 4), 'mCRPC 二线恩扎卢胺，PSA 下降', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '二线反应'}],
        aes=[('fatigue', 2, {}), ('rash', 1, {})])
    d2 = addm(cd, 8 + v)
    p.outcome(d2, 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=16.2, note='ARPI 进展')
    start_chemo(p, d2 + timedelta(days=10), '多西他赛', cycles=4)
    p.visit(addm(d2, 4), '多西他赛治疗中，PSA 下降，轻度神经毒性', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '化疗反应'}],
        aes=[('peripheral_neuropathy', 2, {}), ('myelosuppression', 2, {'auxMeds':'G-CSF'})])
    if v >= 2:
        d3 = addm(d2, 8)
        start_chemo(p, d3, '卡巴他赛', cycles=3)

def scenario_oligo(p, v):
    age = 61 + v * 4
    dx = REF - timedelta(days=365 * (2 + v) + 160)
    sites = 'bone' if v < 2 else 'lymph_node'
    base(p, age=age, dx=dx, cT='cT3bN0M1a' if v < 2 else 'cT2cN1M1a', gp=4, gs=4,
         psa=28 + v * 8, pirads=5, cores=12, sites=sites, lesions=2, extra=False,
         oligo='oligo', mdt=True)
    p.disease_category = 'mHSPC'; p.status = '转移'; p.castration = 1
    p.state('mHSPC', 'mHSPC', dx, '寡转移激素敏感', evidence={'oligo': True})
    p.visit(dx + timedelta(days=20), '寡转移 mHSPC，MDT 决定 ADT + 转移灶 SBRT', [])
    start_adt(p, dx + timedelta(days=25), '戈舍瑞林', line_label='ADT', setting='mHSPC')
    # metastasis-directed RT
    ln = next_line(p); lid = p.line(ln, '其他', '转移灶 SBRT', dx + timedelta(days=40), addm(dx, 2),
                                  response='完成', response_code='mdt')
    eid = p.episode('radiotherapy', 'SBRT', '转移灶 SBRT', dx + timedelta(days=40), addm(dx, 2),
                    line_id=lid, status='completed', intent='palliative', scenario='oligo')
    p.radiation(dx + timedelta(days=40), 'SBRT', 'metastasis', 30, 5, event_type='转移灶SBRT',
                concurrent_adt=True, current=False)
    p.psa_add(addm(dx, 3), 3.2)
    p.visit(addm(dx, 4), 'ADT+转移灶 SBRT 后 PSA 下降，寡转移局部控制', [
        {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': '寡转移治疗反应'}], aes=[('fatigue', 1, {}), ('hot_flashes', 1, {})])
    pd = addm(dx, 14 + v * 2)
    p.imaging(pd + timedelta(days=5), 'PSMA PET-CT', 'PSMA_PET', lesions=4, sites='bone,lymph_node',
              extra=1, psma_positive=1, suv=9.5, notes='寡转移进展为多发转移')
    p.outcome(pd + timedelta(days=5), 'metastasis', sites='bone,lymph_node', lesions=4, basis='imaging',
              imaging_negative=0, note='多发转移')
    p.disease_category = 'mCRPC'; p.met_count = 4
    p.outcome(pd + timedelta(days=7), 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=6.2,
              note='进展为 mCRPC')
    start_arpi(p, pd + timedelta(days=12), '阿比特龙', setting='mCRPC')
    p.visit(addm(pd, 5), 'mCRPC 二线阿比特龙治疗，PSA 下降，骨痛缓解', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '二线治疗反应'}],
        aes=[('fatigue', 2, {}), ('hypertension', 1, {})])

def scenario_rare(p, v):
    age = 57 + v * 4
    dx = REF - timedelta(days=365 * (2 + v) + 200)
    if v == 0:  # ductal
        base(p, age=age, dx=dx, cT='cT3aN0M0', gp=4, gs=5, psa=35, pirads=5, cores=12,
             histology='ductal', mdt=True)
        do_rp(p, dx + timedelta(days=55), nerve='单侧', ln='扩大')
        p.pathologic_stage = 'pT3aN0M0'
        p.imaging(addm(dx, 8), '胸部CT', 'CT', lesions=2, sites='visceral', extra=1,
                  recist='PD', notes='双肺转移')
        p.outcome(addm(dx, 9), 'metastasis', sites='visceral', lesions=2, basis='imaging',
                  imaging_negative=0, note='肺转移')
        p.disease_category = 'mHSPC'; p.met_count = 2; p.visceral = 1
        p.outcome(addm(dx, 10), 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=8.4, note='快速进展')
        start_chemo(p, addm(dx, 10), '多西他赛', cycles=5)
    elif v == 1:  # NEPC
        base(p, age=age, dx=dx, cT='cT3bN1M1b', gp=5, gs=5, psa=70, pirads=5, cores=12,
             sites='bone,visceral', lesions=4, extra=True, visceral=True, histology='neuroendocrine', mdt=True)
        p.disease_category = 'mHSPC'; p.status = '转移'; p.castration = 1
        p.state('mHSPC', 'mHSPC', dx, '神经内分泌分化，初诊转移', evidence={'NEPC': True})
        start_adt(p, dx + timedelta(days=15), '戈舍瑞林', line_label='ADT', setting='mHSPC')
        p.outcome(addm(dx, 8), 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=12.5,
                  note='治疗相关神经内分泌前列腺癌')
        p.disease_category = 'mCRPC'
        start_chemo(p, addm(dx, 9), '多西他赛', cycles=4)
        p.visit(addm(dx, 14), 'NEPC 化疗后进展，PSA 低但影像进展', [
            {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PD',
             'responseBasis': 'imaging', 'psaResponse': 'STABLE', 'summary': '影像进展'}],
            aes=[('fatigue', 3, {}), ('anemia', 2, {})])
    elif v == 2:  # BRCA2
        base(p, age=age, dx=dx, cT='cT2cN0M0', gp=4, gs=4, psa=19, pirads=5, cores=12,
             histology='acinar', mdt=True)
        p.family_history = True
        add_baseline_genomics(p, brca=True)
        do_rp(p, dx + timedelta(days=50), nerve='双侧', ln='扩大')
        p.pathologic_stage = 'pT3aN0M0'
        bd = addm(dx, 22)
        progression_bcr(p, bd, 0.45)
        p.imaging(bd + timedelta(days=7), 'PSMA PET-CT', 'PSMA_PET', lesions=1, sites='bone',
                  psma_positive=1, suv=6.8, notes='BRCA2，生化复发')
        start_adt(p, bd + timedelta(days=14), '戈舍瑞林', line_label='ADT', setting='mHSPC')
        p.outcome(bd + timedelta(days=20), 'metastasis', sites='bone', lesions=1, basis='imaging',
                  imaging_negative=0, note='骨转移')
        p.disease_category = 'mCRPC'
        p.outcome(bd + timedelta(days=22), 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=1.9,
                  note='BRCA2 mCRPC')
        # PARPi
        ln = next_line(p); lid = p.line(ln, 'mCRPC', '奥拉帕利', bd + timedelta(days=30), None,
                                       response='治疗中', response_code='ongoing')
        eid = p.episode('systemic', 'SYSTEMIC', 'PARP抑制剂', bd + timedelta(days=30), None,
                        line_id=lid, status='active', intent='palliative', scenario='mCRPC')
        p.medicine('parpi', '奥拉帕利', bd + timedelta(days=30), addm(bd, 12), dose='300mg bid', schedule='bid', line_id=lid)
        p.psa_add(addm(bd, 3), 0.6)
        p.visit(addm(bd, 4), 'BRCA2 mCRPC 奥拉帕利治疗，PSA 下降', [
            {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
             'summary': 'PARPi 反应'}], aes=[('anemia', 2, {}), ('fatigue', 1, {})])
    else:  # MSI-H
        base(p, age=age, dx=dx, cT='cT3aN0M0', gp=4, gs=5, psa=28, pirads=5, cores=12, mdt=True)
        p.family_history = True
        add_baseline_genomics(p, msi=True)
        do_rp(p, dx + timedelta(days=55), nerve='单侧', ln='扩大')
        p.pathologic_stage = 'pT3aN0M0'
        p.imaging(addm(dx, 8), '腹盆腔CT', 'CT', lesions=2, sites='lymph_node', extra=1,
                  recist='PD', notes='腹膜后淋巴结增大')
        p.outcome(addm(dx, 9), 'metastasis', sites='lymph_node', lesions=2, basis='imaging',
                  imaging_negative=0, note='淋巴结转移')
        p.disease_category = 'mHSPC'; p.met_count = 2
        start_adt(p, addm(dx, 10), '戈舍瑞林', line_label='ADT', setting='mHSPC')
        p.outcome(addm(dx, 20), 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=3.8, note='MSI-H mCRPC')
        p.disease_category = 'mCRPC'
        start_arpi(p, addm(dx, 21), '恩扎卢胺', setting='mCRPC')
        p.visit(addm(dx, 26), 'MSI-H mCRPC，免疫治疗评估中', [
            {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'SD',
             'responseBasis': 'imaging', 'psaResponse': 'STABLE', 'summary': '待免疫治疗'}])

def scenario_post_rt_salvage(p, v):
    age = 66 + v * 4
    dx = REF - timedelta(days=365 * (4 + v) + 60)
    base(p, age=age, dx=dx, cT='cT2cN0M0', gp=4, gs=4, psa=20 + v * 4,
         pirads=5, cores=12, mdt=True)
    do_rt(p, dx + timedelta(days=40), target='prostate', dose=78, fractions=39, adt=True,
          event='根治性放疗(EBRT)')
    p.state('nmHSPC', 'nmHSPC', dx, '放疗后未转移', evidence={'post_rt': True})
    # local recurrence
    ld = addm(dx, 20 + v * 3)
    p.psa_add(ld - timedelta(days=2), 2.6 + v * 0.5)
    p.imaging(ld + timedelta(days=5), 'mpMRI', 'mpMRI', pirads=5, lesions=1, volume=28,
              notes='放疗后局部复发')
    p.pathology(ld + timedelta(days=12), '前列腺穿刺活检病理报告', 'biopsy', 4, 5,
                is_primary=False, cores_total=12, cores_pos=5, notes='放疗后局部复发，GG5')
    p.outcome(ld, 'BCR', subtype='local_recurrence', basis='biopsy', psa_value=2.6 + v * 0.5,
              note='放疗后局部复发')
    p.visit(ld + timedelta(days=15), '放疗后局部复发，MDT 讨论挽救性手术', [])
    add_mdt(p, ld + timedelta(days=18), 'MDT：放疗后局部复发，挽救性 RP 或 ADT')
    if v < 2:
        ln = next_line(p); lid = p.line(ln, '挽救', '挽救性根治性前列腺切除术', ld + timedelta(days=30), ld + timedelta(days=30),
                                       response='完成', response_code='salvage')
        eid = p.episode('surgery', 'RP', '挽救性 RP', ld + timedelta(days=30), ld + timedelta(days=30),
                        line_id=lid, status='completed', intent='salvage', scenario='salvage')
        p.surgery(ld + timedelta(days=30), eid, approach='开放', nerve='单侧', ln='局限',
                  complications=[{'code':'urinary_incontinence','grade':2}], blood=250)
        p.pathologic_stage = 'pT3aN0M0'
        p.psa_add(addm(ld, 3), 0.08, below=True, lod=0.1)
        p.visit(addm(ld, 3), '挽救性 RP 后 PSA 下降，控尿康复中', [
            {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
             'summary': '挽救术后 PSA 下降'}], aes=[('urinary_incontinence', 2, {}), ('erectile_dysfunction', 3, {})])
    else:
        start_adt(p, ld + timedelta(days=30), '戈舍瑞林', line_label='挽救性 ADT', setting='mHSPC')
        p.psa_add(addm(ld, 3), 0.2)
        p.visit(addm(ld, 3), '挽救性 ADT 后 PSA 下降', [
            {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
             'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': 'ADT 反应'}],
            aes=[('hot_flashes', 2, {})])
    p.outcome(addm(ld, 10), 'CRPC', subtype='mCRPC' if v == 3 else 'nmCRPC', basis='testosterone',
              psa_value=1.2, note='挽救治疗后去势抵抗')
    p.disease_category = 'nmCRPC' if v < 3 else 'mCRPC'

def scenario_elderly_ww(p, v):
    age = 79 + v * 2
    dx = REF - timedelta(days=365 * (2 + v) + 300)
    base(p, age=age, dx=dx, cT='cT2bN0M0', gp=3, gs=4, psa=14 + v * 2,
         pirads=4, cores=12, mdt=True)
    add_standard_comorb(p, 3)
    p.ecog = 1 + (v % 2)
    p.charlson = 4 + v
    p.visit(dx + timedelta(days=25), '高龄、合并症多，选择观察等待，优先生活质量', [])
    ln = next_line(p); lid = p.line(ln, '观察等待', '观察等待', dx + timedelta(days=30), None,
                                   response='观察中', response_code='ongoing')
    eid = p.episode('surveillance', 'WW', '观察等待', dx + timedelta(days=30), None, line_id=lid,
                    status='active', intent='palliative', scenario='elderly')
    p.primary_treatment = 'WW'; p.treatment_summary = '第1线 · 观察等待'
    for i in range(3):
        vd = addm(dx, 6 + i * 6)
        p.psa_add(vd - timedelta(days=3), 16 + i * 3.2)
        p.lab_add(vd, 'Hb', '血红蛋白', 112 - i * 2, 'g/L', '130-175')
        p.visit(vd, f'观察等待第{i+1}次：PSA 缓慢上升，无症状', [
            {'episodeId': eid, 'overallResponse': 'SD', 'responseBasis': 'psa', 'psaResponse': 'STABLE',
             'summary': '观察中'}], aes=[('fatigue', 1, {}), ('hypertension', 1, {})])
    if v < 2:
        ad = addm(dx, 24)
        p.psa_add(ad - timedelta(days=3), 28)
        start_adt(p, ad, '戈舍瑞林', line_label='ADT', setting='mHSPC')
        p.psa_add(addm(ad, 3), 2.4)
        p.visit(addm(ad, 3), 'PSA 快速上升，启动 ADT，症状改善', [
            {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
             'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': 'ADT 反应'}],
            aes=[('hot_flashes', 1, {}), ('fatigue', 2, {})])
        p.disease_category = 'mHSPC' if v == 1 else 'nmHSPC'
    else:
        ad = addm(dx, 18)
        start_adt(p, ad, '戈舍瑞林', line_label='姑息性 ADT', setting='mHSPC')
        p.disease_category = 'mHSPC'
        p.psa_add(addm(dx, 20), 42)
        p.visit(addm(dx, 20), 'PSA 快速上升，启动姑息性 ADT，症状部分缓解', [
            {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'SD',
             'responseBasis': 'psa', 'psaResponse': 'STABLE', 'summary': '姑息治疗'}],
            aes=[('fatigue', 2, {}), ('anemia', 1, {})])
        dd = addm(dx, 26)
        p.outcome(dd, 'death', death_cause='前列腺癌', basis='clinical', note='高龄、合并症，家属选择安宁疗护')
        p.visit(dd - timedelta(days=5), '终末期，转入安宁疗护', [])

def scenario_death_lost(p, v):
    age = 68 + v * 4
    dx = REF - timedelta(days=365 * (3 + v) + 60)
    base(p, age=age, dx=dx, cT='cT4N1M1c' if v == 3 else 'cT3bN1M1b', gp=5, gs=5,
         psa=110 + v * 30, pirads=5, cores=12, sites='bone,visceral' if v == 3 else 'bone',
         lesions=4 + v, extra=True, visceral=(v == 3), mdt=True)
    p.disease_category = 'mHSPC'; p.status = '转移'; p.castration = 1
    p.state('mHSPC', 'mHSPC', dx, '初诊转移性前列腺癌', evidence={'de_novo': True})
    start_adt(p, dx + timedelta(days=15), '戈舍瑞林', line_label='ADT+阿比特龙', setting='mHSPC',
              with_arpi='abi')
    p.visit(addm(dx, 4), 'mHSPC 一线治疗，PSA 下降', [
        {'episodeId': 1, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': '治疗反应'}], aes=[('fatigue', 2, {}), ('anemia', 1, {})])
    cd = addm(dx, 12 + v * 2)
    p.outcome(cd, 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=14.2, note='mCRPC')
    p.disease_category = 'mCRPC'
    p.imaging(cd + timedelta(days=5), 'PSMA PET-CT', 'PSMA_PET', lesions=8, sites='bone,visceral' if v == 3 else 'bone',
              extra=1, visceral=(v == 3), psma_positive=1, suv=16.0, notes='广泛转移')
    start_chemo(p, cd + timedelta(days=12), '多西他赛', cycles=4)
    p.visit(addm(cd, 4), '多西他赛治疗中，PSA 下降但体能下降', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '化疗反应'}],
        aes=[('myelosuppression', 2, {'auxMeds':'G-CSF'}), ('fatigue', 3, {})])
    if v < 2:
        dd = addm(dx, 25 + v * 2)
        p.outcome(dd, 'death', death_cause='前列腺癌', basis='clinical', note='终末期，家属放弃抢救')
        p.visit(dd - timedelta(days=10), '终末期，转入安宁疗护', [])
        p.followup = '死亡'; p.status = '死亡'
    else:
        ld = addm(dx, 22)
        p.outcome(ld, 'lost', lost_reason='外地失访，电话未接通', note='末次联系后失访')
        p.followup = '失访'; p.status = '失访'
        p.visit(ld, '末次门诊后失访', [])


def scenario_regional(p, v):
    age = 66 + v * 3
    dx = REF - timedelta(days=365 * (3 + v) + 180)
    base(p, age=age, dx=dx, cT='cT3bN1M0', gp=5, gs=4, psa=32 + v * 7,
         pirads=5, cores=12, mdt=True)
    p.state('nmHSPC', 'nmHSPC', dx, '区域淋巴结转移、无远处转移', evidence={'cN1': True})
    add_mdt(p, dx + timedelta(days=20), 'MDT：cN1M0 区域性疾病，讨论 RP+扩大淋巴结清扫或放疗+ADT')
    if v < 2:
        rp_date = dx + timedelta(days=55)
        do_rp(p, rp_date, nerve='单侧', ln='扩大', blood=200)
        p.pathologic_stage = 'pT3bN1M0'
        p.visit(addm(rp_date, 3), '术后病理 pT3bN1，辅助放疗+ADT', [])
        ln = next_line(p); lid = p.line(ln, '辅助', '辅助放疗+ADT', addm(rp_date, 3), addm(rp_date, 26),
                                       response='完成', response_code='adjuvant')
        eid = p.episode('radiotherapy', 'RT', '辅助放疗+ADT', addm(rp_date, 3), addm(rp_date, 5),
                        line_id=lid, status='completed', intent='adjuvant', scenario='regional')
        p.radiation(addm(rp_date, 3), 'EBRT', 'prostate_pelvis', 66, 33,
                    event_type='辅助放疗(EBRT)', concurrent_adt=True)
        p.castration = 1; p.adt_start = addm(rp_date, 3)
        p.medicine('adt', '戈舍瑞林', addm(rp_date, 3), addm(rp_date, 26), dose='10.8mg', schedule='q12w', line_id=lid)
        p.administration(eid, addm(rp_date, 3), '戈舍瑞林', '10.8mg', next_d=addm(rp_date, 6))
        p.psa_add(addm(rp_date, 6), 0.04, below=True, lod=0.1)
        p.testo_add(addm(rp_date, 6), 14)
        p.visit(addm(rp_date, 6), '辅助治疗中，PSA 不可测，继续 ADT', [
            {'episodeId': eid, 'overallResponse': 'CR', 'responseBasis': 'psa', 'psaResponse': 'UNDETECTABLE',
             'summary': '生化控制'}], aes=[('hot_flashes', 2, {}), ('fatigue', 1, {})])
        bd = addm(rp_date, 20 + v * 3)
    else:
        rt_date = dx + timedelta(days=45)
        do_rt(p, rt_date, target='prostate_pelvis', dose=78, fractions=39, adt=True,
              event='根治性放疗(EBRT)')
        bd = addm(rt_date, 18 + v * 2)
    progression_bcr(p, bd, 0.5 + v * 0.1)
    p.imaging(bd + timedelta(days=8), 'PSMA PET-CT', 'PSMA_PET', lesions=0 if v < 3 else 1,
              sites='' if v < 3 else 'lymph_node', psma_positive=1 if v == 3 else 0,
              suv=3.0 if v < 3 else 6.8, notes='区域性疾病生化复发再分期')
    p.visit(bd, '区域性疾病随访 PSA 上升，评估挽救治疗', [])
    start_adt(p, bd + timedelta(days=15), '戈舍瑞林', line_label='挽救性 ADT+恩扎卢胺',
              setting='mHSPC', with_arpi='enza')
    if v == 3:
        p.outcome(bd + timedelta(days=20), 'metastasis', sites='lymph_node', lesions=1, basis='imaging',
                  imaging_negative=0, note='区域复发伴淋巴结转移')
        p.disease_category = 'mHSPC'; p.met_count = 1; p.status = '转移'
    else:
        p.disease_category = 'nmHSPC'; p.status = '生化复发'
    p.visit(addm(bd, 4), '挽救性 ADT+恩扎卢胺，PSA 下降', [
        {'episodeId': max([e['id'] for e in p.v13['episodes']]), 'overallResponse': 'PR',
         'responseBasis': 'psa', 'psaResponse': 'PSA50', 'summary': '挽救治疗反应'}],
        aes=[('fatigue', 2, {}), ('hot_flashes', 2, {})])

def scenario_post_rp_bcr(p, v):
    age = 64 + v * 3
    dx = REF - timedelta(days=365 * (4 + v) + 200)
    base(p, age=age, dx=dx, cT='cT3aN0M0', gp=4, gs=4, psa=22 + v * 4,
         pirads=5, cores=12, mdt=True)
    rp_date = dx + timedelta(days=50)
    do_rp(p, rp_date, nerve='单侧', ln='扩大')
    p.pathologic_stage = 'pT3aN0M0'
    p.state('nmHSPC', 'nmHSPC', rp_date, '高危根治术后未转移', evidence={'post_rp': True})
    bd = addm(rp_date, 16 + v * 3)
    progression_bcr(p, bd, 0.3 + v * 0.08)
    p.visit(bd, '术后生化复发，PSMA 分期', [])
    p.imaging(bd + timedelta(days=10), 'PSMA PET-CT', 'PSMA_PET', lesions=0 if v < 2 else 1,
              sites='' if v < 2 else 'lymph_node', psma_positive=1 if v >= 2 else 0,
              suv=2.4 if v < 2 else 6.2, notes='生化复发后再分期')
    p.visit(bd + timedelta(days=15), 'MDT：生化复发，挽救性放疗 ± ADT', [], mdt=True)
    ln = next_line(p); lid = p.line(ln, '挽救', '挽救性放疗+ADT', bd + timedelta(days=20), addm(bd, 2),
                                   response='完成', response_code='salvage')
    eid = p.episode('radiotherapy', 'RT', '挽救性放疗+ADT', bd + timedelta(days=20), addm(bd, 2),
                    line_id=lid, status='completed', intent='salvage', scenario='salvage')
    p.radiation(bd + timedelta(days=20), 'EBRT', 'prostate_pelvis', 66, 33,
                event_type='挽救性放疗(EBRT)', concurrent_adt=True)
    p.castration = 1; p.adt_start = p.adt_start or bd + timedelta(days=20)
    p.medicine('adt', '戈舍瑞林', bd + timedelta(days=20), addm(bd, 24), dose='10.8mg', schedule='q12w', line_id=lid)
    p.administration(eid, bd + timedelta(days=20), '戈舍瑞林', '10.8mg', next_d=addm(bd, 3))
    p.psa_add(addm(bd, 3), 0.06, below=True, lod=0.1)
    p.testo_add(addm(bd, 3), 13)
    p.visit(addm(bd, 4), '挽救性放疗结束，PSA 下降，继续 ADT', [
        {'episodeId': eid, 'overallResponse': 'PR', 'responseBasis': 'psa', 'psaResponse': 'PSA50',
         'summary': 'PSA 下降'}], aes=[('proctitis', 1, {}), ('urinary_incontinence', 1, {})])
    p.disease_category = 'nmHSPC'
    if v == 3:
        p.outcome(addm(bd, 10), 'CRPC', subtype='mCRPC', basis='testosterone', psa_value=2.2,
                  note='术后挽救治疗后进展为 mCRPC')
        p.disease_category = 'mCRPC'
        start_arpi(p, addm(bd, 12), '阿比特龙', setting='mCRPC')

def scenario_mhspc(p, v):
    if v < 2:
        scenario_mhspc_arpi(p, v)
    else:
        scenario_mhspc_doc(p, v - 2)

def ensure_visits(p, target=4):
    """Guarantee at least 4 face-to-face contacts without inventing future dates."""
    if p.followup in ('死亡', '失访'):
        return
    guard = 0
    while len(p.v13['visits']) < target and p.v13['episodes'] and guard < 8:
        guard += 1
        base_d = p.last_visit or p.dx
        d = cap(base_d + timedelta(days=45))
        if d <= base_d:
            d = cap(base_d - timedelta(days=30))
        if d <= p.dx:
            break
        eid = max([e['id'] for e in p.v13['episodes']])
        p.psa_add(d - timedelta(days=3), max(0.02, (p.psa[-1]['val'] if p.psa else 0.1)))
        p.visit(d, '按计划随访：PSA/影像复查，继续当前治疗', [
            {'episodeId': eid, 'overallResponse': 'SD', 'responseBasis': 'psa',
             'psaResponse': 'STABLE', 'summary': '随访稳定'}],
            items=[('PSA复查','PSA','done',addm(d, 3)), ('影像复查','CT_MRI','pending',addm(d, 12))])
SCENARIOS = [
    ('AS→RP', scenario_as_rp),
    ('RP favorable→salvage RT', scenario_rp_fav),
    ('RP unfavorable→adjuvant/salvage', scenario_rp_unfav),
    ('High-risk RP→mHSPC', scenario_high_rp),
    ('Very high RT→BCR', scenario_rt_high),
    ('Regional cN1M0', scenario_regional),
    ('Post-RP BCR salvage', scenario_post_rp_bcr),
    ('mHSPC ARPI/docetaxel', scenario_mhspc),
    ('nmCRPC→metastasis', scenario_nmcrpc),
    ('mCRPC sequence', scenario_mcrpc_seq),
    ('Oligometastatic', scenario_oligo),
    ('Rare/BRCA/NEPC', scenario_rare),
    ('Post-RT local recurrence', scenario_post_rt_salvage),
    ('Elderly WW', scenario_elderly_ww),
    ('Death/lost', scenario_death_lost)
]

def main():
    random.seed(20261104)
    patients = []
    for i in range(60):
        sc_name, fn = SCENARIOS[(i * 7 + i // 4) % len(SCENARIOS)]
        # Guarantee 4 each of the first 15; simpler: scenario index = i // 4
        sc_name, fn = SCENARIOS[i // 4]
        p = Patient(i + 1, sc_name)
        fn(p, i % 4)
        # ensure common comorbidity/labs for texture
        if p.n % 3 == 0: p.comorbidity('hypertension')
        if p.n % 5 == 0: p.comorbidity('diabetes')
        if p.n % 7 == 0: p.comorbidity('copd')
        ensure_visits(p, 4)
        add_labs_followup(p, cap((p.last_visit or p.dx) - timedelta(days=3)))
        # ensure psa exists and last record not after REF
        if not p.psa:
            p.psa_add(p.dx, 10)
        p.psa.sort(key=lambda x: x['date'])
        p.state('nmHSPC', 'nmHSPC', p.dx, '初诊非转移', current=not p.disease_category) if not p.v13['diseaseStates'] and not p.disease_category else None
        patients.append(p.finalize())
    backup = {
        'type': 'pcd-backup', 'version': 13,
        'exportedAt': '2026-11-04T12:00:00.000Z',
        'exportedBy': 'local_dev',
        'idCounter': 160,
        'patients': patients,
        'files': []
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(backup, f, ensure_ascii=False, indent=1)
    print('wrote', OUT, 'patients', len(patients), 'bytes', __import__('os').path.getsize(OUT))
    # coverage summary
    from collections import Counter
    print('scenarios', Counter(p['scenario'] for p in patients))
    print('diseaseCategory', Counter(p['diseaseCategory'] for p in patients))
    print('status', Counter(p['status'] for p in patients))
    print('followup', Counter(p['followupStatus'] for p in patients))
    print('lines', sum(len(p['treatmentLines']) for p in patients), 'visits', sum(len(p['v13']['visits']) for p in patients),
          'aes', sum(len(p['v13']['adverseEvents']) for p in patients))

if __name__ == '__main__':
    main()

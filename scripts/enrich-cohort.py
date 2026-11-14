#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
enrich-cohort.py —— 把 60 例演示队列丰富到 PC-166「陈慕远」级别的记录密度。

设计原则
--------
1. **不另起剧情**：复用 generate-test-cohort.py 已生成的真实病程骨架（治疗线/
   治疗段/手术/放疗/化疗/结局），只在既有时间轴上「加密」随访、检验、给药与
   毒性记录。因此每位患者的丰富内容都符合他自己的分期、治疗与转归，60 人
   不会变成同一个故事。
2. **不改既有事实**：已有的 PSA/睾酮/病理/影像/治疗线一律保留原值，新增记录
   只填补时间空隙，且数值围绕既有轨迹插值，不制造矛盾。
3. **日期硬约束**：所有新增日期 <= REF（2026-11-04），死亡患者不晚于死亡日，
   失访患者不晚于末次接触日；不得早于诊断日。
4. **枚举自律**：导入走 backup/import 直插库、绕过 API 校验，故本模块自行
   遵守 server.js 的枚举与冲突约束（用药同类不重叠、val 纯数字等）。

用法
----
    python3 scripts/enrich-cohort.py            # 生成 data/test-cohort-60-rich.json
    python3 scripts/enrich-cohort.py --stats    # 只打印密度对比，不写文件
"""
import json
import os
import random
import sys
from collections import Counter
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    'gtc', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'generate-test-cohort.py'))
gtc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gtc)

REF = gtc.REF
iso, addm, addd, cap = gtc.iso, gtc.addm, gtc.addd, gtc.cap
Patient = gtc.Patient

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'data', 'test-cohort-60-rich.json')

# ---------------------------------------------------------------- 工具

def d(s):
    return date.fromisoformat(s) if s else None


def span_days(a, b):
    return (b - a).days


def clamp(dv, lo, hi):
    if dv is None:
        return None
    return max(lo, min(hi, dv))


def horizon(p):
    """该患者允许写入记录的最后一天。死亡/失访者不得越过其终点。"""
    end = REF - timedelta(days=1)
    if p.followup == '死亡':
        death = None
        for o in p.outcomes:
            if o.get('outcomeType') == 'death' and o.get('outcomeDate'):
                death = d(o['outcomeDate'])
        if death:
            end = min(end, death)
        elif p.last_visit:
            end = min(end, p.last_visit)
    elif p.followup == '失访' and p.last_visit:
        end = min(end, p.last_visit)
    return max(end, p.dx + timedelta(days=30))


def lerp(a, b, t):
    return a + (b - a) * t


def psa_curve_value(p, dv):
    """按既有 PSA 轨迹在给定日期插值，保证新增点与曲线自洽。"""
    pts = [(d(x['date']), float(x['val'])) for x in p.psa if x.get('date')]
    pts.sort()
    if not pts:
        return 0.1
    if dv <= pts[0][0]:
        return pts[0][1]
    if dv >= pts[-1][0]:
        return pts[-1][1]
    for i in range(len(pts) - 1):
        d0, v0 = pts[i]
        d1, v1 = pts[i + 1]
        if d0 <= dv <= d1:
            t = span_days(d0, dv) / max(1, span_days(d0, d1))
            # PSA 用对数插值更贴近真实动力学
            import math
            lv0, lv1 = math.log(max(v0, 0.01)), math.log(max(v1, 0.01))
            return round(math.exp(lerp(lv0, lv1, t)), 3)
    return pts[-1][1]


def active_episode_at(p, dv):
    """给定日期落在哪个治疗段内；没有则取时间上最近的段。"""
    eps = p.v13['episodes']
    if not eps:
        return None
    for e in eps:
        s = d(e['startDate'])
        t = d(e['endDate']) if e.get('endDate') else horizon(p)
        if s and s <= dv <= (t or horizon(p)):
            return e
    best, bd = None, None
    for e in eps:
        s = d(e['startDate'])
        if not s:
            continue
        gap = abs(span_days(s, dv))
        if bd is None or gap < bd:
            best, bd = e, gap
    return best


def active_meds_at(p, dv):
    out = []
    for m in p.medications:
        s = d(m['startDate'])
        t = d(m['endDate']) if m.get('endDate') else horizon(p)
        if s and s <= dv <= (t or horizon(p)):
            out.append(m)
    return out


# ---------------------------------------------------------------- 化验套餐

ROUTINE = [
    ('HGB', '血红蛋白', 132, 'g/L', '130-175'),
    ('WBC', '白细胞', 6.2, '10^9/L', '3.5-9.5'),
    ('PLT', '血小板', 210, '10^9/L', '125-350'),
    ('NEUT', '中性粒细胞绝对值', 3.8, '10^9/L', '1.8-6.3'),
    ('ALT', '丙氨酸氨基转移酶', 24, 'U/L', '9-50'),
    ('AST', '天门冬氨酸氨基转移酶', 22, 'U/L', '15-40'),
    ('TBIL', '总胆红素', 12.5, 'umol/L', '3.4-20.5'),
    ('ALB', '白蛋白', 42, 'g/L', '40-55'),
    ('CREA', '肌酐', 82, 'umol/L', '57-97'),
    ('UREA', '尿素', 5.4, 'mmol/L', '3.1-8.0'),
    ('ALP', '碱性磷酸酶', 88, 'U/L', '45-125'),
    ('CA', '血钙', 2.32, 'mmol/L', '2.11-2.52'),
    ('K', '血钾', 4.1, 'mmol/L', '3.5-5.3'),
    ('NA', '血钠', 140, 'mmol/L', '137-147'),
    ('GLU', '空腹血糖', 5.4, 'mmol/L', '3.9-6.1'),
    ('LDH', '乳酸脱氢酶', 185, 'U/L', '120-250'),
]
BONE_METS = [('ALP', '碱性磷酸酶', 168, 'U/L', '45-125'), ('CA', '血钙', 2.48, 'mmol/L', '2.11-2.52')]
CHEMO_HIT = [('HGB', '血红蛋白', 108, 'g/L', '130-175'), ('WBC', '白细胞', 2.9, '10^9/L', '3.5-9.5'),
             ('NEUT', '中性粒细胞绝对值', 1.3, '10^9/L', '1.8-6.3'), ('PLT', '血小板', 96, '10^9/L', '125-350')]
ARPI_HIT = [('ALT', '丙氨酸氨基转移酶', 62, 'U/L', '9-50'), ('AST', '天门冬氨酸氨基转移酶', 54, 'U/L', '15-40'),
            ('K', '血钾', 3.3, 'mmol/L', '3.5-5.3'), ('GLU', '空腹血糖', 7.2, 'mmol/L', '3.9-6.1')]
LIPID = [('TC', '总胆固醇', 5.6, 'mmol/L', '<5.2'), ('TG', '甘油三酯', 2.1, 'mmol/L', '<1.7'),
         ('LDL', '低密度脂蛋白', 3.6, 'mmol/L', '<3.4'), ('HDL', '高密度脂蛋白', 1.1, 'mmol/L', '>1.0')]


def lab_panel(p, dv, rng, kind='routine'):
    """写一组化验；kind 决定异常倾向。数值带个体抖动，避免 60 人完全一样。"""
    items = list(ROUTINE)
    if kind == 'chemo':
        items = [x for x in items if x[0] not in {y[0] for y in CHEMO_HIT}] + CHEMO_HIT
    elif kind == 'arpi':
        items = [x for x in items if x[0] not in {y[0] for y in ARPI_HIT}] + ARPI_HIT
    elif kind == 'bone':
        items = [x for x in items if x[0] not in {y[0] for y in BONE_METS}] + BONE_METS
    if kind in ('adt', 'arpi'):
        items += LIPID
    for code, label, base_v, unit, ref in items:
        jitter = 1 + rng.uniform(-0.09, 0.09)
        v = round(base_v * jitter, 2)
        flag = ''
        try:
            if '-' in ref:
                lo, hi = ref.split('-')
                if v < float(lo):
                    flag = 'L'
                elif v > float(hi):
                    flag = 'H'
            elif ref.startswith('<') and v > float(ref[1:]):
                flag = 'H'
            elif ref.startswith('>') and v < float(ref[1:]):
                flag = 'L'
        except Exception:
            pass
        p.lab_add(dv, code, label, v, unit, ref, flag)


# ---------------------------------------------------------------- 毒性谱

AE_BY_CLASS = {
    'adt': [('hot_flashes', 1), ('fatigue', 1), ('osteoporosis', 1), ('metabolic_syndrome', 1),
            ('cognitive_impairment', 1), ('erectile_dysfunction', 2)],
    'arpi': [('hypertension', 2), ('liver_toxicity', 1), ('fatigue', 2), ('hot_flashes', 1)],
    'chemo': [('myelosuppression', 2), ('fatigue', 2), ('peripheral_neuropathy', 1),
              ('nausea', 1), ('diarrhea', 1), ('anemia', 2), ('allergy', 1)],
    'parpi': [('anemia', 2), ('nausea', 1), ('fatigue', 2), ('myelosuppression', 1)],
    'nuc': [('nausea', 1), ('fatigue', 1), ('myelosuppression', 1)],
    'bone': [('osteoporosis', 1)],
    'rt': [('proctitis', 1), ('urinary_incontinence', 1), ('hematuria', 1)],
    'surgery': [('urinary_incontinence', 1), ('erectile_dysfunction', 2)],
}
AE_ACTION = {1: 'none', 2: 'none', 3: 'dose_reduce', 4: 'interrupt', 5: 'stop'}
AE_MGMT = {
    'myelosuppression': '重组人粒细胞集落刺激因子支持',
    'anemia': '补铁 + 必要时输血',
    'nausea': '5-HT3 受体拮抗剂预防',
    'diarrhea': '洛哌丁胺 + 补液',
    'peripheral_neuropathy': '甲钴胺营养神经，必要时减量',
    'hypertension': '氨氯地平降压，监测血压',
    'liver_toxicity': '停用可疑药物 + 保肝治疗',
    'hot_flashes': '生活方式干预，必要时文拉法辛',
    'osteoporosis': '钙 + 维生素 D，定期 DEXA',
    'proctitis': '局部灌肠 + 饮食调整',
    'urinary_incontinence': '盆底肌训练',
    'fatigue': '运动处方 + 营养支持',
    'metabolic_syndrome': '饮食运动干预 + 血脂血糖管理',
    'erectile_dysfunction': 'PDE5 抑制剂按需',
    'cognitive_impairment': '认知训练，家属陪护',
    'allergy': '糖皮质激素预处理',
    'hematuria': '止血 + 膀胱冲洗',
}


def ae_terms_for(p, dv):
    meds = active_meds_at(p, dv)
    cats = {m.get('category') for m in meds}
    pool = []
    for c in cats:
        pool += AE_BY_CLASS.get(c, [])
    ep = active_episode_at(p, dv)
    if ep:
        code = ep.get('templateCode')
        if code == 'RT':
            pool += AE_BY_CLASS['rt']
        elif code == 'RP':
            pool += AE_BY_CLASS['surgery']
    if not pool:
        pool = [('fatigue', 1)]
    return pool


# ---------------------------------------------------------------- 主增强

def dedup_ae(p):
    """满足数据库唯一索引：
       idx_ae_row_term  UNIQUE(episode_row_id, term_code) WHERE row IS NOT NULL
       idx_ae_cycle_term UNIQUE(chemo_cycle_id, term_code) WHERE cycle IS NOT NULL
    同一随访行/同一化疗周期内同一术语只能有一条。保留分级最高的那条
    （临床上同一毒性在一次访视里按最重级别记录）。
    另外 visit_items 有 UNIQUE(visit_id, episode_row_id, item_code)，同样去重。
    """
    dropped = 0
    for key in ('episodeRowId', 'chemoCycleId'):
        idkey = 'rowId' if key == 'episodeRowId' else 'cycleId'
        seen = {}
        keep = []
        for a in p.v13['adverseEvents']:
            ref = a.get(key)
            if ref is None:
                keep.append(a)
                continue
            k = (ref, a.get('termCode'))
            if k in seen:
                prev = seen[k]
                if (a.get('grade') or 0) > (prev.get('grade') or 0):
                    keep.remove(prev)
                    keep.append(a)
                    seen[k] = a
                dropped += 1
            else:
                seen[k] = a
                keep.append(a)
        p.v13['adverseEvents'] = keep
    # visit_items 去重
    seen_i = set()
    keep_i = []
    for it in p.v13['items']:
        k = (it.get('visitId'), it.get('episodeRowId'), it.get('itemCode'))
        if k in seen_i:
            dropped += 1
            continue
        seen_i.add(k)
        keep_i.append(it)
    p.v13['items'] = keep_i
    return dropped


def normalize(p):
    """修正原造数脚本遗留的数据缺陷（导入直插库会绕过 API 校验，必须自律）。

    1. templateCode='SBRT' 不是合法随访模板（TEMPLATE_TYPES 只认
       RP/RT/ADT/SYSTEMIC/CHEMO/AS/WW/OTHER），SBRT 属放疗类型，应归 RT。
    2. 同一 category 用药闭区间重叠：后端 findMedicationConflict 明确拒绝
       （含同日换药，需至少隔 1 天）。这里把前一条的结束日提前到后一条开始
       日前一天，保持时间顺序与临床语义。
    3. endocrine 与 arpi 互斥：泼尼松被误归 endocrine，实际是糖皮质激素
       支持治疗，应归 support（与阿比特龙联用是标准方案，不构成冲突）。
    """
    fixed = Counter()
    for e in p.v13['episodes']:
        if e.get('templateCode') == 'SBRT':
            e['templateCode'] = 'RT'
            e['episodeType'] = 'radiotherapy'
            fixed['template'] += 1
    for m in p.medications:
        if m.get('category') == 'endocrine' and any(
                k in m.get('drug', '') for k in ('泼尼松', '泼尼松龙', '地塞米松')):
            m['category'] = 'support'
            fixed['steroid'] += 1
    # 同类重叠：按开始日排序后逐条收缩前一条的结束日
    bycat = {}
    for m in p.medications:
        bycat.setdefault(m.get('category'), []).append(m)
    for cat, ms in bycat.items():
        ms.sort(key=lambda x: x.get('startDate') or '')
        for i in range(len(ms) - 1):
            e = d(ms[i].get('endDate'))
            s2 = d(ms[i + 1].get('startDate'))
            if e and s2 and s2 <= e:
                new_end = addd(s2, -1)
                s1 = d(ms[i].get('startDate'))
                if s1 and new_end >= s1:
                    ms[i]['endDate'] = iso(new_end)
                    fixed['overlap'] += 1
    # endocrine ↔ arpi 仍重叠时，收缩 endocrine 段
    for a in bycat.get('endocrine', []):
        for b in bycat.get('arpi', []):
            a0, a1 = d(a.get('startDate')), d(a.get('endDate'))
            b0, b1 = d(b.get('startDate')), d(b.get('endDate'))
            far = date(9999, 12, 31)
            if a0 and b0 and a0 <= (b1 or far) and b0 <= (a1 or far):
                new_end = addd(b0, -1)
                if new_end >= a0:
                    a['endDate'] = iso(new_end)
                    fixed['cross'] += 1
    return fixed


def enrich(p, rng):
    """在既有病程骨架上加密记录。返回新增计数明细。"""
    end = horizon(p)
    start = p.dx
    if span_days(start, end) < 60:
        end = min(REF - timedelta(days=1), start + timedelta(days=60))
    added = Counter()

    # 已有日期集合，避免与既有记录同日重复
    have_psa = {x['date'] for x in p.psa}
    have_testo = {x['date'] for x in p.testo}
    have_visit = {x['visitDate'] for x in p.v13['visits']}
    have_lab = {x['date'] for x in p.lab_values}
    have_admin = {x['adminDate'] for x in p.v13['administrations']}

    eps = p.v13['episodes']
    on_adt = any(m.get('category') in ('endocrine', 'arpi') for m in p.medications)
    has_chemo = any(e.get('templateCode') == 'CHEMO' for e in eps)
    has_bone_met = bool(p.met_count) and p.met_count > 0

    # 病程短的患者（如初诊即高危、快速进展或早期死亡）按更密的间隔随访，
    # 这符合临床实际：病情越重、复查越频。长病程者维持常规间隔，避免记录冗余。
    total_days = max(1, span_days(start, end))
    dense = total_days < 1200
    freq = 0.62 if dense else 1.0

    # ---------- 1. PSA 密集随访：全程每 6-9 周一次（短病程更密） ----------
    cur = start
    step = max(21, int((45 + (p.n % 4) * 7) * freq))
    while cur <= end:
        key = iso(cur)
        if key not in have_psa:
            v = psa_curve_value(p, cur)
            noise = 1 + rng.uniform(-0.06, 0.06)
            v = max(0.01, round(v * noise, 3))
            below = v < 0.1
            p.psa_add(cur, v, below=below, lod=0.1 if below else 0.1)
            have_psa.add(key)
            added['psa'] += 1
        cur = addd(cur, step)

    # ---------- 2. 睾酮：去势治疗期间每 3 个月 ----------
    if on_adt:
        adt_start = p.adt_start or start
        cur = adt_start
        while cur <= end:
            key = iso(cur)
            if key not in have_testo:
                # 去势水平 <20 ng/dl，偶有突破
                base = 12 if rng.random() > 0.12 else 38
                p.testo_add(cur, round(base * (1 + rng.uniform(-0.25, 0.25)), 1))
                have_testo.add(key)
                added['testo'] += 1
            cur = addm(cur, 3)

    # ---------- 3. 结构化就诊 + 随访行 + 毒性 ----------
    cur = addd(start, 21)
    vstep = max(28, int((60 + (p.n % 3) * 15) * freq))
    while cur <= end:
        key = iso(cur)
        if key not in have_visit:
            ep = active_episode_at(p, cur)
            if ep:
                meds = active_meds_at(p, cur)
                cats = {m.get('category') for m in meds}
                kind = 'chemo' if 'chemo' in cats else ('arpi' if 'arpi' in cats else ('adt' if cats & {'endocrine'} else 'routine'))
                psa_v = psa_curve_value(p, cur)
                # 疗效按 PSA 相对基线变化判定
                base_psa = float(p.psa[0]['val']) if p.psa else psa_v
                drop = 1 - (psa_v / max(base_psa, 0.01))
                resp = 'PR' if drop >= 0.5 else ('SD' if drop >= -0.25 else 'PD')
                if ep.get('templateCode') in ('RP', 'RT'):
                    resp = 'CR' if psa_v < 0.2 else 'NA'
                pool = ae_terms_for(p, cur)
                aes = []
                # 每次就诊 0-2 条毒性，级别随治疗强度
                k = rng.choice([0, 1, 1, 2]) if kind != 'routine' else rng.choice([0, 0, 1])
                for term, g in rng.sample(pool, min(k, len(pool))):
                    grade = g
                    if kind == 'chemo' and term in ('myelosuppression', 'anemia') and rng.random() < 0.25:
                        grade = 3
                    # 恢复状态随时间推移：临床上多数毒性经处理后转归，
                    # 只有近期（90 天内）发生的才可能仍在恢复/未恢复。
                    # 否则整个队列会挂满「≥2 级毒性尚未恢复」的紧急预警，
                    # 与真实随访队列不符。
                    age_days = span_days(cur, end)
                    if grade <= 1 or age_days > 180:
                        rec = 'recovered'
                    elif age_days > 90:
                        rec = 'recovered' if rng.random() < 0.8 else 'recovering'
                    else:
                        rec = rng.choice(['recovering', 'recovering', 'not_recovered'])
                    aes.append((term, grade, {
                        'recovery': rec,
                        'management': AE_MGMT.get(term, '对症支持'),
                        'action': AE_ACTION.get(grade, 'none'),
                        'notes': '按 CTCAE 5.0 评估',
                    }))
                summary = f'第{len(p.v13["visits"]) + 1}次随访：PSA {psa_v} ng/mL'
                if meds:
                    summary += '，在用 ' + '、'.join(sorted({m['drug'] for m in meds})[:3])
                summary += f'，疗效评估 {resp}'
                items = [('PSA复查', 'PSA', 'done', addm(cur, 3)),
                         ('睾酮', 'TESTO', 'done' if on_adt else 'na', addm(cur, 3)),
                         ('血常规', 'CBC', 'done', addm(cur, 1)),
                         ('肝肾功能', 'LFT_RENAL', 'done', addm(cur, 3))]
                if has_bone_met:
                    items.append(('骨扫描/影像', 'CT_MRI', 'done' if rng.random() > 0.5 else 'pending', addm(cur, 6)))
                p.visit(cur, summary,
                        [{'episodeId': ep['id'], 'overallResponse': resp, 'responseBasis': 'psa',
                          'psaResponse': 'DECLINE' if resp in ('PR', 'CR') else ('STABLE' if resp == 'SD' else 'RISE'),
                          'summary': summary}],
                        visit_type='chemo' if kind == 'chemo' else 'outpatient',
                        next_plan='继续当前方案，按期复查', next_visit=addm(cur, 3),
                        items=items, aes=aes or None)
                have_visit.add(key)
                added['visits'] += 1
                added['aes'] += len(aes)
        cur = addd(cur, vstep)

    # ---------- 4. 化验套餐：每 6-8 周一组 ----------
    cur = addd(start, 14)
    while cur <= end:
        key = iso(cur)
        if key not in have_lab:
            meds = active_meds_at(p, cur)
            cats = {m.get('category') for m in meds}
            if 'chemo' in cats:
                kind = 'chemo'
            elif 'arpi' in cats:
                kind = 'arpi'
            elif has_bone_met:
                kind = 'bone'
            elif cats & {'endocrine'}:
                kind = 'adt'
            else:
                kind = 'routine'
            lab_panel(p, cur, rng, kind)
            have_lab.add(key)
            added['labGroups'] += 1
        cur = addd(cur, max(21, int((42 + (p.n % 3) * 7) * freq)))

    # ---------- 5. 给药日志：按在用注射类药物按周期补 ----------
    INJ = {'戈舍瑞林': ('3.6mg', 28), '亮丙瑞林': ('3.75mg', 28), '曲普瑞林': ('3.75mg', 28),
           '地加瑞克': ('80mg', 28), '地舒单抗': ('120mg', 28), '唑来膦酸': ('4mg', 28)}
    for m in p.medications:
        drug = m.get('drug', '')
        hit = next((k for k in INJ if k in drug), None)
        if not hit:
            continue
        dose, interval = INJ[hit]
        s = d(m['startDate'])
        t = d(m['endDate']) if m.get('endDate') else end
        t = min(t or end, end)
        if not s:
            continue
        ep = active_episode_at(p, s)
        if not ep:
            continue
        cur = s
        while cur <= t:
            key = iso(cur)
            if key not in have_admin:
                p.administration(ep['id'], cur, hit, dose, next_d=addd(cur, interval))
                have_admin.add(key)
                added['admins'] += 1
            cur = addd(cur, interval)

    # ---------- 6. 化疗周期加密：既有段内按 21 天补齐 ----------
    for ep in eps:
        if ep.get('templateCode') != 'CHEMO':
            continue
        s = d(ep['startDate'])
        t = d(ep['endDate']) if ep.get('endDate') else end
        t = min(t or end, end)
        if not s:
            continue
        existing = [c for c in p.v13['chemoCycles'] if c.get('episodeId') == ep['id']]
        have_no = {c['cycleNo'] for c in existing}
        have_cd = {c['cycleDate'] for c in existing}
        line_id = ep.get('lineId') or (p.treatment_lines[0]['id'] if p.treatment_lines else 1)
        regimen = existing[0]['regimen'] if existing else '多西他赛 + 泼尼松'
        no = max(have_no) if have_no else 0
        cur = s
        while cur <= t and no < 18:
            key = iso(cur)
            if key not in have_cd:
                no += 1
                red = 20 if rng.random() < 0.15 else 0
                delay = 7 if rng.random() < 0.12 else 0
                cid = p.cycle(ep['id'], line_id, no, cur, regimen,
                              agents=[{'drug': '多西他赛', 'dose': '75mg/m²'}, {'drug': '泼尼松', 'dose': '5mg bid'}],
                              gcsf=rng.random() < 0.3, reduction=red, delay=delay,
                              next_d=addd(cur, 21 + delay))
                if red or delay:
                    p.ae('myelosuppression', 3, episode_id=ep['id'], cycle_id=cid, onset=cur,
                         recovery='recovered', action='dose_reduce' if red else 'delay',
                         management=AE_MGMT['myelosuppression'], notes='周期调整原因：骨髓抑制')
                    added['aes'] += 1
                have_cd.add(key)
                added['cycles'] += 1
            cur = addd(cur, 21)

    # ---------- 7. 药物特异性监测勾选 ----------
    MON = {
        '地舒单抗': [('血钙', 3), ('口腔检查', 6), ('25-OH维生素D', 6)],
        '唑来膦酸': [('血钙', 3), ('肾功能', 3), ('口腔检查', 6)],
        '阿比特龙': [('血压', 1), ('血钾', 1), ('肝功能', 1)],
        '恩扎卢胺': [('血压', 3), ('肝功能', 3)],
        '达罗他胺': [('肝功能', 3), ('血压', 3)],
        '阿帕他胺': [('甲状腺功能', 6), ('血压', 3), ('皮疹评估', 3)],
        '多西他赛': [('血常规', 1), ('肝功能', 1)],
        '卡巴他赛': [('血常规', 1), ('肝功能', 1)],
        '奥拉帕利': [('血常规', 1), ('肾功能', 3)],
        '戈舍瑞林': [('睾酮', 3), ('骨密度', 12), ('血脂', 6)],
        '亮丙瑞林': [('睾酮', 3), ('骨密度', 12), ('血糖', 6)],
    }
    have_mon = {(x.get('item'), x.get('date')) for x in p.clinical_records}
    for m in p.medications:
        drug = m.get('drug', '')
        hit = next((k for k in MON if k in drug), None)
        if not hit:
            continue
        s = d(m['startDate'])
        t = d(m['endDate']) if m.get('endDate') else end
        t = min(t or end, end)
        if not s:
            continue
        for item, every in MON[hit]:
            cur = addm(s, every)
            while cur <= t:
                key = (f'{hit}·{item}', iso(cur))
                if key not in have_mon:
                    st = '异常' if rng.random() < 0.12 else '已完成'
                    p.clinical_records.append({
                        'category': 'monitor', 'item': f'{hit}·{item}', 'date': iso(cur),
                        'val': None, 'unit': '', 'status': st,
                        'note': '按药物毒性谱定期监测' if st == '已完成' else '结果异常，已对症处理并复查',
                    })
                    have_mon.add(key)
                    added['monitor'] += 1
                cur = addm(cur, every)

    # ---------- 8. 骨健康 / 心血管 / 生活质量 ----------
    if on_adt:
        cur = addm(p.adt_start or start, 12)
        while cur <= end:
            p.clinical_records.append({'category': 'bone', 'item': 'DEXA', 'date': iso(cur),
                                       'val': round(-1.2 - rng.uniform(0, 1.6), 2), 'unit': 'T值',
                                       'status': '', 'note': '腰椎 T 值'})
            added['bone'] += 1
            cur = addm(cur, 12)
    cur = addd(start, 30)
    while cur <= end:
        p.clinical_records.append({'category': 'cardio', 'item': 'BP_SYS', 'date': iso(cur),
                                   'val': round(126 + rng.uniform(-12, 22)), 'unit': 'mmHg',
                                   'status': '', 'note': '诊室血压'})
        p.clinical_records.append({'category': 'qol', 'item': 'IPSS', 'date': iso(cur),
                                   'val': round(8 + rng.uniform(0, 14)), 'unit': '分',
                                   'status': '', 'note': '国际前列腺症状评分'})
        added['cardio'] += 2
        cur = addm(cur, 3 if dense else 6)

    # ---------- 9. 影像随访：转移者每 6 个月，非转移每 12 个月 ----------
    have_img = {x.get('studyDate') for x in p.imaging_studies}
    interval = 6 if has_bone_met else 12
    cur = addm(start, interval)
    while cur <= end:
        key = iso(cur)
        if key not in have_img:
            modality = 'PSMA_PET' if (has_bone_met and rng.random() < 0.4) else ('bone_scan' if has_bone_met else 'mpMRI')
            comp = 'stable'
            if has_bone_met:
                comp = rng.choice(['stable', 'stable', 'progress', 'improved'])
            eid = p.event(cur, '影像复查', f'{modality} 复查：{comp}')
            p.imaging_studies.append({
                'id': len(p.imaging_studies) + 1, 'eventId': eid, 'studyDate': iso(cur),
                'modality': modality, 'target': 'prostate_pelvis' if not has_bone_met else 'whole_body',
                'comparison': comp, 'lesionCount': p.met_count if has_bone_met else 0,
                'dimTransverseCm': round(1.2 + rng.uniform(0, 1.4), 1) if not has_bone_met else None,
                'dimApCm': round(1.0 + rng.uniform(0, 1.2), 1) if not has_bone_met else None,
                'dimCranialCm': round(1.1 + rng.uniform(0, 1.3), 1) if not has_bone_met else None,
                'pirads': 4 if not has_bone_met else None,
                'findings': '与前片比较未见明显变化' if comp == 'stable' else ('病灶较前增大/新增' if comp == 'progress' else '病灶较前缩小'),
                'conclusion': f'疗效影像评估：{comp}', 'isCurrent': False,
            })
            have_img.add(key)
            added['imaging'] += 1
        cur = addm(cur, interval)

    # ---------- 10. 合并症补齐 ----------
    if len(p.v13['comorbidities']) < 4:
        pool = ['hypertension', 'hyperlipidemia', 'diabetes', 'osteoporosis', 'copd', 'peptic_ulcer']
        rng.shuffle(pool)
        for code in pool:
            if len(p.v13['comorbidities']) >= 5:
                break
            if any(c['diseaseCode'] == code for c in p.v13['comorbidities']):
                continue
            p.comorbidity(code, severity=rng.choice(['轻度', '中度']))
            added['comorb'] += 1

    # ---------- 11. 时间轴事件：把新增检验/影像/就诊镜像为节点 ----------
    #   业务端 import 会按结构化对象自动镜像部分节点，这里补临床沟通类事件
    cur = addd(start, 45)
    while cur <= end:
        p.event(cur, '随访沟通', '电话/门诊随访：症状评估、用药依从性与不良反应宣教')
        added['events'] += 1
        cur = addd(cur, max(30, int((90 + (p.n % 4) * 10) * freq)))

    return added


def main():
    stats_only = '--stats' in sys.argv
    random.seed(20261104)
    patients = []
    total = Counter()
    before_after = []
    for i in range(60):
        sc_name, fn = gtc.SCENARIOS[i // 4]
        p = Patient(i + 1, sc_name)
        fn(p, i % 4)
        if p.n % 3 == 0:
            p.comorbidity('hypertension')
        if p.n % 5 == 0:
            p.comorbidity('diabetes')
        if p.n % 7 == 0:
            p.comorbidity('copd')
        gtc.ensure_visits(p, 4)
        gtc.add_labs_followup(p, cap((p.last_visit or p.dx) - timedelta(days=3)))
        if not p.psa:
            p.psa_add(p.dx, 10)
        p.psa.sort(key=lambda x: x['date'])
        if not p.v13['diseaseStates'] and not p.disease_category:
            p.state('nmHSPC', 'nmHSPC', p.dx, '初诊非转移')

        def count(pp):
            return (len(pp.psa) + len(pp.testo) + len(pp.lab_values) + len(pp.clinical_records)
                    + len(pp.medications) + len(pp.treatment_lines) + len(pp.events)
                    + len(pp.pathology_reports) + len(pp.imaging_studies) + len(pp.radiation_records)
                    + len(pp.outcomes) + len(pp.specimens) + len(pp.genomic) + len(pp.ihc)
                    + sum(len(v) for v in pp.v13.values()))

        n0 = count(p)
        total.update(normalize(p))
        rng = random.Random(90000 + i)
        added = enrich(p, rng)
        total.update(added)
        dropped = dedup_ae(p)
        if dropped:
            total['dedup'] += dropped
        n1 = count(p)
        before_after.append((p.id, p.name, n0, n1))
        patients.append(p.finalize())

    # 保留线上真人录入的患者：由调用方在合并阶段注入，这里只产出 60 例演示
    backup = {
        'type': 'pcd-backup', 'version': 13,
        'exportedAt': '2026-11-14T14:00:00.000Z',
        'exportedBy': 'local_dev',
        'idCounter': 160,
        'patients': patients,
        'files': [],
    }
    ns = [x[3] for x in before_after]
    print('=== 密度对比（丰富前 → 丰富后）===')
    for pid, name, a, b in before_after[:6]:
        print(f'  {pid} {name}: {a} → {b}')
    print(f'  ... 共 {len(ns)} 例')
    print(f'平均: {sum(x[2] for x in before_after) // 60} → {sum(ns) // 60}')
    print(f'最少: {min(ns)}   最多: {max(ns)}   总计: {sum(ns)}')
    print('新增明细:', dict(total))
    if not stats_only:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(backup, f, ensure_ascii=False)
        print('wrote', OUT, 'bytes', os.path.getsize(OUT))


if __name__ == '__main__':
    main()
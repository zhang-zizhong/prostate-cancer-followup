/* 为现有 60 位演示患者生成药物使用记录。
 *
 * 目的：让「药物使用时间轴」有真实可看的并发用药数据，而不是空表。
 * 规则按患者的首选治疗、分期、Gleason、状态和已有 ADT/放疗事件推导；
 * 不是处方，所有记录仅用于本演示库。
 *
 * 运行：
 *   node scripts/seed-medications.mjs
 *   node scripts/seed-medications.mjs --force   # 清空后重灌（谨慎）
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const db = new Database(path.resolve('data/clinical.db'));
db.pragma('foreign_keys = ON');

const force = process.argv.includes('--force');
const existing = db.prepare('SELECT COUNT(*) AS n FROM medication_records').get().n;
if (existing > 0 && !force) {
  console.log('medication_records 已有 ' + existing + ' 条记录；如需重灌请加 --force');
  process.exit(0);
}
if (force) db.prepare('DELETE FROM medication_records').run();

const today = '2026-10-18';
const patients = db.prepare('SELECT * FROM patients ORDER BY id').all();
const psaStmt = db.prepare('SELECT rec_date, value FROM psa_records WHERE patient_id=? ORDER BY rec_date, id');
const evStmt = db.prepare('SELECT event_date, event_type FROM timeline_events WHERE patient_id=? ORDER BY event_date, id');

const DAY = 86400000;
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / DAY);
}
function normDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s ? s : null;
}
function isup(g) {
  const m = String(g || '').match(/^(\d)\+(\d)=(\d+)$/);
  if (!m) return 0;
  const a = +m[1], b = +m[2], total = +m[3];
  if (total <= 6) return 1;
  if (total === 7) return a === 3 ? 2 : 3;
  if (total === 8) return 4;
  return 5;
}
function tNum(stage) {
  const m = String(stage || '').match(/T(\d)/i);
  return m ? +m[1] : 0;
}
function has(s, needle) { return String(s || '').includes(needle); }

const ADT_DRUGS = ['戈舍瑞林', '亮丙瑞林', '曲普瑞林', '地加瑞克'];
const ARPI_DRUGS = ['阿比特龙+泼尼松', '恩扎卢胺', '阿帕他胺', '达罗他胺'];
const rows = [];
const seen = new Set();

function add(pid, diag, cap, category, drug, start, end, notes) {
  let s = normDate(start);
  if (!s) return;
  if (diag && s < diag) s = diag;
  if (cap && s > cap) return;
  let e = end ? normDate(end) : null;
  if (end && !e) return;
  if (cap && (!e || e > cap)) e = cap;
  if (e && e < s) return;
  const key = [pid, category, drug, s, e || ''].join('|');
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({
    patient_id: pid, category, drug_name: drug,
    start_date: s, end_date: e, notes: notes || '',
    created_by: 'local_dev', created_at: new Date().toISOString()
  });
}

/* 个别复杂患者用明确的换线顺序；其余按规则生成。 */
const SPECIAL = new Set(['PC-208', 'PC-210', 'PC-217']);

for (let idx = 0; idx < patients.length; idx++) {
  const p = patients[idx];
  const id = p.id;
  const diag = normDate(p.diag_date) || today;
  const surg = normDate(p.surg_date);
  const psa = psaStmt.all(id).filter(x => normDate(x.rec_date));
  const events = evStmt.all(id);
  const lastPsa = psa.length ? psa[psa.length - 1].rec_date : diag;
  const lastSeen = [lastPsa, normDate(p.last_followup_date), diag].filter(Boolean).sort().at(-1) || diag;
  const status = p.status || '';
  const isDead = status === '死亡';
  const isLost = status === '失访';
  const isMet = status === '转移';
  const isBCR = status === '生化复发';
  // 死亡/失访/转移患者没有后续记录时，把用药结束日收敛到最后一次接触，
  // 避免演示时间轴出现“已经死亡却仍在用药”的长条。
  const cap = (isDead || isLost || isMet) ? lastSeen : null;
  const stage = p.stage || '';
  const m1 = has(stage, 'M1');
  const n1 = has(stage, 'N1');
  const t = tNum(stage);
  const gg = isup(p.gleason);
  const highRisk = t >= 3 || n1 || m1 || gg >= 4;
  const isADT = p.treatment === '内分泌治疗';
  const isSurgery = p.treatment === '根治性手术';
  const isRT = p.treatment === '放疗';
  const isObs = p.treatment === '观察等待' || p.treatment === '主动监测';

  const rtEvents = events.filter(e => String(e.event_type).includes('外照射'));
  const rtStart = rtEvents.length ? rtEvents[0].event_date : null;
  const rtEnd = normDate(p.rt_end_date) || (rtEvents.length ? addDays(rtEvents[rtEvents.length - 1].event_date, 30) : null);
  const adtEvent = events.find(e => e.event_type === 'ADT启动');
  const adtStart = normDate(p.adt_start_date) || (adtEvent ? adtEvent.event_date : null);

  // 所有患者的基础骨健康支持：这是唯一一个所有患者都有的“用药”记录，
  // 让时间轴在低危/观察患者上也有内容，同时符合老年肿瘤患者的常规支持。
  add(id, diag, cap, 'support', '钙+维生素D', addDays(diag, 30), null, '骨健康基础支持');

  if (!isObs && !isADT && !isSurgery && !isRT) {
    // 兜底：未知治疗方式只保留基础支持
    continue;
  }

  // 生化复发日期：术后取首次 PSA≥0.1；放疗后取首次 nadir+2；观察等待取末次前一次。
  let bcrDate = null;
  if (isBCR) {
    if (isSurgery && surg) {
      const after = psa.filter(x => x.rec_date > surg);
      bcrDate = (after.find(x => Number(x.value) >= 0.1) || after[after.length - 1] || {}).rec_date || lastPsa;
    } else if (isRT) {
      const after = psa.filter(x => !rtEnd || x.rec_date > rtEnd);
      const vals = after.map(x => Number(x.value)).filter(Number.isFinite);
      const nadir = vals.length ? Math.min(...vals) : 0;
      bcrDate = (after.find(x => Number(x.value) >= nadir + 2) || after[after.length - 1] || {}).rec_date || lastPsa;
    } else {
      bcrDate = psa.length > 1 ? psa[psa.length - 2].rec_date : lastPsa;
    }
  }

  /* ---------- 三个复杂病例：明确的多线治疗 ---------- */
  if (id === 'PC-208') {
    add(id, diag, cap, 'adt', '戈舍瑞林', '2022-01-05', null, 'mHSPC 基础 ADT');
    add(id, diag, cap, 'arpi', '阿比特龙+泼尼松', '2022-01-19', '2023-06-30', 'mHSPC 强化；后因进展换线');
    add(id, diag, cap, 'chemo', '多西他赛+泼尼松', '2023-07-15', '2023-12-15', '6 周期，mCRPC 一线化疗');
    add(id, diag, cap, 'arpi', '恩扎卢胺', '2024-01-01', '2025-12-31', 'mCRPC 后线 ARPI');
    add(id, diag, cap, 'nuc', '氯化镭-223', '2025-02-01', '2025-07-01', '骨转移，6 次核素治疗');
    add(id, diag, cap, 'chemo', '卡巴他赛+泼尼松', '2026-01-15', '2026-05-15', '多西他赛后进展');
    add(id, diag, cap, 'parpi', '奥拉帕利', '2026-06-01', null, 'HRR 阳性（演示数据），后线维持');
    add(id, diag, cap, 'bone', '唑来膦酸', '2022-02-01', null, '骨转移；每 12 周');
    continue;
  }
  if (id === 'PC-210') {
    add(id, diag, cap, 'adt', '亮丙瑞林', '2025-06-01', null, 'mHSPC 基础 ADT');
    add(id, diag, cap, 'arpi', '恩扎卢胺', '2025-06-15', null, 'mHSPC 强化');
    add(id, diag, cap, 'nuc', 'Lu-177-PSMA-617', '2026-09-15', '2026-12-15', 'PSMA 阳性，计划 6 周期');
    add(id, diag, cap, 'bone', '唑来膦酸', '2025-07-01', null, '骨转移；每 12 周');
    continue;
  }
  if (id === 'PC-217') {
    add(id, diag, cap, 'adt', '戈舍瑞林', '2021-06-01', null, 'mHSPC 基础 ADT');
    add(id, diag, cap, 'arpi', '阿比特龙+泼尼松', '2021-06-15', '2023-01-31', 'mHSPC/mCRPC 强化');
    add(id, diag, cap, 'chemo', '多西他赛+泼尼松', '2023-02-15', '2023-07-15', '6 周期');
    add(id, diag, cap, 'arpi', '恩扎卢胺', '2023-08-01', null, '后线 ARPI');
    add(id, diag, cap, 'bone', '唑来膦酸', '2021-07-01', null, '骨转移；每 12 周');
    continue;
  }

  /* ---------- 内分泌治疗：ADT + ARPI（N1/M1/高危） ---------- */
  if (isADT && !SPECIAL.has(id)) {
    const start = adtStart || addDays(diag, 14);
    const adtDrug = ADT_DRUGS[idx % ADT_DRUGS.length];
    add(id, diag, cap, 'adt', adtDrug, start, null, '晚期/高危前列腺癌基础 ADT');
    const arpiNeeded = m1 || n1;
    const arpiStart = addDays(start, 14);
    if (adtDrug !== '地加瑞克') {
      add(id, diag, cap, 'endocrine', '比卡鲁胺', start,
        arpiNeeded ? addDays(arpiStart, -1) : addDays(start, 30), 'LHRH 激动剂起始防 flare');
    }
    if (arpiNeeded) {
      const arpi = id === 'PC-209' ? '恩扎卢胺' : ARPI_DRUGS[idx % ARPI_DRUGS.length];
      add(id, diag, cap, 'arpi', arpi, arpiStart, null, m1 ? 'mHSPC 强化' : '区域疾病强化');
      if (m1 && (isMet || isDead || p.oligo_type === '高瘤负荷')) {
        const chemoStart = addMonths(arpiStart, 9);
        if (chemoStart <= lastSeen) {
          add(id, diag, cap, 'chemo', '多西他赛+泼尼松', chemoStart, addDays(chemoStart, 150), 'mHSPC 三联中的化疗，6 周期');
        }
        if (['PC-128', 'PC-130', 'PC-131'].includes(id)) {
          add(id, diag, cap, 'bone', idx % 2 ? '地舒单抗' : '唑来膦酸', addDays(start, 30), null, '骨转移/骨风险支持');
        }
      }
    }
    continue;
  }

  /* ---------- 根治性手术：转移/BCR/N1 才加系统治疗 ---------- */
  if (isSurgery) {
    if (isMet || m1) {
      const start = adtStart || addDays(diag, 14);
      add(id, diag, cap, 'adt', '戈舍瑞林', start, null, '转移性前列腺癌基础 ADT');
      const arpiStart = addDays(start, 14);
      add(id, diag, cap, 'endocrine', '比卡鲁胺', start, addDays(arpiStart, -1), 'LHRH 激动剂起始防 flare');
      add(id, diag, cap, 'arpi', '阿比特龙+泼尼松', arpiStart, null, 'mHSPC/mCRPC 强化');
      const chemoStart = addMonths(arpiStart, 9);
      if (chemoStart <= lastSeen) {
        add(id, diag, cap, 'chemo', '多西他赛+泼尼松', chemoStart, addDays(chemoStart, 150), 'mHSPC 化疗，6 周期');
        if (isMet) add(id, diag, cap, 'chemo', '卡巴他赛+泼尼松', addDays(chemoStart, 180), addDays(chemoStart, 300), '多西他赛后二线化疗');
      }
      add(id, diag, cap, 'bone', '唑来膦酸', addDays(start, 30), null, '骨转移/骨风险支持');
    } else if (isBCR) {
      const start = bcrDate || addDays(surg || diag, 30);
      const adtDrug = ADT_DRUGS[idx % ADT_DRUGS.length];
      add(id, diag, cap, 'adt', adtDrug, start, null, '术后生化复发，挽救性 ADT');
      const arpiStart = addDays(start, 30);
      if (adtDrug !== '地加瑞克') {
        add(id, diag, cap, 'endocrine', '比卡鲁胺', start, addDays(arpiStart, -1), 'LHRH 激动剂起始防 flare');
      }
      const arpi = ARPI_DRUGS[idx % ARPI_DRUGS.length];
      add(id, diag, cap, 'arpi', arpi, arpiStart, null, '术后 BCR 强化治疗');
      if (id === 'PC-104' || id === 'PC-214') {
        add(id, diag, cap, 'bone', '唑来膦酸', addDays(start, 45), null, 'N1/骨风险支持');
      }
    } else if (n1) {
      const start = addDays(surg || diag, 30);
      add(id, diag, cap, 'adt', '戈舍瑞林', start, addMonths(start, 24), 'N1 术后辅助 ADT');
      add(id, diag, cap, 'arpi', '阿比特龙+泼尼松', addDays(start, 14), addMonths(start, 24), 'N1 高危强化');
      add(id, diag, cap, 'bone', '唑来膦酸', addDays(start, 30), addMonths(start, 24), '骨风险支持');
    }
    continue;
  }

  /* ---------- 放疗：根据风险给 ADT，BCR/转移再加 ARPI/化疗 ---------- */
  if (isRT) {
    const lowRT = ['PC-119', 'PC-122', 'PC-124'].includes(id);
    if (!lowRT && rtStart) {
      const start = addDays(rtStart, -21);
      const adtDrug = ADT_DRUGS[idx % ADT_DRUGS.length];
      const months = highRisk ? 24 : 6;
      const adtEnd = m1 ? null : addMonths(start, months);
      add(id, diag, cap, 'adt', adtDrug, start, adtEnd, '放疗同期/辅助 ADT');
      const arpiNeeded = m1 || isBCR || n1;
      const arpiStart = isBCR && bcrDate ? bcrDate : addDays(start, 21);
      if (adtDrug !== '地加瑞克') {
        add(id, diag, cap, 'endocrine', '比卡鲁胺', start,
          arpiNeeded ? addDays(arpiStart, -1) : addDays(start, 30), 'LHRH 激动剂起始防 flare');
      }
      if (arpiNeeded) {
        add(id, diag, cap, 'arpi', ARPI_DRUGS[idx % ARPI_DRUGS.length], arpiStart, null, m1 ? 'mHSPC 强化' : '复发/区域强化');
      }
      if (m1) {
        const chemoStart = addMonths(start, 6);
        add(id, diag, cap, 'chemo', '多西他赛+泼尼松', chemoStart, addDays(chemoStart, 150), 'mHSPC 化疗，6 周期');
        if (isMet) add(id, diag, cap, 'chemo', '卡巴他赛+泼尼松', addDays(chemoStart, 180), addDays(chemoStart, 300), '多西他赛后二线化疗');
        add(id, diag, cap, 'bone', idx % 2 ? '地舒单抗' : '唑来膦酸', addDays(start, 30), null, '骨转移支持');
      }
    }
    continue;
  }

  /* ---------- 观察等待/主动监测：BCR/转移才加系统治疗 ---------- */
  if (isObs) {
    if (isBCR) {
      const start = bcrDate || addDays(diag, 180);
      add(id, diag, cap, 'adt', '戈舍瑞林', start, null, '观察等待中生化复发，启动 ADT');
      const arpiStart = addDays(start, 30);
      add(id, diag, cap, 'endocrine', '比卡鲁胺', start, addDays(arpiStart, -1), '起始防 flare');
      add(id, diag, cap, 'arpi', '阿帕他胺', arpiStart, null, 'BCR 强化');
    } else if (isMet || id === 'PC-137') {
      const start = addDays(diag, 30);
      add(id, diag, cap, 'adt', '亮丙瑞林', start, null, '转移性前列腺癌 ADT');
      add(id, diag, cap, 'arpi', '阿比特龙+泼尼松', addDays(start, 14), null, 'mHSPC 强化');
      add(id, diag, cap, 'chemo', '多西他赛+泼尼松', addMonths(start, 9), addMonths(start, 14), 'mHSPC 化疗，6 周期');
      add(id, diag, cap, 'bone', '唑来膦酸', addDays(start, 30), null, '骨转移支持');
    } else if (id === 'PC-139') {
      add(id, diag, cap, 'other', '镇痛药', '2021-01-01', null, '晚期姑息镇痛');
    }
  }
}

/* 用药逻辑校验：同一大类严格重叠即报错；内分泌与 ARPI 用闭区间，同一天也不允许。
   校验在写入前执行，避免把不合规的演示数据灌进库。 */
{
  const FAR = '9999-12-31';
  const byPatient = new Map();
  rows.forEach(r => {
    if (!byPatient.has(r.patient_id)) byPatient.set(r.patient_id, []);
    byPatient.get(r.patient_id).push(r);
  });
  const conflicts = [];
  byPatient.forEach((list, pid) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const ae = a.end_date || FAR, be = b.end_date || FAR;
        if (a.category === b.category && a.start_date <= be && b.start_date <= ae) {
          conflicts.push(pid + ' 同大类重叠：' + a.drug_name + '/' + b.drug_name);
        }
        const cross = (a.category === 'endocrine' && b.category === 'arpi') ||
          (a.category === 'arpi' && b.category === 'endocrine');
        if (cross && a.start_date <= be && b.start_date <= ae) {
          conflicts.push(pid + ' 内分泌与ARPI同期：' + a.drug_name + '/' + b.drug_name);
        }
      }
    }
  });
  if (conflicts.length) {
    console.error('用药逻辑校验失败：\n' + conflicts.slice(0, 30).join('\n'));
    process.exit(1);
  }
  console.log('用药逻辑校验通过：同一大类无重叠，内分泌与 ARPI 无同期。');
}

/* 写入 */
const ins = db.prepare(`INSERT INTO medication_records
  (patient_id,category,drug_name,start_date,end_date,notes,created_by,created_at)
  VALUES(@patient_id,@category,@drug_name,@start_date,@end_date,@notes,@created_by,@created_at)`);
const tx = db.transaction(list => list.forEach(r => ins.run(r)));
tx(rows);

const byCat = db.prepare('SELECT category, COUNT(*) n FROM medication_records GROUP BY category ORDER BY n DESC').all();
const byPatient = db.prepare(`SELECT patient_id, COUNT(*) n,
  SUM(CASE WHEN end_date IS NULL OR end_date>=? THEN 1 ELSE 0 END) active
  FROM medication_records GROUP BY patient_id`).all(today);
console.log('已写入 ' + rows.length + ' 条用药记录，覆盖 ' + byPatient.length + '/' + patients.length + ' 位患者');
console.log('分类：' + byCat.map(x => x.category + '=' + x.n).join('，'));
console.log('用药条数最多：' + byPatient.slice().sort((a, b) => b.n - a.n).slice(0, 6).map(x => x.patient_id + '(' + x.n + ')').join('，'));
console.log('当前在用患者数：' + byPatient.filter(x => x.active > 0).length);

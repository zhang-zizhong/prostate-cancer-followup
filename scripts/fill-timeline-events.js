#!/usr/bin/env node
/* ============================================================================
   为演示患者填充「诊疗时间轴」事件
   ----------------------------------------------------------------------------
   用途：功能改完后，给库里每位患者按临床路径生成一批诊疗事件，
         用来验证时间轴的展示、滚动、编辑是否正常。

   特点：
     · 直连 SQLite（不走 API）——四百多次 HTTP 请求慢且中途失败难收拾。
     · 幂等可重复：每次先清空 timeline_events 再按同一套规则重建，结果确定。
     · 不生成、不挂载任何图片，timeline_images 保持空表。
     · 随机抖动用「患者 id 的哈希」做种子，不是真随机，所以每次跑结果一致、可复核。

   ⚠️ 运行前必须停掉服务：服务在跑时写库可能撞 SQLITE_BUSY，也会与请求互相干扰。
      脚本会主动探测端口，占用即拒绝执行。

   用法：
     node scripts/fill-timeline-events.js          # 交互确认后执行
     node scripts/fill-timeline-events.js --yes    # 跳过确认（CI / 重复运行）
   ============================================================================ */
import path from 'path';
import fs from 'fs';
import net from 'net';
import readline from 'readline';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'clinical.db');

/* ---- 事件名称常量 ----
   必须与 public/index.html 里 EVENT_PRESETS 的字符串逐字一致，
   否则前端 eventCat() 认不出类别，节点会全部落到中性灰的 other。 */
const EV = {
  PSA0:     'PSA检测',
  DRE:      '直肠指检(DRE)',
  MRI:      '多参数磁共振(mpMRI)',
  BIOPSY:   '前列腺穿刺活检',
  BIPATH:   '穿刺病理报告',
  PSMA:     'PSMA PET-CT',
  STAGE:    '临床分期评估',
  MDT:      'MDT多学科会诊',
  RP:       '根治性前列腺切除术(RP)',
  EBRT:     '外照射放疗(EBRT)',
  ADT:      'ADT启动',
  NHA:      '新型内分泌治疗',
  TESTO:    '睾酮检测',
  AS:       '主动监测',
  SPPATH:   '手术病理报告',
  PSAFU:    'PSA复查',
  BCR:      '生化复发确认',
  IMGFU:    '影像学复查',
  METATX:   '转移灶局部治疗',
  DEATH:    '终止随访/死亡'
};

/* ---- 小工具 ---- */

/* FNV-1a 字符串哈希：把患者 id 变成稳定的整数种子 */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/* mulberry32：轻量确定性 PRNG，同一种子每次产出同一串随机数 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* 日期加天数，纯 UTC 计算避免跨时区偏一天 */
function dateAdd(d, n) {
  const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(t)) return null;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
/* "4+4=8" / "3+4=7" → 8 / 7；取等号后的总分，取不到就用主+次 */
function gleasonTotal(g) {
  const m = String(g || '').match(/=\s*(\d+)/);
  if (m) return +m[1];
  const m2 = String(g || '').match(/(\d)\s*\+\s*(\d)/);
  if (m2) return (+m2[1]) + (+m2[2]);
  return 0;
}
/* 高危：局部进展(T3/T4)、淋巴结阳性(N1/N2)、远处转移(M1) 或 Gleason≥8 */
function isHighRisk(stage, g) {
  const s = String(stage || '');
  return /T3|T4/.test(s) || /N1|N2/.test(s) || /M1/.test(s) || gleasonTotal(g) >= 8;
}

/* ---- 为单个患者生成事件列表 ----
   以诊断日期 D 为锚点。诊断链排在 D 之前（临床上 DRE/MRI/穿刺本就发生在确诊前），
   既符合病程，也绕开了演示数据里「诊断→手术最小仅 28 天」的紧间隔。
   seq 用于同一天的事件排序：渲染按 (event_date, id)，而 id 按插入顺序递增，
   所以先按 (date, seq) 排好再插入，同日事件的先后就等于临床先后。 */
function buildEvents(p, psa, rng) {
  const ev = [];
  const add = (date, type, o) => {
    if (!date) return;
    ev.push(Object.assign({ date: String(date).slice(0, 10), type: type, gleason: '', stage: '', isSurgery: 0, seq: 10 }, o || {}));
  };
  const j = n => Math.floor(rng() * n);   // 0..n-1 的确定性抖动

  const D = String(p.diag_date || (psa[0] && psa[0].rec_date) || p.surg_date || '').slice(0, 10);
  if (!D) return ev;

  const high = isHighRisk(p.stage, p.gleason);
  const cT = p.stage ? 'c' + p.stage : '';   // 临床分期
  const pT = p.stage ? 'p' + p.stage : '';   // 病理分期（术后标本）

  /* 诊断链（D 之前） */
  add(dateAdd(D, -(48 + j(5))), EV.DRE);
  add(dateAdd(D, -(38 + j(5))), EV.MRI);
  add(dateAdd(D, -(13 + j(4))), EV.BIOPSY);
  if (high) add(dateAdd(D, -(6 + j(3))), EV.PSMA);

  /* 确诊当天：初始 PSA + 穿刺病理报告。
     初始 PSA 的日期直接取 psa_records 里 is_initial 那条（演示数据中它恰好等于 D），
     不另造日期，保证时间轴与 PSA 曲线严格对齐。seq=5 让它排在同日病理报告之前。
     psaRecordId 一并带上：PSA 镜像事件靠它认出自己的源记录，
     不带的话删掉那条 PSA 记录时事件就成了孤儿，只能靠启动迁移事后补救。 */
  const initPsa = psa.find(r => r.is_initial === 1) || psa[0];
  if (initPsa) add(initPsa.rec_date, EV.PSA0, { seq: 5, psaRecordId: initPsa.id });
  add(D, EV.BIPATH, { gleason: p.gleason || '', stage: cT, seq: 20 });
  add(dateAdd(D, 7 + j(3)), EV.STAGE, { stage: cT });
  if (high) add(dateAdd(D, 10 + j(4)), EV.MDT);

  /* 治疗分支：优先看 surg_date（做过手术就有日期），否则按首选治疗 */
  const treat = p.treatment || '';
  if (p.surg_date) {
    const sd = String(p.surg_date).slice(0, 10);
    add(sd, EV.RP, { isSurgery: 1, stage: pT });              // 日期精确=surg_date，sync 后不变
    add(dateAdd(sd, 10 + j(5)), EV.SPPATH, { gleason: p.gleason || '', stage: pT });
  } else if (treat.includes('放疗')) {
    const r0 = dateAdd(D, 7 + j(4));
    add(r0, EV.EBRT);
    add(dateAdd(r0, 30 + j(6)), EV.EBRT);
    add(dateAdd(r0, 60 + j(9)), EV.EBRT);
  } else if (treat.includes('内分泌')) {
    const a0 = dateAdd(D, 7 + j(5));
    add(a0, EV.ADT);
    add(dateAdd(a0, 28 + j(6)), EV.TESTO);                    // ADT 期间监测睾酮
    add(dateAdd(a0, 88 + j(12)), EV.NHA);
  } else if (treat.includes('手术')) {
    /* 矛盾数据：首选治疗是手术却没有手术日期。演示数据中不存在，
       兜底生成一条 RP（会由 sync 反推出手术日期），避免这类患者时间轴缺治疗环节。 */
    const sd = dateAdd(D, 60);
    add(sd, EV.RP, { isSurgery: 1, stage: pT });
    add(dateAdd(sd, 10 + j(5)), EV.SPPATH, { gleason: p.gleason || '', stage: pT });
  } else {
    add(dateAdd(D, 7 + j(5)), EV.AS);                         // 观察等待 → 主动监测
  }

  /* 随访：每条非初始 PSA 记录都对应一个复查事件，日期与该记录对齐。
     带上 psaRecordId 建立镜像绑定；下面的「生化复发确认」虽然常落在同一天，
     但它是独立的临床判断事件、不是某条 PSA 记录的投影，故不带绑定。 */
  psa.filter(r => r.is_initial !== 1).forEach(r => add(r.rec_date, EV.PSAFU, { seq: 10, psaRecordId: r.id }));

  /* 按状态收尾 */
  const dates = psa.map(r => String(r.rec_date).slice(0, 10)).sort();
  const lastPsa = dates[dates.length - 1] || D;
  if (p.status === '生化复发') {
    const rec = psa.find(r => r.is_initial !== 1 && r.value >= 0.2);
    add(rec ? rec.rec_date : lastPsa, EV.BCR, { seq: 30 });
  } else if (p.status === '转移') {
    add(lastPsa, EV.IMGFU, { seq: 30 });
    add(dateAdd(lastPsa, 18 + j(8)), EV.METATX);
  }
  if (p.status === '死亡') {
    /* 终止事件必须是全时间轴最后一条：取现有事件最大日期再往后推 */
    let mx = lastPsa;
    ev.forEach(e => { if (e.date > mx) mx = e.date; });
    add(dateAdd(mx, 45 + j(10)), EV.DEATH, { seq: 99 });
  }

  return ev;
}

/* ---- 端口占用探测：服务在跑就拒绝执行 ---- */
function portBusy(port) {
  return new Promise(resolve => {
    const s = new net.Socket();
    let done = false;
    const fin = v => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(800);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, '127.0.0.1');
  });
}
function readPort() {
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch (e) { /* .env 不存在则用默认 */ }
  return parseInt(process.env.PORT, 10) || 3000;
}
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}

/* ---- 主流程 ---- */
async function main() {
  const port = readPort();
  if (await portBusy(port)) {
    console.error('❌ 检测到服务正在端口 ' + port + ' 运行。');
    console.error('   请先停止服务（kill 占用进程）再运行本脚本，否则可能与写库冲突（SQLITE_BUSY）。');
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ 数据库不存在：' + DB_PATH);
    console.error('   请先 npm start 建库并导入演示数据，或运行 scripts/reset-local-data.sh。');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  /* 表不存在说明代码还没升级到含时间轴的版本 */
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='timeline_events'").get();
  if (!hasTable) {
    console.error('❌ 数据库里还没有 timeline_events 表，请先启动一次服务完成建表迁移。');
    process.exit(1);
  }

  const existing = db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get().n;
  const patientCount = db.prepare('SELECT COUNT(*) AS n FROM patients').get().n;
  console.log('数据库：' + DB_PATH);
  console.log('现有患者：' + patientCount + ' 位　现有事件：' + existing + ' 条');
  if (!process.argv.includes('--yes')) {
    const a = await ask('\n将【清空】现有 ' + existing + ' 条事件，并为 ' + patientCount + ' 位患者重建诊疗时间轴。\n此操作会删除医生手工添加的事件，且不可撤销。继续？[y/N] ');
    if (!/^y(es)?$/i.test(a.trim())) { console.log('已取消。'); db.close(); process.exit(0); }
  }

  const patients = db.prepare('SELECT * FROM patients ORDER BY id').all();
  /* 必须带出 id：PSA 镜像事件要靠它写入 psa_record_id 绑定 */
  const psaStmt = db.prepare('SELECT id, rec_date, value, is_initial FROM psa_records WHERE patient_id=? ORDER BY rec_date, id');

  let total = 0, droppedByBirth = 0;
  const perPatient = [];
  const typeCount = {};

  /* 整个重建放在一个事务里：任何断言失败都 throw，事务回滚，数据库保持原样 */
  db.transaction(() => {
    db.prepare('DELETE FROM timeline_events').run();   // 级联删 timeline_images（本就为空）
    const ins = db.prepare(`INSERT INTO timeline_events(patient_id,event_date,event_type,gleason,stage,is_surgery,psa_record_id,created_by)
                            VALUES(?,?,?,?,?,?,?,?)`);
    for (const p of patients) {
      const psa = psaStmt.all(p.id);
      const rng = mulberry32(hashStr(p.id));
      let ev = buildEvents(p, psa, rng);
      /* 断言：任何事件都不得早于出生日期。诊断链最早约 D-52，而 D-birth 通常是几十年，
         正常不会触发；这里过滤只是防御异常数据，被丢弃的会计数并告警。 */
      const before = ev.length;
      ev = ev.filter(e => !p.birth_date || e.date > String(p.birth_date).slice(0, 10));
      droppedByBirth += (before - ev.length);
      /* 按 (date, seq) 排序后依次插入，使 id 递增顺序 == 临床先后顺序。
         psa_record_id：非 PSA 事件没有该字段（undefined），必须落成 null——
         better-sqlite3 不接受 undefined 绑定，会直接抛错。 */
      ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
      ev.forEach(e => ins.run(p.id, e.date, e.type, e.gleason, e.stage, e.isSurgery,
        e.psaRecordId !== undefined ? e.psaRecordId : null, p.created_by));
      ev.forEach(e => { typeCount[e.type] = (typeCount[e.type] || 0) + 1; });
      total += ev.length;
      perPatient.push([p.id, p.status, ev.length]);
    }

    /* 与后端 syncSurgDate 同款：用手术事件反推 surg_date，验证两者一致 */
    db.prepare(`UPDATE patients SET surg_date=(
                  SELECT MIN(event_date) FROM timeline_events
                   WHERE patient_id=patients.id AND is_surgery=1)`).run();

    /* ---- 事务内断言，失败即回滚 ---- */
    const badBirth = db.prepare(`SELECT COUNT(*) AS n FROM timeline_events e JOIN patients p ON p.id=e.patient_id
                                 WHERE p.birth_date IS NOT NULL AND e.event_date <= p.birth_date`).get().n;
    if (badBirth) throw new Error('有 ' + badBirth + ' 条事件日期 <= 出生日期');

    const surgMismatch = db.prepare(`SELECT COUNT(*) AS n FROM patients p
        WHERE p.surg_date IS NOT NULL
          AND p.surg_date <> (SELECT MIN(event_date) FROM timeline_events WHERE patient_id=p.id AND is_surgery=1)`).get().n;
    if (surgMismatch) throw new Error('有 ' + surgMismatch + ' 位患者的 surg_date 与手术事件不一致');

    const orphan = db.prepare(`SELECT COUNT(*) AS n FROM timeline_events
        WHERE patient_id NOT IN (SELECT id FROM patients)`).get().n;
    if (orphan) throw new Error('有 ' + orphan + ' 条事件挂在不存在的患者上');
  })();

  /* ---- 结果报告 ---- */
  const surg = db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE is_surgery=1').get().n;
  const noEvent = db.prepare(`SELECT COUNT(*) AS n FROM patients
      WHERE id NOT IN (SELECT DISTINCT patient_id FROM timeline_events)`).get().n;
  const counts = perPatient.map(x => x[2]);
  const minC = Math.min(...counts), maxC = Math.max(...counts);

  console.log('\n✅ 填充完成（事务已提交）');
  console.log('  事件总数：' + total + '　每位患者：' + minC + '~' + maxC + ' 条（均值 ' + (total / patientCount).toFixed(1) + '）');
  console.log('  无事件的患者：' + noEvent + '（应为 0）');
  console.log('  手术事件(is_surgery=1)：' + surg);
  console.log('  因早于出生日期被丢弃：' + droppedByBirth + '（应为 0）');
  console.log('  timeline_images：' + db.prepare('SELECT COUNT(*) AS n FROM timeline_images').get().n + '（本脚本不生成图片，应为 0）');
  console.log('\n  按类型统计：');
  Object.keys(typeCount).sort((a, b) => typeCount[b] - typeCount[a])
    .forEach(t => console.log('    ' + String(typeCount[t]).padStart(4) + '  ' + t));
  console.log('\n  前若干位患者的事件数：');
  perPatient.slice(0, 8).forEach(([id, st, n]) => console.log('    ' + id + '（' + st + '）：' + n + ' 条'));

  db.close();
}

main().catch(e => { console.error('\n❌ 失败，已回滚：' + e.message); process.exit(1); });

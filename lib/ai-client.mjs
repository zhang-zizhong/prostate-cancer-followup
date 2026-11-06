/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * AI 病历登记 — 阿里云百炼模型调用层
 *
 * ★★★ API Key 配置位置（用户需要填的唯一地方）★★★
 *   在项目根目录 .env 文件中加入以下 5 行：
 *
 *     DASHSCOPE_API_KEY=sk-你的密钥
 *     DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
 *     AI_MODEL_EXTRACT=qwen3-vl-flash
 *     AI_MODEL_REDACT=qwen-turbo
 *     AI_INTAKE_ENABLED=true
 *
 *   不配置 DASHSCOPE_API_KEY 时，本模块进入「离线演练模式」：
 *   不调用任何网络接口，返回一份结构合法的示例结果，
 *   用于本地验证前后端链路、审核界面与入库逻辑是否正常。
 *   离线模式产出的数据在 sessions 表中标记 model_used='offline-mock'，
 *   审核界面也会显著提示，避免被误当成真实抽取结果采纳。
 *
 * 模型选型依据见 docs 同级目录的《前列腺随访网站AI登记功能技术文档》：
 *   默认 qwen3-vl-flash（原生支持 JSON Schema 结构化输出，单份约 0.004 元）
 *   兜底 qwen3.5-ocr（长文档 / PDF，支持 table_parser）
 *   脱敏 qwen-turbo（纯文本，输入 0.3 元/百万 tokens）
 * ========================================================= */

import fs from 'fs';
import path from 'path';

/* 三个模型角色，分别可在 .env 覆盖 */
export const ROLE_EXTRACT = 'extract';
export const ROLE_REDACT = 'redact';

const DEFAULTS = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: {
    extract: process.env.AI_MODEL_EXTRACT || 'qwen3-vl-flash',
    redact: process.env.AI_MODEL_REDACT || 'qwen-turbo'
  }
};

/* 单次调用超时：三段式流水线每段独立计时，不做整体 120s 限制，
   避免与 Nginx proxy_read_timeout 120s 撞车（本模块由后台任务调用，
   不占用 HTTP 请求生命周期，因此不受反代超时影响）。 */
const CALL_TIMEOUT_MS = Number(process.env.AI_CALL_TIMEOUT_MS || 120000);

/* 重试策略：429/5xx/超时退避重试 2 次（1s / 4s），与既有评测方案一致。
   400/401/403 不重试——那是配置或权限问题，重试只会浪费时间与配额。 */
const RETRY_DELAYS_MS = [1000, 4000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function aiConfigured() {
  return !!(process.env.DASHSCOPE_API_KEY || '').trim();
}

export function aiEnabled() {
  /* 默认开启；显式设为 false/0 才关闭。关闭后接口返回 503，
     前端提示"AI 功能未启用"，不影响常规录入。 */
  const v = String(process.env.AI_INTAKE_ENABLED || 'true').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no');
}

export function aiStatus() {
  return {
    enabled: aiEnabled(),
    configured: aiConfigured(),
    offline: !aiConfigured(),
    baseUrl: process.env.DASHSCOPE_BASE_URL || DEFAULTS.baseUrl,
    models: { ...DEFAULTS.models },
    promptBudget: { maxImages: MAX_IMAGES_PER_CALL }
  };
}

/* 单请求图片上限：既有评测方案规定"单请求最多 8 张图；超过就分批" */
const MAX_IMAGES_PER_CALL = Number(process.env.AI_MAX_IMAGES_PER_CALL || 8);
export { MAX_IMAGES_PER_CALL };

/* ------------------------------------------------------------------ */
/* 图片编码                                                            */
/* ------------------------------------------------------------------ */

/**
 * 读文件转 data URL。
 *
 * ⚠ 内存提示：readFileSync + base64 会让内存占用膨胀到文件的 4/3 倍，
 *   JSON.stringify 进请求体时再复制一份。PM2 配置 max_memory_restart=300M，
 *   因此上传环节必须先把图片压到长边 2000px（前端 Canvas 完成），
 *   否则并发几个医生上传原图就会触发进程重启、连带杀掉正在跑的任务。
 */
export function fileToDataUrl(filePath, mime) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime || 'image/jpeg'};base64,${b64}`;
}

/** 估算图片 token：h×w/(32×32)+2（官方公式）。用于成本告警。 */
export function estimateImageTokens(width, height) {
  if (!width || !height) return 0;
  return Math.round((width * height) / (32 * 32)) + 2;
}

/* ------------------------------------------------------------------ */
/* JSON 解析容错                                                       */
/* ------------------------------------------------------------------ */

/**
 * 从模型输出中提取 JSON。
 *
 * 三类常见脏输出都要能救回来：
 *   1) 带 ```json 围栏（OCR 专用模型不支持 response_format，必然出现）
 *   2) JSON 前后有解释文字
 *   3) 尾部截断（finish_reason=length）——这类只能标记，不能瞎补
 *
 * @returns {{ok:true, data:any, repaired:string[]}|{ok:false, error:string, errorClass:string, raw:string}}
 */
export function parseModelJson(raw) {
  const repaired = [];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '模型返回空内容', errorClass: 'empty', raw: String(raw || '') };
  }

  let s = raw.trim();

  /* 1. 去 Markdown 围栏 */
  const fence = s.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (fence) { s = fence[1].trim(); repaired.push('fence_removed'); }
  else if (s.startsWith('```')) {
    s = s.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim();
    repaired.push('fence_removed');
  }

  /* 2. 直接解析 */
  try { return { ok: true, data: JSON.parse(s), repaired }; } catch (e) { /* 继续尝试 */ }

  /* 3. 截取第一个 { 到最后一个 } —— 处理 JSON 前后夹带解释文字 */
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = s.slice(first, last + 1);
    try {
      const data = JSON.parse(slice);
      repaired.push('extracted_object');
      return { ok: true, data, repaired };
    } catch (e) { /* 继续 */ }

    /* 4. 尾部截断：尝试补齐缺失的括号。
       这是最后的挣扎，只补结构不编内容；补出来的对象可能缺 items，
       由上层 Schema 校验兜住。标记 truncated_repaired 以便统计。 */
    const fixed = repairTruncatedJson(slice);
    if (fixed) {
      try {
        const data = JSON.parse(fixed);
        repaired.push('truncated_repaired');
        return { ok: true, data, repaired };
      } catch (e) { /* 放弃 */ }
    }
  }

  return {
    ok: false,
    error: 'JSON 解析失败',
    errorClass: 'parse_error',
    raw: s.slice(0, 2000)
  };
}

/** 补齐截断 JSON 的引号与括号。只补结构，不虚构内容。 */
function repairTruncatedJson(s) {
  let out = '';
  let inStr = false, esc = false;
  const stack = [];
  for (const ch of s) {
    out += ch;
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) out += '"';
  /* 去掉悬挂的逗号/冒号，否则补了括号也解析不过 */
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, ':null');
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out !== s ? out : null;
}

/* ------------------------------------------------------------------ */
/* HTTP 调用                                                           */
/* ------------------------------------------------------------------ */

/**
 * 调用 OpenAI 兼容的 chat/completions 端点。
 *
 * @param {object} opt
 * @param {'extract'|'redact'} opt.role
 * @param {Array} opt.messages     OpenAI 格式消息数组
 * @param {boolean} [opt.jsonSchema] 是否要求 JSON Schema 结构化输出
 * @param {object} [opt.schema]     结构化输出的 schema
 * @returns {Promise<{content:string, usage:object, model:string, finishReason:string, latencyMs:number, retried:number}>}
 */
export async function chatCompletion(opt) {
  const apiKey = (process.env.DASHSCOPE_API_KEY || '').trim();
  if (!apiKey) {
    const e = new Error('未配置 DASHSCOPE_API_KEY，无法调用模型');
    e.errorClass = 'not_configured';
    throw e;
  }
  const baseUrl = (process.env.DASHSCOPE_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const model = DEFAULTS.models[opt.role] || DEFAULTS.models.extract;

  const body = {
    model,
    messages: opt.messages,
    temperature: 0,            /* 抽取任务必须确定性输出 */
    max_tokens: Number(process.env.AI_MAX_TOKENS || 32768),
    enable_thinking: false,    /* 显式关闭思考，否则输出 token 与延迟都会暴涨 */
    stream: false
  };
  /* 结构化输出：qwen3-vl-flash / qwen3.8-flash 等通用视觉模型支持；
     OCR 专用模型（qwen-vl-ocr、qwen3.5-ocr）不支持此开关，
     传了会报 400，因此由调用方按模型能力决定是否传。 */
  if (opt.jsonSchema) {
    body.response_format = { type: 'json_object' };
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const text = await res.text();
      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { msg = JSON.parse(text).error?.message || msg; } catch (e) { /* 保留状态码 */ }
        const e = new Error(msg);
        e.status = res.status;
        /* 400 参数错、401/403 鉴权或额度问题：不重试 */
        e.errorClass = res.status === 429 ? 'rate_limited'
          : res.status >= 500 ? 'server_error'
          : res.status === 403 ? 'forbidden_or_quota'
          : 'bad_request';
        e.retryable = res.status === 429 || res.status >= 500;
        lastErr = e;
        if (!e.retryable) throw e;
        continue;
      }

      const data = JSON.parse(text);
      const choice = data.choices?.[0];
      return {
        content: choice?.message?.content || '',
        usage: data.usage || {},
        model: data.model || model,
        finishReason: choice?.finish_reason || '',
        latencyMs,
        retried: attempt
      };
    } catch (err) {
      const e = err;
      e.errorClass = e.errorClass || (e.name === 'AbortError' ? 'timeout' : 'network_error');
      e.retryable = e.retryable !== undefined ? e.retryable : true;
      lastErr = e;
      if (!e.retryable) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('模型调用失败');
}

/* ------------------------------------------------------------------ */
/* 离线演练模式                                                        */
/* ------------------------------------------------------------------ */

/**
 * 未配置 API Key 时返回的示例结果。
 *
 * 用途：本地验证「上传 → 任务流转 → 审核界面 → 采纳入库」全链路，
 *      不产生任何网络请求与费用。
 * 安全：结果固定标注 mock=true，sessions.model_used 记为 offline-mock，
 *      审核界面顶部显示醒目横幅，避免演练数据被误采纳进真实病历。
 *
 * 内容刻意覆盖各类型的边界情形：belowLod 的 PSA、nmol/L 单位的睾酮、
 * null 值的三态字段、联合用药拆分、自造事件类型进 warnings。
 */
export function offlineMockResult(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const name = ctx?.patientName || '演示患者';
  return {
    documentType: 'mixed',
    patientNameInDocument: name,
    mock: true,
    items: [
      { kind: 'profile', field: 'name', value: name, evidence: '【离线演练】姓名：' + name, page: 1 },
      { kind: 'profile', field: 'date', value: '2024-03-15', evidence: '【离线演练】确诊日期 2024-03-15', page: 1 },
      { kind: 'profile', field: 'gleason', value: '4+3=7', evidence: '【离线演练】Gleason 4+3=7，ISUP 3 级', page: 1 },
      { kind: 'profile', field: 'clinicalStage', value: 'cT3aN0M0', evidence: '【离线演练】临床分期 cT3aN0M0', page: 1 },
      { kind: 'profile', field: 'castration', value: null, evidence: '【离线演练】材料未提及去势状态，按规则输出 null', page: 1 },
      {
        kind: 'psa',
        payload: { date: '2024-03-10', value: 18.6, belowLod: false, lod: null },
        evidence: '【离线演练】2024-03-10 血清 PSA 18.60 ng/mL', page: 1
      },
      {
        kind: 'psa',
        payload: { date: '2025-09-01', value: 0.03, belowLod: true, lod: 0.03 },
        evidence: '【离线演练】2025-09-01 PSA <0.03 ng/mL', page: 2
      },
      {
        kind: 'testosterone',
        payload: { date: '2025-09-01', value: 0.62, unit: 'nmol/L', assayMethod: 'CLIA', lab: '', sampleTime: '08:30' },
        evidence: '【离线演练】睾酮 0.62 nmol/L（CLIA 法）', page: 2
      },
      {
        kind: 'lab',
        payload: { date: '2025-09-01', itemCode: 'CREAT', item: '肌酐', value: 89.3, unit: 'μmol/L', note: '参考范围 57-97' },
        evidence: '【离线演练】肌酐 89.3 μmol/L ↑', page: 2
      },
      {
        kind: 'clinical',
        payload: { date: '2025-09-01', category: 'bone', item: 'DEXA_T', value: -2.1, unit: 'T', status: '已完成', note: '' },
        evidence: '【离线演练】骨密度 T 值 -2.1', page: 2
      },
      {
        kind: 'medication',
        payload: { drug: '戈舍瑞林', category: 'adt', startDate: '2024-04-01', endDate: null, dose: '3.6mg', schedule: 'q4w', notes: '' },
        evidence: '【离线演练】戈舍瑞林 3.6mg 皮下注射 q4w，2024-04-01 起', page: 1
      },
      {
        kind: 'medication',
        payload: { drug: '比卡鲁胺', category: 'endocrine', startDate: '2024-04-01', endDate: '2024-06-30', dose: '50mg', schedule: 'qd', notes: '联合用药已拆分' },
        evidence: '【离线演练】ADT+比卡鲁胺 50mg qd 联合方案', page: 1
      },
      {
        kind: 'profile', field: 'treatment', value: '根治性手术',
        evidence: '【离线演练】2024-05-06 根治性前列腺切除术', page: 1
      },
      {
        kind: 'pathology',
        payload: { specimenType: 'biopsy', reportDate: '2024-03-20', coresTotal: 12, coresPositive: 5,
          gleasonPrimary: 4, gleasonSecondary: 3, ptnm: '', marginStatus: 'unknown', marginSite: '',
          ece: null, svi: null, lnPositive: null, lnExamined: null, idcP: null, cribriform: null,
          dac: null, pni: null, nepc: null, nepcDetail: '', tumorVolumePct: null,
          tumorCellPct: null, isPrimary: true, notes: '' },
        evidence: '【离线演练】2024-03-20 前列腺穿刺 12 针 5 阳，Gleason 4+3=7', page: 1
      },
      {
        kind: 'pathology',
        payload: { specimenType: 'RP', reportDate: '2024-05-06', gleasonPrimary: 4, gleasonSecondary: 3,
          ptnm: 'pT3aN0M0', marginStatus: 'positive', ece: true, svi: false, pni: true,
          lnPositive: 0, lnExamined: 8, isPrimary: true, notes: '' },
        evidence: '【离线演练】术后病理 pT3aN0M0，切缘阳性，ECE+，SVI-，LN 0/8', page: 1
      },
      {
        kind: 'imaging',
        payload: { modality: 'PSMA_PET', studyDate: '2025-09-01', region: '全身', lesionCount: 2,
          metastaticSites: ['bone'], extraPelvic: false, psmaPositive: true, psmaLesionCount: 2,
          psmaSuvmax: 5.2, recist: '', pcwg: '', oligoStatus: 'oligo', isCurrent: true, notes: '' },
        evidence: '【离线演练】PSMA PET 示 2 处骨转移，均位于盆腔/脊柱内', page: 2
      },
      {
        kind: 'radiation',
        payload: { rtType: 'EBRT', startDate: '2024-06-01', endDate: '2024-07-15', doseGy: 66,
          fractions: 33, target: 'prostate', concurrentAdt: true, adtDurationMonths: 6,
          technique: '', toxicityGrade: '', isCurrent: true, notes: '' },
        evidence: '【离线演练】2024-06-01 至 2024-07-15 外照射 66Gy/33f', page: 1
      },
      {
        kind: 'outcome',
        payload: { outcomeType: 'metastasis', eventDate: '2025-09-10', subtype: '', basis: 'imaging',
          psaValue: null, imagingNegative: null, metastaticSites: ['bone'], lesionCount: 2,
          oligoStatus: 'oligo', deathCause: '', lostReason: '', lastContactDate: null, note: '骨转移' },
        evidence: '【离线演练】2025-09-10 转移确认', page: 2
      },
      {
        kind: 'treatment_line',
        payload: { lineNo: 1, setting: '局限治疗', regimen: '根治性前列腺切除术',
          startDate: '2024-05-06', endDate: '2024-05-06', stopReason: '', response: '',
          agents: [{ drug: '根治性前列腺切除术', dose: '', schedule: '', startDate: '2024-05-06', endDate: '2024-05-06' }] },
        evidence: '【离线演练】2024-05-06 根治性前列腺切除术（第1线）', page: 1
      },
      {
        kind: 'event',
        payload: { date: '2024-05-06', type: '根治性前列腺切除术(RP)', gleason: '4+3=7', stage: 'pT3aN0M0', notes: '' },
        evidence: '【离线演练】2024-05-06 行机器人辅助根治性前列腺切除术', page: 1
      },
      {
        kind: 'event',
        payload: { date: '2024-04-01', type: 'ADT启动', gleason: '', stage: '', notes: '重复演示：与戈舍瑞林药物同组' },
        evidence: '【离线演练】2024-04-01 启动 ADT', page: 1
      },
      {
        kind: 'event',
        payload: { date: '2024-03-20', type: '前列腺穿刺活检病理报告', gleason: '', stage: '', notes: '重复演示：与病理结构化同组' },
        evidence: '【离线演练】2024-03-20 前列腺穿刺活检', page: 1
      }
    ],
    warnings: [
      /* 离线提示由 runPipeline 统一 unshift 一条，这里不再重复，
         否则两条文案不同的离线提示无法被 Set 去重。 */
      '演示：材料仅精确到月的日期已按规则补为当月 1 日。'
    ]
  };
}

/* ------------------------------------------------------------------ */
/* 三段式流水线的高层封装                                              */
/* ------------------------------------------------------------------ */

/**
 * 第一段：脱敏。
 * 用轻量文本模型识别并替换直接标识符，产出可审计的替换清单。
 *
 * 未配置 Key 时跳过（返回原文），因为离线模式不会把数据发出去。
 *
 * @returns {Promise<{text:string, replaced:string[], skipped:boolean, usage:object}>}
 */
export async function redactText(text) {
  if (!text || !text.trim()) return { text: '', replaced: [], skipped: true, usage: {} };
  if (!aiConfigured()) return { text, replaced: [], skipped: true, usage: {} };

  const { buildRedactionPrompt } = await import('./ai-prompt.mjs');
  const res = await chatCompletion({
    role: ROLE_REDACT,
    messages: [{ role: 'user', content: buildRedactionPrompt(text) }],
    jsonSchema: true
  });
  const parsed = parseModelJson(res.content);
  if (!parsed.ok) {
    /* 脱敏失败必须"失败即保守"：宁可整段丢弃也不能把未脱敏文本送去云端抽取。
       这里返回 skipped=false + text=''，由调用方决定是否中止。 */
    return { text: '', replaced: [], skipped: false, failed: true, error: parsed.error, usage: res.usage };
  }
  const d = parsed.data || {};
  return {
    text: typeof d.redacted === 'string' ? d.redacted : text,
    replaced: Array.isArray(d.replaced) ? d.replaced.map(String).slice(0, 20) : [],
    skipped: false,
    usage: res.usage
  };
}

/**
 * 第三段：结构化抽取。
 *
 * @param {object} opt
 * @param {string} opt.prompt        buildExtractPrompt 的产物
 * @param {Array}  [opt.images]      [{path, mime}]，最多 8 张
 * @param {boolean}[opt.supportsJsonSchema] 模型是否支持 response_format
 * @returns {Promise<{data:any, usage:object, model:string, finishReason:string, latencyMs:number, repaired:string[], offline:boolean}>}
 */
export async function extractStructured(opt) {
  /* 离线演练：不发任何网络请求 */
  if (!aiConfigured()) {
    return {
      data: offlineMockResult(opt.ctx),
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      model: 'offline-mock',
      finishReason: 'mock',
      latencyMs: 0,
      repaired: [],
      offline: true
    };
  }

  const content = [{ type: 'text', text: opt.prompt }];
  (opt.images || []).slice(0, MAX_IMAGES_PER_CALL).forEach(img => {
    content.push({ type: 'image_url', image_url: { url: fileToDataUrl(img.path, img.mime) } });
  });

  const res = await chatCompletion({
    role: ROLE_EXTRACT,
    messages: [{ role: 'user', content }],
    /* OCR 专用模型不支持 response_format，由调用方按模型名判断 */
    jsonSchema: opt.supportsJsonSchema !== false
  });

  const parsed = parseModelJson(res.content);
  if (!parsed.ok) {
    const e = new Error(parsed.error);
    e.errorClass = parsed.errorClass;
    e.raw = parsed.raw;
    throw e;
  }
  return {
    data: parsed.data,
    usage: res.usage,
    model: res.model,
    finishReason: res.finishReason,
    latencyMs: res.latencyMs,
    repaired: parsed.repaired,
    offline: false
  };
}

/** 模型是否支持 response_format 结构化输出开关（OCR 专用模型不支持） */
export function modelSupportsJsonSchema(modelName) {
  const m = String(modelName || '').toLowerCase();
  return !(m.includes('ocr'));
}

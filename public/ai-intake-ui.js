/*!
 * 前列腺癌随访与科研数据库 (Prostate Cancer Follow-up & Research Database)
 * Copyright © 2026 张子众 (Zhang Zizhong)
 * SPDX-License-Identifier: Apache-2.0
 */

/* =========================================================
 * AI 病历登记 — 前端界面模块
 *
 * 加载顺序：必须在 index.html 的内联 <script> 之后引入，
 *   因为本模块运行时依赖内联脚本定义的 api() / toast() /
 *   reload() / htmlAttr() 等全局函数。函数声明在用户交互时
 *   才解析，因此后置加载不影响 renderEdit() 调用本模块。
 *
 * 依赖后端接口：/api/ai-intake/*（见 lib/ai-intake.mjs）
 *
 * 安全：模型输出与材料文本均为不可信数据，所有渲染必须转义
 *   （与 index.html:2028「下面所有渲染都必须转义」的要求一致）。
 * ========================================================= */
(function () {
  'use strict';

  /* ---------- 本地状态 ---------- */
  const ai = {
    status: null,          /* /api/ai-intake/status 的结果 */
    dict: null,            /* 受控词表 */
    files: [],             /* [{file, blobUrl, w, h, compressed}] 待上传 */
    session: null,         /* 当前审核的会话详情 */
    decisions: {},         /* itemId -> 'adopt'|'reject' */
    edits: {},             /* itemId -> {字段:值} 医生改过的内容 */
    force: {},             /* itemId -> true：重复项“单独保留”时使用 */
    pollTimer: null,
    pollCount: 0,
    /* 当前正在查看的患者 ID。历史列表按它过滤（患者隔离），
       切换患者时用它判断旧的审核/轮询状态是否该清掉——
       不清的话会把 A 患者的识别结果留在 B 患者的界面上。 */
    currentPid: null
  };

  /* 图片压缩参数：长边 2000px / JPEG 0.85。
     依据技术文档 4.3 节——不压缩的 3000×4000 原图会让单请求越过 32K
     档位使输入单价翻倍，且 base64 膨胀会撞 PM2 的 300M 内存重启线。
     Canvas 重绘同时天然丢弃 EXIF（含 GPS），满足脱敏要求。 */
  const MAX_EDGE = 2000;
  const JPEG_QUALITY = 0.85;

  /* ---------- 工具 ---------- */
  function esc(s) {
    /* 优先用内联脚本的 htmlAttr（它已处理 & < > 与引号），不可用时兜底 */
    if (typeof window.htmlAttr === 'function') return window.htmlAttr(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const say = m => { if (typeof window.toast === 'function') window.toast(m); else console.log(m); };
  const call = (p, o) => window.api(p, o);

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ---------- 注入样式 ---------- */
  /* 刻意不复用 aurora-glass.css：那份文件 11668 行，新增类名有撞车风险。
     这里只沿用项目既有的 .btn/.panel/.form-item 等类名，
     AI 专属样式加 ai- 前缀，作用域隔离。 */
  function injectCss() {
    if (document.getElementById('ai-intake-css')) return;
    const css = `
.ai-wrap{display:flex;flex-direction:column;gap:14px}
.ai-banner{border-radius:10px;padding:11px 14px;font-size:13px;line-height:1.6;border:1px solid}
.ai-banner.offline{background:#fff6e5;border-color:#e8c98a;color:#7a5a12}
.ai-banner.info{background:#eaf4f6;border-color:#a8ccd4;color:#1c4f5c}
.ai-banner.danger{background:#fdeeed;border-color:#e6b3b0;color:#8d3531}
.ai-panel{background:var(--card,#f7fcfc);border:1px solid var(--border,rgba(102,146,155,.25));border-radius:12px;padding:14px}
.ai-panel h4{margin:0 0 10px;font-size:14.5px;color:var(--primary,#123f4c);font-weight:700}
.ai-drop{border:2px dashed rgba(102,146,155,.45);border-radius:10px;padding:20px;text-align:center;color:var(--text-light,#58747c);font-size:13px;cursor:pointer;transition:.15s}
.ai-drop:hover,.ai-drop.over{border-color:var(--accent,#0d7c83);background:rgba(13,124,131,.05)}
.ai-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.ai-thumb{position:relative;width:84px;height:84px;border-radius:8px;overflow:hidden;border:1px solid var(--border,rgba(102,146,155,.25))}
.ai-thumb img{width:100%;height:100%;object-fit:cover}
.ai-thumb .x{position:absolute;top:2px;right:2px;width:19px;height:19px;border-radius:50%;background:#00000099;color:#fff;border:0;cursor:pointer;font-size:12px;line-height:1}
.ai-thumb .sz{position:absolute;bottom:0;left:0;right:0;background:#000000a0;color:#fff;font-size:10px;padding:1px 4px;text-align:center}
.ai-progress{display:flex;align-items:center;gap:9px;padding:11px 13px;background:#eaf4f6;border-radius:9px;font-size:13px;color:#1c4f5c}
.ai-spin{width:15px;height:15px;border:2px solid #a8ccd4;border-top-color:#0d7c83;border-radius:50%;animation:airot .8s linear infinite;flex:0 0 auto}
@keyframes airot{to{transform:rotate(360deg)}}
.ai-steps{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap}
.ai-step{font-size:11.5px;padding:2px 8px;border-radius:20px;background:#dce9ed;color:#58747c}
.ai-step.on{background:#0d7c83;color:#fff}
.ai-step.done{background:#218366;color:#fff}
.ai-item{border:1px solid var(--border,rgba(102,146,155,.25));border-radius:10px;padding:11px 12px;margin-bottom:9px;background:#fff}
.ai-item.r-warn{border-left:4px solid #aa731d;background:#fffcf5}
.ai-item.r-danger{border-left:4px solid #bd504b;background:#fef8f7}
.ai-item.r-conflict{border-left:4px solid #bd504b;background:#fff6f5}
.ai-item.rejected{opacity:.5}
.ai-item-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:7px}
.ai-tag{font-size:11px;padding:2px 7px;border-radius:5px;background:#e4eef0;color:#1c4f5c;font-weight:600}
.ai-tag.k-psa{background:#e3f0ea;color:#218366}
.ai-tag.k-testosterone{background:#ece7f5;color:#5b4592}
.ai-tag.k-medication{background:#fdf0e3;color:#96651c}
.ai-tag.k-event{background:#e5eff7;color:#2b5f86}
.ai-tag.k-lab{background:#eef4e6;color:#4d7024}
.ai-tag.k-profile{background:#e4eef0;color:#1c4f5c}
.ai-tag.k-pathology{background:#f3e9f4;color:#6a3b73}
.ai-tag.k-imaging{background:#e8f0fa;color:#2f5f8f}
.ai-tag.k-radiation{background:#fdf0e3;color:#96651c}
.ai-tag.k-outcome{background:#fdeaea;color:#8d3531}
.ai-tag.k-clinical{background:#e9f7f1;color:#2d6b4f}
.ai-tag.k-treatment_line{background:#eef0fb;color:#3f4d8a}
.ai-risk{font-size:11.5px;padding:2px 7px;border-radius:5px;font-weight:600}
.ai-risk.warn{background:#fbeed6;color:#8a5c11}
.ai-risk.danger{background:#f8dedc;color:#8d3531}
.ai-risk.conflict{background:#f8dedc;color:#8d3531;border:1px solid #e6b3b0}
.ai-conflict{margin:7px 0;padding:9px 10px;border:1px solid #e6b3b0;background:#fdeeed;border-radius:7px;color:#7d2f2a;font-size:12.5px}
.ai-conflict-hd{font-weight:700;margin-bottom:5px}
.ai-diff{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;margin:4px 0;align-items:baseline}
.ai-diff span{color:#9a5b56}
.ai-diff b{color:#7d2f2a;font-weight:700;overflow-wrap:anywhere}
.ai-conflict-note{font-size:11.5px;color:#8d3531;margin-top:5px;line-height:1.55}
.ai-existing{margin:6px 0;padding:7px 9px;background:#f4f8f9;border-left:3px solid #c5dade;border-radius:4px;font-size:12px;color:#4d6c74;line-height:1.55}
.ai-existing b{color:#1c4f5c}
.ai-no-write{font-size:12px;color:#7f8c8d;margin-top:6px;margin-left:auto}
.ai-fields{display:flex;flex-wrap:wrap;gap:7px 14px;margin:5px 0}
.ai-fields-readonly{opacity:.72;pointer-events:none}
.ai-f{display:flex;align-items:center;gap:5px;font-size:12.5px}
.ai-f label{color:var(--text-light,#58747c);white-space:nowrap}
.ai-f input,.ai-f select{padding:3px 7px;border:1px solid var(--border,rgba(102,146,155,.35));border-radius:6px;font-size:12.5px;background:#fff;color:var(--text,#183842)}
.ai-f input[type=text],.ai-f input[type=number]{width:118px}
.ai-f input[type=date]{width:142px}
.ai-ev{font-size:12px;color:var(--text-light,#58747c);background:#f4f8f9;border-radius:6px;padding:6px 9px;margin-top:6px;line-height:1.55;border-left:3px solid #c5dade}
.ai-ev b{color:#1c4f5c}
.ai-tri{display:inline-flex;border:1px solid var(--border,rgba(102,146,155,.35));border-radius:6px;overflow:hidden}
.ai-tri button{border:0;background:#fff;padding:3px 9px;font-size:12px;cursor:pointer;color:var(--text-light,#58747c)}
.ai-tri button.on{background:#0d7c83;color:#fff}
.ai-tri button.na.on{background:#8fa8ae}
.ai-acts{display:flex;gap:6px;margin-top:8px;justify-content:flex-end}
.ai-btn{padding:4px 11px;border-radius:7px;border:1px solid var(--border,rgba(102,146,155,.4));background:#fff;font-size:12.5px;cursor:pointer;color:var(--text,#183842)}
.ai-btn:hover{border-color:var(--accent,#0d7c83)}
.ai-btn.on-adopt{background:#218366;border-color:#218366;color:#fff}
.ai-btn.conflict-adopt{background:#b23b32;border-color:#b23b32;color:#fff}
.ai-btn.conflict-adopt:hover{border-color:#8d2c26;background:#9d312a}
.ai-btn.on-reject{background:#bd504b;border-color:#bd504b;color:#fff}
.ai-sess{display:flex;align-items:center;gap:9px;padding:8px 11px;border:1px solid var(--border,rgba(102,146,155,.25));border-radius:9px;margin-bottom:7px;background:#fff;font-size:12.5px;flex-wrap:wrap}
.ai-st{font-size:11px;padding:2px 7px;border-radius:5px;font-weight:600}
.ai-st.pending{background:#fbeed6;color:#8a5c11}
.ai-st.adopted{background:#e3f0ea;color:#218366}
.ai-st.failed{background:#f8dedc;color:#8d3531}
.ai-st.rejected{background:#eceef0;color:#5c6b70}
.ai-st.run{background:#e5eff7;color:#2b5f86}
.ai-warn{font-size:12px;color:#8a5c11;background:#fffcf5;border:1px solid #e8d5ab;border-radius:7px;padding:6px 9px;margin-bottom:7px;line-height:1.55}
.ai-imgs{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}
.ai-imgs img{width:104px;height:104px;object-fit:cover;border-radius:7px;border:1px solid var(--border,rgba(102,146,155,.3));cursor:zoom-in}
.ai-sum{display:flex;gap:14px;flex-wrap:wrap;padding:9px 12px;background:#f4f8f9;border-radius:8px;font-size:12.5px;color:#1c4f5c;margin-bottom:10px}
.ai-sum b{font-size:15px}
.ai-empty{text-align:center;color:var(--text-light,#58747c);font-size:13px;padding:22px}
`;
    const st = document.createElement('style');
    st.id = 'ai-intake-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 图片压缩 ---------- */
  /**
   * 把 File 压到长边 ≤2000px 的 JPEG，同时丢弃 EXIF。
   * 返回 {blob, w, h, bytes}；失败时回退原文件（宁可体积大也不要丢材料）。
   */
  function compressImage(file) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth, h = img.naturalHeight;
          const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          /* toBlob 是异步的；PNG 转 JPEG 会丢透明通道，
             化验单没有透明需求，先铺白底避免透明区变黑 */
          cv.toBlob(blob => {
            URL.revokeObjectURL(url);
            if (!blob) return resolve({ blob: file, w: img.naturalWidth, h: img.naturalHeight, bytes: file.size, compressed: false });
            resolve({ blob, w, h, bytes: blob.size, compressed: true, url: URL.createObjectURL(blob) });
          }, 'image/jpeg', JPEG_QUALITY);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve({ blob: file, w: img.naturalWidth, h: img.naturalHeight, bytes: file.size, compressed: false });
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ blob: file, w: 0, h: 0, bytes: file.size, compressed: false });
      };
      img.src = url;
    });
  }

  /* ---------- 初始化 ---------- */
  async function aiInit() {
    injectCss();
    try {
      ai.status = await call('/api/ai-intake/status');
      ai.dict = await call('/api/ai-intake/dict');
    } catch (e) {
      ai.status = { enabled: false, offline: true };
      console.warn('[ai-intake] 状态获取失败', e);
    }
  }

  /* ---------- 主渲染：AI 登记 pane ----------
     必须同步返回 HTML 字符串：renderEdit() 用字符串拼接 innerHTML，
     async 函数返回 Promise 会被拼成 "[object Promise]"。
     因此这里同步产出外壳，状态/词表通过 aiInit() 异步补齐后重渲染内层。 */
  function renderAiPane(p) {
    injectCss();
    /* 患者隔离：切换患者时必须丢弃上一个患者的在途状态。
       审核结果、采纳决策、待上传文件、轮询任务都属于具体某位患者，
       不清掉就会把 A 患者的识别卡片留在 B 患者的界面上。 */
    if (ai.currentPid && ai.currentPid !== p.id) {
      stopPoll();
      ai.session = null;
      ai.decisions = {};
      ai.edits = {};
      ai.force = {};
      clearFilesSilent();
    }
    ai.currentPid = p.id;
    if (!ai.status) {
      /* 首次进入：先渲染「加载中」，拿到状态后重绘内层并拉历史 */
      aiInit().then(() => {
        /* 异步回来时可能已切走：只在仍停留在同一患者时重绘，
           否则会把旧患者的内容画到新患者的界面上 */
        if (ai.currentPid !== p.id) return;
        const root = document.getElementById('ai-pane-inner');
        if (root) root.innerHTML = buildAiInner(p);
        loadHistory();
      }).catch(() => { /* 保持加载中提示 */ });
    } else {
      setTimeout(() => { if (ai.currentPid === p.id) loadHistory(); }, 30);
    }
    return '<div class="ai-wrap"><div id="ai-pane-inner">' + buildAiInner(p) + '</div></div>';
  }

  /* 内层内容：纯同步，读取 ai.status（可能为 null，此时按「加载中」安全渲染） */
  function buildAiInner(p) {
    const s = ai.status;
    if (!s) {
      return '<div class="ai-panel"><div class="ai-empty">正在加载 AI 功能状态…</div></div>';
    }
    if (!s.enabled) {
      return '<div class="ai-banner danger">AI 登记功能已在服务端关闭（AI_INTAKE_ENABLED=false）。常规录入不受影响。</div>';
    }
    let h = '';

    if (s.offline) {
      h += '<div class="ai-banner offline"><b>⚠ 离线演练模式</b>：服务端未配置 <code>DASHSCOPE_API_KEY</code>，' +
        '现在返回的是<b>演示数据</b>而非真实识别结果。可用于验证界面与入库流程，' +
        '<b>请勿把演练结果采纳进真实病历</b>。配置方法见 <code>lib/ai-client.mjs</code> 顶部注释。</div>';
    } else {
      h += '<div class="ai-banner info">识别模型：<b>' + esc(s.models && s.models.extract) + '</b>　·　单次最多 ' +
        esc((s.promptBudget || {}).maxImages) + ' 张图　·　图片自动压缩至长边 ' + MAX_EDGE + 'px 后上传</div>';
    }

    /* 上传区 */
    h += '<div class="ai-panel"><h4>① 上传病历 / 化验单 / 病理报告</h4>' +
      '<div class="ai-drop" id="ai-drop" onclick="document.getElementById(\'ai-file\').click()" ' +
      'ondragover="event.preventDefault();this.classList.add(\'over\')" ' +
      'ondragleave="this.classList.remove(\'over\')" ' +
      'ondrop="AiUI.onDrop(event)">' +
      '点击选择，或把图片拖到这里<br><span style="font-size:11.5px">支持 JPG / PNG，单张 ≤15MB，一次最多 ' +
      esc((s.promptBudget || {}).maxImages) + ' 张；PDF 暂未支持，请先截图或转成图片</span></div>' +
      '<input type="file" id="ai-file" accept="image/*" multiple style="display:none" onchange="AiUI.onFiles(this.files)">' +
      '<div class="ai-thumbs" id="ai-thumbs"></div>' +
      '<div class="form-item" style="margin-top:11px"><label>或粘贴文字材料（医生口述、出院小结文本等）</label>' +
      '<textarea id="ai-text" rows="3" placeholder="可直接粘贴文字，无需图片。含患者姓名/证件号时系统会先自动脱敏再送模型。" ' +
      'style="width:100%;padding:7px 9px;border:1px solid var(--border,rgba(102,146,155,.35));border-radius:7px;font-size:13px;resize:vertical"></textarea></div>' +
      '<div class="form-item" style="margin-top:9px"><label>材料类型（可选，帮助模型判断分期前缀）</label>' +
      '<select id="ai-doctype" style="padding:5px 8px;border:1px solid var(--border,rgba(102,146,155,.35));border-radius:7px;font-size:13px">' +
      ['lab|化验单', 'pathology|病理报告', 'discharge|出院小结', 'imaging|影像报告', 'prescription|处方/用药', 'progress|病程/口述', 'mixed|混合']
        .map(o => { const [v, l] = o.split('|'); return '<option value="' + v + '">' + l + '</option>'; }).join('') +
      '</select></div>' +
      '<div style="display:flex;gap:8px;margin-top:11px;align-items:center;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-primary" id="ai-submit" onclick="AiUI.submit(\'' + esc(p.id) + '\',this)">开始识别</button>' +
      '<button type="button" class="btn btn-outline" onclick="AiUI.clearFiles()">清空</button>' +
      '<span id="ai-hint" style="font-size:12px;color:var(--text-light,#58747c)"></span></div>' +
      '<div id="ai-progress"></div>' +
      '</div>';

    /* 审核区 */
    h += '<div id="ai-review"></div>';

    /* 历史会话 */
    h += '<div class="ai-panel"><h4>③ 本次会话历史</h4><div id="ai-history"><div class="ai-empty">加载中…</div></div></div>';

    return h;
  }

  /* ---------- 文件选择 ---------- */
  async function onFiles(fileList) {
    const max = (ai.status && ai.status.promptBudget && ai.status.promptBudget.maxImages) || 8;
    const incoming = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
    if (!incoming.length) { say('⚠ 请选择图片文件'); return; }
    if (ai.files.length + incoming.length > max) {
      say('⚠ 单次最多 ' + max + ' 张，已保留前 ' + max + ' 张');
    }
    for (const f of incoming) {
      if (ai.files.length >= max) break;
      if (f.size > 15 * 1024 * 1024) { say('⚠ ' + f.name + ' 超过 15MB，已跳过'); continue; }
      const c = await compressImage(f);
      ai.files.push({ name: f.name, blob: c.blob, url: c.url || URL.createObjectURL(c.blob), w: c.w, h: c.h, bytes: c.bytes, compressed: c.compressed, mime: 'image/jpeg' });
    }
    renderThumbs();
  }

  function onDrop(ev) {
    ev.preventDefault();
    const el = document.getElementById('ai-drop');
    if (el) el.classList.remove('over');
    onFiles(ev.dataTransfer && ev.dataTransfer.files);
  }

  function renderThumbs() {
    const box = document.getElementById('ai-thumbs');
    if (!box) return;
    if (!ai.files.length) { box.innerHTML = ''; updateHint(); return; }
    box.innerHTML = ai.files.map((f, i) =>
      '<div class="ai-thumb"><img src="' + esc(f.url) + '" alt="">' +
      '<button type="button" class="x" onclick="AiUI.rmFile(' + i + ')" title="移除">×</button>' +
      '<div class="sz">' + esc(f.w) + '×' + esc(f.h) + ' · ' + esc(fmtBytes(f.bytes)) + '</div></div>').join('');
    updateHint();
  }

  function updateHint() {
    const el = document.getElementById('ai-hint');
    if (!el) return;
    const before = ai.files.filter(f => !f.compressed).length;
    const saved = ai.files.length - before;
    el.textContent = ai.files.length
      ? '已选 ' + ai.files.length + ' 张' + (saved ? '（' + saved + ' 张已压缩并去除定位信息）' : '')
      : '';
  }

  function rmFile(i) {
    const f = ai.files[i];
    if (f && f.url) { try { URL.revokeObjectURL(f.url); } catch (e) { /* 忽略 */ } }
    ai.files.splice(i, 1);
    renderThumbs();
  }

  function clearFiles() {
    ai.files.forEach(f => { try { URL.revokeObjectURL(f.url); } catch (e) { /* 忽略 */ } });
    ai.files = [];
    renderThumbs();
    const t = document.getElementById('ai-text'); if (t) t.value = '';
    const r = document.getElementById('ai-review'); if (r) r.innerHTML = '';
  }

  /* 切换患者时的静默清空：只释放内存中的待上传文件，不碰 DOM。
     此时旧患者的面板可能已被 renderEdit 替换或卸载，
     操作不存在的元素虽有空值保护，但没必要再触发一次重绘。 */
  function clearFilesSilent() {
    ai.files.forEach(f => { try { URL.revokeObjectURL(f.url); } catch (e) { /* 忽略 */ } });
    ai.files = [];
  }

  /* ---------- 提交 ---------- */
  async function submit(pid, btn) {
    const text = (document.getElementById('ai-text') || {}).value || '';
    if (!ai.files.length && !text.trim()) { say('⚠ 请至少上传一张图片或粘贴一段文字'); return; }

    const fd = new FormData();
    ai.files.forEach((f, i) => {
      /* blob 没有文件名，FormData 会当成普通字段；必须显式给名字 */
      fd.append('files', f.blob, f.name || ('page-' + (i + 1) + '.jpg'));
      fd.append('w' + i, String(f.w || 0));
      fd.append('h' + i, String(f.h || 0));
    });
    fd.append('patientId', pid);
    if (text.trim()) fd.append('text', text.trim());
    fd.append('docType', (document.getElementById('ai-doctype') || {}).value || 'mixed');

    if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
    let res;
    try {
      res = await call('/api/ai-intake/sessions', { method: 'POST', body: fd });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '开始识别'; }
      return say('⚠ ' + (e.message || '上传失败'));
    }
    if (btn) { btn.disabled = false; btn.textContent = '开始识别'; }
    say('已提交，正在识别…');
    startPoll(res.sessionId);
  }

  /* ---------- 轮询 ---------- */
  function startPoll(sid) {
    stopPoll();
    ai.pollCount = 0;
    renderProgress(sid, 'queued', '排队中');
    ai.pollTimer = setInterval(() => pollOnce(sid), 2500);
    pollOnce(sid);
  }
  function stopPoll() {
    if (ai.pollTimer) { clearInterval(ai.pollTimer); ai.pollTimer = null; }
  }

  async function pollOnce(sid) {
    ai.pollCount++;
    let s;
    try { s = await call('/api/ai-intake/sessions/' + sid); }
    catch (e) { stopPoll(); renderProgress(sid, 'failed', '查询失败：' + (e.message || '')); return; }

    renderProgress(sid, s.status, s.stageDetail);

    if (s.status === 'pending') {
      stopPoll();
      await openReview(sid);
    } else if (s.status === 'failed') {
      stopPoll();
      const box = document.getElementById('ai-progress');
      if (box) {
        box.innerHTML = '<div class="ai-banner danger" style="margin-top:10px"><b>识别失败</b>：' +
          esc(s.errorMsg || s.errorClass || '未知错误') +
          '<br><span style="font-size:12px">材料仍已保存在会话 ' + esc(sid.slice(0, 8)) + '，可重试或改用常规录入。</span></div>';
      }
      say('⚠ 识别失败');
      loadHistory();
    } else if (ai.pollCount > 120) {
      /* 5 分钟兜底：任务可能因服务重启变成僵尸，不让界面永远转圈 */
      stopPoll();
      renderProgress(sid, 'failed', '等待超时，请刷新后在会话历史中查看结果');
    }
  }

  const STEP_LABELS = { queued: '排队', preprocessing: '检查材料', redacting: '脱敏', extracting: '模型识别', pending: '待审核' };
  const STEP_ORDER = ['queued', 'preprocessing', 'redacting', 'extracting', 'pending'];

  function renderProgress(sid, status, detail) {
    const box = document.getElementById('ai-progress');
    if (!box) return;
    if (status === 'pending' || status === 'failed') { box.innerHTML = ''; return; }
    const cur = STEP_ORDER.indexOf(status);
    box.innerHTML = '<div class="ai-progress" style="margin-top:11px"><div class="ai-spin"></div>' +
      '<div><div>' + esc(detail || STEP_LABELS[status] || status) + '…</div>' +
      '<div class="ai-steps">' + STEP_ORDER.map((k, i) =>
        '<span class="ai-step ' + (i < cur ? 'done' : i === cur ? 'on' : '') + '">' + STEP_LABELS[k] + '</span>').join('') +
      '</div></div></div>';
  }

  /* ---------- 审核界面 ---------- */
  async function openReview(sid) {
    let d;
    try { d = await call('/api/ai-intake/sessions/' + sid + '/result'); }
    catch (e) { return say('⚠ 结果获取失败：' + (e.message || '')); }
    ai.session = d;
    ai.decisions = {};
    ai.edits = {};
    ai.force = {};
    /* 默认策略：ok 项预选采纳，warn/danger 项不预选；
       重复项也不预选，必须医生选择“合并”或“单独保留”。
       主档已有值（无论与材料一致还是有冲突）一律不默认选中：
       一致/未提及的没有写入必要，冲突的必须由医生逐条点“采纳并更新”。 */
    (d.items || []).forEach(it => {
      const existingProfile = it.kind === 'profile' && it.hasExisting;
      ai.decisions[it.id] = (!it.duplicateOf && it.risk === 'ok' && !existingProfile) ? 'adopt' : '';
    });
    renderReview();
    loadHistory();
  }

  const KIND_LABEL = {
    profile: '主档', psa: 'PSA', testosterone: '睾酮', lab: '化验', clinical: '监测',
    medication: '用药', treatment_line: '治疗线',
    episode: '治疗段', visit: '就诊', surgery: '手术记录', chemo_cycle: '化疗周期',
    administration: '给药', comorbidity: '合并症', disease_state: '疾病状态', adverse_event: '不良反应',
    pathology: '病理', imaging: '影像', radiation: '放疗', outcome: '结局', event: '病程事件'
  };

  /* 主档值的中文展示：冲突对比里不能直接给医生看 0/1、former、widespread。 */
  function profileValueLabel(field, value) {
    if (value === null || value === undefined || value === '') return '未评估';
    if (['castration', 'metExtraPelvis', 'visceralMet', 'familyHistory'].includes(field)) {
      const s = String(value).trim().toLowerCase();
      if (['1', 'true', '是', '有', 'yes'].includes(s)) return '是';
      if (['0', 'false', '否', '无', 'no'].includes(s)) return '否';
      return String(value);
    }
    if (['metCount', 'ecog', 'charlson', 'bmi'].includes(field)) return String(value);
    if (field === 'smoking') {
      return ({ never: '从不吸烟', former: '既往吸烟', current: '现吸烟', unknown: '不详' })[value] || String(value);
    }
    if (field === 'lastFollowupMode') {
      return ({ clinic: '门诊', phone: '电话', external: '线上/外院', hospital: '住院', other: '其他' })[value] || String(value);
    }
    if (field === 'oligoType') {
      const opt = ((ai.dict && ai.dict.oligoTypes) || []).find(x => x.v === value);
      return opt ? opt.l : String(value);
    }
    return String(value);
  }

  /* 已建档患者的姓名项 row.field 为空、字段名在 payload.field 里；
     审核卡统一用有效字段，避免显示成“主档 · ”空标签。 */
  function profileFieldOf(it) {
    return (it && (it.field || (it.payload && it.payload.field))) || '';
  }

  /* 主档项是否允许“采纳写入”：空字段直接写；已有值只有红标冲突且未被
     病理同步/身份保护拦住时，才允许医生显式点“采纳并更新”。 */
  function canAdoptProfileItem(it) {
    if (!it || it.kind !== 'profile') return true;
    if (!it.hasExisting) return true;
    return !!(it.conflict && !it.overwriteBlocked);
  }

  function renderReview() {
    const d = ai.session;
    const box = document.getElementById('ai-review');
    if (!box) return;
    if (!d) { box.innerHTML = ''; return; }

    const items = d.items || [];
    const nDanger = items.filter(i => i.risk === 'danger').length;
    const nWarn = items.filter(i => i.risk === 'warn').length;
    const nConflict = items.filter(i => i.conflict).length;
    const hasExistingProfile = items.some(i => i.kind === 'profile' && i.hasExisting);
    const nAdopt = Object.values(ai.decisions).filter(v => v === 'adopt').length;

    let h = '<div class="ai-panel"><h4>② 审核识别结果（共 ' + items.length + ' 项）</h4>';

    if (d.offline) {
      h += '<div class="ai-banner offline" style="margin-bottom:10px"><b>⚠ 离线演练数据</b>：以下内容为演示数据，采纳会写入演示值。请仅在测试环境使用。</div>';
    }
    const warns = d.warnings || [];
    const modelWarns = warns.filter(w => /^\[(date_precision|custom_event|uncertainty|drug_alias|other)\]/.test(String(w)));
    const sysWarns = warns.filter(w => !modelWarns.includes(w));
    sysWarns.forEach(w => { h += '<div class="ai-warn">' + esc(w) + '</div>'; });
    if (modelWarns.length) {
      h += '<details class="ai-warn" style="margin-bottom:7px"><summary style="cursor:pointer">模型提示 ' +
        modelWarns.length + ' 条（已按原文核验，点击展开）</summary>' +
        modelWarns.map(w => '<div style="margin-top:5px">' + esc(w) + '</div>').join('') + '</details>';
    }

    h += '<div class="ai-sum">' +
      '<span>已选采纳 <b>' + nAdopt + '</b> / ' + items.length + '</span>' +
      (nConflict ? '<span style="color:#8d3531">与现有档案冲突 <b>' + nConflict + '</b></span>' : '') +
      (nDanger ? '<span style="color:#8d3531">必须确认 <b>' + nDanger + '</b></span>' : '') +
      (nWarn ? '<span style="color:#8a5c11">需留意 <b>' + nWarn + '</b></span>' : '') +
      '<span>模型 <b style="font-size:12.5px">' + esc(d.modelUsed || '-') + '</b></span>' +
      '<span>耗时 <b>' + esc(Math.round((d.latencyMs || 0) / 100) / 10) + '</b> 秒</span>' +
      '<span>Token <b>' + esc((d.inputTokens || 0) + '+' + (d.outputTokens || 0)) + '</b></span>' +
      '</div>';

    /* 材料缩略图：医生核对 evidence 时能看到原文 */
    if ((d.files || []).length) {
      h += '<div class="ai-imgs">' + d.files.map(f =>
        '<img src="' + esc(f.url) + '" data-token-url="' + esc(f.url) + '" onclick="AiUI.viewImg(this)" alt="材料第' + esc(f.page) + '页" title="第' + esc(f.page) + '页 ' + esc(f.filename || '') + '">').join('') + '</div>';
      h += '<div style="font-size:11.5px;color:var(--text-light,#58747c);margin-bottom:9px">点击缩略图可放大查看原始材料（图片需带登录态加载）</div>';
    }

    if (!items.length) {
      h += '<div class="ai-empty">模型没有从材料中识别出可录入的信息。<br>可能原因：材料模糊、内容为空、或全是网站不存储的项目。</div>';
    }

    /* 按 kind 分组展示，同类相邻便于批量核对 */
    const order = ['profile', 'psa', 'testosterone', 'lab', 'clinical', 'medication', 'treatment_line', 'episode', 'visit', 'surgery', 'chemo_cycle', 'administration', 'comorbidity', 'disease_state', 'adverse_event', 'pathology', 'imaging', 'radiation', 'outcome', 'event'];
    order.forEach(k => {
      const group = items.filter(i => i.kind === k);
      if (!group.length) return;
      h += '<div style="margin:12px 0 7px;font-size:13px;font-weight:700;color:var(--primary,#123f4c)">' +
        KIND_LABEL[k] + '（' + group.length + '）</div>';
      group.forEach(it => { h += renderItem(it); });
    });
    /* 未知 kind 兜底，不静默丢弃 */
    const rest = items.filter(i => !order.includes(i.kind));
    if (rest.length) {
      h += '<div style="margin:12px 0 7px;font-size:13px;font-weight:700;color:#8d3531">未识别类型（' + rest.length + '，采纳时会被忽略）</div>';
      rest.forEach(it => { h += renderItem(it); });
    }

    h += '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--border,rgba(102,146,155,.25));padding-top:12px">' +
      '<button type="button" class="btn btn-green" id="ai-adopt-btn" onclick="AiUI.adopt(this)">采纳所选并写入病历</button>' +
      '<button type="button" class="btn btn-outline" onclick="AiUI.allAdopt()" title="已有档案值/冲突项不会被全选，需逐条确认">' +
      (hasExistingProfile ? '全选可写入项' : '全选') + '</button>' +
      '<button type="button" class="btn btn-outline" onclick="AiUI.allNone()">全不选</button>' +
      '<button type="button" class="btn btn-danger" onclick="AiUI.reject()">整批拒绝</button>' +
      '<span style="font-size:12px;color:var(--text-light,#58747c);flex:1;min-width:200px">' +
      '采纳即写入数据库并记入审计日志；主档冲突项默认不选，点“采纳并更新”才会覆盖现有值。' +
      '三态字段请确认「未评估」与「阴性」的区别，两者临床含义不同。</span></div>';
    h += '</div>';

    box.innerHTML = h;
    /* 材料图需带 Authorization 头才能取到，用 imgWithToken 换成 blob URL */
    loadReviewImages();
  }

  async function loadReviewImages() {
    if (typeof window.imgWithToken !== 'function') return;
    const imgs = document.querySelectorAll('#ai-review img[data-token-url]');
    for (const im of imgs) {
      const u = im.getAttribute('data-token-url');
      const blob = await window.imgWithToken(u).catch(() => null);
      if (blob) im.src = blob; else im.style.opacity = '.35';
    }
  }

  function viewImg(im) {
    /* 复用既有 lightbox，保持交互一致 */
    const lb = document.getElementById('lightbox');
    const li = document.getElementById('lightbox-img');
    if (lb && li && im.src) { li.src = im.src; lb.style.display = 'flex'; }
  }

  function renderItem(it) {
    const dec = ai.decisions[it.id] || '';
    const ed = ai.edits[it.id] || {};
    const pl = Object.assign({}, it.payload, ed);
    const isProfile = it.kind === 'profile';
    const pfield = isProfile ? profileFieldOf(it) : it.field;
    const conflict = !!(isProfile && it.conflict);
    const existingOnly = !!(isProfile && it.hasExisting && !conflict);
    const blocked = !!(conflict && it.overwriteBlocked);
    const canAdopt = canAdoptProfileItem(it);
    const cls = [
      it.risk === 'danger' ? 'r-danger' : it.risk === 'warn' ? 'r-warn' : '',
      conflict ? 'r-conflict' : '',
      dec === 'reject' ? 'rejected' : ''
    ].filter(Boolean).join(' ');

    let h = '<div class="ai-item ' + cls + '" id="ai-item-' + it.id + '">';
    h += '<div class="ai-item-hd">' +
      '<span class="ai-tag k-' + esc(it.kind) + '">' + esc(KIND_LABEL[it.kind] || it.kind) +
        (pfield ? ' · ' + esc(isProfile ? fieldLabel(pfield) : pfield) : '') + '</span>' +
      (it.page ? '<span class="ai-tag">第' + esc(it.page) + '页</span>' : '') +
      (conflict ? '<span class="ai-risk conflict">⚠ 与现有档案冲突</span>' : '') +
      (it.risk !== 'ok' ? '<span class="ai-risk ' + esc(it.risk) + '">' + (it.risk === 'danger' ? '必须确认' : '需留意') + '</span>' : '') +
      (it.decision && it.decision !== 'pending' ? '<span class="ai-tag">已' + (it.decision === 'adopted' ? '采纳' : '拒绝') + '</span>' : '') +
      '</div>';

    if (it.duplicateOf) {
      h += '<div class="ai-warn" style="margin-bottom:7px">↔ 重复项：' + esc(it.dedupeReason || '与同组主项重复') +
        '　<button type="button" class="ai-btn" onclick="AiUI.mergeDup(' + it.id + ')">合并到主项</button>' +
        '<button type="button" class="ai-btn ' + (ai.force[it.id] ? 'on-adopt' : '') + '" onclick="AiUI.keepDup(' + it.id + ')">单独保留</button></div>';
    }
    if (it.riskReason) {
      h += '<div class="ai-warn" style="margin-bottom:7px">' + esc(it.riskReason) + '</div>';
    }

    /* 主档现有值：冲突用红色对比块；一致/未提及用灰蓝提示并禁止写入。
       这一段放在可编辑字段之前，医生先看“档案现在是什么”，再看材料值。 */
    if (isProfile && it.hasExisting) {
      if (conflict) {
        const materialValue = profileValueLabel(pfield, pl.value);
        h += '<div class="ai-conflict">' +
          '<div class="ai-conflict-hd">⚠ 与现有档案不同</div>' +
          '<div class="ai-diff">' +
            '<span>现有档案</span><b>' + esc(it.existingValue) + '</b>' +
            '<span>材料提取</span><b>' + esc(materialValue) + '</b>' +
          '</div>' +
          '<div class="ai-conflict-note">' +
            (blocked
              ? esc(it.overwriteBlocked) + '；本条不能直接覆盖，请到对应页签修改。'
              : '点“采纳并更新”会用材料值覆盖现有档案；点“不要”保留现有值。') +
          '</div>' +
        '</div>';
      } else {
        const hasMaterialValue = String(pl.value == null ? '' : pl.value).trim() !== '';
        h += '<div class="ai-existing">现有档案：<b>' + esc(it.existingValue) + '</b>　' +
          (hasMaterialValue ? '与材料值一致，保留现有值。' : '材料未提及新值，保留现有值。') +
          '</div>';
      }
    }

    h += '<div class="ai-fields' + (isProfile && !canAdopt ? ' ai-fields-readonly' : '') + '">' + renderFields(it, pl) + '</div>';

    if (it.evidence) {
      h += '<div class="ai-ev"><b>原文依据：</b>' + esc(it.evidence) + '</div>';
    } else {
      h += '<div class="ai-ev" style="border-left-color:#e6b3b0;color:#8d3531"><b>⚠ 无原文依据</b>：模型未提供证据摘录，请对照材料核实后再决定</div>';
    }

    h += '<div class="ai-acts">';
    if (canAdopt) {
      const adoptCls = 'ai-btn ' + (dec === 'adopt' ? 'on-adopt ' : '') + (conflict ? 'conflict-adopt' : '');
      h += '<button type="button" class="' + adoptCls + '" onclick="AiUI.decide(' + it.id + ',\'adopt\')">' +
        (conflict ? '⚠ 采纳并更新' : (it.duplicateOf ? '单独保留' : '✓ 采纳')) + '</button>';
    }
    if (canAdopt || blocked) {
      h += '<button type="button" class="ai-btn ' + (dec === 'reject' ? 'on-reject' : '') + '" onclick="AiUI.decide(' + it.id + ',\'reject\')">✗ 不要</button>';
    }
    if (!canAdopt && !blocked) {
      h += '<span class="ai-no-write">本条无需写入：现有值已保留</span>';
    }
    h += '</div></div>';
    return h;
  }

  /* 每种 kind 的可编辑字段。字段名与后端 payload 一致，
     医生改过的值随 decisions[].value 提交，后端存进 edited_value。 */
  function renderFields(it, pl) {
    const F = (label, inner) => '<span class="ai-f"><label>' + esc(label) + '</label>' + inner + '</span>';
    const inp = (k, type, val, w) => '<input type="' + type + '" value="' + esc(val == null ? '' : val) + '" ' +
      (w ? 'style="width:' + w + '"' : '') + ' onchange="AiUI.edit(' + it.id + ',\'' + k + '\',this.value)">';
    const sel = (k, val, opts) => '<select onchange="AiUI.edit(' + it.id + ',\'' + k + '\',this.value)">' +
      opts.map(o => {
        const v = typeof o === 'string' ? o : o[0], l = typeof o === 'string' ? o : o[1];
        return '<option value="' + esc(v) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>';
      }).join('') + '</select>';
    const tri = (k, val, yes, no) => {
      const v = (val == null || val === '') ? '' : ((val === 0 || val === '0' || val === false) ? '0' : '1');
      return sel(k, v, [['', '未评估'], ['1', yes || '是'], ['0', no || '否']]);
    };
    const arr = (k, val) => inp(k, 'text', Array.isArray(val) ? val.join(',') : val, '150px');

    if (it.kind === 'profile') {
      const f = profileFieldOf(it);
      /* 三态布尔：三按钮组，默认停在「未评估」，不允许默认选中模型值 */
      if (['castration', 'metExtraPelvis', 'visceralMet', 'familyHistory'].includes(f)) {
        const yesNo = { castration: ['是（去势水平）', '否'], metExtraPelvis: ['是', '否'], visceralMet: ['有', '无'], familyHistory: ['有', '无'] }[f];
        return F('评估', triButtons(it.id, pl.value, yesNo[0], yesNo[1]));
      }
      if (['birth', 'date', 'rtEndDate', 'adtStartDate', 'lastFollowupDate'].includes(f)) {
        return F(fieldLabel(f), inp('value', 'date', pl.value));
      }
      if (['ecog', 'charlson', 'bmi', 'metCount'].includes(f)) {
        return F(fieldLabel(f) + '（留空=未评估）', inp('value', 'number', pl.value, '96px'));
      }
      if (f === 'smoking') {
        return F(fieldLabel(f), sel('value', pl.value, [['', '未填'], ['never', '不吸'], ['former', '既往吸'], ['current', '现吸'], ['unknown', '不详']]));
      }
      if (f === 'lastFollowupMode') {
        return F(fieldLabel(f), sel('value', pl.value, [['', '未填'], ['clinic', '门诊'], ['phone', '电话'], ['external', '线上/外院'], ['hospital', '住院'], ['other', '其他']]));
      }
      if (f === 'treatment') {
        return F(fieldLabel(f), sel('value', pl.value, ['根治性手术', '放疗', '内分泌治疗', '主动监测', '观察等待']));
      }
      if (f === 'oligoType') {
        const opts = (ai.dict && ai.dict.oligoTypes || []).map(o => [o.v, o.l]);
        return F(fieldLabel(f), sel('value', pl.value, opts));
      }
      return F(fieldLabel(f), inp('value', 'text', pl.value, '190px'));
    }

    if (it.kind === 'psa') {
      let h = F('日期', inp('date', 'date', pl.date)) + F('总PSA', inp('value', 'number', pl.value, '92px'));
      /* belowLod 专用开关：server.js:572-581 要求「检测不到」不能存 0 也不能存 0.03 */
      h += '<span class="ai-f"><label>低于检测下限</label>' +
        '<select onchange="AiUI.edit(' + it.id + ',\'belowLod\',this.value===\'1\')">' +
        '<option value="0"' + (!pl.belowLod ? ' selected' : '') + '>否</option>' +
        '<option value="1"' + (pl.belowLod ? ' selected' : '') + '>是（显示为 &lt;下限）</option></select></span>';
      if (pl.belowLod) h += F('下限值', inp('lod', 'number', pl.lod, '86px'));
      /* 游离PSA 三字段：医生可在审核时补录或修正。
         freeVal 清空（空串）表示不录游离，提交时按 null 处理。 */
      h += F('游离PSA', inp('freeVal', 'number', pl.freeVal, '92px')) +
        '<span class="ai-f"><label>游离低于下限</label>' +
        '<select onchange="AiUI.edit(' + it.id + ',\'freeBelowLod\',this.value===\'1\')">' +
        '<option value="0"' + (!pl.freeBelowLod ? ' selected' : '') + '>否</option>' +
        '<option value="1"' + (pl.freeBelowLod ? ' selected' : '') + '>是</option></select></span>';
      if (pl.freeBelowLod) h += F('游离下限', inp('freeLod', 'number', pl.freeLod, '86px'));
      /* 实时比值预览：与后端 psaFreeRatio 同一规则——
         两个值都是实测数字才算，任一低于下限显示原因而非假数字。
         这里前端算只为了预览；入库值仍由后端现算，两处规则一致不会打架。 */
      if (pl.freeVal != null && pl.freeVal !== '' && Number(pl.value) > 0) {
        const ratio = (!pl.belowLod && !pl.freeBelowLod)
          ? Math.round((Number(pl.freeVal) / Number(pl.value)) * 1000) / 1000
          : null;
        h += '<span class="ai-f"><label>游离/总</label><b style="font-size:12.5px;color:var(--accent)">' +
          (ratio != null ? ratio : '下限值不计算') + '</b></span>';
      }
      return h;
    }

    if (it.kind === 'testosterone') {
      return F('日期', inp('date', 'date', pl.date)) +
        F('录入值', inp('enteredValue', 'number', pl.enteredValue != null ? pl.enteredValue : pl.value, '86px')) +
        F('单位', sel('unit', pl.unit, [['ng/dl', 'ng/dl'], ['nmol/L', 'nmol/L']])) +
        F('换算后', '<b style="font-size:12.5px">' + esc(pl.value) + ' ng/dl</b>') +
        F('检测方法', sel('assayMethod', pl.assayMethod, [['', '未填'], 'RIA', 'CLIA', 'LC-MS/MS', '其他']));
    }

    if (it.kind === 'lab') {
      return F('日期', inp('date', 'date', pl.date)) +
        F('项目代码', inp('itemCode', 'text', pl.itemCode, '90px')) +
        F('项目名', inp('item', 'text', pl.itemLabel || pl.item, '110px')) +
        F('结果', inp('value', 'number', pl.value, '92px')) +
        F('单位', inp('unit', 'text', pl.unit, '78px')) +
        F('实验室', inp('lab', 'text', pl.lab, '100px')) +
        F('方法', inp('method', 'text', pl.method, '86px')) +
        F('参考范围', inp('refRange', 'text', pl.refRange, '100px')) +
        F('异常标记', inp('flag', 'text', pl.flag, '64px')) +
        F('备注', inp('note', 'text', pl.note, '150px')) +
        '<div style="width:100%;font-size:11.5px;color:var(--text-light,#58747c)">写 lab_values，并自动生成当天「化验/监测」时间轴摘要</div>';
    }

    if (it.kind === 'clinical') {
      return F('日期', inp('date', 'date', pl.date)) +
        F('分类', sel('category', pl.category, [['bone', '骨健康'], ['cardio', '心血管代谢'], ['qol', '生活质量'], ['monitor', '药物监测']])) +
        F('项目代码', inp('item', 'text', pl.item, '100px')) +
        F('结果', inp('value', 'number', pl.value, '92px')) +
        F('单位', inp('unit', 'text', pl.unit, '78px')) +
        F('状态', sel('status', pl.status, [['', '未填'], ['未做', '未做'], ['已完成', '已完成'], ['异常', '异常']])) +
        F('备注', inp('note', 'text', pl.note, '190px'));
    }

    if (it.kind === 'treatment_line') {
      const agents = Array.isArray(pl.agents) ? pl.agents : [];
      return F('线数', inp('lineNo', 'number', pl.lineNo, '64px')) +
        F('情境', sel('setting', pl.setting, ['新辅助','辅助','挽救','mHSPC','nmCRPC','mCRPC','局限治疗','主动监测','观察等待','其他'])) +
        F('方案名', inp('regimen', 'text', pl.regimen, '210px')) +
        F('开始', inp('startDate', 'date', pl.startDate)) +
        F('结束', inp('endDate', 'date', pl.endDate)) +
        F('停药原因', inp('stopReason', 'text', pl.stopReason, '130px')) +
        F('疗效', inp('response', 'text', pl.response, '100px')) +
        '<span class="ai-f" style="width:100%"><label>药物明细（保存后可在治疗线面板编辑）</label>' +
          '<span style="font-size:12px">' + (agents.length ? esc(agents.map(a => [a.drug, a.dose, a.schedule, a.startDate, a.endDate].filter(Boolean).join(' · ')).join('；')) : '（无）') + '</span></span>';
    }

    if (it.kind === 'medication') {
      const cats = (ai.dict && ai.dict.medCategories || []).map(c => [c.key, c.label]);
      return F('药物', inp('drug', 'text', pl.drug, '130px')) +
        F('分类', sel('category', pl.category, cats)) +
        F('开始', inp('startDate', 'date', pl.startDate)) +
        F('结束', inp('endDate', 'date', pl.endDate)) +
        F('剂量', inp('dose', 'text', pl.dose, '82px')) +
        F('频次', inp('schedule', 'text', pl.schedule, '82px'));
    }

    if (it.kind === 'episode') {
      return F('模板', inp('templateCode', 'text', pl.templateCode, '90px')) +
        F('类型', sel('episodeType', pl.episodeType, [['surgery','手术'],['radiotherapy','放疗'],['endocrine','内分泌'],['systemic','系统'],['chemo','化疗'],['surveillance','监测'],['other','其他']])) +
        F('名称', inp('label', 'text', pl.label, '180px')) +
        F('开始', inp('startDate', 'date', pl.startDate)) +
        F('结束', inp('endDate', 'date', pl.endDate)) +
        F('状态', sel('status', pl.status, [['active','进行中'],['completed','已完成'],['stopped','停止'],['planned','计划']])) +
        F('关联线数', inp('lineNo', 'number', pl.lineNo, '64px'));
    }

    if (it.kind === 'visit') {
      const rows = Array.isArray(pl.rows) ? pl.rows : [];
      return F('日期', inp('visitDate', 'date', pl.visitDate)) +
        F('类型', sel('visitType', pl.visitType, [['baseline','基线'],['outpatient','门诊'],['inpatient','住院'],['phone','电话'],['external','外院'],['mdt','MDT'],['chemo','化疗'],['other','其他']])) +
        F('小结', inp('summary', 'text', pl.summary, '230px')) +
        F('下次随访', inp('nextVisitDate', 'date', pl.nextVisitDate)) +
        '<span class="ai-f" style="width:100%"><label>关联治疗段行</label><span style="font-size:12px">' +
        (rows.length ? esc(rows.map(r => [r.episodeTemplate || r.episodeLabel || '?', r.overallResponse || 'NA', r.summary || ''].join(' · ')).join('；')) : '（无）') + '</span></span>';
    }

    if (it.kind === 'surgery') {
      return F('手术日期', inp('surgeryDate', 'date', pl.surgeryDate)) +
        F('术式', inp('procedure', 'text', pl.procedure, '90px')) +
        F('入路', inp('approach', 'text', pl.approach, '90px')) +
        F('神经保留', inp('nerveSparing', 'text', pl.nerveSparing, '80px')) +
        F('淋巴结清扫', inp('lnDissection', 'text', pl.lnDissection, '80px')) +
        F('治疗段模板', inp('episodeTemplate', 'text', pl.episodeTemplate, '80px'));
    }

    if (it.kind === 'chemo_cycle') {
      return F('周期', inp('cycleNo', 'number', pl.cycleNo, '64px')) +
        F('日期', inp('cycleDate', 'date', pl.cycleDate)) +
        F('方案', inp('regimen', 'text', pl.regimen, '180px')) +
        F('治疗段模板', inp('episodeTemplate', 'text', pl.episodeTemplate, '80px')) +
        F('BSA', inp('bsa', 'number', pl.bsa, '70px')) +
        F('减量%', inp('doseReductionPct', 'number', pl.doseReductionPct, '70px'));
    }

    if (it.kind === 'administration') {
      return F('给药日期', inp('adminDate', 'date', pl.adminDate)) +
        F('药物', inp('drug', 'text', pl.drug, '120px')) +
        F('剂量', inp('dose', 'text', pl.dose, '80px')) +
        F('途径', inp('route', 'text', pl.route, '80px')) +
        F('治疗段模板', inp('episodeTemplate', 'text', pl.episodeTemplate, '80px')) +
        F('下次给药', inp('nextDueDate', 'date', pl.nextDueDate));
    }

    if (it.kind === 'comorbidity') {
      return F('编码', inp('diseaseCode', 'text', pl.diseaseCode, '120px')) +
        F('名称', inp('diseaseLabel', 'text', pl.diseaseLabel, '120px')) +
        F('状态', inp('status', 'text', pl.status, '80px')) +
        F('严重度', inp('severity', 'text', pl.severity, '80px')) +
        F('诊断日期', inp('diagnosedDate', 'date', pl.diagnosedDate));
    }

    if (it.kind === 'disease_state') {
      return F('状态码', inp('stateCode', 'text', pl.stateCode, '60px')) +
        F('状态名', inp('stateLabel', 'text', pl.stateLabel, '100px')) +
        F('日期', inp('sinceDate', 'date', pl.sinceDate)) +
        F('依据', inp('basis', 'text', pl.basis, '220px')) +
        F('设为当前', sel('isCurrent', pl.isCurrent ? '1' : '0', [['1','是'],['0','否']]));
    }

    if (it.kind === 'adverse_event' || it.kind === 'ae') {
      return F('毒性编码', inp('termCode', 'text', pl.termCode, '110px')) +
        F('分级', inp('grade', 'number', pl.grade, '60px')) +
        F('开始日期', inp('onsetDate', 'date', pl.onsetDate)) +
        F('恢复状态', inp('recoveryStatus', 'text', pl.recoveryStatus, '90px')) +
        F('处理', inp('management', 'text', pl.management, '180px')) +
        F('关联治疗段模板', inp('episodeTemplate', 'text', pl.episodeTemplate, '80px'));
    }

    if (it.kind === 'pathology') {
      return F('标本类型', sel('specimenType', pl.specimenType, [
          ['biopsy', '穿刺活检'], ['RP', '根治性切除'], ['TURP', '前列腺电切'],
          ['metastasis', '转移灶活检'], ['review', '会诊/复核'], ['unknown', '未注明']
        ])) +
        F('报告日期', inp('reportDate', 'date', pl.reportDate)) +
        F('穿刺总针数', inp('coresTotal', 'number', pl.coresTotal, '76px')) +
        F('阳性针数', inp('coresPositive', 'number', pl.coresPositive, '76px')) +
        F('Gleason 原发', inp('gleasonPrimary', 'number', pl.gleasonPrimary, '64px')) +
        F('Gleason 次要', inp('gleasonSecondary', 'number', pl.gleasonSecondary, '64px')) +
        F('pTNM（仅 RP/TURP）', inp('ptnm', 'text', pl.ptnm, '108px')) +
        F('切缘', sel('marginStatus', pl.marginStatus, [
          ['negative', '阴性'], ['positive', '阳性'], ['close', '近切缘'], ['unknown', '未评估']
        ])) +
        F('切缘部位', inp('marginSite', 'text', pl.marginSite, '130px')) +
        F('ECE', tri('ece', pl.ece, '有', '无')) +
        F('SVI', tri('svi', pl.svi, '有', '无')) +
        F('淋巴结阳性', inp('lnPositive', 'number', pl.lnPositive, '72px')) +
        F('淋巴结检查', inp('lnExamined', 'number', pl.lnExamined, '72px')) +
        F('IDC-P', tri('idcP', pl.idcP, '有', '无')) +
        F('筛状结构', tri('cribriform', pl.cribriform, '有', '无')) +
        F('DAC', tri('dac', pl.dac, '有', '无')) +
        F('PNI', tri('pni', pl.pni, '有', '无')) +
        F('NEPC', tri('nepc', pl.nepc, '有', '无')) +
        F('NEPC 详情', inp('nepcDetail', 'text', pl.nepcDetail, '140px')) +
        F('肿瘤体积%', inp('tumorVolumePct', 'number', pl.tumorVolumePct, '76px')) +
        F('肿瘤细胞%', inp('tumorCellPct', 'number', pl.tumorCellPct, '76px')) +
        F('主要病理', tri('isPrimary', pl.isPrimary, '是', '否')) +
        F('备注', inp('notes', 'text', pl.notes, '190px'));
    }

    if (it.kind === 'imaging') {
      return F('模态', sel('modality', pl.modality, [
          ['mpMRI', 'mpMRI'], ['CT', 'CT'], ['PSMA_PET', 'PSMA PET'],
          ['bone_scan', '骨扫描'], ['other', '其他']
        ])) +
        F('检查日期', inp('studyDate', 'date', pl.studyDate)) +
        F('部位', inp('region', 'text', pl.region, '120px')) +
        F('病灶数', inp('lesionCount', 'number', pl.lesionCount, '76px')) +
        F('转移部位（逗号分隔）', arr('metastaticSites', pl.metastaticSites)) +
        F('盆腔/脊柱外', tri('extraPelvic', pl.extraPelvic, '是', '否')) +
        F('新发病灶', tri('newLesion', pl.newLesion, '是', '否')) +
        F('PI-RADS', inp('pirads', 'number', pl.pirads, '64px')) +
        F('PSMA 阳性', tri('psmaPositive', pl.psmaPositive, '是', '否')) +
        F('PSMA 灶数', inp('psmaLesionCount', 'number', pl.psmaLesionCount, '76px')) +
        F('SUVmax', inp('psmaSuvmax', 'number', pl.psmaSuvmax, '76px')) +
        F('RECIST', sel('recist', pl.recist, [['', '未评估'], 'CR', 'PR', 'SD', 'PD', 'NE'])) +
        F('PCWG', sel('pcwg', pl.pcwg, [['', '未评估'], 'PSA_response', 'PSA_progression', 'bone_response', 'bone_progression', 'NE'])) +
        F('Flare', tri('flare', pl.flare, '有', '无')) +
        F('寡转移状态', sel('oligoStatus', pl.oligoStatus, [['', '未评估'], ['none', '无转移'], ['oligo', '寡转移'], ['widespread', '广泛转移'], ['unknown', '未知']])) +
        F('当前影像（同步负荷）', tri('isCurrent', pl.isCurrent, '是', '否')) +
        F('备注', inp('notes', 'text', pl.notes, '190px'));
    }

    if (it.kind === 'radiation') {
      return F('放疗类型', sel('rtType', pl.rtType, [
          ['EBRT', '外照射 EBRT'], ['SBRT', 'SBRT'], ['brachy', '近距离'], ['other', '其他']
        ])) +
        F('开始日期', inp('startDate', 'date', pl.startDate)) +
        F('结束日期', inp('endDate', 'date', pl.endDate)) +
        F('剂量 Gy', inp('doseGy', 'number', pl.doseGy, '76px')) +
        F('分割次数', inp('fractions', 'number', pl.fractions, '76px')) +
        F('靶区', sel('target', pl.target, [
          ['', '未填'], ['prostate', '前列腺'], ['pelvis', '盆腔'],
          ['prostate_pelvis', '前列腺+盆腔'], ['metastasis', '转移灶'], ['other', '其他']
        ])) +
        F('同期 ADT', tri('concurrentAdt', pl.concurrentAdt, '是', '否')) +
        F('ADT 时长（月）', inp('adtDurationMonths', 'number', pl.adtDurationMonths, '80px')) +
        F('技术', inp('technique', 'text', pl.technique, '120px')) +
        F('毒性分级', inp('toxicityGrade', 'text', pl.toxicityGrade, '90px')) +
        F('当前放疗（同步 rtEndDate）', tri('isCurrent', pl.isCurrent, '是', '否')) +
        F('备注', inp('notes', 'text', pl.notes, '190px'));
    }

    if (it.kind === 'outcome') {
      return F('结局类型', sel('outcomeType', pl.outcomeType, [
          ['BCR', '生化复发'], ['CRPC', '去势抵抗'], ['metastasis', '转移'],
          ['death', '死亡'], ['lost', '失访']
        ])) +
        F('结局日期', inp('eventDate', 'date', pl.eventDate)) +
        F('亚型', inp('subtype', 'text', pl.subtype, '110px')) +
        F('依据', sel('basis', pl.basis, [['', '未填'], ['PSA', 'PSA'], ['imaging', '影像'], ['both', 'PSA+影像'], ['clinical', '临床']])) +
        F('PSA 值', inp('psaValue', 'number', pl.psaValue, '86px')) +
        F('影像阴性', tri('imagingNegative', pl.imagingNegative, '是', '否')) +
        F('转移部位（逗号分隔）', arr('metastaticSites', pl.metastaticSites)) +
        F('病灶数', inp('lesionCount', 'number', pl.lesionCount, '76px')) +
        F('寡转移状态', sel('oligoStatus', pl.oligoStatus, [['', '未评估'], ['none', '无转移'], ['oligo', '寡转移'], ['widespread', '广泛转移'], ['unknown', '未知']])) +
        F('死因', sel('deathCause', pl.deathCause, [['', '未填'], ['prostate_cancer', '前列腺癌'], ['other', '其他'], ['unknown', '不明']])) +
        F('失访原因', inp('lostReason', 'text', pl.lostReason, '140px')) +
        F('末次接触日期', inp('lastContactDate', 'date', pl.lastContactDate)) +
        F('备注', inp('notes', 'text', pl.notes, '190px'));
    }

    if (it.kind === 'event') {
      const types = (ai.dict && ai.dict.eventTypes) || [];
      const cur = pl.type;
      const opts = (cur && !types.includes(cur) ? [cur].concat(types) : types);
      return F('日期', inp('date', 'date', pl.date)) +
        F('活动', '<select onchange="AiUI.edit(' + it.id + ',\'type\',this.value)" style="max-width:230px">' +
          opts.map(t => '<option value="' + esc(t) + '"' + (t === cur ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>') +
        F('Gleason', inp('gleason', 'text', pl.gleason, '84px')) +
        F('分期', inp('stage', 'text', pl.stage, '104px')) +
        F('备注', inp('notes', 'text', pl.notes, '190px'));
    }

    return '<span class="ai-f">' + esc(JSON.stringify(pl)) + '</span>';
  }

  /* 三态按钮组：未评估 / 是 / 否。默认停在「未评估」，
     与既有 triSelectHtml 的三态语义保持一致。 */
  function triButtons(itemId, val, yesText, noText) {
    const v = val == null || val === '' ? '' : (val ? '1' : '0');
    return '<span class="ai-tri">' +
      '<button type="button" class="na ' + (v === '' ? 'on' : '') + '" onclick="AiUI.editTri(' + itemId + ',null)">未评估</button>' +
      '<button type="button" class="' + (v === '1' ? 'on' : '') + '" onclick="AiUI.editTri(' + itemId + ',true)">' + esc(yesText) + '</button>' +
      '<button type="button" class="' + (v === '0' ? 'on' : '') + '" onclick="AiUI.editTri(' + itemId + ',false)">' + esc(noText) + '</button></span>';
  }

  function fieldLabel(f) {
    return ({
      name: '姓名', birth: '出生日期', date: '确诊日期', gleason: 'Gleason',
      clinicalStage: '临床分期 cTNM', pathologicStage: '病理分期 pTNM',
      treatment: '首选治疗', concomitantMeds: '合并用药',
      rtEndDate: '放疗结束', adtStartDate: 'ADT 开始', lastFollowupDate: '末次随访',
      lastFollowupMode: '随访方式', metCount: '转移灶数', oligoType: '瘤负荷类型',
      familyHistoryDetail: '家族史', ecog: 'ECOG', charlson: 'Charlson', bmi: 'BMI', smoking: '吸烟'
    })[f] || f;
  }

  /* ---------- 交互 ---------- */
  function mergeDup(id) {
    ai.force[id] = false;
    ai.decisions[id] = 'reject';
    renderReview();
  }
  function keepDup(id) {
    const it = (ai.session.items || []).find(x => x.id === id);
    if (it && it.kind === 'profile' && !canAdoptProfileItem(it)) {
      return say(it.overwriteBlocked
        ? '⚠ ' + it.overwriteBlocked + '，本条不能直接覆盖'
        : '⚠ 该字段已有档案值，本条无需写入');
    }
    ai.force[id] = true;
    ai.decisions[id] = 'adopt';
    renderReview();
  }
  function decide(id, v) {
    const it = (ai.session.items || []).find(x => x.id === id);
    if (v === 'adopt' && it && it.kind === 'profile' && !canAdoptProfileItem(it)) {
      return say(it.overwriteBlocked
        ? '⚠ ' + it.overwriteBlocked + '，本条不能直接覆盖'
        : '⚠ 该字段已有档案值，本条无需写入');
    }
    ai.decisions[id] = (ai.decisions[id] === v) ? '' : v;   /* 再点一次取消 */
    /* 重复项点“采纳”必须等同于“单独保留”，否则后端会按默认策略跳过，
       医生会以为已经写入。 */
    if (v === 'adopt' && it && it.duplicateOf) ai.force[id] = true;
    if (v !== 'adopt') ai.force[id] = false;
    renderReview();
  }
  /* 全选只选“可写入项”：已有档案值的主档项（含冲突项）必须医生逐条确认，
     不能被批量全选绕过。 */
  function allAdopt() {
    (ai.session.items || []).forEach(i => {
      if (i.duplicateOf) return;
      if (i.kind === 'profile' && i.hasExisting) return;
      ai.decisions[i.id] = 'adopt';
    });
    renderReview();
  }
  function allNone() { Object.keys(ai.decisions).forEach(k => { ai.decisions[k] = ''; }); renderReview(); }

  function edit(id, key, val) {
    ai.edits[id] = Object.assign({}, ai.edits[id], { [key]: val });
    /* belowLod / freeBelowLod 切换会增减「下限值」输入框，需重绘该卡片 */
    if (key === 'belowLod' || key === 'freeBelowLod' || key === 'unit' || key === 'category' || key === 'type') {
      const it = (ai.session.items || []).find(x => x.id === id);
      if (it) {
        const el = document.getElementById('ai-item-' + id);
        if (el) {
          const merged = Object.assign({}, it.payload, ai.edits[id]);
          const keep = { ...it, payload: merged };
          el.querySelector('.ai-fields').innerHTML = renderFields(keep, merged);
        }
      }
    }
  }
  function editTri(id, val) {
    ai.edits[id] = Object.assign({}, ai.edits[id], { value: val });
    renderReview();
  }

  /* ---------- 采纳 / 拒绝 ---------- */
  async function adopt(btn) {
    const d = ai.session;
    if (!d) return;
    const decisions = (d.items || [])
      .filter(it => ai.decisions[it.id])
      .map(it => ({
        itemId: it.id,
        decision: ai.decisions[it.id],
        /* 医生改过的字段随 value 提交；后端存进 edited_value 作为标注数据 */
        value: ai.edits[it.id] || undefined,
        /* 主档红标冲突项被医生显式采纳时，允许后端覆盖现有档案值 */
        overwrite: !!(it.kind === 'profile' && it.conflict && !it.overwriteBlocked),
        force: !!ai.force[it.id]
      }));
    const nAdopt = decisions.filter(x => x.decision === 'adopt').length;
    if (!nAdopt) { say('⚠ 请至少选择一项采纳'); return; }

    const nDanger = (d.items || []).filter(it => ai.decisions[it.id] === 'adopt' && it.risk === 'danger').length;
    const nOverwrite = decisions.filter(x => x.decision === 'adopt' && x.overwrite).length;
    let msg = '将写入 ' + nAdopt + ' 项到 ' + (d.patientId || '新建患者') + ' 的病历。\n\n';
    if (nOverwrite) msg += '⚠ 其中 ' + nOverwrite + ' 项与现有档案冲突，将用材料值覆盖现有档案值。\n\n';
    if (nDanger) msg += '⚠ 其中 ' + nDanger + ' 项被标记为「必须确认」，请确保已逐条核对原文依据。\n\n';
    msg += '写入后不可一键撤销（需逐条删除）。确认继续？';
    if (!confirm(msg)) return;

    if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }
    let r;
    try {
      r = await call('/api/ai-intake/sessions/' + d.id + '/adopt', { method: 'POST', body: JSON.stringify({ decisions }) });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '采纳所选并写入病历'; }
      return say('⚠ ' + (e.message || '采纳失败'));
    }
    if (btn) { btn.disabled = false; btn.textContent = '采纳所选并写入病历'; }

    let m = '✅ 已写入 ' + r.adopted + ' 项';
    if (r.overwritten) m += '（其中覆盖现有值 ' + r.overwritten + ' 项）';
    if ((r.skipped || []).length) m += '，跳过 ' + r.skipped.length + ' 项';
    if ((r.errors || []).length) m += '，失败 ' + r.errors.length + ' 项';
    say(m);
    if ((r.errors || []).length || (r.skipped || []).length) {
      const detail = (r.errors || []).map(e => '✗ ' + (e.drug || e.type || e.kind) + '：' + e.reason)
        .concat((r.skipped || []).map(s => '⊘ ' + s.field + '：' + s.reason)).join('\n');
      setTimeout(() => alert('以下项未写入：\n\n' + detail), 300);
    }

    /* 刷新患者数据，让时间轴/PSA 曲线立即反映新记录 */
    ai.session = null;
    const box = document.getElementById('ai-review');
    if (box) box.innerHTML = '<div class="ai-panel"><div class="ai-banner info">已完成写入，可在「档案」「病程」「PSA/睾酮」等页签查看结果。</div></div>';
    clearFiles();
    if (typeof window.reload === 'function') {
      try { await window.reload(); } catch (e) { console.warn('[ai-intake] reload 失败', e); }
    }
    loadHistory();
  }

  async function reject() {
    const d = ai.session;
    if (!d) return;
    const reason = prompt('拒绝原因（可选，用于改进识别质量）：', '') ;
    if (reason === null) return;
    try {
      await call('/api/ai-intake/sessions/' + d.id + '/reject', { method: 'POST', body: JSON.stringify({ reason }) });
      say('已拒绝该批结果');
      ai.session = null;
      const box = document.getElementById('ai-review');
      if (box) box.innerHTML = '';
      loadHistory();
    } catch (e) { say('⚠ ' + (e.message || '操作失败')); }
  }

  /* ---------- 历史会话 ---------- */
  async function loadHistory() {
    const box = document.getElementById('ai-history');
    if (!box) return;
    /* 患者隔离：必须带 patientId，后端只返回该患者的会话。
       不带的话后端会回退到「按创建人」或「admin 看全部」，
       界面上就会出现其他患者的识别记录。 */
    const pid = ai.currentPid;
    if (!pid) { box.innerHTML = '<div class="ai-empty">请先选择患者</div>'; return; }
    let list;
    try { list = await call('/api/ai-intake/sessions?limit=10&patientId=' + encodeURIComponent(pid)); }
    catch (e) { box.innerHTML = '<div class="ai-empty">历史加载失败</div>'; return; }
    /* 响应回来时可能已切到别的患者：不画，避免串页 */
    if (ai.currentPid !== pid) return;
    if (!list || !list.length) { box.innerHTML = '<div class="ai-empty">该患者还没有识别记录</div>'; return; }

    const ST = { pending: '待审核', adopted: '已采纳', rejected: '已拒绝', failed: '失败', queued: '排队中', preprocessing: '处理中', redacting: '脱敏中', extracting: '识别中' };
    box.innerHTML = list.map(s => {
      const stCls = ['queued', 'preprocessing', 'redacting', 'extracting'].includes(s.status) ? 'run' : s.status;
      const st = s.stats || {};
      const running = stCls === 'run';
      return '<div class="ai-sess">' +
        '<span class="ai-st ' + stCls + '">' + esc(ST[s.status] || s.status) + '</span>' +
        '<span>' + esc((s.createdAt || '').replace('T', ' ').slice(0, 16)) + '</span>' +
        '<span style="color:var(--text-light,#58747c)">' + esc(s.docType || '-') + '</span>' +
        '<span>' + esc(s.fileCount || 0) + ' 张图</span>' +
        (s.modelUsed ? '<span style="color:var(--text-light,#58747c)">' + esc(s.modelUsed) + '</span>' : '') +
        (st.total ? '<span>采纳 ' + esc(st.adopted || 0) + ' / 改 ' + esc(st.edited || 0) + ' / 拒 ' + esc(st.rejected || 0) + '</span>' : '') +
        '<span style="flex:1"></span>' +
        (running
          ? '<button type="button" class="ai-btn" onclick="AiUI.resume(\'' + esc(s.id) + '\')">查看进度</button>'
          : (s.status === 'pending'
            ? '<button type="button" class="ai-btn" onclick="AiUI.open(\'' + esc(s.id) + '\')">继续审核</button>'
            : '<button type="button" class="ai-btn" onclick="AiUI.open(\'' + esc(s.id) + '\')">查看</button>')) +
        '<button type="button" class="ai-btn" onclick="AiUI.del(\'' + esc(s.id) + '\')" title="删除会话与材料">删</button>' +
        '</div>';
    }).join('');
  }

  function open(sid) { openReview(sid); document.getElementById('ai-review').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  function resume(sid) { startPoll(sid); }

  async function del(sid) {
    if (!confirm('删除该会话及其上传的材料图片？此操作不可恢复。')) return;
    try {
      await call('/api/ai-intake/sessions/' + sid, { method: 'DELETE' });
      say('已删除');
      if (ai.session && ai.session.id === sid) { ai.session = null; const b = document.getElementById('ai-review'); if (b) b.innerHTML = ''; }
      loadHistory();
    } catch (e) { say('⚠ ' + (e.message || '删除失败')); }
  }

  /* ---------- 对外暴露 ---------- */
  window.AiUI = {
    renderAiPane, onFiles, onDrop, rmFile, clearFiles, submit,
    decide, mergeDup, keepDup, allAdopt, allNone, edit, editTri, adopt, reject,
    open, resume, del, viewImg, loadHistory, _state: ai
  };
  /* renderEdit() 通过全局函数名调用 */
  window.renderAiRegistration = renderAiPane;
})();

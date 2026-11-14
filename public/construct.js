/* =========================================================================
 * 红色构成 · 随机构成装饰层 V2
 * -------------------------------------------------------------------------
 * 只做视觉：注入纯装饰节点（aria-hidden / pointer-events:none），
 * 为卡片分配色纸与强调色、驱动入场动画与点击涟漪。
 * 不修改任何业务 DOM 的文字、结构或事件；登录页文案允许重写。
 * 随机使用固定种子，构图稳定可复现。
 * ========================================================================= */
(function () {
  'use strict';

  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry(20261112);
  const pick = a => a[Math.floor(rnd() * a.length)];
  /* 松绿构成：装饰主色为松绿系，蓝黄仅作构成主义点缀；红色不参与装饰 */
  const PALETTE = ['#00694B', '#2A4E86', '#E0AE33', '#111111'];
  const SAT = ['#00694B', '#00A870', '#2A4E86', '#2A7480', '#5A4A87', '#6B8E23', '#00875A'];

  function el(tag, cls, css) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.setAttribute('aria-hidden', 'true');
    if (css) n.style.cssText = css;
    return n;
  }

  /* ---- 多层漂移几何背景 ---- */
  function buildBg() {
    if (document.querySelector('.cx-bg')) return;
    const wrap = el('div', 'cx-bg');
    const wrap2 = el('div', 'cx-bg2');
    const shapes = 16;
    for (let i = 0; i < shapes; i++) {
      const layer = i % 2 ? wrap2 : wrap;
      const s = el('i');
      const size = 40 + Math.floor(rnd() * 180);
      const c = pick(SAT);
      const kind = rnd();
      let css = 'left:' + (rnd() * 100) + '%;top:' + (rnd() * 100) + '%;width:' + size + 'px;height:' + size + 'px;';
      css += '--o:' + (0.05 + rnd() * 0.09).toFixed(2) + ';--d:' + (18 + Math.floor(rnd() * 22)) + 's;--dl:-' + Math.floor(rnd() * 20) + 's;';
      if (kind < 0.34) { css += 'border-radius:50%;background:' + c; }
      else if (kind < 0.62) { css += 'background:' + c + ';clip-path:polygon(50% 0,100% 100%,0 100%)'; }
      else if (kind < 0.82) { css += 'border:3px solid ' + c + ';background:transparent'; }
      else { css += 'background:repeating-linear-gradient(45deg,' + c + ' 0 3px,transparent 3px 9px)'; }
      s.style.cssText = css;
      layer.appendChild(s);
    }
    document.body.appendChild(wrap);
    document.body.appendChild(wrap2);
  }

  /* ---- 登录页键盘焦点陷阱：Tab 只在登录控件内循环 ---- */
  function loginFocusables() {
    const ls = document.getElementById('loginScreen');
    if (!ls) return [];
    return Array.prototype.filter.call(
      ls.querySelectorAll('input, button, select, textarea, a[href], [tabindex]'),
      (n) => {
        if (n.disabled || n.getAttribute('tabindex') === '-1') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = n.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      }
    );
  }
  document.addEventListener('keydown', (e) => {
    const ls = document.getElementById('loginScreen');
    if (!ls || ls.classList.contains('hidden')) return;
    if (e.key !== 'Tab') return;
    const items = loginFocusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (!ls.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }, true);
  /* 焦点若因任何原因落到登录页之外，立即拉回 */
  document.addEventListener('focusin', (e) => {
    const ls = document.getElementById('loginScreen');
    if (!ls || ls.classList.contains('hidden')) return;
    if (ls.contains(e.target)) return;
    const items = loginFocusables();
    if (items.length) items[0].focus();
  }, true);

  /* ---- 登录页滚动锁定：登录页就是登录页，不允许下拉看到应用内容 ---- */
  function syncLoginLock() {
    const ls = document.getElementById('loginScreen');
    if (!ls) return;
    const onLogin = !ls.classList.contains('hidden');
    const root = document.documentElement;
    if (onLogin) {
      if (!root.classList.contains('pcd-login-lock')) {
        root.classList.add('pcd-login-lock');
        window.scrollTo(0, 0);
      }
      /* 应用层在登录态不参与布局与焦点 */
      document.querySelectorAll('header, main').forEach((n) => {
        if (!n.hasAttribute('inert')) n.setAttribute('inert', '');
        n.setAttribute('aria-hidden', 'true');
      });
    } else {
      root.classList.remove('pcd-login-lock');
      document.querySelectorAll('header, main').forEach((n) => {
        n.removeAttribute('inert');
        n.removeAttribute('aria-hidden');
      });
    }
  }

  /* ---- 登录页海报 ---- */
  function buildLogin() {
    const story = document.querySelector('.login-story');
    const box = document.querySelector('.login-box');
    if (!story || !box) return;
    if (!story.dataset.cxBuilt) {
      story.dataset.cxBuilt = '1';
      story.innerHTML =
        '<div class="cx-login-head">' +
        '<div class="brand-lockup">' +
          '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></span>' +
          '<div><strong>XX医院 · 泌尿外科</strong><small>PROSTATE CANCER RESEARCH DATABASE</small></div>' +
        '</div>' +
        '<div class="cx-login-eyebrow" aria-hidden="true">SINGLE-DISEASE RESEARCH DATABASE</div>' +
        '<h2>让每一例病例，<br><span class="cx-quote-accent">都成为证据。</span></h2>' +
        '<p>聚焦前列腺癌单一病种，统一变量与随访口径，把日常诊疗沉淀为可检索、可统计、可复用的研究队列。</p>' +
        '</div>' +
        '<div class="cx-login-body">' +
        '<figure class="cx-login-chart">' +
          '<figcaption class="cx-chart-cap"><span>PSA 随访趋势 · 示意</span><b>ng/mL</b></figcaption>' +
          '<svg class="login-art" viewBox="0 0 400 178" fill="none" aria-hidden="true">' +
            '<path d="M0 40H400M0 85H400M0 130H400" stroke="rgba(255,255,255,.28)" stroke-width=".7"/>' +
            '<path d="M20 25L90 74L160 99L230 115L300 124L380 127" stroke="#E0AE33" stroke-width="3"/>' +
            '<path d="M20 25L90 74L160 99L230 115L300 124L380 127V150H20Z" fill="#E0AE33" fill-opacity=".2"/>' +
            '<g fill="#111111" stroke="#E0AE33" stroke-width="2"><rect x="15" y="20" width="10" height="10"/><rect x="85" y="69" width="10" height="10"/><rect x="155" y="94" width="10" height="10"/><rect x="225" y="110" width="10" height="10"/><rect x="295" y="119" width="10" height="10"/><rect x="375" y="122" width="10" height="10"/></g>' +
            '<g fill="rgba(255,255,255,.9)" font-size="9.5" font-family="sans-serif" letter-spacing="1"><text x="5" y="172">诊断</text><text x="148" y="172">治疗</text><text x="322" y="172">持续随访</text></g>' +
          '</svg>' +
        '</figure>' +
        '<div class="cx-login-metrics">' +
          '<div class="cx-metric"><i>01</i><b>专病档案</b><span>诊断 · 分期 · 治疗 · 随访</span></div>' +
          '<div class="cx-metric"><i>02</i><b>连续监测</b><span>PSA · 睾酮 · 影像 · 化验</span></div>' +
          '<div class="cx-metric"><i>03</i><b>科研数据</b><span>队列构建 · 导出统计 · 辅助研究</span></div>' +
        '</div>' +
        '</div>' +
        '<div class="story-footer"><span>单病种科研数据 · 长期随访</span><span>UROLOGY</span></div>';
      const bar = el('div', 'cx-login-bar');
      PALETTE.forEach(c => bar.appendChild(el('i', '', 'background:' + c)));
      story.appendChild(bar);
      story.appendChild(el('div', 'cx-login-tri'));
    }
    const eyebrow = box.querySelector('.login-eyebrow');
    if (eyebrow) eyebrow.textContent = 'RESEARCH WORKSPACE';
    const h2 = box.querySelector('h2');
    if (h2) h2.textContent = '登录科研工作台';
    const sub = box.querySelector('.sub');
    if (sub) sub.textContent = 'XX医院前列腺癌单病种科研数据库';
    /* 底部提示：定位改为单病种科研数据库，保留授权、存储与免责三项事实 */
    const tip = box.querySelector('.login-tip');
    if (tip) {
      tip.innerHTML = '账号由管理员统一分配<br>科研数据统一存储于服务器<br>' +
        '<span style="opacity:.72">本系统为前列腺癌单病种科研数据库，自动判定仅供科研与临床参考，诊疗决策以医生判断为准。</span>';
    }

    /* 右栏框景：顶部标识条 + 底部安全条（纯装饰文案，登录页允许） */
    if (!box.querySelector('.cx-login-top')) {
      const top = document.createElement('div');
      top.className = 'cx-login-top';
      top.innerHTML = '<span class="cx-lt-mark" aria-hidden="true"></span>' +
        '<span class="cx-lt-txt">SECURE CLINICAL ACCESS</span>' +
        '<span class="cx-lt-dot" aria-hidden="true"></span>';
      box.insertBefore(top, box.firstChild);
    }

    /* 把原有控件整体移入聚焦白卡：只移动节点，不改结构、文案与事件 */
    if (!box.querySelector('.cx-login-card')) {
      const card = document.createElement('div');
      card.className = 'cx-login-card';
      const keep = ['.login-eyebrow', 'h2', '.sub', 'label[for="login-user"]', '#login-user',
        'label[for="login-pass"]', '.pass-field', '#login-err', '.btn', '.login-tip'];
      keep.forEach((sel) => {
        const n = box.querySelector(sel);
        if (n && n.parentElement === box) card.appendChild(n);
      });
      box.appendChild(card);
    }
    /* 底部安全条必须在白卡之后，保证视觉顺序为 标识条 → 卡片 → 安全条 */
    if (!box.querySelector('.cx-login-foot')) {
      const foot = document.createElement('div');
      foot.className = 'cx-login-foot';
      foot.innerHTML = '<span>院内授权访问 · 操作留痕可审计</span><b>PCD · 2.0</b>';
      box.appendChild(foot);
    }

    /* 错误文案较长时保留完整 title，便于悬停查看 */
    const errBox = document.getElementById('login-err');
    if (errBox && !errBox.dataset.cxTitle) {
      errBox.dataset.cxTitle = '1';
      const sync = () => { errBox.title = errBox.innerText || ''; };
      new MutationObserver(sync).observe(errBox, { childList: true, characterData: true, subtree: true });
      sync();
    }

    /* 输入反馈：出错后重新输入即清除错误标记 */
    ['login-user', 'login-pass'].forEach((id) => {
      const n = document.getElementById(id);
      if (!n || n.dataset.cxBound) return;
      n.dataset.cxBound = '1';
      n.addEventListener('input', () => {
        n.classList.remove('cx-bad');
        const e = document.getElementById('login-err');
        if (e && e.innerText) e.innerText = '';
      });
    });
  }

  /* ---- 患者头部徽章语义配色 ----
   * 业务只给「风险/疾病/随访/预警」四类徽章带 chip- 或 tone- 前缀类，
   * 年龄、分期、Gleason、ISUP、治疗段是裸 .ws2-badge，此前被统一刷成白底。
   * 这里按文案前缀补语义类，让每枚徽章有自己的颜色；不改文字与结构。 */
  const CHIP_RULES = [
    [/^\d+\s*岁/, 'cx-c-age'],
    [/^[cp]?[Ty]?\d|^cT|^pT|^T\d|^N\d|^M\d/, 'cx-c-stage'],
    [/Gleason/i, 'cx-c-gleason'],
    [/ISUP/i, 'cx-c-isup'],
    [/^风险[：:]/, 'cx-c-risk'],
    [/^疾病[：:]/, 'cx-c-disease'],
    [/^随访[：:]/, 'cx-c-follow'],
    [/手术|切除|放疗|ADT|ARPI|化疗|内分泌|监测|观察|未建治疗段/, 'cx-c-treat']
  ];
  function tintHeader() {
    const head = document.getElementById('edit-title');
    if (!head) return;
    head.querySelectorAll('.ws2-badge').forEach((chip) => {
      const txt = (chip.textContent || '').trim();
      /* 预警徽章已有 tone-*，只标记它是预警，不参与前缀匹配 */
      if (chip.classList.contains('ws2-warn')) {
        if (!chip.classList.contains('cx-c-alert')) chip.classList.add('cx-c-alert');
        return;
      }
      const hit = CHIP_RULES.find(([re]) => re.test(txt));
      const cls = hit ? hit[1] : 'cx-c-misc';
      if (chip.dataset.cxc === cls) return;
      chip.dataset.cxc = cls;
      CHIP_RULES.forEach(([, c]) => chip.classList.remove(c));
      chip.classList.remove('cx-c-misc');
      chip.classList.add(cls);
    });
    /* 四个操作按钮：主操作 + 三个次操作各自取色 */
    head.querySelectorAll('.ws2-head-actions .btn').forEach((btn, i) => {
      if (btn.dataset.cxa) return;
      btn.dataset.cxa = '1';
      btn.classList.add('cx-a' + Math.min(i, 3));
    });
  }

  /* ---- 临床摘要分区 + 指南评估条目标记 ----
   * 摘要九个分区按标题语义配色；指南评估每行补编号与语义类，
   * 让「标签 ↔ 结论 ↔ 依据」三段一眼对得上。只加类与纯装饰编号，
   * 不改任何临床文字、结构与事件。 */
  const SUM_RULES = [
    [/疾病状态|预警/, 'cx-s-risk'], [/当前治疗/, 'cx-s-treat'], [/就诊|毒性/, 'cx-s-visit'],
    [/病理|分子/, 'cx-s-path'], [/结局/, 'cx-s-outcome'], [/检验/, 'cx-s-lab'],
    [/随访/, 'cx-s-plan'], [/合并症/, 'cx-s-comorb'], [/数据质量/, 'cx-s-quality']
  ];
  function tintSummary() {
    document.querySelectorAll('#summaryBody .sum-grid > section').forEach((sec) => {
      const h = sec.querySelector('h3');
      if (!h) return;
      const hit = SUM_RULES.find(([re]) => re.test(h.textContent || ''));
      const cls = hit ? hit[1] : 'cx-s-misc';
      if (sec.dataset.cxs !== cls) {
        sec.dataset.cxs = cls;
        SUM_RULES.forEach(([, c]) => sec.classList.remove(c));
        sec.classList.remove('cx-s-misc');
        sec.classList.add(cls);
      }
      if (!h.querySelector('.cx-s-num')) {
        const idx = [...sec.parentElement.children].indexOf(sec) + 1;
        const num = el('i', 'cx-s-num');
        num.textContent = String(idx).padStart(2, '0');
        h.insertBefore(num, h.firstChild);
      }
    });
  }
  const CSCO_RULES = [
    [/疾病状态/, 'cx-g-disease'], [/预警/, 'cx-g-warn'], [/去势/, 'cx-g-castrate'],
    [/风险分层/, 'cx-g-risk'], [/ISUP|分级/, 'cx-g-isup'], [/治愈/, 'cx-g-cure'],
    [/PSADT|PSAV|nadir/, 'cx-g-kinetic'], [/复发/, 'cx-g-bcr'],
    [/CRPC|进展/, 'cx-g-crpc']
  ];
  function markCsco() {
    const heads = [...document.querySelectorAll('.ws2-card-h')];
    const head = heads.find((h) => (h.textContent || '').includes('指南评估'));
    if (!head) return;
    const card = head.closest('.ws2-card');
    const wrap = head.nextElementSibling;
    if (!card || !wrap || !wrap.children.length) return;
    if (!card.classList.contains('cx-csco')) card.classList.add('cx-csco');
    if (!wrap.classList.contains('cx-g-list')) wrap.classList.add('cx-g-list');
    [...wrap.children].forEach((row, i) => {
      if (!row.classList.contains('cx-g-row')) row.classList.add('cx-g-row');
      const label = row.children[0];
      const val = row.children[1];
      if (label && !label.classList.contains('cx-g-k')) label.classList.add('cx-g-k');
      if (val && !val.classList.contains('cx-g-v')) val.classList.add('cx-g-v');
      const hit = CSCO_RULES.find(([re]) => re.test(label ? label.textContent : ''));
      const cls = hit ? hit[1] : 'cx-g-misc';
      if (row.dataset.cxg !== cls) {
        row.dataset.cxg = cls;
        CSCO_RULES.forEach(([, c]) => row.classList.remove(c));
        row.classList.remove('cx-g-misc');
        row.classList.add(cls);
      }
      if (label && !label.querySelector('.cx-g-num')) {
        const num = el('i', 'cx-g-num');
        num.textContent = String(i + 1).padStart(2, '0');
        label.insertBefore(num, label.firstChild);
      }
    });
  }

  /* ---- 药物特异性监测：状态下拉三态配色 ----
   * 业务只给 .mon-select 一个裸 select（未做/已完成/异常），没有状态类。
   * 这里按当前选中值补 cx-mon-todo/done/abn，并给所在格补左标记类，
   * 让「异常」在扫视时就能定位，不必逐个读下拉文字。
   * 只加类，不改文字、结构与 onchange 绑定；写入前先比对，保证幂等。 */
  const MON_CLS = { '未做': 'cx-mon-todo', '已完成': 'cx-mon-done', '异常': 'cx-mon-abn' };
  function tintMonitors() {
    document.querySelectorAll('.mon-select').forEach((sel) => {
      const cls = MON_CLS[String(sel.value || '').trim()] || 'cx-mon-todo';
      if (sel.dataset.cxm !== cls) {
        sel.dataset.cxm = cls;
        Object.values(MON_CLS).forEach((c) => { if (c !== cls) sel.classList.remove(c); });
        if (!sel.classList.contains(cls)) sel.classList.add(cls);
      }
      const cell = sel.closest('.mon-item');
      if (!cell) return;
      const mark = cls === 'cx-mon-abn' ? 'cx-mon-cell-abn' : cls === 'cx-mon-done' ? 'cx-mon-cell-done' : '';
      if (cell.dataset.cxmc === mark) return;
      cell.dataset.cxmc = mark;
      cell.classList.remove('cx-mon-cell-abn', 'cx-mon-cell-done');
      if (mark) cell.classList.add(mark);
    });
  }
  /* 医生改下拉后立即换色：change 会冒泡到 document，卡片重建也不丢绑定 */
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('mon-select')) tintMonitors();
  }, true);

  /* ---- 卡片配色：稳定索引 + 轻微随机偏移 ---- */
  function tintCards() {
    const groups = [
      ['.chart-card', 0], ['.pie-card', 2], ['.ws2-card', 1], ['.ov-panel', 3],
      ['.ws2-option', 5], ['.med-item', 6], ['.ws2-episode', 0],
      ['.ws2-summary-card', 1], ['.cohort-panel', 2], ['.cr-panel', 4], ['.stage-block', 5]
    ];
    groups.forEach(([sel, base]) => {
      document.querySelectorAll(sel).forEach((c, i) => {
        if (c.dataset.cxTint) return;
        c.dataset.cxTint = '1';
        const t = (base + i + (rnd() > 0.8 ? 1 : 0)) % 7;
        c.classList.add('cx-t' + t);
      });
    });
    /* 随访计划卡的颜色必须来自完成状态（over/missing/scheduled/pending），
       不能进随机色纸循环，否则同一「待完成」会被染成青/奶油等与图例不符的颜色。
       这里清掉历史残留的 cx-t*，让 CSS 的状态色唯一生效。 */
    document.querySelectorAll('.ws2-plan-item').forEach((c) => {
      c.className = c.className.replace(/\bcx-t\d\b/g, '').replace(/\s+/g, ' ').trim();
      delete c.dataset.cxTint;
    });
    /* 面板标题色条循环 */
    document.querySelectorAll('.panel-title').forEach((p, i) => {
      /* 业务会在选中患者后补上 tone-*（风险语义色）。此时必须撤掉装饰循环色类，
         否则两套规则打架，标题栏会出现与风险不符的底色/描边。 */
      if (/tone-/.test(p.className)) {
        if (p.dataset.cxBar) {
          p.className = p.className.replace(/\bcx-b\d\b/g, '').replace(/\s+/g, ' ').trim();
          delete p.dataset.cxBar;
        }
        return;
      }
      if (p.dataset.cxBar) return;
      p.dataset.cxBar = '1';
      p.classList.add('cx-b' + (i % 5));
    });
    /* KPI 语义配色：按真实 DOM 顺序分配，深色块反白、浅色块墨字 */
    document.querySelectorAll('.ov-kpis, .stats, .kpis').forEach((row) => {
      Array.prototype.forEach.call(row.children, (k, i) => {
        if (!k.matches('.ov-kpi, .stat-card')) return;
        if (k.dataset.cxK) return;
        k.dataset.cxK = '1';
        const label = (k.querySelector('.ov-kpi-label, .stat-label') || {}).textContent || '';
        let cls;
        /* 只有「紧急预警」保留醒目红块；CRPC/转移等累计量改用柔和陶土底，避免总览一片红 */
        if (/紧急|预警/.test(label)) cls = 'cx-k-red';
        else if (/CRPC|转移|死亡|复发/.test(label)) cls = 'cx-k-clay';
        else if (/需关注|到期|逾期/.test(label)) cls = 'cx-k-yellow';
        else if (/就绪|达标|稳定/.test(label)) cls = 'cx-k-teal';
        else if (i === 0) cls = 'cx-k-blue';
        else cls = 'cx-k-tint cx-t' + (i % 7);
        cls.split(' ').forEach(c => k.classList.add(c));
        if (i !== 0) {
          k.style.setProperty('--cx-rot', ((rnd() - 0.5) * 0.5).toFixed(2) + 'deg');
          k.classList.add('cx-tilt');
        }
      });
    });
    /* 患者列表行：读取业务已渲染的风险圆点色，映射为语义类（绿=绿/黄=黄/红=红） */
    tintRows();
    /* 图表卡角标 */
    document.querySelectorAll('.chart-card, .pie-card').forEach((c) => {
      if (c.querySelector('.cx-deco')) return;
      const cs = getComputedStyle(c);
      if (cs.position === 'static') c.style.position = 'relative';
      const size = 10 + Math.floor(rnd() * 10);
      const c1 = pick(SAT);
      const shape = rnd() > 0.5 ? 'border-radius:50%' : '';
      c.appendChild(el('div', 'cx-deco', 'left:0;bottom:0;width:' + size + 'px;height:' + size + 'px;background:' + c1 + ';' + shape + ';opacity:.85'));
    });
  }

  /* ---- 弹窗滚动指示条 ----
   * 本机系统滚动条是覆盖式（静止时不可见），医生看不出弹窗还能往下滚。
   * 在弹窗右侧画一条常驻主题色指示条：轨道 + 滑块，随滚动移动，点击轨道可跳转。
   * 纯装饰 + 滚动控制，不改任何业务结构与文案。 */
  function paintScroll(body, bar) {
    const thumb = bar.firstElementChild;
    if (!thumb) return;
    const trackH = bar.clientHeight;
    const h = Math.max(28, Math.round(trackH * (body.clientHeight / body.scrollHeight)));
    const max = trackH - h;
    const span = body.scrollHeight - body.clientHeight;
    const top = span > 0 ? (body.scrollTop / span) * max : 0;
    thumb.style.height = h + 'px';
    thumb.style.transform = 'translateY(' + (isFinite(top) ? top : 0) + 'px)';
  }
  function bindScroll(body, bar) {
    if (bar.dataset.cxBound) return;
    bar.dataset.cxBound = '1';
    const jump = (ev) => {
      const r = bar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      body.scrollTop = ratio * (body.scrollHeight - body.clientHeight);
    };
    bindBarDrag(bar, jump);
    body.addEventListener('scroll', () => paintScroll(body, bar), { passive: true });
  }
  function syncModalScroll() {
    document.querySelectorAll('.ws2-modal-b, #summaryModal .summary-body').forEach((body) => {
      const modal = body.closest('.ws2-modal, .summary-dialog');
      if (!modal) return;
      let bar = modal.querySelector('.cx-scroll');
      if (body.scrollHeight - body.clientHeight <= 4) { if (bar) bar.remove(); return; }
      if (!bar) {
        bar = el('div', 'cx-scroll');
        bar.appendChild(el('i'));
        modal.appendChild(bar);
      }
      /* 监听必须每次同步都确保绑定：弹窗重开/内容重渲染可能重建指示条，
         只在创建时绑定会丢失监听（移动端曾因此拖不动）。 */
      bindScroll(body, bar);
      /* 指示条与内容区上下沿精确对齐：用 offsetTop/offsetHeight 取布局位置，
         避免弹窗入场动画的 transform 让 getBoundingClientRect 读到中间态。 */
      bar.style.top = body.offsetTop + 'px';
      bar.style.height = body.offsetHeight + 'px';
      bar.style.bottom = 'auto';
      paintScroll(body, bar);
    });
  }

  /* ---- 时间轴横向滚动条 ----
   * 原生滚动条在本机是覆盖式（静止不可见），此前用 ::after 画的灰色装饰带
   * 反而把它盖住了。这里在轨道下方画一条独立的常驻滚动条：
   * 有真实槽位、可点击跳转、可拖动，且绝不覆盖内容或原生控件。 */
  function paintHScroll(wrap, bar) {
    const thumb = bar.firstElementChild;
    if (!thumb) return;
    const trackW = bar.clientWidth;
    const w = Math.max(40, Math.round(trackW * (wrap.clientWidth / wrap.scrollWidth)));
    const max = trackW - w;
    const span = wrap.scrollWidth - wrap.clientWidth;
    const left = span > 0 ? (wrap.scrollLeft / span) * max : 0;
    thumb.style.width = w + 'px';
    thumb.style.transform = 'translateX(' + (isFinite(left) ? left : 0) + 'px)';
  }
  /* ---- 自绘滚动条的统一拖拽绑定 ----
   * 四处滚动条（弹窗纵向、诊疗时间轴、用药时间轴、概览缩略图）此前各自
   * 在 window 上挂 pointermove/pointerup，且从不处理 pointercancel：
   * 触摸被系统接管（例如判定为页面滚动）后监听残留，下一次拖动会叠加，
   * 表现为滑块乱跳。统一改为捕获到控件自身 + 按 pointerId 过滤 +
   * 三事件全解绑，保证一次拖动只有一路生效。 */
  function bindBarDrag(bar, jump) {
    if (bar.dataset.cxDrag) return;
    bar.dataset.cxDrag = '1';
    bar.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      jump(ev);
      const id = ev.pointerId;
      try { bar.setPointerCapture(id); } catch (e) { /* 不支持则退化 */ }
      const move = (e2) => { if (e2.pointerId === id) jump(e2); };
      const up = (e2) => {
        if (e2 && e2.pointerId !== id) return;
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        try { bar.releasePointerCapture(id); } catch (e) { /* 已释放 */ }
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }

  function syncTimelineScroll() {
    document.querySelectorAll('.tl-viewport').forEach((vp) => {
      const wrap = vp.querySelector('.tl-track-wrap');
      if (!wrap) return;
      let bar = vp.querySelector('.cx-hscroll');
      if (wrap.scrollWidth - wrap.clientWidth <= 4) { if (bar) bar.remove(); return; }
      if (!bar) {
        bar = el('div', 'cx-hscroll');
        bar.appendChild(el('i'));
        vp.appendChild(bar);
        const jump = (ev) => {
          const r = bar.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
          wrap.scrollLeft = ratio * (wrap.scrollWidth - wrap.clientWidth);
        };
        bindBarDrag(bar, jump);
        wrap.addEventListener('scroll', () => paintHScroll(wrap, bar), { passive: true });
      }
      paintHScroll(wrap, bar);
    });
  }

  /* ---- 用药时间轴横向浏览增强 ----
   * 画布按时间跨度给足像素（宁可横向滚动也不纵向堆叠），因此需要顺手的横滑：
   * ① 悬停在轴上时纵向滚轮直接转成横向滚动（不必记 Shift）；
   * ② 在空白处按住拖动可平移；点在药物条/说明上仍走原有备注弹窗。
   * 只增强滚动，不改任何业务 DOM、文字与事件。 */
  /* 说明标签吸附：横向滚动后，起点已滑出左边界的药物段，其说明会被裁成
     「个月」这类无意义残尾。这里把仍在视窗内的段的说明吸附到左边缘，
     药名始终可读；空间不足时按可用宽度省略，绝不与下一段说明重叠。 */
  function pinMedLabels(sc) {
    const left = sc.scrollLeft;
    const viewRight = left + sc.clientWidth;
    const GAP = 10;      /* 相邻说明之间的最小空隙 */
    const CHROME = 16;   /* 吸附态自身的左内边距 + 左边框 + 右内边距 */
    sc.querySelectorAll('.med-tl-cat-row').forEach((row) => {
      const details = [...row.querySelectorAll('.med-tl-detail')];
      const segs = [...row.querySelectorAll('.med-tl-seg')];
      /* 一次性算出每条说明的最终左沿与可用宽度，再统一写入。
         逐条边算边写会让后一条读到前一条已改动的几何，边界随视口漂移。 */
      const plan = details.map((d, i) => {
        if (d.dataset.cxw === undefined) d.dataset.cxw = d.style.width || '';
        const dl = d.offsetLeft;
        const seg = segs[i];
        const segRight = seg ? seg.offsetLeft + seg.offsetWidth : dl + d.offsetWidth;
        /* 紧凑标注（短程药单行）由渲染器按真实间距算好像素宽度，
           完全交给 CSS，不参与吸附改写，避免被覆盖后裁字。 */
        const isTight = d.classList.contains('cx-tight');
        const pinned = !isTight && dl < left - 0.5 && segRight > left + 14;
        return { d, i, dl, segRight, pinned, isTight, anchor: pinned ? left + 6 : dl, homeW: d.dataset.cxw };
      });
      /* 药名自然宽度必须缓存：吸附态给 b 加了 max-width:100% + 省略号，
         若每帧都量当前宽度，就会「变窄→量到更窄→再变窄」逐帧收缩，
         同一滚动位置往回到达时结果不同 → 横向滑动持续抖动。
         文字内容不变，自然宽度是常量，量一次即可。 */
      const canvasW = (sc.querySelector('.med-tl-canvas') || sc).clientWidth || 1;
      plan.forEach((it) => {
        const d = it.d;
        let nw = Number(d.dataset.cxnw || 0);
        if (!nw) {
          const nameEl = d.querySelector('b');
          let measured = 0;
          if (nameEl) {
            /* 在不受吸附约束的状态下量：临时解除宽度限制，量完立即还原 */
            const keepM = d.style.maxWidth;
            const hadPin = d.classList.contains('cx-pinned');
            if (hadPin) d.classList.remove('cx-pinned');
            d.style.maxWidth = 'none';
            try {
              const rg = document.createRange();
              rg.selectNodeContents(nameEl);
              measured = rg.getBoundingClientRect().width;
              rg.detach && rg.detach();
            } catch (e) { /* 量测失败下次再试 */ }
            d.style.maxWidth = keepM;
            if (hadPin) d.classList.add('cx-pinned');
          }
          /* 只有量到真实宽度才缓存。整览模式下说明区 display:none，
             此时量到 0；若把兜底值写进缓存，切到细看后会一直沿用偏小值，
             导致药名被截断。 */
          if (measured > 0) { nw = Math.ceil(measured); d.dataset.cxnw = String(nw); }
          else nw = 80;
        }
        it.nameW = nw;
        /* 原始宽度按画布宽度换算，不读 offsetWidth——那可能已被本函数改过 */
        const hw = String(it.homeW || '');
        it.homePx = hw.endsWith('%') ? (parseFloat(hw) / 100) * canvasW
          : (parseFloat(hw) || d.offsetWidth);
        it.tucked = false;
      });
      const anchorOf = (k) => (k < plan.length ? plan[k].anchor : viewRight);
      /* 从左到右分配。吸附（仍在用、起点已滑出左缘）的药名优先完整显示：
         若与下一条间距不够，就把下一条收起来，而不是把本条截成「亮…」。 */
      /* 第一阶段：只计算每条说明的目标态，绝不碰 DOM。
         旧实现「先清空 transform/width 再写回」，同一帧内一来一回，
         实测 24 次滚动产生 2646 次 style 改写 → 图标高频频闪。 */
      plan.forEach((it, i) => {
        const { d, dl, pinned, anchor } = it;
        const next = { width: it.homeW, maxWidth: '', transform: '', pin: '', pinned: false, tucked: !!it.tucked };
        if (it.isTight) {
          /* 紧凑标注宽度由渲染器定好，只决定是否整条收起。
             用缓存的原始宽度，不读可能已被改写的 offsetWidth。 */
          next.width = it.homeW;
          next.tucked = dl + it.homePx < left + 12;
        } else if (!it.tucked && pinned) {
          const need = it.nameW + CHROME;
          let limit = anchorOf(i + 1) - GAP;
          if (limit - anchor < need && i + 1 < plan.length && !plan[i + 1].pinned) {
            plan[i + 1].tucked = true;
            limit = anchorOf(i + 2) - GAP;
          }
          if (limit - anchor < need) {
            next.tucked = true;
          } else {
            next.pinned = true;
            next.width = need + 'px';
            next.maxWidth = need + 'px';
            next.transform = 'translateX(' + (anchor - dl).toFixed(1) + 'px)';
            const seg = segs[it.i];
            if (seg && seg.style.background) next.pin = seg.style.background;
          }
        } else if (!it.tucked) {
          const nextPinned = plan[i + 1] && plan[i + 1].pinned && !plan[i + 1].tucked;
          const avail = anchorOf(i + 1) - GAP - anchor;
          if (nextPinned && it.homePx > avail) {
            const wv = Math.max(0, avail) + 'px';
            next.width = wv; next.maxWidth = wv;
            next.tucked = avail < 28;
          }
        }
        it.next = next;
      });
      /* 第二阶段：与当前值逐项比对，只写真正变化的属性 */
      const setCls = (el, cls, on) => { if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on); };
      const setStyle = (el, prop, val) => { if (el.style.getPropertyValue(prop) !== val) el.style.setProperty(prop, val); };
      plan.forEach((it) => {
        const d = it.d, n = it.next;
        setStyle(d, 'width', n.width);
        setStyle(d, 'max-width', n.maxWidth);
        setStyle(d, 'transform', n.transform);
        if (n.pin) setStyle(d, '--cx-pin', n.pin);
        setCls(d, 'cx-pinned', n.pinned);
        setCls(d, 'cx-tucked', n.tucked);
      });
    });
  }
  /* 贴边刻度内侧对齐：刻度文字默认以刻度线为中心，横滑后靠近视窗左/右缘的
     刻度会被裁掉半截（如「2025-07」只剩「025-07」）。这里按实际位置改对齐方向。 */
  function alignMedTicks(sc) {
    const canvas = sc.querySelector('.med-tl-canvas');
    if (!canvas) return;
    const sr = sc.getBoundingClientRect();
    const ticks = [...canvas.querySelectorAll('.med-tl-tick')];
    /* 幂等写入：只在目标状态真的变化时才动 class。
       每帧无条件 remove+add 会让同一元素反复产生 mutation，
       既触发观察器重跑，也让浏览器重复失效样式 → 高频频闪。 */
    const setCls = (el, cls, on) => { if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on); };
    /* 关键：不再「先移除对齐类再量测」。那样每次滚动都要 remove→measure→add，
       原生横向滚动逐帧派发时，刻度会在相邻帧之间来回翻转 → 高频频闪。
       改为直接量刻度线本身（tick 的 left 不受 span 对齐影响），
       再用缓存的文字宽度推算默认居中时的左右边界，一次性判定目标类。 */
    ticks.forEach((t) => {
      const span = t.querySelector('span');
      if (!span) return;
      const lineX = t.getBoundingClientRect().left;
      const off = lineX < sr.left - 0.5 || lineX > sr.right + 0.5;
      setCls(t, 'cx-offview', off);
      if (off) { setCls(t, 'cx-edge-l', false); setCls(t, 'cx-edge-r', false); return; }
      /* 文字宽度与刻度无关，缓存后避免每帧读取受对齐影响的 span 几何 */
      let w = Number(t.dataset.cxsw || 0);
      if (!w) { w = span.getBoundingClientRect().width || 44; t.dataset.cxsw = String(Math.round(w)); }
      const centeredL = lineX + 4 - w / 2;   /* 默认样式：left:4px + translateX(-50%) */
      setCls(t, 'cx-edge-l', centeredL < sr.left + 2);
      setCls(t, 'cx-edge-r', centeredL >= sr.left + 2 && centeredL + w > sr.right - 2);
    });
  }

  /* 常驻日期徽标：横向滚动后年份刻度会滑出视窗，医生不知道在看哪一年。
     在刻度行左缘固定一枚徽标，实时显示当前视窗左缘对应的年月。 */
  function syncMedDateBadge(sc) {
    const frame = sc.closest('.med-tl-frame');
    const box = sc.closest('.med-tl-box');
    const canvas = sc.querySelector('.med-tl-canvas');
    if (!frame || !box || !canvas) return;
    let badge = frame.querySelector('.cx-meddate');
    const scrollable = sc.scrollWidth - sc.clientWidth > 4;
    if (!scrollable) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = el('div', 'cx-meddate');
      frame.appendChild(badge);
    }
    /* 直接读渲染好的刻度：每个 tick 的 title 是 ISO 日期、left 是百分比。
       取「当前视窗左缘」之前最近的一个刻度，不依赖任何业务全局变量。 */
    const cw = canvas.getBoundingClientRect().width;
    let label = '';
    if (cw > 0) {
      const frac = Math.min(100, Math.max(0, (sc.scrollLeft / cw) * 100));
      const ticks = [...canvas.querySelectorAll('.med-tl-tick')];
      let best = null;
      ticks.forEach((t) => {
        const l = parseFloat(t.style.left) || 0;
        const iso = t.getAttribute('title') || '';
        if (l <= frac + 0.001 && iso && (!best || l >= best.l)) best = { l, iso };
      });
      /* 视窗左缘在首个刻度之前时，用疗程起始年月，避免显示成后面的年份 */
      if (!best) {
        const s = box.dataset.medStart || '';
        if (s) best = { l: 0, iso: s };
      }
      if (best && best.iso) label = best.iso.slice(0, 7);
    }
    badge.textContent = label ? '当前视窗 ' + label : '';
    badge.style.display = label ? '' : 'none';
    /* 徽标独占刻度行上方一条，绝不与刻度文字重叠 */
    const labels = frame.querySelector('.med-tl-labels');
    const lw = labels ? labels.getBoundingClientRect().width : 0;
    badge.style.left = (lw + 6) + 'px';
    badge.style.top = '2px';
    if (!frame.classList.contains('cx-hasdate')) frame.classList.add('cx-hasdate');
  }
  function paintMedBar(sc, bar) {
    const thumb = bar.firstElementChild;
    if (!thumb) return;
    const trackW = bar.clientWidth;
    const w = Math.max(48, Math.round(trackW * (sc.clientWidth / sc.scrollWidth)));
    const max = trackW - w;
    const span = sc.scrollWidth - sc.clientWidth;
    const left = span > 0 ? (sc.scrollLeft / span) * max : 0;
    thumb.style.width = w + 'px';
    thumb.style.transform = 'translateX(' + (isFinite(left) ? left : 0) + 'px)';
    /* 两端渐隐：提示左右还有内容 */
    bar.classList.toggle('at-start', sc.scrollLeft <= 2);
    bar.classList.toggle('at-end', sc.scrollLeft >= span - 2);
  }
  /* 全程概览：把整条疗程压缩成一条彩色缩略图 + 当前视窗框。
     医生一眼看到「9 年疗程里药都在后半段」，点/拖缩略图即可跳转，
     不必反复横向滚动去找有药的年份。 */
  function paintMedMini(sc, mini) {
    const win = mini.querySelector('.cx-mini-win');
    if (!win) return;
    const total = sc.scrollWidth;
    const leftPct = total > 0 ? (sc.scrollLeft / total) * 100 : 0;
    const widthPct = total > 0 ? (sc.clientWidth / total) * 100 : 100;
    win.style.left = leftPct.toFixed(3) + '%';
    win.style.width = Math.min(100, widthPct).toFixed(3) + '%';
  }
  function buildMedMini(sc, box, frame) {
    let mini = box.querySelector('.cx-medmini');
    if (mini) return mini;
    mini = el('div', 'cx-medmini');
    const track = el('div', 'cx-mini-track');
    /* 从真实药物条读取位置与颜色，缩略图与主图始终一致 */
    const canvas = sc.querySelector('.med-tl-canvas');
    const cw = canvas ? canvas.getBoundingClientRect().width : 0;
    sc.querySelectorAll('.med-tl-cat-row').forEach((row) => {
      row.querySelectorAll('.med-tl-seg').forEach((seg) => {
        const r = seg.getBoundingClientRect();
        const sr = sc.getBoundingClientRect();
        const absLeft = (r.left - sr.left) + sc.scrollLeft;
        const l = cw > 0 ? (absLeft / cw) * 100 : parseFloat(seg.style.left) || 0;
        const w = cw > 0 ? (r.width / cw) * 100 : parseFloat(seg.style.width) || 1;
        const pip = el('i', 'cx-mini-pip');
        pip.style.cssText = 'left:' + Math.max(0, l).toFixed(3) + '%;width:' +
          Math.max(0.35, w).toFixed(3) + '%;background:' + (seg.style.background || 'var(--brand)');
        track.appendChild(pip);
      });
    });
    const win = el('div', 'cx-mini-win');
    track.appendChild(win);
    mini.appendChild(track);
    const cap = el('div', 'cx-mini-cap');
    cap.textContent = '全程概览 · 点击或拖动跳转';
    mini.appendChild(cap);
    frame.parentNode.insertBefore(mini, frame);
    const jump = (ev) => {
      const r = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      sc.scrollLeft = ratio * sc.scrollWidth - sc.clientWidth / 2;
    };
    bindBarDrag(track, jump);
    sc.addEventListener('scroll', () => paintMedMini(sc, mini), { passive: true });
    return mini;
  }
  /* 首次渲染定位到「当前在用药」附近；全部已停药则定位到末段，
     避免打开就停在最早年份、整屏空白泳道。 */
  function focusMedNow(sc) {
    if (sc.dataset.cxFocused) return;
    sc.dataset.cxFocused = '1';
    const segs = [...sc.querySelectorAll('.med-tl-seg')];
    if (!segs.length) return;
    const open = segs.filter(s => s.classList.contains('open'));
    const target = open.length ? open[open.length - 1] : segs[segs.length - 1];
    const sr = sc.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const absLeft = (tr.left - sr.left) + sc.scrollLeft;
    /* 让目标段落在视窗右侧 1/3 处，既看到当前用药也保留近期上下文 */
    sc.scrollLeft = Math.max(0, absLeft - sc.clientWidth * 0.62);
  }
  function syncMedBar() {
    document.querySelectorAll('.med-tl-scroll').forEach((sc) => {
      const frame = sc.closest('.med-tl-frame');
      const box = sc.closest('.med-tl-box');
      if (!frame || !box) return;
      let bar = box.querySelector('.cx-medscroll');
      if (sc.scrollWidth - sc.clientWidth <= 4) {
        if (bar) bar.remove();
        const m = box.querySelector('.cx-medmini');
        if (m) m.remove();
        return;
      }
      const mini = buildMedMini(sc, box, frame);
      focusMedNow(sc);
      paintMedMini(sc, mini);
      if (!bar) {
        bar = el('div', 'cx-medscroll');
        bar.appendChild(el('i'));
        /* 插在 frame 之后、手机明细之前，成为独立一行，绝不覆盖内容 */
        frame.parentNode.insertBefore(bar, frame.nextSibling);
        const jump = (ev) => {
          const r = bar.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
          sc.scrollLeft = ratio * (sc.scrollWidth - sc.clientWidth);
        };
        bindBarDrag(bar, jump);
        /* 每帧只更新一次：原生横向滚动每帧都派发 scroll，直接同步执行会
           在同一帧内多次「改类→量测→改回」，表现为刻度高频频闪。 */
        sc.addEventListener('scroll', () => scheduleMedPaint(sc, bar), { passive: true });
      }
      /* 滚动条与画布区左右对齐（左侧类别列不参与滚动） */
      const fr = frame.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      bar.style.marginLeft = Math.max(0, sr.left - fr.left) + 'px';
      paintMedBar(sc, bar);
      pinMedLabels(sc);
      syncMedDateBadge(sc);
      alignMedTicks(sc);
    });
  }
  /* 滚动装饰的单帧合并调度：一帧内无论派发多少次 scroll，只在 rAF 里算一次。
     横向触控板滚动是浏览器原生逐帧派发，同步处理会让刻度类在同一帧反复翻转。 */
  const medPaintRaf = new WeakMap();
  function scheduleMedPaint(sc, bar) {
    if (medPaintRaf.get(sc)) return;
    const id = requestAnimationFrame(() => {
      medPaintRaf.delete(sc);
      if (!sc.isConnected) return;
      paintMedBar(sc, bar);
      pinMedLabels(sc);
      syncMedDateBadge(sc);
      alignMedTicks(sc);
    });
    medPaintRaf.set(sc, id);
  }
  function enhanceMedScroll() {
    document.querySelectorAll('.med-tl-scroll').forEach((sc) => {
      if (sc.dataset.cxMed) return;
      sc.dataset.cxMed = '1';
      sc.addEventListener('wheel', (ev) => {
        if (sc.scrollWidth - sc.clientWidth <= 4) return;
        /* 触控板横向手势交给浏览器；纵向滚轮转横向 */
        if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
        const before = sc.scrollLeft;
        sc.scrollLeft += ev.deltaY;
        if (sc.scrollLeft !== before) ev.preventDefault();
      }, { passive: false });
      let drag = null;
      sc.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        /* 触摸交给浏览器原生横向滚动（touch-action:pan-x 已限定手势轴）。
           JS 拖动只服务鼠标：此前对触摸也 setPointerCapture，会把纵向
           滑动一并捕获，手指落在时间轴上就整页滑不动。 */
        if (ev.pointerType === 'touch') return;
        /* 药物条与说明有自己的点击行为，不参与拖动 */
        if (ev.target.closest('.med-tl-seg, .med-tl-detail, .med-tl-today')) return;
        drag = { x: ev.clientX, y: ev.clientY, left: sc.scrollLeft, moved: false, id: ev.pointerId };
      });
      sc.addEventListener('pointermove', (ev) => {
        if (!drag || ev.pointerId !== drag.id) return;
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        /* 鼠标也做轴向判定：明显纵向意图时放弃拖动，不抢页面滚动 */
        if (!drag.moved) {
          if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
          drag.moved = true;
          sc.classList.add('cx-grabbing');
          try { sc.setPointerCapture(ev.pointerId); } catch (e) { /* 不支持则退化为普通拖动 */ }
        }
        sc.scrollLeft = drag.left - dx;
      });
      const end = (ev) => {
        if (!drag || ev.pointerId !== drag.id) return;
        const id = drag.id;
        drag = null;
        sc.classList.remove('cx-grabbing');
        try { sc.releasePointerCapture(id); } catch (e) { /* 已释放 */ }
      };
      sc.addEventListener('pointerup', end);
      sc.addEventListener('pointercancel', end);
      sc.addEventListener('pointerleave', end);
    });
  }

  /* ---- 患者列表行风险着色 ----
   * 业务把风险写在 .risk-dot 的内联背景色上，这里只读取该色并映射为语义类，
   * 不重新计算风险、不改文字与事件。色值变化时重新分类，保证与圆点始终一致。 */
  const RISK_CLASS = {
    '0,135,90': 'cx-r-green', '138,106,18': 'cx-r-yellow', '168,68,60': 'cx-r-red',
    '90,90,90': 'cx-r-gray', '42,78,134': 'cx-r-pending'
  };
  function tintRow(row) {
    const dot = row.querySelector('.risk-dot');
    if (!dot) return;
    const rgb = (getComputedStyle(dot).backgroundColor.match(/\d+/g) || []).slice(0, 3).join(',');
    const cls = RISK_CLASS[rgb];
    if (!cls || row.classList.contains(cls)) return;
    Object.values(RISK_CLASS).forEach(c => row.classList.remove(c));
    row.classList.add(cls);
  }
  function tintRows() {
    document.querySelectorAll('#mgmtList .mgmt-row').forEach(tintRow);
  }
  /* 列表每次重渲染都会重建行节点，风险类随之丢失。
   * 用独立观察器在微任务内立即补回（早于下一帧绘制），避免出现一帧无风险色的底色闪现。 */
  let rowMO = null;
  function watchRows() {
    const list = document.getElementById('mgmtList');
    if (!list || rowMO) return;
    rowMO = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (n.matches && n.matches('.mgmt-row')) tintRow(n);
            else if (n.querySelectorAll) n.querySelectorAll('.mgmt-row').forEach(tintRow);
          });
        } else if (m.target && m.target.classList && m.target.classList.contains('mgmt-row')) {
          /* 业务改写 class（如切换 selected）会抹掉风险类，这里同帧补回 */
          tintRow(m.target);
        }
      }
    });
    rowMO.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  /* ---- 入场分级动画：每个元素只播放一次，结束后移除类，避免悬停/重渲染冲突 ---- */
  const SEL = '.ov-kpi,.stat-card,.chart-card,.pie-card,.ws2-card,.wb-card,.patient-card,.ws2-plan-item,.panel,.ov-panel';
  function stagger() {
    document.querySelectorAll('.section.active ' + SEL).forEach((c) => {
      if (c.dataset.cxIn) return;
      c.dataset.cxIn = '1';
      const sibs = Array.prototype.filter.call(c.parentElement.children, x => x.matches && x.matches(SEL));
      c.style.setProperty('--cx-i', Math.max(0, sibs.indexOf(c)));
      c.classList.add('cx-in');
      c.addEventListener('animationend', () => c.classList.remove('cx-in'), { once: true });
    });
    /* 区块切换时播放一次入场 */
    document.querySelectorAll('.section.active').forEach((s) => {
      if (s.dataset.cxSec) return;
      s.dataset.cxSec = '1';
      s.style.animation = 'cxIn .32s cubic-bezier(.2,.8,.2,1)';
      s.addEventListener('animationend', () => { s.style.animation = ''; }, { once: true });
    });
  }

  /* ---- 点击涟漪 ---- */
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn,.ws2-mini-btn,.med-mini-btn,.record-menu-btn');
    if (!b) return;
    const r = b.getBoundingClientRect();
    const d = Math.max(r.width, r.height);
    const s = el('span', 'cx-ripple', 'left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px;width:' + d + 'px;height:' + d + 'px');
    b.appendChild(s);
    setTimeout(() => s.remove(), 550);
  }, { passive: true });

  /* ---- 区块编号 ---- */
  function syncMark() {
    let mark = document.getElementById('cxMark');
    if (!mark) {
      mark = el('div', 'cx-mark', 'right:2vw;top:120px');
      mark.id = 'cxMark';
      document.body.appendChild(mark);
    }
    const active = document.querySelector('header .nav-tab.active');
    const map = { overview: '01', patients: '02', users: '03', manage: '04' };
    const key = active && active.getAttribute('data-tab');
    mark.textContent = map[key] || '01';
    const colors = { overview: 'rgba(0,105,75,.08)', patients: 'rgba(42,78,134,.08)', users: 'rgba(90,74,135,.08)' };
    mark.style.color = colors[key] || 'rgba(17,17,17,.06)';
  }

  /* 窄屏整览↔细看切换后，画布宽度变了：重算滚动条、概览与标签吸附。
     整览模式下没有横向滚动，自绘条与概览会自动移除。 */
  window.addEventListener('cx-medview-change', () => {
    requestAnimationFrame(() => {
      document.querySelectorAll('.med-tl-scroll').forEach((sc) => { delete sc.dataset.cxFocused; });
      syncMedBar();
      document.querySelectorAll('.med-tl-scroll').forEach(pinMedLabels);
    });
  });

  /* ---- 手机端工作台表头：固定高度吸顶区 + 手势结束后才切换形态 ----
   *
   * 上一版把「滚动超过 88px 就收起表头」直接做成改变文档高度的 sticky：
   * 表头 248px → 66px 会让 scrollHeight 缩短 182px，浏览器随即钳制 scrollTop，
   * 而钳制后的值又落回阈值以下 → 表头展开 → 高度涨回 → 再次越过阈值……
   * 真机触摸实测单次上滑 scrollTop 在 0↔88 之间来回弹、紧凑态翻转 14 次，
   * 表现就是「往下翻不停跳、根本滑不动」。桌面用滚轮/脚本滚动不易触发，
   * 所以只在真机触摸下暴露。
   *
   * 新方案彻底断开这条反馈链：
   *   1. 表头改为 position:absolute 的固定高度区（--cx-head-h 由实测写入），
   *      内容区用等值 padding-top 让位。表头形态变化只改自身内部，
   *      绝不改变 scrollHeight，滚动位置因此不会被钳制。
   *   2. 形态切换只在手势结束且惯性停稳后做一次（touchend/pointercancel +
   *      120ms 静默判定），滑动过程中表头完全静止，不参与任何布局计算。
   *   3. 阈值 160 / 回落 40 拉开到 120px 回差，远大于任何单帧位移。
   * 监听绑在浮层自身（它才是滚动容器），dataset 去重，写入前比对保持幂等。 */
  function syncCompactHead() {
    const panel = document.getElementById('editPanel');
    if (!panel) return;
    const title = document.getElementById('edit-title');
    if (!title) return;
    const isMobile = () => panel.classList.contains('mobile-open') && window.innerWidth <= 860;

    /* 清掉历史版本留下的内联变量：它们曾驱动「改表头高度 + 改内容让位量」，
       是停手后跳一段的根源，现在布局完全不由 JS 决定。 */
    panel.style.removeProperty('--cx-head-h');
    panel.style.removeProperty('--cx-head-now');
    if (title.classList.contains('cx-compact')) title.classList.remove('cx-compact');

    /* 常驻紧凑条：fixed 脱离文档流，显隐只改 opacity/transform，
       因此无论怎么切都不会改变 scrollHeight，滚动位置零干预。
       桌面端必须连节点都不存在：验收脚本按 textContent 采集文字，
       display:none 的节点仍会被采到，凭空多出一段「患者列表」。 */
    let bar = panel.querySelector('.cx-headbar');
    if (!isMobile()) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = el('div', 'cx-headbar');
      bar.removeAttribute('aria-hidden');
      bar.innerHTML = '<button class="cx-hb-back" type="button" aria-label="返回患者列表">' +
        '<i aria-hidden="true">←</i><span>患者列表</span></button>' +
        '<span class="cx-hb-name"></span><span class="cx-hb-risk"></span>';
      panel.appendChild(bar);
      bar.querySelector('.cx-hb-back').addEventListener('click', () => {
        if (typeof closeEditorPanel === 'function') closeEditorPanel();
      });
    }

    /* 文案与风险色跟随当前患者头部，只在内容变化时写一次 */
    const nameEl = title.querySelector('.ws2-name');
    const nm = nameEl ? (nameEl.childNodes[0] ? String(nameEl.childNodes[0].textContent || '').trim() : '') : '';
    const idSpan = nameEl ? nameEl.querySelector('span') : null;
    const pid = idSpan ? idSpan.textContent.trim() : '';
    const tone = (String(title.className).match(/tone-(\w+)/) || [])[1] || 'green';
    const alert = title.querySelector('.ws2-warn');
    const alertText = alert ? alert.textContent.trim() : '';
    const key = nm + '|' + pid + '|' + tone + '|' + alertText;
    if (bar.dataset.cxKey !== key) {
      bar.dataset.cxKey = key;
      const n = bar.querySelector('.cx-hb-name');
      n.textContent = nm;
      if (pid) { const e = document.createElement('em'); e.textContent = pid; n.appendChild(e); }
      bar.querySelector('.cx-hb-risk').textContent = alertText;
      ['red', 'yellow', 'green', 'gray', 'pending'].forEach(t => bar.classList.remove('cx-tone-' + t));
      bar.classList.add('cx-tone-' + tone);
    }

    /* 显隐判定：完整表头滚出视口即显示紧凑条。阈值取表头实际高度，
       回差 24px；只读 scrollTop，不写任何布局属性。 */
    const apply = () => {
      const on = isMobile() && (panel.scrollTop || 0) > Math.max(48, title.offsetHeight - 24);
      if (bar.classList.contains('cx-on') !== on) bar.classList.toggle('cx-on', on);
    };

    if (!panel.dataset.cxCHead) {
      panel.dataset.cxCHead = '1';
      let pending = false, idle = 0;
      panel.addEventListener('scroll', () => {
        /* 一帧最多判定一次；判定只切 class，不触发布局重排 */
        if (!pending) {
          pending = true;
          requestAnimationFrame(() => { pending = false; apply(); });
        }
        if (!panel.classList.contains('cx-scrolling')) panel.classList.add('cx-scrolling');
        clearTimeout(idle);
        idle = setTimeout(() => panel.classList.remove('cx-scrolling'), 160);
      }, { passive: true });
      window.addEventListener('resize', apply, { passive: true });
    }
    apply();
  }

  /* 浮层打开后由业务侧派发：此时 mobile-open 与徽章/按钮都已就位，
     测量才能拿到真实的完整表头高度。 */
  document.addEventListener('cx-head-remeasure', () => {
    requestAnimationFrame(syncCompactHead);
  });

  let raf = 0;
  function run() {
    buildLogin();
    syncLoginLock();
    const ls = document.getElementById('loginScreen');
    if (ls && !ls.classList.contains('hidden')) return; /* 登录态不渲染内页装饰 */
    buildBg();
    tintCards();
    tintHeader();
    tintSummary();
    markCsco();
    tintMonitors();
    watchRows();
    tintRows();
    stagger();
    syncMark();
    syncModalScroll();
    syncTimelineScroll();
    enhanceMedScroll();
    syncMedBar();
    syncCompactHead();
  }
  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(run);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  /* 只响应业务 DOM 变化；忽略装饰层自身的类/节点变动，防止动画反复重置。
     滚动时会给刻度/说明打上 cx-pinned、cx-edge-*、cx-offview 等类并改 style，
     这些也必须算装饰——否则每帧都触发整层重跑，实测 24 次滚动产生 9447 次
     class 改写，表现为图标高频频闪。 */
  const DECO_CLASS = /cx-(in|deco|ripple|tilt|bg|mark|tape|reg|scroll|hscroll|medscroll|medmini|meddate|mini-[a-z]+|c-[a-z]+|a\d|s-[a-z]+|g-[a-z]+|csco|pinned|tucked|tight|offview|edge-[lr]|grabbing|fitview|num-warn|chemo|fold|mon-todo|mon-done|mon-abn|mon-cell-[a-z]+|compact|scrolling)/;
  const isDeco = (n) => {
    if (!n || n.nodeType !== 1) return false;
    const c = n.className && n.className.toString ? n.className.toString() : '';
    return DECO_CLASS.test(c) || /cx-t\d|cx-b\d|cx-k-|cx-r-/.test(c) ||
      !!n.closest('.cx-bg,.cx-bg2,.cx-scroll,.cx-hscroll,.cx-medscroll,.cx-medmini,.cx-meddate');
  };
  /* 只有「业务类」变化才值得重跑：把装饰类剔除后比较前后快照。
     oldValue 由 observe 的 attributeOldValue 提供。 */
  const stripDeco = (s) => String(s || '').split(/\s+/).filter(x => x && !DECO_CLASS.test(x) && !/^cx-(t|b)\d$|^cx-k-|^cx-r-/.test(x)).join(' ');
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (t && t.id === 'loginScreen') { schedule(); return; }
        /* style 变化一律不触发重跑：滚动定位、宽度、吸附位移都在改 style */
        if (m.attributeName === 'style') continue;
        if (m.attributeName === 'class') {
          if (stripDeco(m.oldValue) === stripDeco(t.getAttribute('class'))) continue;
        } else if (isDeco(t)) continue;
      }
      if (m.type === 'childList') {
        const added = Array.prototype.some.call(m.addedNodes, (n) => !isDeco(n));
        const removed = Array.prototype.some.call(m.removedNodes, (n) => !isDeco(n));
        if (!added && !removed) continue;
      }
      schedule();
      return;
    }
  });
  mo.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeOldValue: true, attributeFilter: ['class', 'style']
  });
})();
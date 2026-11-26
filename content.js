// 千川 ROI 实时监控悬浮面板（Shadow DOM 隔离，支持单值秒级监听 + 计划列表多行监听）

(() => {
  if (window.__QC_ROI_MONITOR_LOADED__) {
    return;
  }
  window.__QC_ROI_MONITOR_LOADED__ = true;

  const STORAGE_KEY = "qc_roi_monitor_config_v1";
  const DEFAULT_CONFIG = {
    enabled: false,
    mode: "both", // "both" | "single" | "table"
    selector: "",
    selectorLabel: "",
    roiHeaderKeyword: "ROI",
    costHeaderKeyword: "消耗",
    nameHeaderKeyword: "计划",
    minCost: 100,
    lowerLimit: "1.5",
    upperLimit: "4.0",
    cooldownMinutes: 10,
    autoClickRefresh: false,
    refreshIntervalSec: 60,
    soundEnabled: true,
    desktopEnabled: true,
    wecomWebhook: "",
    wecomMobiles: "",
    pushplusToken: "",
    customWebhook: "",
    barkUrl: "",
  };

  let config = { ...DEFAULT_CONFIG };
  let isExpanded = false;
  let isPicking = false;
  let hoveredEl = null;
  let observer = null;
  let pollTimer = null;
  let refreshTimer = null;
  let cooldownMap = new Map(); // key -> { ts, direction }
  let alertLogs = [];
  let latestDisplay = {
    status: "idle", // idle | ok | high | low | warn
    text: "未启动",
    rowsSummary: "",
  };

  // ---------- Shadow DOM UI ----------
  const host = document.createElement("div");
  host.id = "qc-roi-monitor-host";
  host.style.cssText =
    "position:fixed;top:84px;right:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; }
    .pill {
      display: flex; align-items: center; gap: 8px;
      background: #141720; color: #f3f6ff;
      border: 1px solid #2b3347; border-radius: 999px;
      padding: 8px 14px; cursor: pointer; user-select: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.32);
      font-size: 13px; font-weight: 600;
      transition: transform 0.15s ease, border-color 0.2s ease;
    }
    .pill:hover { transform: translateY(-1px); border-color: #4f7cff; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; flex-shrink: 0; }
    .dot.ok { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
    .dot.low { background: #ef4444; box-shadow: 0 0 10px #ef4444; }
    .dot.high { background: #f59e0b; box-shadow: 0 0 10px #f59e0b; }
    .dot.warn { background: #eab308; }

    .panel {
      width: 372px; max-height: 84vh; overflow-y: auto;
      background: #141720; color: #e5e9f2;
      border: 1px solid #2b3347; border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.45);
      font-size: 12px; line-height: 1.45;
      display: none;
    }
    .panel.open { display: block; }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; border-bottom: 1px solid #242b3d;
      background: #1a1f2e; border-radius: 14px 14px 0 0;
      position: sticky; top: 0; z-index: 2;
    }
    .title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .icon-btn {
      background: transparent; border: 1px solid #303952; color: #b8c2d8;
      border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px;
    }
    .icon-btn:hover { background: #273046; color: #fff; }
    .body { padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 12px; }

    .status-card {
      background: #1b2131; border: 1px solid #2b344a; border-radius: 10px;
      padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px;
    }
    .status-value { font-size: 20px; font-weight: 700; color: #fff; }
    .status-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }
    .btn {
      border: none; border-radius: 8px; padding: 7px 12px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      transition: opacity 0.15s ease;
    }
    .btn:hover { opacity: 0.9; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-success { background: #16a34a; color: #fff; }
    .btn-ghost { background: #252d42; color: #dbe3f5; border: 1px solid #33405c; }
    .btn-sm { padding: 5px 9px; font-size: 11px; }

    .section {
      background: #181d2b; border: 1px solid #252d40; border-radius: 10px;
      padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
    }
    .section-title { font-size: 12px; font-weight: 700; color: #93c5fd; display: flex; justify-content: space-between; align-items: center; }

    .tabs { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
    .tab {
      background: #1f2638; color: #9aa7c2; border: 1px solid #2d364d;
      border-radius: 8px; padding: 7px 6px; cursor: pointer; text-align: center; font-weight: 600; font-size: 11px;
    }
    .tab.active { background: #263961; color: #fff; border-color: #4f7cff; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
    label.field { display: flex; flex-direction: column; gap: 4px; color: #b7c2d9; font-size: 11px; }
    input[type="text"], input[type="number"], input[type="password"] {
      width: 100%; background: #0f131c; color: #f8fafc;
      border: 1px solid #303a52; border-radius: 6px;
      padding: 6px 8px; font-size: 12px; outline: none;
    }
    input:focus { border-color: #4f7cff; }
    .check-row { display: flex; align-items: center; gap: 8px; color: #cbd5e1; cursor: pointer; }
    .check-row input { accent-color: #3b82f6; }

    .row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .muted { color: #8c98b3; font-size: 11px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: #93c5fd; word-break: break-all; }

    .logs {
      max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px;
    }
    .log-item {
      background: #10141f; border-left: 3px solid #3b82f6;
      padding: 6px 8px; border-radius: 4px; font-size: 11px;
    }
    .log-item.low { border-left-color: #ef4444; }
    .log-item.high { border-left-color: #f59e0b; }
    .log-item.ok { border-left-color: #22c55e; }
    .toast {
      font-size: 11px; color: #fde68a; background: #2c2614;
      border: 1px solid #594a1f; border-radius: 6px; padding: 6px 8px; display: none;
    }
    .toast.show { display: block; }
  `;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.innerHTML = `
    <div class="pill" id="pillBtn" title="点击展开千川 ROI 监控面板">
      <span class="dot" id="pillDot"></span>
      <span id="pillText">ROI 监控: 未启动</span>
    </div>

    <div class="panel" id="panel">
      <div class="header">
        <div class="title">
          <span class="dot" id="headerDot"></span>
          <span>千川 ROI 实时监控</span>
        </div>
        <button class="icon-btn" id="collapseBtn">收起</button>
      </div>

      <div class="body">
        <div class="status-card">
          <div>
            <div class="status-value" id="currentRoiValue">--</div>
            <div class="status-sub" id="currentStatusSub">配置上下限后点击开始监控</div>
          </div>
          <button class="btn btn-success" id="toggleMonitorBtn">开始监控</button>
        </div>

        <div class="toast" id="toastBox"></div>

        <!-- 监控模式 -->
        <div class="section">
          <div class="section-title">
            <span>1. 监控对象（实时读取）</span>
          </div>
          <div class="tabs">
            <div class="tab active" data-mode="both" id="tabBoth">整体 + 多计划</div>
            <div class="tab" data-mode="single" id="tabSingle">仅整体 ROI</div>
            <div class="tab" data-mode="table" id="tabTable">仅计划列表</div>
          </div>

          <div id="singleModeBox" style="display:flex;flex-direction:column;gap:8px;">
            <div class="row-between">
              <button class="btn btn-primary btn-sm" id="pickElementBtn">点选页面整体 ROI</button>
              <button class="btn btn-ghost btn-sm" id="autoFindRoiBtn">自动查找整体 ROI</button>
            </div>
            <div class="muted" id="selectorPreview">尚未绑定整体 ROI（可自动查找，或点左侧按钮直接点页面数字）</div>
          </div>

          <div id="tableModeBox" style="display:none;flex-direction:column;gap:8px;">
            <div class="grid-3">
              <label class="field">ROI 列关键词
                <input type="text" id="roiHeaderKeyword" placeholder="ROI">
              </label>
              <label class="field">消耗列关键词
                <input type="text" id="costHeaderKeyword" placeholder="消耗">
              </label>
              <label class="field">名称列关键词
                <input type="text" id="nameHeaderKeyword" placeholder="计划">
              </label>
            </div>
            <div class="grid-2">
              <label class="field">最低消耗门槛(元)
                <input type="number" step="10" id="minCost" placeholder="100">
              </label>
              <label class="field">自动点刷新间隔(秒)
                <input type="number" min="15" step="5" id="refreshIntervalSec" placeholder="60">
              </label>
            </div>
            <label class="check-row">
              <input type="checkbox" id="autoClickRefresh">
              <span>定时自动点击页面内“刷新”按钮（不整页重载）</span>
            </label>
            <div class="muted" id="tableScanSummary">等待扫描页面表格...</div>
          </div>
        </div>

        <!-- 上下限阈值 -->
        <div class="section">
          <div class="section-title"><span>2. 告警上下限 & 防刷屏</span></div>
          <div class="grid-3">
            <label class="field">下限值(跌破提醒)
              <input type="number" step="0.01" id="lowerLimit" placeholder="如 1.5">
            </label>
            <label class="field">上限值(突破提醒)
              <input type="number" step="0.01" id="upperLimit" placeholder="如 4.0">
            </label>
            <label class="field">冷却(分钟)
              <input type="number" min="0" step="1" id="cooldownMinutes" placeholder="10">
            </label>
          </div>
          <div class="row-between">
            <label class="check-row">
              <input type="checkbox" id="desktopEnabled">
              <span>桌面弹窗通知</span>
            </label>
            <label class="check-row">
              <input type="checkbox" id="soundEnabled">
              <span>告警提示音</span>
            </label>
          </div>
        </div>

        <!-- 手机微信推送 -->
        <div class="section">
          <div class="section-title">
            <span>3. 手机微信 / 群推送配置</span>
            <button class="btn btn-ghost btn-sm" id="testPushBtn">发送测试推送</button>
          </div>
          <label class="field">企业微信群机器人 Webhook（推荐：免费不限量，微信可直收）
            <input type="text" id="wecomWebhook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...">
          </label>
          <label class="field">企微 @手机号（可选，填 @all 则提醒所有人，多个用逗号隔开）
            <input type="text" id="wecomMobiles" placeholder="如 13800138000 或 @all">
          </label>
          <label class="field">PushPlus Token（直达个人微信，免费 200 条/天，需实名）
            <input type="password" id="pushplusToken" placeholder="粘贴 PushPlus token">
          </label>
          <label class="field">飞书 / 钉钉群机器人 Webhook（可选）
            <input type="text" id="customWebhook" placeholder="https://open.feishu.cn/... 或 https://oapi.dingtalk.com/...">
          </label>
          <label class="field">Bark 推送地址（仅 iPhone，免费不限量，可选）
            <input type="text" id="barkUrl" placeholder="https://api.day.app/你的Key">
          </label>
        </div>

        <!-- 日志 -->
        <div class="section">
          <div class="section-title">
            <span>4. 实时告警记录</span>
            <button class="btn btn-ghost btn-sm" id="clearLogsBtn">清空</button>
          </div>
          <div class="logs" id="logsContainer">
            <div class="muted">暂无告警记录</div>
          </div>
        </div>
      </div>
    </div>
  `;
  shadow.appendChild(root);
  document.documentElement.appendChild(host);

  // 高亮框（放在主文档用于点选元素）
  const pickerHighlight = document.createElement("div");
  pickerHighlight.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #3b82f6;background:rgba(59,130,246,0.16);border-radius:4px;display:none;transition:all 0.05s ease;";
  document.documentElement.appendChild(pickerHighlight);

  const $ = (id) => shadow.getElementById(id);

  // ---------- 工具函数 ----------
  function showToast(msg, duration = 3500) {
    const box = $("toastBox");
    box.textContent = msg;
    box.classList.add("show");
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.classList.remove("show"), duration);
  }

  function parseNumber(rawText) {
    if (!rawText) return null;
    const cleaned = String(rawText).replace(/[,，\s￥¥元%]/g, "");
    const match = cleaned.match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    const val = Number(match[0]);
    return Number.isFinite(val) ? val : null;
  }

  function formatTime(date = new Date()) {
    return date.toTimeString().slice(0, 8);
  }

  function playBeep(direction = "low") {
    if (!config.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const freqs = direction === "low" ? [520, 390, 520] : [740, 960];
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.14, ctx.currentTime + idx * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.16);
        osc.stop(ctx.currentTime + idx * 0.16 + 0.15);
      });
    } catch {
      // 浏览器未交互前可能阻止音频，静默忽略
    }
  }

  function buildUniqueSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      return `#${CSS.escape(el.id)}`;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  }

  // ---------- 自动查找页面 ROI 元素 ----------
  function autoFindRoiElement() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const labelNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent?.trim() || "";
      if (txt.length > 0 && txt.length <= 24 && /ROI/i.test(txt)) {
        const parent = node.parentElement;
        if (parent && !host.contains(parent) && isVisible(parent)) {
          labelNodes.push(parent);
        }
      }
    }
    for (const labelEl of labelNodes) {
      // 在自身、同级、父级卡片内找包含纯数字的叶子元素
      const container = labelEl.closest("[class*='card'], [class*='metric'], [class*='item'], div") || labelEl.parentElement;
      if (!container) continue;
      const candidates = Array.from(container.querySelectorAll("*")).filter((el) => {
        if (el === labelEl || el.children.length > 0 || !isVisible(el)) return false;
        const txt = el.textContent?.trim() || "";
        return /^\d+(\.\d+)?$/.test(txt);
      });
      if (candidates.length > 0) {
        const target = candidates[0];
        return {
          el: target,
          selector: buildUniqueSelector(target),
          label: labelEl.textContent.trim(),
          value: target.textContent.trim(),
        };
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---------- 计划列表表格扫描 ----------
  function scanCampaignTables() {
    const roiKey = (config.roiHeaderKeyword || "ROI").trim().toLowerCase();
    const costKey = (config.costHeaderKeyword || "消耗").trim().toLowerCase();
    const nameKey = (config.nameHeaderKeyword || "计划").trim().toLowerCase();
    const rowsResult = [];

    // 1) 标准 <table>
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      if (!isVisible(table)) continue;
      const headerCells = Array.from(table.querySelectorAll("thead th, thead td, tr:first-child th"));
      if (headerCells.length < 2) continue;

      const headers = headerCells.map((c) => (c.textContent || "").trim().toLowerCase());
      const roiIdx = headers.findIndex((h) => h.includes(roiKey));
      if (roiIdx === -1) continue;

      const costIdx = headers.findIndex((h) => h.includes(costKey));
      let nameIdx = headers.findIndex((h) => h.includes(nameKey));
      if (nameIdx === -1) nameIdx = 0;

      const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
      for (let i = 0; i < bodyRows.length; i++) {
        const cells = Array.from(bodyRows[i].querySelectorAll("td"));
        if (cells.length <= roiIdx) continue;
        const roiVal = parseNumber(cells[roiIdx]?.textContent);
        if (roiVal === null) continue;
        const costVal = costIdx >= 0 && cells[costIdx] ? parseNumber(cells[costIdx].textContent) : null;
        const nameText = (cells[nameIdx]?.textContent || `计划#${i + 1}`).trim().replace(/\s+/g, " ").slice(0, 36);
        rowsResult.push({ name: nameText || `计划#${i + 1}`, roi: roiVal, cost: costVal });
      }
    }

    // 2) 兼容 Arco / Ant / React 虚拟表格 role="row"
    if (rowsResult.length === 0) {
      const headerRows = Array.from(document.querySelectorAll('[role="row"]')).filter((r) =>
        r.querySelector('[role="columnheader"]')
      );
      for (const hRow of headerRows) {
        const headerCells = Array.from(hRow.querySelectorAll('[role="columnheader"]'));
        const headers = headerCells.map((c) => (c.textContent || "").trim().toLowerCase());
        const roiIdx = headers.findIndex((h) => h.includes(roiKey));
        if (roiIdx === -1) continue;
        const costIdx = headers.findIndex((h) => h.includes(costKey));
        let nameIdx = headers.findIndex((h) => h.includes(nameKey));
        if (nameIdx === -1) nameIdx = 0;

        const grid = hRow.closest('[role="table"], [role="grid"]') || hRow.parentElement;
        if (!grid) continue;
        const dataRows = Array.from(grid.querySelectorAll('[role="row"]')).filter(
          (r) => !r.querySelector('[role="columnheader"]')
        );
        dataRows.forEach((row, idx) => {
          const cells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]'));
          if (cells.length <= roiIdx) return;
          const roiVal = parseNumber(cells[roiIdx]?.textContent);
          if (roiVal === null) return;
          const costVal = costIdx >= 0 && cells[costIdx] ? parseNumber(cells[costIdx].textContent) : null;
          const nameText = (cells[nameIdx]?.textContent || `计划#${idx + 1}`).trim().replace(/\s+/g, " ").slice(0, 36);
          rowsResult.push({ name: nameText, roi: roiVal, cost: costVal });
        });
      }
    }

    return rowsResult;
  }

  // ---------- 阈值判断与推送 ----------
  function checkAndAlert(targetKey, label, roiVal, extraLines = []) {
    const lower = config.lowerLimit !== "" && config.lowerLimit !== null ? Number(config.lowerLimit) : null;
    const upper = config.upperLimit !== "" && config.upperLimit !== null ? Number(config.upperLimit) : null;

    let direction = null;
    let threshold = null;
    if (lower !== null && Number.isFinite(lower) && roiVal < lower) {
      direction = "low";
      threshold = lower;
    } else if (upper !== null && Number.isFinite(upper) && roiVal > upper) {
      direction = "high";
      threshold = upper;
    }

    if (!direction) return "ok";

    // 冷却去重检查
    const cooldownMs = Math.max(0, Number(config.cooldownMinutes || 0)) * 60 * 1000;
    const last = cooldownMap.get(targetKey);
    const now = Date.now();
    if (last && last.direction === direction && now - last.ts < cooldownMs) {
      return direction;
    }
    cooldownMap.set(targetKey, { ts: now, direction });

    const isLow = direction === "low";
    const title = isLow ? `⚠️ ROI 跌破下限提醒` : `🔥 ROI 突破上限提醒`;
    const summary = `${label} 当前 ROI = ${roiVal}（${isLow ? `低于下限 ${threshold}` : `高于上限 ${threshold}`}）`;
    const detailLines = [
      `触发时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      ...extraLines,
      `页面标题：${document.title || "监控页面"}`,
    ];

    playBeep(direction);
    pushLog(direction, `${summary}`);
    dispatchToBackground({ title, summary, detailLines, level: direction });

    return direction;
  }

  function dispatchToBackground({ title, summary, detailLines, level }, isTest = false) {
    const channels = {
      desktop: config.desktopEnabled,
      wecomWebhook: config.wecomWebhook,
      wecomMobiles: config.wecomMobiles,
      pushplusToken: config.pushplusToken,
      customWebhook: config.customWebhook,
      barkUrl: config.barkUrl,
    };

    chrome.runtime.sendMessage(
      {
        type: "DISPATCH_ALERT",
        payload: { title, summary, detailLines, level, channels },
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          const msg = `推送通信异常：${chrome.runtime.lastError.message}`;
          if (isTest) showToast(msg, 5000);
          pushLog("low", msg);
          return;
        }
        const results = resp?.results || [];
        if (results.length === 0) {
          if (isTest) showToast("未开启任何推送渠道，请先勾选桌面通知或填写 Webhook/Token", 4500);
          return;
        }
        const summaryText = results
          .map((r) => `${r.channel}:${r.ok ? "成功" : `失败(${r.error})`}`)
          .join(" | ");
        if (isTest) {
          showToast(`测试推送结果 → ${summaryText}`, 5500);
          pushLog("ok", `测试推送 → ${summaryText}`);
        } else {
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) {
            pushLog("low", `部分推送失败 → ${summaryText}`);
          }
        }
      }
    );
  }

  // ---------- 核心评估函数（秒级回调 + 轮询兜底） ----------
  function mergeStatus(a, b) {
    const rank = { low: 4, high: 3, ok: 2, warn: 1, idle: 0 };
    return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
  }

  function evaluateNow() {
    if (!config.enabled) return;

    const wantSingle = config.mode === "both" || config.mode === "single";
    const wantTable = config.mode === "both" || config.mode === "table";

    let singleStatus = "idle";
    let singleValueText = "--";
    let singleSubText = "";

    if (wantSingle) {
      if (!config.selector) {
        singleStatus = "warn";
        singleValueText = "未绑定";
        singleSubText = "整体ROI未绑定";
      } else {
        const el = document.querySelector(config.selector);
        if (!el) {
          singleStatus = "warn";
          singleValueText = "未找到";
          singleSubText = "整体ROI暂不在当前视图";
        } else {
          const val = parseNumber(el.textContent);
          if (val === null) {
            singleStatus = "warn";
            singleValueText = "无数字";
            singleSubText = `读取到：${(el.textContent || "").trim().slice(0, 16)}`;
          } else {
            const label = config.selectorLabel || "整体 ROI";
            singleStatus = checkAndAlert("single_roi", label, val);
            singleValueText = String(val);
            singleSubText = `${label}: ${val}`;
          }
        }
      }
    }

    let tableStatus = "idle";
    let tableValueText = "--";
    let tableSubText = "";

    if (wantTable) {
      const rows = scanCampaignTables();
      const minCost = Number(config.minCost || 0);
      if (rows.length === 0) {
        $("tableScanSummary").textContent = "暂未识别到含 ROI 列的表格（可调整上方列关键词）";
        tableStatus = "warn";
        tableValueText = "0条计划";
        tableSubText = "未识别到计划表格";
      } else {
        let activeCount = 0;
        let alertCount = 0;
        let worst = "ok";
        let minRoi = Infinity;
        let maxRoi = -Infinity;

        for (const row of rows) {
          if (row.cost !== null && minCost > 0 && row.cost < minCost) {
            continue;
          }
          activeCount++;
          if (row.roi < minRoi) minRoi = row.roi;
          if (row.roi > maxRoi) maxRoi = row.roi;

          const extra = row.cost !== null ? [`当前消耗：¥${row.cost}`] : [];
          const st = checkAndAlert(`row:${row.name}`, `计划「${row.name}」`, row.roi, extra);
          if (st !== "ok") {
            alertCount++;
            worst = mergeStatus(worst, st);
          }
        }

        const rangeText = activeCount > 0 ? `计划ROI ${minRoi}~${maxRoi}` : "暂无达标消耗计划";
        $("tableScanSummary").textContent = `已识别 ${rows.length} 条计划，达标监控 ${activeCount} 条，异常 ${alertCount} 条（${rangeText}）`;
        tableStatus = worst;
        tableValueText = alertCount > 0 ? `${alertCount}条异常` : `${activeCount}条正常`;
        tableSubText = rangeText;
      }
    }

    const limitHint = `区间[${config.lowerLimit || "-∞"}, ${config.upperLimit || "+∞"}]`;
    if (config.mode === "both") {
      const combinedStatus = mergeStatus(singleStatus, tableStatus);
      updateDisplay(
        combinedStatus,
        `整体 ${singleValueText} · ${tableValueText}`,
        `${limitHint} | ${tableSubText || singleSubText}`
      );
    } else if (config.mode === "single") {
      updateDisplay(singleStatus, singleValueText, `${singleSubText} · ${limitHint}`);
    } else {
      updateDisplay(tableStatus, tableValueText, `${tableSubText} · ${limitHint}`);
    }
  }

  function tryClickPageRefresh() {
    if (!config.enabled || !config.autoClickRefresh) return;
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, span"));
    const refreshBtn = candidates.find((el) => {
      if (host.contains(el) || !isVisible(el)) return false;
      const txt = (el.textContent || "").trim();
      const title = (el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
      return txt === "刷新" || title === "刷新" || title === "刷新数据";
    });
    if (refreshBtn) {
      refreshBtn.click();
    }
  }

  // ---------- 启动 / 停止监听 ----------
  function startMonitoring() {
    stopMonitoring(false);
    config.enabled = true;
    saveConfig();

    // 使用 MutationObserver 监听 DOM 秒级变动（防抖 200ms 避免频繁重绘卡顿）
    let debounceTimer = null;
    observer = new MutationObserver(() => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        evaluateNow();
      }, 200);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // 1 秒兜底检查（防止部分 canvas/textContent 边缘变化漏捕获）
    pollTimer = setInterval(evaluateNow, 1000);

    // 表格模式可选定时点击页内刷新
    if ((config.mode === "table" || config.mode === "both") && config.autoClickRefresh) {
      const sec = Math.max(15, Number(config.refreshIntervalSec || 60));
      refreshTimer = setInterval(tryClickPageRefresh, sec * 1000);
    }

    syncMonitorButton();
    evaluateNow();
  }

  function stopMonitoring(persist = true) {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (persist) {
      config.enabled = false;
      saveConfig();
      updateDisplay("idle", "--", "监控已暂停");
      syncMonitorButton();
    }
  }

  // ---------- 点选页面元素模式 ----------
  function enterPickerMode() {
    if (isPicking) return;
    isPicking = true;
    showToast("请将鼠标移到页面上的 ROI 数字并点击（按 Esc 取消）", 6000);

    const onMove = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || host.contains(target)) {
        pickerHighlight.style.display = "none";
        hoveredEl = null;
        return;
      }
      hoveredEl = target;
      const rect = target.getBoundingClientRect();
      pickerHighlight.style.display = "block";
      pickerHighlight.style.left = `${rect.left}px`;
      pickerHighlight.style.top = `${rect.top}px`;
      pickerHighlight.style.width = `${rect.width}px`;
      pickerHighlight.style.height = `${rect.height}px`;
    };

    const cleanup = () => {
      isPicking = false;
      pickerHighlight.style.display = "none";
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        cleanup();
        showToast("已取消点选");
      }
    };

    const onClick = (e) => {
      if (!isPicking) return;
      if (host.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const target = hoveredEl || e.target;
      cleanup();

      const sel = buildUniqueSelector(target);
      const val = parseNumber(target.textContent);
      config.selector = sel;
      config.selectorLabel = `已选元素(${(target.textContent || "").trim().slice(0, 12)})`;
      saveConfig();
      renderSelectorPreview();
      if (val === null) {
        showToast("已绑定元素，但当前文本里没看到数字，请确认是否选准了数值节点", 4500);
      } else {
        showToast(`绑定成功！当前读数：${val}`, 3500);
      }
      if (config.enabled) evaluateNow();
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  // ---------- UI 渲染 ----------
  function updateDisplay(status, valueText, subText) {
    latestDisplay = { status, text: valueText, rowsSummary: subText };
    $("currentRoiValue").textContent = valueText;
    $("currentStatusSub").textContent = subText;

    const pillDot = $("pillDot");
    const headerDot = $("headerDot");
    pillDot.className = `dot ${status}`;
    headerDot.className = `dot ${status}`;

    const prefix = config.enabled ? "ROI" : "ROI 监控";
    const statusLabel =
      status === "low" ? "跌破下限" : status === "high" ? "突破上限" : status === "ok" ? "正常" : "";
    $("pillText").textContent = config.enabled
      ? `${prefix}: ${valueText}${statusLabel ? ` (${statusLabel})` : ""}`
      : "ROI 监控: 未启动";
  }

  function syncMonitorButton() {
    const btn = $("toggleMonitorBtn");
    if (config.enabled) {
      btn.textContent = "停止监控";
      btn.className = "btn btn-danger";
    } else {
      btn.textContent = "开始监控";
      btn.className = "btn btn-success";
    }
  }

  function renderSelectorPreview() {
    const box = $("selectorPreview");
    if (config.selector) {
      box.innerHTML = `已绑定：<span class="mono">${escapeHtml(config.selector)}</span>`;
    } else {
      box.textContent = "尚未绑定页面元素（点击上方按钮后，在网页上点一下 ROI 数字）";
    }
  }

  function pushLog(level, message) {
    alertLogs.unshift({ time: formatTime(), level, message });
    if (alertLogs.length > 25) alertLogs.pop();
    const container = $("logsContainer");
    container.innerHTML = alertLogs
      .map(
        (item) =>
          `<div class="log-item ${item.level}"><strong>[${item.time}]</strong> ${escapeHtml(item.message)}</div>`
      )
      .join("");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function setPanelOpen(open) {
    isExpanded = open;
    $("panel").classList.toggle("open", open);
    $("pillBtn").style.display = open ? "none" : "flex";
  }

  function switchMode(mode) {
    config.mode = mode;
    $("tabBoth").classList.toggle("active", mode === "both");
    $("tabSingle").classList.toggle("active", mode === "single");
    $("tabTable").classList.toggle("active", mode === "table");
    $("singleModeBox").style.display = mode === "both" || mode === "single" ? "flex" : "none";
    $("tableModeBox").style.display = mode === "both" || mode === "table" ? "flex" : "none";
    saveConfig();
    if (config.enabled) {
      startMonitoring();
    }
  }

  // ---------- 配置持久化 ----------
  function saveConfig() {
    chrome.storage.local.set({ [STORAGE_KEY]: config });
  }

  function applyConfigToInputs() {
    $("roiHeaderKeyword").value = config.roiHeaderKeyword;
    $("costHeaderKeyword").value = config.costHeaderKeyword;
    $("nameHeaderKeyword").value = config.nameHeaderKeyword;
    $("minCost").value = config.minCost;
    $("lowerLimit").value = config.lowerLimit;
    $("upperLimit").value = config.upperLimit;
    $("cooldownMinutes").value = config.cooldownMinutes;
    $("refreshIntervalSec").value = config.refreshIntervalSec;
    $("autoClickRefresh").checked = Boolean(config.autoClickRefresh);
    $("desktopEnabled").checked = Boolean(config.desktopEnabled);
    $("soundEnabled").checked = Boolean(config.soundEnabled);
    $("wecomWebhook").value = config.wecomWebhook;
    $("wecomMobiles").value = config.wecomMobiles;
    $("pushplusToken").value = config.pushplusToken;
    $("customWebhook").value = config.customWebhook;
    $("barkUrl").value = config.barkUrl;
    renderSelectorPreview();
    switchMode(config.mode);
    syncMonitorButton();
  }

  function bindEvents() {
    $("pillBtn").addEventListener("click", () => setPanelOpen(true));
    $("collapseBtn").addEventListener("click", () => setPanelOpen(false));

    $("tabBoth").addEventListener("click", () => switchMode("both"));
    $("tabSingle").addEventListener("click", () => switchMode("single"));
    $("tabTable").addEventListener("click", () => switchMode("table"));

    $("toggleMonitorBtn").addEventListener("click", () => {
      if (config.enabled) {
        stopMonitoring(true);
      } else {
        if ((config.mode === "single" || config.mode === "both") && !config.selector) {
          const found = autoFindRoiElement();
          if (found) {
            config.selector = found.selector;
            config.selectorLabel = found.label;
            renderSelectorPreview();
            showToast(`已自动识别「${found.label}」(${found.value}) 并开始监控`, 3500);
          } else if (config.mode === "single") {
            showToast("请先点选页面上的 ROI 数字，或切到“整体+多计划”模式", 4000);
            return;
          } else {
            showToast("已启动计划列表监控；如需同时盯整体 ROI，请点一下“点选页面整体 ROI”", 4500);
          }
        }
        startMonitoring();
      }
    });

    $("pickElementBtn").addEventListener("click", enterPickerMode);

    $("autoFindRoiBtn").addEventListener("click", () => {
      const found = autoFindRoiElement();
      if (found) {
        config.selector = found.selector;
        config.selectorLabel = found.label;
        saveConfig();
        renderSelectorPreview();
        showToast(`自动识别成功：${found.label} = ${found.value}`, 3500);
        if (config.enabled) evaluateNow();
      } else {
        showToast("未自动找到 ROI 数字，请点击左侧“点选页面上的 ROI 数字”手动点一下", 4000);
      }
    });

    $("testPushBtn").addEventListener("click", () => {
      playBeep("high");
      dispatchToBackground(
        {
          title: "✅ 千川 ROI 监控测试推送",
          summary: "推送通道连接正常！突破上下限时你将在这里实时收到告警。",
          detailLines: [
            `测试时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
            `当前设置区间：[${config.lowerLimit || "-∞"}, ${config.upperLimit || "+∞"}]`,
          ],
          level: "high",
        },
        true
      );
    });

    $("clearLogsBtn").addEventListener("click", () => {
      alertLogs = [];
      cooldownMap.clear();
      $("logsContainer").innerHTML = '<div class="muted">暂无告警记录（冷却记录已重置）</div>';
    });

    // 输入绑定自动保存
    const textFields = [
      "roiHeaderKeyword",
      "costHeaderKeyword",
      "nameHeaderKeyword",
      "minCost",
      "lowerLimit",
      "upperLimit",
      "cooldownMinutes",
      "refreshIntervalSec",
      "wecomWebhook",
      "wecomMobiles",
      "pushplusToken",
      "customWebhook",
      "barkUrl",
    ];
    textFields.forEach((key) => {
      $(key).addEventListener("input", (e) => {
        config[key] = e.target.value;
        saveConfig();
        if (config.enabled) evaluateNow();
      });
    });

    const checkFields = ["autoClickRefresh", "desktopEnabled", "soundEnabled"];
    checkFields.forEach((key) => {
      $(key).addEventListener("change", (e) => {
        config[key] = e.target.checked;
        saveConfig();
        if (key === "autoClickRefresh" && config.enabled) {
          startMonitoring();
        }
      });
    });
  }

  // 响应点击浏览器扩展图标切换面板
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOGGLE_PANEL") {
      setPanelOpen(!isExpanded);
    } else if (msg?.type === "OPEN_PANEL") {
      setPanelOpen(true);
    }
  });

  // 初始化
  bindEvents();
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    if (res && res[STORAGE_KEY]) {
      config = { ...DEFAULT_CONFIG, ...res[STORAGE_KEY] };
    }
    applyConfigToInputs();
    if (config.enabled) {
      startMonitoring();
    }
    // 本地测试页自动展开面板方便体验
    if (location.href.endsWith("demo.html")) {
      setPanelOpen(true);
    }
  });
})();

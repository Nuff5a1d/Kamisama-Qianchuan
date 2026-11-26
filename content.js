// 千川 ROI 实时监控悬浮面板（Shadow DOM 隔离，支持单值秒级监听 + 多架构计划列表监听 + 页面异常提醒）

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
    anomalyAlertEnabled: true,
    staleMinutes: 15,
    soundEnabled: true,
    desktopEnabled: true,
    wecomWebhook: "",
    wecomMobiles: "",
    pushplusToken: "",
    customWebhook: "",
    barkUrl: "",
  };

  const ROI_EXCLUDE_RE = /(目标|出价|设置|预期|建议|保本|门槛|最低)/i;
  const ROI_PREFER_RE = /(整体支付|直接支付|支付roi|成交roi|整体roi|当日roi|实时roi)/i;
  const COST_EXCLUDE_RE = /(成本|预算|出价|门槛|补贴|评分|roi)/i;
  const NAME_EXCLUDE_RE = /(状态|设置|操作|工具|类型|方式|时段|时间|出价|预算|消耗|roi|订单|金额|成本|补贴|评分)/i;
  const SUMMARY_ROW_TEXT_RE = /^(合计|总计|汇总|小计|全部合计|当前页合计|筛选合计|总览|共\s*\d+\s*条)/;
  const SUMMARY_ROW_CLASS_RE = /(measure-row|placeholder|empty|summary|total-row|tfoot|sticky-summary)/i;
  const TABLE_HEADER_PEER_RE = /(计划|消耗|roi|订单|成交|状态|操作|金额|成本|预算|商品|直播|创意|广告)/i;

  const LOGIN_EXPIRED_RE = /(登录已失效|登录已过期|登录状态已失效|请重新登录|账号已退出|会话已过期|身份认证已过期|登录超时|账号已在其他地方登录|请先登录)/;
  const PAGE_ERROR_RE = /(系统异常|网络异常|服务异常|请求失败|加载失败|数据加载异常|页面加载失败|暂无权限|无权访问|访问受限|系统繁忙，请稍后|服务开小差|接口异常|页面崩溃|502 Bad Gateway|504 Gateway|500 Internal)/;
  const ANNOUNCEMENT_IGNORE_RE = /(尊敬的客户|平台公告|温馨提示|系统通知|升级公告)/;

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
    status: "idle", // idle | ok | high | low | warn | error
    text: "未启动",
    rowsSummary: "",
  };

  // 页面健康与断流追踪状态
  const healthState = {
    monitorStartedAt: 0,
    lastDataChangeAt: 0,
    lastDataFingerprint: "",
    hadValidData: false,
    dataMissingSince: 0,
    lastAnomalyCheckAt: 0,
    lastScanMeta: null,
    activeAnomalies: [],
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
    .dot.low, .dot.error { background: #ef4444; box-shadow: 0 0 10px #ef4444; }
    .dot.high { background: #f59e0b; box-shadow: 0 0 10px #f59e0b; }
    .dot.warn { background: #eab308; box-shadow: 0 0 8px #eab308; }

    .panel {
      width: 382px; max-height: 86vh; overflow-y: auto;
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
    .version-tag {
      font-size: 10px; font-weight: 600; color: #93c5fd;
      background: #1f2e4d; border: 1px solid #30497a;
      border-radius: 999px; padding: 1px 6px;
    }
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
    .status-value { font-size: 19px; font-weight: 700; color: #fff; }
    .status-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; word-break: break-word; }
    .btn {
      border: none; border-radius: 8px; padding: 7px 12px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      transition: opacity 0.15s ease; flex-shrink: 0;
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
    .section-title { font-size: 12px; font-weight: 700; color: #93c5fd; display: flex; justify-content: space-between; align-items: center; gap: 6px; }

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
    .health-bar {
      background: #121724; border: 1px solid #25304a; border-radius: 6px;
      padding: 6px 8px; font-size: 11px; color: #cbd5e1;
    }
    .health-bar.warn { border-color: #854d0e; background: #271f0e; color: #fde68a; }
    .health-bar.error { border-color: #7f1d1d; background: #2a1215; color: #fecaca; }

    .logs {
      max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px;
    }
    .log-item {
      background: #10141f; border-left: 3px solid #3b82f6;
      padding: 6px 8px; border-radius: 4px; font-size: 11px;
    }
    .log-item.low, .log-item.error { border-left-color: #ef4444; }
    .log-item.high, .log-item.warn { border-left-color: #f59e0b; }
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
          <span class="version-tag">v1.1.1</span>
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
            <button class="btn btn-ghost btn-sm" id="copyDiagBtn" title="复制页面表格结构诊断JSON（不含Cookie/Token）">复制诊断</button>
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

        <!-- 上下限阈值与页面异常提醒 -->
        <div class="section">
          <div class="section-title"><span>2. 告警阈值 & 页面异常提醒</span></div>
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
          <div class="grid-2">
            <label class="check-row">
              <input type="checkbox" id="anomalyAlertEnabled">
              <span>登录失效/报错/断流提醒</span>
            </label>
            <label class="field">数据无更新断流(分钟,0关)
              <input type="number" min="0" step="1" id="staleMinutes" placeholder="15">
            </label>
          </div>
          <div class="health-bar" id="healthStatusBox">页面健康：等待启动监控</div>
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

  function normalizeText(str) {
    return String(str || "").replace(/\s+/g, " ").trim();
  }

  // 智能解析数值：优先取多行单元格首行（如 "2.81\n基础 2.81"），支持 万/w/亿/千 单位，排除 "-" 和纯百分比涨跌幅
  function parseMetricNumber(rawText, options = {}) {
    const { rejectPercent = true } = options;
    if (rawText === null || rawText === undefined) return null;
    const lines = String(rawText)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;

    const primary = lines[0];
    if (/^[-—–]+$/.test(primary) || /^(暂无|无|N\/A|null|undefined)$/i.test(primary)) {
      return null;
    }

    const cleaned = primary.replace(/[,，\s￥¥元]/g, "");
    const match = cleaned.match(/(-?\d+(?:\.\d+)?)(亿|万|w|W|千|k|K)?(%?)/);
    if (!match) return null;
    if (rejectPercent && match[3] === "%" && !match[2]) {
      return null;
    }

    let val = Number(match[1]);
    if (!Number.isFinite(val)) return null;

    const unit = match[2] || "";
    if (unit === "亿") val *= 1e8;
    else if (unit === "万" || unit === "w" || unit === "W") val *= 1e4;
    else if (unit === "千" || unit === "k" || unit === "K") val *= 1e3;

    return Math.round(val * 10000) / 10000;
  }

  function formatCostDisplay(costVal) {
    if (costVal === null || costVal === undefined) return "--";
    if (costVal >= 10000) {
      return `¥${(costVal / 10000).toFixed(2)}万 (${costVal.toFixed(0)}元)`;
    }
    return `¥${costVal}`;
  }

  function formatTime(date = new Date()) {
    return date.toTimeString().slice(0, 8);
  }

  function playBeep(direction = "low") {
    if (!config.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const freqs =
        direction === "low" || direction === "error"
          ? [520, 390, 520]
          : direction === "warn"
            ? [600, 480]
            : [740, 960];
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

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (host.contains(el)) return false;
    const styleObj = window.getComputedStyle(el);
    if (styleObj.display === "none" || styleObj.visibility === "hidden" || styleObj.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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

  function splitKeywords(raw, fallback) {
    const list = String(raw || "")
      .split(/[,，|｜/]+/)
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, ""))
      .filter(Boolean);
    return list.length > 0 ? list : [fallback.toLowerCase()];
  }

  // 智能列头匹配：支持多关键词，自动避开“目标ROI/出价ROI”和“计划状态”等干扰列
  function findBestColumnIndex(headers, rawKeyword, type) {
    const fallback = type === "roi" ? "roi" : type === "cost" ? "消耗" : "计划";
    const keywords = splitKeywords(rawKeyword, fallback);
    const userWantsExcludedRoi = keywords.some((k) => ROI_EXCLUDE_RE.test(k));
    const userWantsExcludedCost = keywords.some((k) => COST_EXCLUDE_RE.test(k));
    const userWantsExcludedName = keywords.some((k) => NAME_EXCLUDE_RE.test(k));

    let bestIdx = -1;
    let bestScore = -1;

    headers.forEach((rawHeader, idx) => {
      const h = normalizeText(rawHeader);
      if (!h) return;
      const compact = h.toLowerCase().replace(/\s+/g, "");
      const pure = compact.replace(/[（(][^）)]*[）)]/g, "");

      const matchedKw = keywords.find((kw) => compact.includes(kw));
      if (!matchedKw) return;

      if (type === "roi" && !userWantsExcludedRoi && ROI_EXCLUDE_RE.test(compact)) {
        return;
      }
      if (type === "cost" && !userWantsExcludedCost && COST_EXCLUDE_RE.test(compact)) {
        return;
      }
      if (type === "name" && !userWantsExcludedName && NAME_EXCLUDE_RE.test(compact)) {
        return;
      }

      let score = 10;
      if (pure === matchedKw || compact === matchedKw) score += 100;

      if (type === "roi") {
        if (/整体支付roi|直接支付roi/.test(pure)) score += 70;
        else if (/支付roi|成交roi/.test(pure)) score += 50;
        else if (ROI_PREFER_RE.test(pure)) score += 30;
      } else if (type === "cost") {
        if (/整体消耗|总消耗|消耗/.test(pure)) score += 50;
      } else if (type === "name") {
        if (/^(计划|计划名称|广告计划|推广计划|商品|商品名称|名称)$/.test(pure)) score += 70;
        else if (/名称/.test(pure)) score += 40;
      }

      if (compact.length > 20) score -= 25;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });

    return bestIdx;
  }

  function isIgnoredTableRow(rowEl, firstCellsText = []) {
    if (!rowEl || rowEl.nodeType !== 1) return true;
    if (rowEl.closest("thead, tfoot")) return true;
    if (rowEl.getAttribute("aria-hidden") === "true") return true;

    const cls = typeof rowEl.className === "string" ? rowEl.className : "";
    if (SUMMARY_ROW_CLASS_RE.test(cls)) return true;

    const rect = rowEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 1) return true;

    const samples = firstCellsText.length > 0
      ? firstCellsText
      : [normalizeText(rowEl.innerText || rowEl.textContent || "").slice(0, 60)];

    for (const s of samples) {
      const t = normalizeText(s);
      if (!t) continue;
      if (SUMMARY_ROW_TEXT_RE.test(t)) return true;
    }
    return false;
  }

  function extractPlanIdentity(nameCell, rowEl, fallbackIndex) {
    const rawText = String(nameCell?.innerText || nameCell?.textContent || "");
    const idMatch = rawText.match(/ID[:：\s]*(\d{6,})/i);
    const rowKeyAttr =
      rowEl?.getAttribute?.("data-row-key") ||
      rowEl?.getAttribute?.("data-key") ||
      rowEl?.dataset?.rowKey ||
      "";
    const planId = idMatch ? idMatch[1] : rowKeyAttr;

    // 优先尝试查找单元格内明显的标题/链接节点
    let candidateName = "";
    if (nameCell && nameCell.querySelector) {
      const titleEl = nameCell.querySelector(
        "a[title], [class*='name'][title], [class*='title'][title], a, [class*='plan-name'], [class*='campaign-name'], [class*='title']"
      );
      if (titleEl) {
        const t = normalizeText(titleEl.getAttribute("title") || titleEl.innerText || titleEl.textContent);
        if (t && t.length >= 2 && !/^(推商品|推直播间|商品卡|素材|编辑|详情|升级乘方|ID[:：])/i.test(t)) {
          candidateName = t;
        }
      }
    }

    if (!candidateName) {
      const lines = rawText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter(
          (l) =>
            !/^ID[:：\s]*\d+/i.test(l) &&
            !/^(商品卡|推商品|推直播间|直播|图文|视频|素材|素材\d+|投放中|已暂停|待投放|升级乘方.*)$/i.test(l)
        );
      if (lines.length > 0) {
        candidateName = lines[0].replace(/^(商品卡|推商品|全站推广|全域推广|图文|视频)\s+/i, "");
      }
    }

    const cleanName =
      normalizeText(candidateName || rawText)
        .replace(/\s*ID[:：\s]*\d+.*$/i, "")
        .trim()
        .slice(0, 38) || `计划#${fallbackIndex + 1}`;
    const uniqueKey = planId ? `id:${planId}` : `name:${cleanName}`;
    return { id: uniqueKey, planId, name: cleanName };
  }

  // ---------- 自动查找页面整体 ROI 元素（避开表格表头、建议卡片与目标ROI） ----------
  function autoFindRoiElement() {
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = normalizeText(node.textContent);
      if (!txt || txt.length > 24 || !/ROI/i.test(txt)) continue;
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) continue;
      if (parent.closest("table, thead, tbody, [role='table'], [role='grid'], [role='columnheader'], [class*='table-head'], [class*='table-header']")) {
        continue;
      }
      if (ROI_EXCLUDE_RE.test(txt) || /建议/.test(txt)) continue;

      let labelScore = 10;
      if (/整体支付ROI|直接支付ROI/i.test(txt)) labelScore += 80;
      else if (/支付ROI|成交ROI|整体ROI/i.test(txt)) labelScore += 50;
      candidates.push({ el: parent, label: txt, score: labelScore });
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const item of candidates) {
      // 向上最多查找 3 层，找到尺寸合理的指标卡容器
      let container = item.el.parentElement;
      for (let depth = 0; depth < 3 && container; depth++) {
        const rect = container.getBoundingClientRect();
        if (rect.width >= 80 && rect.width <= 520 && rect.height >= 40 && rect.height <= 240) {
          const numEls = Array.from(container.querySelectorAll("*")).filter((el) => {
            if (el === item.el || el.contains(item.el) || !isVisible(el)) return false;
            const t = normalizeText(el.innerText || el.textContent);
            if (!t || t.length > 16 || /%/.test(t)) return false;
            if (!/^\d+(?:,\d+)*(?:\.\d+)?$/.test(t)) return false;
            // 允许纯叶子节点，或仅用于拆分整数/小数的极小内联容器
            return el.children.length === 0 || el.querySelectorAll("div, p, table").length === 0;
          });

          if (numEls.length > 0) {
            // 优先选字号最大、最紧凑的数值元素
            numEls.sort((a, b) => {
              const fa = parseFloat(getComputedStyle(a).fontSize) || 12;
              const fb = parseFloat(getComputedStyle(b).fontSize) || 12;
              if (fb !== fa) return fb - fa;
              return a.children.length - b.children.length;
            });
            const target = numEls[0];
            return {
              el: target,
              selector: buildUniqueSelector(target),
              label: item.label,
              value: normalizeText(target.innerText || target.textContent),
            };
          }
        }
        container = container.parentElement;
      }
    }
    return null;
  }

  // ---------- 多架构计划列表表格扫描 ----------
  // 判断 <thead> 内的某一行是否为千川汇总行（如 ovui-table 会把「共18条计划 | 1120.58 | 2.97」放在 thead 的第二行）
  function isTheadSummaryRow(tr) {
    if (!tr) return true;
    const cls = typeof tr.className === "string" ? tr.className : "";
    if (SUMMARY_ROW_CLASS_RE.test(cls)) return true;

    const cells = Array.from(tr.children).filter((c) => c.tagName === "TH" || c.tagName === "TD");
    if (cells.length === 0) return true;

    const nonEmptyTexts = cells
      .map((c) => normalizeText(c.innerText || c.textContent))
      .filter(Boolean);
    if (nonEmptyTexts.length === 0) return true;

    if (nonEmptyTexts.slice(0, 3).some((t) => SUMMARY_ROW_TEXT_RE.test(t))) {
      return true;
    }

    // 真实表头应以中文/英文列名为主；若半数以上非空单元格是纯数字或 "-"，说明是汇总数据行
    const numericLikeCount = nonEmptyTexts.filter((t) =>
      /^([-—–]+|[¥￥]?\d+(?:,\d+)*(?:\.\d+)?[万亿wWkK%]?)$/.test(t)
    ).length;
    if (nonEmptyTexts.length >= 3 && numericLikeCount / nonEmptyTexts.length >= 0.5) {
      return true;
    }

    return false;
  }

  // 解析 <thead>（支持多行合并表头，并自动剔除放在 thead 里的千川「共N条计划」汇总行）
  function extractTableHeaderLeafCells(table) {
    const rawHeaderRows = Array.from(table.querySelectorAll("thead tr")).filter((tr) => isVisible(tr));
    let headerRows = rawHeaderRows.filter((tr) => !isTheadSummaryRow(tr));
    // 若所有 thead tr 都被过滤（极少数纯数字表头场景），回退使用第一行
    if (headerRows.length === 0 && rawHeaderRows.length > 0) {
      headerRows = [rawHeaderRows[0]];
    }
    if (headerRows.length === 0) {
      const firstRow = table.querySelector("tr");
      if (firstRow && firstRow.querySelector("th") && !isTheadSummaryRow(firstRow)) {
        headerRows.push(firstRow);
      }
    }
    if (headerRows.length === 0) return [];

    // 构建虚拟二维网格展开 rowSpan / colSpan
    const grid = [];
    headerRows.forEach((tr, rIdx) => {
      if (!grid[rIdx]) grid[rIdx] = [];
      let cIdx = 0;
      const cells = Array.from(tr.children).filter((c) => c.tagName === "TH" || c.tagName === "TD");
      for (const cell of cells) {
        while (grid[rIdx][cIdx]) cIdx++;
        const rowSpan = Math.max(1, Number(cell.rowSpan) || 1);
        const colSpan = Math.max(1, Number(cell.colSpan) || 1);
        for (let dr = 0; dr < rowSpan; dr++) {
          if (!grid[rIdx + dr]) grid[rIdx + dr] = [];
          for (let dc = 0; dc < colSpan; dc++) {
            grid[rIdx + dr][cIdx + dc] = cell;
          }
        }
        cIdx += colSpan;
      }
    });

    const lastRow = grid[grid.length - 1] || [];
    return lastRow.map((cell, idx) => ({
      idx,
      cell,
      text: normalizeText(cell?.innerText || cell?.textContent || ""),
      rect: cell ? cell.getBoundingClientRect() : null,
      colCount: lastRow.length,
    }));
  }

  function findRowCellByColumn(cells, colIdx, headerRect, expectedColCount = 0) {
    // 列数完全一致时直接按列下标取单元格（免疫横向滚动与 sticky 固定列遮挡重叠）
    if (expectedColCount > 0 && cells.length === expectedColCount && colIdx >= 0 && colIdx < cells.length) {
      return cells[colIdx];
    }
    // 列数不一致时（如 colSpan 或固定列拆分表）通过 X 坐标中心点/重叠匹配
    if (headerRect && headerRect.width > 0) {
      const hCenter = headerRect.left + headerRect.width / 2;
      let best = null;
      let bestOverlap = 0;
      for (const c of cells) {
        const r = c.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const overlap = Math.min(r.right, headerRect.right) - Math.max(r.left, headerRect.left);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = c;
        } else if (!best && hCenter >= r.left - 4 && hCenter <= r.right + 4) {
          best = c;
        }
      }
      if (best && bestOverlap >= Math.min(headerRect.width, 16) * 0.25) {
        return best;
      }
    }
    if (colIdx >= 0 && colIdx < cells.length) {
      return cells[colIdx];
    }
    return null;
  }

  function getDirectRowCells(tr) {
    return Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
  }

  // 策略 1 & 2：标准 <table> + Arco/Semi/Ant/rc-table 表头表体拆分 & 左右固定列拆分 <table>
  function scanHtmlTables() {
    const tables = Array.from(document.querySelectorAll("table")).filter((t) => isVisible(t));
    if (tables.length === 0) return null;

    const seenRows = new Set();
    const rowsResult = [];
    let excludedSummaryCount = 0;
    let matchedMeta = null;

    // 1) 标准单表（同一 <table> 同时含表头和数据行）
    for (const table of tables) {
      const headerCols = extractTableHeaderLeafCells(table);
      if (headerCols.length < 2) continue;

      const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter((tr) => getDirectRowCells(tr).length > 0);
      if (bodyRows.length === 0) continue;

      const headerTexts = headerCols.map((c) => c.text);
      const roiIdx = findBestColumnIndex(headerTexts, config.roiHeaderKeyword, "roi");
      if (roiIdx === -1) continue;

      const costIdx = findBestColumnIndex(headerTexts, config.costHeaderKeyword, "cost");
      let nameIdx = findBestColumnIndex(headerTexts, config.nameHeaderKeyword, "name");
      if (nameIdx === -1) nameIdx = 0;

      matchedMeta = {
        engine: "standard-table",
        roiHeader: headerTexts[roiIdx],
        costHeader: costIdx >= 0 ? headerTexts[costIdx] : "(未匹配)",
        nameHeader: headerTexts[nameIdx] || "(首列)",
      };

      bodyRows.forEach((tr, i) => {
        const cells = getDirectRowCells(tr);
        const firstTexts = cells.slice(0, 3).map((c) => normalizeText(c.innerText || c.textContent));
        if (isIgnoredTableRow(tr, firstTexts)) {
          excludedSummaryCount++;
          return;
        }
        const expectedCols = headerCols.length;
        const roiCell = findRowCellByColumn(cells, roiIdx, headerCols[roiIdx]?.rect, expectedCols);
        const roiVal = parseMetricNumber(roiCell?.innerText || roiCell?.textContent);
        if (roiVal === null) return;

        const costCell =
          costIdx >= 0 ? findRowCellByColumn(cells, costIdx, headerCols[costIdx]?.rect, expectedCols) : null;
        const costVal = costCell ? parseMetricNumber(costCell.innerText || costCell.textContent) : null;
        const nameCell = findRowCellByColumn(cells, nameIdx, headerCols[nameIdx]?.rect, expectedCols) || cells[0];
        const ident = extractPlanIdentity(nameCell, tr, i);

        if (!seenRows.has(ident.id)) {
          seenRows.add(ident.id);
          rowsResult.push({ id: ident.id, name: ident.name, roi: roiVal, cost: costVal });
        }
      });

      if (rowsResult.length > 0) {
        return { rows: rowsResult, meta: { ...matchedMeta, excludedSummaryCount } };
      }
    }

    // 2) 表头/表体拆分表（Arco / Semi / Ant / ByteDance 固定表头或固定列双/多 <table>）
    const headerOnlyTables = tables.filter((t) => {
      const headers = extractTableHeaderLeafCells(t);
      const dataTrs = Array.from(t.querySelectorAll("tbody tr")).filter((tr) => !isIgnoredTableRow(tr));
      return headers.length >= 2 && dataTrs.length === 0;
    });

    for (const hTable of headerOnlyTables) {
      // 向上查找包含对应表体 <table> 的公共表格容器（最多 6 层）
      let wrapper = hTable.parentElement;
      let siblingBodyTables = [];
      let wrapperHeaderTables = [];
      for (let depth = 0; depth < 6 && wrapper && wrapper !== document.body; depth++) {
        const innerTables = Array.from(wrapper.querySelectorAll("table")).filter((t) => isVisible(t));
        const bodies = innerTables.filter(
          (t) => t !== hTable && Array.from(t.querySelectorAll("tbody tr")).some((tr) => getDirectRowCells(tr).length > 0)
        );
        if (bodies.length > 0) {
          siblingBodyTables = bodies;
          wrapperHeaderTables = innerTables.filter((t) => extractTableHeaderLeafCells(t).length >= 1);
          break;
        }
        wrapper = wrapper.parentElement;
      }

      if (siblingBodyTables.length === 0) continue;

      // 合并容器内所有表头单元格（支持左侧固定列独立 header table + 右侧主 header table）
      const allHeaderCols = [];
      for (const wt of wrapperHeaderTables) {
        const cols = extractTableHeaderLeafCells(wt);
        cols.forEach((c) => allHeaderCols.push({ ...c, table: wt }));
      }

      const headerTexts = allHeaderCols.map((c) => c.text);
      const roiHIdx = findBestColumnIndex(headerTexts, config.roiHeaderKeyword, "roi");
      if (roiHIdx === -1) continue;

      const costHIdx = findBestColumnIndex(headerTexts, config.costHeaderKeyword, "cost");
      const nameHIdx = findBestColumnIndex(headerTexts, config.nameHeaderKeyword, "name");

      const roiCol = allHeaderCols[roiHIdx];
      const costCol = costHIdx >= 0 ? allHeaderCols[costHIdx] : null;
      const nameCol = nameHIdx >= 0 ? allHeaderCols[nameHIdx] : allHeaderCols[0];

      // 找到与 roiCol 水平位置重叠的主表体 table
      const pickBodyTableForHeader = (col) => {
        if (!col || !col.rect) return siblingBodyTables[0];
        let bestTable = null;
        let bestScore = -1;
        for (const bt of siblingBodyTables) {
          const bRect = bt.getBoundingClientRect();
          const overlap = Math.min(bRect.right, col.rect.right) - Math.max(bRect.left, col.rect.left);
          const colCountMatch =
            bt.querySelector("tbody tr") &&
            getDirectRowCells(bt.querySelector("tbody tr")).length === extractTableHeaderLeafCells(col.table).length
              ? 1000
              : 0;
          const score = (overlap > 0 ? overlap : 0) + colCountMatch;
          if (score > bestScore) {
            bestScore = score;
            bestTable = bt;
          }
        }
        return bestTable || siblingBodyTables[0];
      };

      const roiBodyTable = pickBodyTableForHeader(roiCol);
      const costBodyTable = costCol ? pickBodyTableForHeader(costCol) : roiBodyTable;
      const nameBodyTable = nameCol ? pickBodyTableForHeader(nameCol) : roiBodyTable;

      const getValidRows = (bt) => {
        const allTrs = Array.from(bt.querySelectorAll("tbody tr")).filter((tr) => getDirectRowCells(tr).length > 0);
        const valid = [];
        allTrs.forEach((tr) => {
          const cells = getDirectRowCells(tr);
          const firstTexts = cells.slice(0, 3).map((c) => normalizeText(c.innerText || c.textContent));
          if (isIgnoredTableRow(tr, firstTexts)) {
            excludedSummaryCount++;
            return;
          }
          valid.push({
            tr,
            cells,
            rect: tr.getBoundingClientRect(),
            rowKey: tr.getAttribute("data-row-key") || tr.dataset?.rowKey || "",
          });
        });
        return valid;
      };

      const roiRows = getValidRows(roiBodyTable);
      const costRows = costBodyTable === roiBodyTable ? roiRows : getValidRows(costBodyTable);
      const nameRows = nameBodyTable === roiBodyTable ? roiRows : getValidRows(nameBodyTable);

      const findPairedRow = (targetRow, targetIdx, pool) => {
        if (pool === roiRows) return targetRow;
        if (targetRow.rowKey) {
          const byKey = pool.find((r) => r.rowKey && r.rowKey === targetRow.rowKey);
          if (byKey) return byKey;
        }
        // 按 Y 坐标对齐（支持固定列与滚动表独立渲染）
        const byY = pool.find((r) => Math.abs(r.rect.top - targetRow.rect.top) <= 14);
        if (byY) return byY;
        return pool[targetIdx] || null;
      };

      matchedMeta = {
        engine: "split-table",
        roiHeader: roiCol.text,
        costHeader: costCol ? costCol.text : "(未匹配)",
        nameHeader: nameCol ? nameCol.text : "(首列)",
      };

      roiRows.forEach((rowObj, idx) => {
        const roiCell = findRowCellByColumn(rowObj.cells, roiCol.idx, roiCol.rect, roiCol.colCount || 0);
        const roiVal = parseMetricNumber(roiCell?.innerText || roiCell?.textContent);
        if (roiVal === null) return;

        let costVal = null;
        if (costCol) {
          const costRow = findPairedRow(rowObj, idx, costRows);
          if (costRow) {
            const costCell = findRowCellByColumn(costRow.cells, costCol.idx, costCol.rect, costCol.colCount || 0);
            costVal = parseMetricNumber(costCell?.innerText || costCell?.textContent);
          }
        }

        const nameRow = findPairedRow(rowObj, idx, nameRows) || rowObj;
        const nameCell =
          (nameCol ? findRowCellByColumn(nameRow.cells, nameCol.idx, nameCol.rect, nameCol.colCount || 0) : null) ||
          nameRow.cells[0];
        const ident = extractPlanIdentity(nameCell, nameRow.tr, idx);

        if (!seenRows.has(ident.id)) {
          seenRows.add(ident.id);
          rowsResult.push({ id: ident.id, name: ident.name, roi: roiVal, cost: costVal });
        }
      });

      if (rowsResult.length > 0) {
        return { rows: rowsResult, meta: { ...matchedMeta, excludedSummaryCount } };
      }
    }

    return null;
  }

  // 策略 3：ARIA role="table" / role="grid" 虚拟表格
  function scanAriaGridTables() {
    const headerCellsAll = Array.from(document.querySelectorAll('[role="columnheader"]')).filter((el) =>
      isVisible(el)
    );
    if (headerCellsAll.length < 2) return null;

    // 按所属 grid/table 容器分组
    const groupMap = new Map();
    for (const hc of headerCellsAll) {
      const grid = hc.closest('[role="table"], [role="grid"], [class*="table"]') || hc.parentElement?.parentElement;
      if (!grid) continue;
      if (!groupMap.has(grid)) groupMap.set(grid, []);
      groupMap.get(grid).push(hc);
    }

    for (const [grid, hCells] of groupMap.entries()) {
      const headerInfos = hCells.map((cell, idx) => ({
        idx,
        cell,
        text: normalizeText(cell.innerText || cell.textContent),
        rect: cell.getBoundingClientRect(),
      }));
      const headerTexts = headerInfos.map((h) => h.text);
      const roiIdx = findBestColumnIndex(headerTexts, config.roiHeaderKeyword, "roi");
      if (roiIdx === -1) continue;

      const costIdx = findBestColumnIndex(headerTexts, config.costHeaderKeyword, "cost");
      let nameIdx = findBestColumnIndex(headerTexts, config.nameHeaderKeyword, "name");
      if (nameIdx === -1) nameIdx = 0;

      const dataRows = Array.from(grid.querySelectorAll('[role="row"]')).filter(
        (r) => isVisible(r) && !r.querySelector('[role="columnheader"]')
      );
      if (dataRows.length === 0) continue;

      // 将同一视觉水平带（或同一 data-row-key）的拆分行合并
      const bands = [];
      for (const r of dataRows) {
        const cells = Array.from(r.querySelectorAll('[role="cell"], [role="gridcell"]')).filter((c) => isVisible(c));
        if (cells.length === 0) continue;
        const rect = r.getBoundingClientRect();
        const key = r.getAttribute("data-row-key") || "";
        let band = bands.find((b) => (key && b.key === key) || Math.abs(b.top - rect.top) <= 14);
        if (!band) {
          band = { key, top: rect.top, rowEl: r, cells: [] };
          bands.push(band);
        }
        band.cells.push(...cells);
      }

      const rowsResult = [];
      const seen = new Set();
      let excludedSummaryCount = 0;

      bands.forEach((band, idx) => {
        const firstTexts = band.cells.slice(0, 3).map((c) => normalizeText(c.innerText || c.textContent));
        if (isIgnoredTableRow(band.rowEl, firstTexts)) {
          excludedSummaryCount++;
          return;
        }
        const roiCell = findRowCellByColumn(band.cells, roiIdx, headerInfos[roiIdx].rect);
        const roiVal = parseMetricNumber(roiCell?.innerText || roiCell?.textContent);
        if (roiVal === null) return;

        const costCell =
          costIdx >= 0 ? findRowCellByColumn(band.cells, costIdx, headerInfos[costIdx].rect) : null;
        const costVal = costCell ? parseMetricNumber(costCell.innerText || costCell.textContent) : null;
        const nameCell = findRowCellByColumn(band.cells, nameIdx, headerInfos[nameIdx]?.rect) || band.cells[0];
        const ident = extractPlanIdentity(nameCell, band.rowEl, idx);

        if (!seen.has(ident.id)) {
          seen.add(ident.id);
          rowsResult.push({ id: ident.id, name: ident.name, roi: roiVal, cost: costVal });
        }
      });

      if (rowsResult.length > 0) {
        return {
          rows: rowsResult,
          meta: {
            engine: "aria-grid",
            roiHeader: headerTexts[roiIdx],
            costHeader: costIdx >= 0 ? headerTexts[costIdx] : "(未匹配)",
            nameHeader: headerTexts[nameIdx] || "(首列)",
            excludedSummaryCount,
          },
        };
      }
    }

    return null;
  }

  // 策略 4：通用 Div / 虚拟滚动表格几何对齐引擎（专治无 <table> 且无 role="columnheader" 的千川全域/推商品虚拟列表）
  function scanGeometricDivTables() {
    const roiKeywords = splitKeywords(config.roiHeaderKeyword, "roi");
    const userWantsExcludedRoi = roiKeywords.some((k) => ROI_EXCLUDE_RE.test(k));

    // 1) 查找页面上所有可能是表格 ROI 列头的元素
    const roiHeaderCandidates = [];
    const allEls = document.querySelectorAll("th, [role='columnheader'], [class*='head'] *, [class*='th'], [class*='header'] *, div, span");
    for (const el of allEls) {
      if (!isVisible(el)) continue;
      // 跳过大容器，只看紧凑的列头节点
      const rect = el.getBoundingClientRect();
      if (rect.height > 64 || rect.width > 340 || rect.width < 24) continue;
      // 跳过包含嵌套块级大布局的元素，优先最内层文本容器
      if (el.querySelector("table, tr, [role='row']")) continue;

      const txt = normalizeText(el.innerText || el.textContent);
      if (!txt || txt.length > 26) continue;
      const compact = txt.toLowerCase().replace(/\s+/g, "");
      if (!roiKeywords.some((kw) => compact.includes(kw))) continue;
      if (!userWantsExcludedRoi && ROI_EXCLUDE_RE.test(compact)) continue;

      // 避免父子同时命中：只保留不含同样匹配子元素的最深节点
      const hasMatchingChild = Array.from(el.children).some((ch) => {
        const ct = normalizeText(ch.innerText || ch.textContent).toLowerCase().replace(/\s+/g, "");
        return ct && roiKeywords.some((kw) => ct.includes(kw));
      });
      if (hasMatchingChild) continue;

      roiHeaderCandidates.push({ el, text: txt, rect });
    }

    if (roiHeaderCandidates.length === 0) return null;

    for (const cand of roiHeaderCandidates) {
      // 向上找公共表头行 / 表格容器：需要同一水平 Y 带上存在 >= 2 个其他常见表头词（如 计划/消耗/订单/成交/操作）
      let tableRoot = null;
      let peerHeaders = [];
      let headerBottom = cand.rect.bottom;

      let cur = cand.el.parentElement;
      for (let depth = 0; depth < 7 && cur && cur !== document.body; depth++) {
        const curRect = cur.getBoundingClientRect();
        if (curRect.width >= 420 && curRect.height >= 120) {
          // 收集与 cand 在同一水平带上的所有紧凑列头文本节点
          const bandNodes = [];
          const descendants = cur.querySelectorAll("th, [role='columnheader'], [class*='th'], [class*='cell'], [class*='head'] div, [class*='head'] span, div, span");
          for (const d of descendants) {
            if (!isVisible(d)) continue;
            const r = d.getBoundingClientRect();
            if (r.height > 64 || r.width < 20 || r.width > 340) continue;
            if (Math.abs(r.top - cand.rect.top) > 22 && Math.abs((r.top + r.bottom) / 2 - (cand.rect.top + cand.rect.bottom) / 2) > 22) {
              continue;
            }
            const t = normalizeText(d.innerText || d.textContent);
            if (!t || t.length > 26) continue;
            // 仅保留无同文本子元素的叶子/表头单元
            const dupChild = Array.from(d.children).some((ch) => normalizeText(ch.innerText || ch.textContent) === t);
            if (dupChild) continue;
            bandNodes.push({ el: d, text: t, rect: r });
          }

          // 去重（按 X 坐标重叠去重，保留更紧凑节点）
          bandNodes.sort((a, b) => a.rect.left - b.rect.left || a.rect.width - b.rect.width);
          const deduped = [];
          for (const bn of bandNodes) {
            const existing = deduped.find(
              (e) => Math.abs(e.rect.left - bn.rect.left) < 12 && Math.abs(e.rect.right - bn.rect.right) < 12
            );
            if (!existing) deduped.push(bn);
          }

          const peerScore = deduped.filter((h) => TABLE_HEADER_PEER_RE.test(h.text)).length;
          if (deduped.length >= 3 && peerScore >= 2 && curRect.bottom > cand.rect.bottom + 50) {
            tableRoot = cur;
            peerHeaders = deduped;
            headerBottom = Math.max(...deduped.map((h) => h.rect.bottom));
            break;
          }
        }
        cur = cur.parentElement;
      }

      if (!tableRoot || peerHeaders.length < 3) continue;

      const headerTexts = peerHeaders.map((h) => h.text);
      const roiIdx = findBestColumnIndex(headerTexts, config.roiHeaderKeyword, "roi");
      if (roiIdx === -1) continue;
      const costIdx = findBestColumnIndex(headerTexts, config.costHeaderKeyword, "cost");
      const nameIdx = findBestColumnIndex(headerTexts, config.nameHeaderKeyword, "name");

      const roiHeader = peerHeaders[roiIdx];
      const costHeader = costIdx >= 0 ? peerHeaders[costIdx] : null;
      const nameHeader = nameIdx >= 0 ? peerHeaders[nameIdx] : peerHeaders[0];

      // 收集表头下方的数据行元素
      const rowSelectors = [
        "tbody tr",
        "[role='row']",
        "[data-row-key]",
        "[class*='table-row']",
        "[class*='TableRow']",
        "[class*='table_row']",
        "[class*='body-row']",
        "[class*='tr-row']",
      ].join(",");

      const rawRows = Array.from(tableRoot.querySelectorAll(rowSelectors)).filter((r) => {
        if (!isVisible(r)) return false;
        const rect = r.getBoundingClientRect();
        return rect.top >= headerBottom - 6 && rect.height >= 24 && rect.width >= 150;
      });

      if (rawRows.length === 0) continue;

      // 按 data-row-key 或 Y 坐标合并拆分的固定列与主滚动列
      const bands = [];
      for (const r of rawRows) {
        // 跳过嵌套在其他候选行内部的子元素
        if (rawRows.some((other) => other !== r && other.contains(r))) continue;
        const rect = r.getBoundingClientRect();
        const key = r.getAttribute("data-row-key") || r.dataset?.rowKey || "";
        let band = bands.find((b) => (key && b.key === key) || Math.abs(b.top - rect.top) <= 14);
        if (!band) {
          band = { key, top: rect.top, rowEls: [] };
          bands.push(band);
        }
        band.rowEls.push(r);
      }

      const rowsResult = [];
      const seen = new Set();
      let excludedSummaryCount = 0;

      bands.forEach((band, idx) => {
        const primaryRow = band.rowEls[0];
        const allCells = [];
        for (const rEl of band.rowEls) {
          const explicitCells = Array.from(
            rEl.querySelectorAll("td, [role='cell'], [role='gridcell'], [class*='table-cell'], [class*='TableCell'], [class*='table-td'], [class*='cell']")
          ).filter((c) => {
            if (!isVisible(c)) return false;
            const cr = c.getBoundingClientRect();
            return cr.width >= 20 && cr.width <= 460 && cr.height >= 16;
          });
          if (explicitCells.length >= 2) {
            // 去掉嵌套外层容器，只保留最直接的单元格
            explicitCells.forEach((c) => {
              if (!explicitCells.some((other) => other !== c && c.contains(other) && other.getBoundingClientRect().width > 20)) {
                allCells.push(c);
              }
            });
          } else {
            Array.from(rEl.children)
              .filter((c) => isVisible(c))
              .forEach((c) => allCells.push(c));
          }
        }

        const firstTexts = allCells.slice(0, 3).map((c) => normalizeText(c.innerText || c.textContent));
        if (band.rowEls.some((rEl) => isIgnoredTableRow(rEl, firstTexts))) {
          excludedSummaryCount++;
          return;
        }

        const roiCell = findRowCellByColumn(allCells, -1, roiHeader.rect);
        const roiVal = parseMetricNumber(roiCell?.innerText || roiCell?.textContent);
        if (roiVal === null) return;

        const costCell = costHeader ? findRowCellByColumn(allCells, -1, costHeader.rect) : null;
        const costVal = costCell ? parseMetricNumber(costCell.innerText || costCell.textContent) : null;

        const nameCell = (nameHeader ? findRowCellByColumn(allCells, -1, nameHeader.rect) : null) || allCells[0];
        const ident = extractPlanIdentity(nameCell, primaryRow, idx);

        if (!seen.has(ident.id)) {
          seen.add(ident.id);
          rowsResult.push({ id: ident.id, name: ident.name, roi: roiVal, cost: costVal });
        }
      });

      if (rowsResult.length > 0) {
        return {
          rows: rowsResult,
          meta: {
            engine: "geometric-div-table",
            roiHeader: roiHeader.text,
            costHeader: costHeader ? costHeader.text : "(未匹配)",
            nameHeader: nameHeader ? nameHeader.text : "(首列)",
            excludedSummaryCount,
          },
        };
      }
    }

    return null;
  }

  function scanCampaignTables() {
    const res = scanHtmlTables() || scanAriaGridTables() || scanGeometricDivTables();
    if (res) {
      healthState.lastScanMeta = res.meta;
      return res;
    }
    healthState.lastScanMeta = null;
    return { rows: [], meta: null };
  }

  // ---------- 页面异常检测（登录失效 / 页面报错 / 断流卡死 / 目标丢失） ----------
  function findPageUpdateTimeText() {
    // 识别千川顶部如 "11-26 16:14 更新" 的更新时间文本，辅助判断断流
    const els = document.querySelectorAll("span, div, p");
    for (const el of els) {
      if (el.children.length > 0 || !isVisible(el)) continue;
      const t = normalizeText(el.textContent);
      if (t.length >= 6 && t.length <= 28 && /\d{1,2}:\d{2}\s*更新/.test(t)) {
        return t;
      }
    }
    return "";
  }

  function detectPageAnomalies(hasValidData, fingerprint) {
    if (!config.enabled || !config.anomalyAlertEnabled) {
      updateHealthBox("ok", "页面异常提醒已关闭");
      return [];
    }

    const now = Date.now();
    if (hasValidData && fingerprint) {
      healthState.hadValidData = true;
      healthState.dataMissingSince = 0;
      if (fingerprint !== healthState.lastDataFingerprint) {
        healthState.lastDataFingerprint = fingerprint;
        healthState.lastDataChangeAt = now;
      }
    } else if (healthState.hadValidData && !healthState.dataMissingSince) {
      healthState.dataMissingSince = now;
    }

    // DOM 异常扫描每 3 秒执行一次，避免高频遍历消耗性能
    if (now - healthState.lastAnomalyCheckAt < 3000) {
      return healthState.activeAnomalies;
    }
    healthState.lastAnomalyCheckAt = now;

    const detected = [];

    // 1) 登录态失效检测（URL 跳转或登录弹窗）
    if (/(^|\/)(login|passport|signin|sso)(\/|$|\?)/i.test(location.pathname)) {
      detected.push({
        key: "anomaly:login_url",
        level: "error",
        title: "🔐 页面登录态失效提醒",
        summary: `当前页面已跳转至登录页（${location.pathname}），ROI 监控已中断`,
      });
    } else {
      const dialogNodes = document.querySelectorAll(
        "[role='dialog'], [role='alertdialog'], [class*='modal'], [class*='dialog'], [class*='login'], [class*='passport']"
      );
      for (const el of dialogNodes) {
        if (!isVisible(el)) continue;
        const txt = normalizeText(el.innerText || el.textContent).slice(0, 260);
        if (!txt || ANNOUNCEMENT_IGNORE_RE.test(txt)) continue;
        const m = txt.match(LOGIN_EXPIRED_RE);
        if (m) {
          detected.push({
            key: "anomaly:login_modal",
            level: "error",
            title: "🔐 千川登录态失效提醒",
            summary: `检测到登录弹窗/提示「${m[0]}」，请尽快重新登录恢复监控`,
          });
          break;
        }
      }
    }

    // 2) 页面报错 / 接口异常检测（避开顶部公告条）
    if (detected.length === 0) {
      const alertNodes = document.querySelectorAll(
        "[role='alert'], [role='dialog'], [class*='message'], [class*='toast'], [class*='error'], [class*='exception'], [class*='empty']"
      );
      for (const el of alertNodes) {
        if (!isVisible(el)) continue;
        if (el.closest("[class*='banner'], [class*='announce'], [class*='notice-bar'], [class*='marquee']")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height > 460 && rect.width > window.innerWidth * 0.85) continue;
        const txt = normalizeText(el.innerText || el.textContent).slice(0, 220);
        if (!txt || ANNOUNCEMENT_IGNORE_RE.test(txt)) continue;
        const m = txt.match(PAGE_ERROR_RE);
        if (m) {
          detected.push({
            key: `anomaly:error:${m[0]}`,
            level: "error",
            title: "🚨 千川页面异常/报错提醒",
            summary: `页面出现异常提示「${m[0]}」，请检查网络或刷新页面`,
            snippet: txt.slice(0, 80),
          });
          break;
        }
      }
    }

    // 3) 监控目标突然持续丢失 >= 2 分钟（曾正常读到过数据，随后页面白屏/切页/崩溃）
    if (healthState.hadValidData && healthState.dataMissingSince > 0) {
      const missingMin = (now - healthState.dataMissingSince) / 60000;
      if (missingMin >= 2) {
        detected.push({
          key: "anomaly:data_missing",
          level: "warn",
          title: "⚠️ 监控数据丢失提醒",
          summary: `已连续 ${Math.floor(missingMin)} 分钟无法读取到 ROI 数据，页面可能已切页、卡死或加载失败`,
        });
      }
    }

    // 4) 数据长时间无更新 / 断流卡死检测
    const staleMinLimit = Number(config.staleMinutes || 0);
    if (staleMinLimit > 0 && healthState.lastDataChangeAt > 0 && hasValidData) {
      const idleMin = (now - healthState.lastDataChangeAt) / 60000;
      if (idleMin >= staleMinLimit) {
        detected.push({
          key: "anomaly:data_stale",
          level: "warn",
          title: "⏸️ 页面数据长时间未更新（断流提醒）",
          summary: `已连续 ${Math.floor(idleMin)} 分钟未检测到任何 ROI/消耗数据变动，可能已断流或未开启刷新`,
        });
      }
    }

    healthState.activeAnomalies = detected;

    if (detected.length > 0) {
      const top = detected[0];
      updateHealthBox(top.level, `异常：${top.summary}`);
      for (const item of detected) {
        triggerAnomalyAlert(item);
      }
    } else {
      const idleSec = healthState.lastDataChangeAt ? Math.floor((now - healthState.lastDataChangeAt) / 1000) : 0;
      const idleText = healthState.lastDataChangeAt
        ? idleSec < 60
          ? `${idleSec}秒前有数据更新`
          : `${Math.floor(idleSec / 60)}分钟前有数据更新`
        : "已启动健康监测";
      updateHealthBox("ok", `页面健康：正常（${idleText}）`);
    }

    return detected;
  }

  function updateHealthBox(level, text) {
    const box = $("healthStatusBox");
    if (!box) return;
    box.textContent = text;
    box.className = `health-bar${level === "warn" ? " warn" : level === "error" ? " error" : ""}`;
  }

  function triggerAnomalyAlert(item) {
    const cooldownMs = Math.max(5, Number(config.cooldownMinutes || 10)) * 60 * 1000;
    const last = cooldownMap.get(item.key);
    const now = Date.now();
    if (last && now - last.ts < cooldownMs) {
      return;
    }
    cooldownMap.set(item.key, { ts: now, direction: item.level });

    const detailLines = [
      `检测时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      ...(item.snippet ? [`异常片段：${item.snippet}`] : []),
      `当前页面：${document.title || location.pathname}`,
    ];

    playBeep(item.level);
    pushLog(item.level, `${item.title} - ${item.summary}`);
    dispatchToBackground({
      title: item.title,
      summary: item.summary,
      detailLines,
      level: item.level,
    });
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

    const cooldownMs = Math.max(0, Number(config.cooldownMinutes || 0)) * 60 * 1000;
    const last = cooldownMap.get(targetKey);
    const now = Date.now();
    if (last && last.direction === direction && now - last.ts < cooldownMs) {
      return direction;
    }
    cooldownMap.set(targetKey, { ts: now, direction });

    const isLow = direction === "low";
    const title = isLow ? "⚠️ ROI 跌破下限提醒" : "🔥 ROI 突破上限提醒";
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
    const rank = { error: 5, low: 4, high: 3, ok: 2, warn: 1, idle: 0 };
    return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
  }

  function evaluateNow() {
    if (!config.enabled) return;

    const wantSingle = config.mode === "both" || config.mode === "single";
    const wantTable = config.mode === "both" || config.mode === "table";

    let singleStatus = "idle";
    let singleValueText = "--";
    let singleSubText = "";
    let singleValid = false;
    let singleFp = "";

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
          const val = parseMetricNumber(el.innerText || el.textContent);
          if (val === null) {
            singleStatus = "warn";
            singleValueText = "无数字";
            singleSubText = `读取到：${normalizeText(el.textContent).slice(0, 16)}`;
          } else {
            const label = config.selectorLabel || "整体 ROI";
            singleStatus = checkAndAlert("single_roi", label, val);
            singleValueText = String(val);
            singleSubText = `${label}: ${val}`;
            singleValid = true;
            singleFp = `S:${val}`;
          }
        }
      }
    }

    let tableStatus = "idle";
    let tableValueText = "--";
    let tableSubText = "";
    let tableValid = false;
    let tableFp = "";

    if (wantTable) {
      const { rows, meta } = scanCampaignTables();
      const minCost = Number(config.minCost || 0);
      if (rows.length === 0) {
        $("tableScanSummary").textContent =
          "暂未识别到含 ROI 列的表格（请确认列表已加载，或点右上角「复制诊断」发给开发者）";
        tableStatus = "warn";
        tableValueText = "0条计划";
        tableSubText = "未识别到计划表格";
      } else {
        tableValid = true;
        tableFp = rows.map((r) => `${r.id}:${r.cost ?? ""}:${r.roi}`).join("|");

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

          const extra = row.cost !== null ? [`当前消耗：${formatCostDisplay(row.cost)}`] : [];
          const st = checkAndAlert(`row:${row.id}`, `计划「${row.name}」`, row.roi, extra);
          if (st !== "ok") {
            alertCount++;
            worst = mergeStatus(worst, st);
          }
        }

        const rangeText = activeCount > 0 ? `计划ROI ${minRoi}~${maxRoi}` : "暂无达标消耗计划";
        const colHint = meta ? ` · 匹配列[${meta.nameHeader}|${meta.costHeader}|${meta.roiHeader}]` : "";
        $("tableScanSummary").textContent = `已识别 ${rows.length} 条计划，达标 ${activeCount} 条，异常 ${alertCount} 条（${rangeText}）${colHint}`;
        tableStatus = worst;
        tableValueText = alertCount > 0 ? `${alertCount}条异常` : `${activeCount}条正常`;
        tableSubText = rangeText;
      }
    }

    // 页面健康与断流监测
    const pageTimeTag = findPageUpdateTimeText();
    const hasValidData = singleValid || tableValid;
    const fingerprint = [singleFp, tableFp, pageTimeTag].filter(Boolean).join("#");
    const anomalies = detectPageAnomalies(hasValidData, fingerprint);
    const anomalyLevel = anomalies.length > 0 ? anomalies[0].level : "idle";

    const limitHint = `区间[${config.lowerLimit || "-∞"}, ${config.upperLimit || "+∞"}]`;
    if (config.mode === "both") {
      const combinedStatus = mergeStatus(mergeStatus(singleStatus, tableStatus), anomalyLevel);
      updateDisplay(
        combinedStatus,
        `整体 ${singleValueText} · ${tableValueText}`,
        `${limitHint} | ${tableSubText || singleSubText}`
      );
    } else if (config.mode === "single") {
      updateDisplay(mergeStatus(singleStatus, anomalyLevel), singleValueText, `${singleSubText} · ${limitHint}`);
    } else {
      updateDisplay(mergeStatus(tableStatus, anomalyLevel), tableValueText, `${tableSubText} · ${limitHint}`);
    }
  }

  function tryClickPageRefresh() {
    if (!config.enabled || !config.autoClickRefresh) return;
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, span, i"));
    const refreshBtn = candidates.find((el) => {
      if (!isVisible(el)) return false;
      const txt = normalizeText(el.textContent);
      const title = normalizeText(el.getAttribute("title") || el.getAttribute("aria-label"));
      const cls = typeof el.className === "string" ? el.className : "";
      return (
        txt === "刷新" ||
        txt === "刷新数据" ||
        title === "刷新" ||
        title === "刷新数据" ||
        (title.includes("刷新") && title.length <= 10) ||
        (/icon-refresh|refresh-btn|btn-refresh/i.test(cls) && el.getBoundingClientRect().width <= 48)
      );
    });
    if (refreshBtn) {
      refreshBtn.click();
    }
  }

  // ---------- 安全 DOM 诊断（不含 Cookie / Token） ----------
  function buildDomDiagnosticReport() {
    const tables = Array.from(document.querySelectorAll("table")).map((t, i) => ({
      i,
      visible: isVisible(t),
      cls: String(t.className || "").slice(0, 80),
      parentCls: String(t.parentElement?.className || "").slice(0, 80),
      headers: extractTableHeaderLeafCells(t).map((c) => c.text).slice(0, 16),
      tbodyRows: t.querySelectorAll("tbody tr").length,
      sampleRow1: Array.from(t.querySelectorAll("tbody tr")[0]?.children || [])
        .map((c) => normalizeText(c.innerText || c.textContent).slice(0, 24))
        .slice(0, 12),
    }));
    const roleGrids = Array.from(
      document.querySelectorAll("[role='table'], [role='grid'], [class*='table-wrap'], [class*='arco-table'], [class*='semi-table'], [class*='byted-table'], [class*='ovui-table']")
    )
      .slice(0, 10)
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className || "").slice(0, 90),
        role: el.getAttribute("role"),
        rows: el.querySelectorAll("[role='row'], tr, [class*='row']").length,
      }));
    const scanRes = scanCampaignTables();
    return {
      version: "1.1.1",
      urlPath: location.origin + location.pathname,
      scanMeta: scanRes.meta,
      scannedCount: scanRes.rows.length,
      sampleScanned: scanRes.rows.slice(0, 3),
      tablesCount: tables.length,
      tables: tables.slice(0, 8),
      roleGrids,
    };
  }

  // ---------- 启动 / 停止监听 ----------
  function startMonitoring() {
    stopMonitoring(false);
    config.enabled = true;
    saveConfig();

    const now = Date.now();
    healthState.monitorStartedAt = now;
    healthState.lastDataChangeAt = now;
    healthState.lastDataFingerprint = "";
    healthState.hadValidData = false;
    healthState.dataMissingSince = 0;
    healthState.lastAnomalyCheckAt = 0;
    healthState.activeAnomalies = [];

    let debounceTimer = null;
    observer = new MutationObserver(() => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        evaluateNow();
      }, 250);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    pollTimer = setInterval(evaluateNow, 1000);

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
      updateHealthBox("ok", "页面健康：监控已暂停");
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
      const val = parseMetricNumber(target.innerText || target.textContent);
      config.selector = sel;
      config.selectorLabel = `已选元素(${normalizeText(target.textContent).slice(0, 12)})`;
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
      status === "error"
        ? "页面异常"
        : status === "low"
          ? "跌破下限"
          : status === "high"
            ? "突破上限"
            : status === "ok"
              ? "正常"
              : "";
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
    if (alertLogs.length > 30) alertLogs.pop();
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
    $("staleMinutes").value = config.staleMinutes;
    $("autoClickRefresh").checked = Boolean(config.autoClickRefresh);
    $("anomalyAlertEnabled").checked = Boolean(config.anomalyAlertEnabled);
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
        showToast("未自动找到 ROI 数字，请点击左侧“点选页面整体 ROI”手动点一下", 4000);
      }
    });

    $("copyDiagBtn").addEventListener("click", async () => {
      const report = buildDomDiagnosticReport();
      const jsonText = JSON.stringify(report, null, 2);
      try {
        await navigator.clipboard.writeText(jsonText);
        showToast(`诊断 JSON 已复制（当前扫描到 ${report.scannedCount} 条计划）`, 4000);
      } catch {
        console.log("[QC-ROI-DIAG]", jsonText);
        showToast("剪贴板无权限，已输出到 F12 Console 的 [QC-ROI-DIAG]", 4500);
      }
    });

    $("testPushBtn").addEventListener("click", () => {
      playBeep("high");
      dispatchToBackground(
        {
          title: "✅ 千川 ROI 监控测试推送",
          summary: "推送通道连接正常！突破上下限或页面异常时你将在这里实时收到告警。",
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

    const textFields = [
      "roiHeaderKeyword",
      "costHeaderKeyword",
      "nameHeaderKeyword",
      "minCost",
      "lowerLimit",
      "upperLimit",
      "cooldownMinutes",
      "refreshIntervalSec",
      "staleMinutes",
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

    const checkFields = ["autoClickRefresh", "anomalyAlertEnabled", "desktopEnabled", "soundEnabled"];
    checkFields.forEach((key) => {
      $(key).addEventListener("change", (e) => {
        config[key] = e.target.checked;
        saveConfig();
        if (key === "autoClickRefresh" && config.enabled) {
          startMonitoring();
        } else if (config.enabled) {
          evaluateNow();
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
    if (location.href.endsWith("demo.html")) {
      setPanelOpen(true);
    }
  });
})();

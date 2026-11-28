// 后台 Service Worker：负责跨域消息推送（企微/PushPlus/钉钉/飞书/Bark）、桌面通知以及任意网页一键注入面板

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  } catch (err) {
    // 当前页面未自动注入时（例如其他自研后台或本地测试页），动态注入 content.js 并展开面板
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: "OPEN_PANEL" }).catch(() => {});
      }, 150);
    } catch (injectErr) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "ROI 监控无法在当前页启动",
        message: "Chrome 系统页/应用商店不支持注入，请在千川或普通网页上点击图标。",
      });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DISPATCH_ALERT") {
    handleDispatchAlert(message.payload)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true; // 保持异步通道
  }
  if (message?.type === "GENERATE_AI_SUMMARY") {
    handleGenerateAiSummary(message.payload)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "CHECK_EXTENSION_UPDATE") {
    handleCheckExtensionUpdate()
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

function compareSemver(a, b) {
  const pa = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function handleCheckExtensionUpdate() {
  const currentVersion = chrome.runtime.getManifest()?.version || "1.3.3";
  const pageUrl = "https://www.kamisama.si";
  const ts = Date.now();
  let latestVersion = "";
  let downloadUrl = "";
  let notes = "";

  // 1) 优先读取官网轻量版本清单 https://www.kamisama.si/version.json
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(`${pageUrl}/version.json?t=${ts}`, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      if (data && data.version) {
        latestVersion = String(data.version).replace(/^v/i, "").trim();
        downloadUrl = String(data.downloadUrl || "").trim();
        notes = String(data.notes || "").trim();
      }
    }
  } catch {
    // 若官网暂未放置 version.json，自动回退检查主页源码
  }

  // 2) 回退检测主页 HTML 中的安装包版本号
  if (!latestVersion) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const resp = await fetch(`${pageUrl}/?t=${ts}`, { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (resp.ok) {
        const html = await resp.text();
        const zipMatch = html.match(/Kamisama-Qianchuan-v(\d+\.\d+\.\d+)\.zip/i);
        if (zipMatch) {
          latestVersion = zipMatch[1];
          downloadUrl = `${pageUrl}/downloads/Kamisama-Qianchuan-v${latestVersion}.zip`;
        }
      }
    } catch {
      // 网络不可达时返回当前版本与主页入口
    }
  }

  const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);
  return {
    currentVersion,
    latestVersion: latestVersion || currentVersion,
    hasUpdate,
    downloadUrl: downloadUrl || pageUrl,
    pageUrl,
    notes,
    remoteChecked: Boolean(latestVersion),
  };
}

async function handleDispatchAlert(payload) {
  const { title, summary, detailLines, level } = payload;
  let channels = { ...(payload.channels || {}) };
  // 兜底：若页面侧有未同步或空字段，自动从 chrome.storage.local 持久化渠道补齐
  try {
    const stored = await chrome.storage.local.get(["qc_roi_monitor_channels_v1"]);
    const saved = stored?.qc_roi_monitor_channels_v1;
    if (saved) {
      if (channels.desktop === undefined) channels.desktop = Boolean(saved.desktopEnabled);
      if (!channels.wecomWebhook && saved.wecomWebhook) channels.wecomWebhook = saved.wecomWebhook;
      if (!channels.wecomMobiles && saved.wecomMobiles) channels.wecomMobiles = saved.wecomMobiles;
      if (!channels.pushplusToken && saved.pushplusToken) channels.pushplusToken = saved.pushplusToken;
      if (!channels.customWebhook && saved.customWebhook) channels.customWebhook = saved.customWebhook;
      if (!channels.barkUrl && saved.barkUrl) channels.barkUrl = saved.barkUrl;
    }
  } catch {
    // 忽略读取异常，继续使用传入配置
  }
  const results = [];
  const plainText = [title, summary, ...(detailLines || [])].filter(Boolean).join("\n");
  const markdownText = [
    `### ${title}`,
    `> ${summary}`,
    ...(detailLines || []).map((line) => `- ${line}`),
  ].join("\n");

  // 1. Chrome 桌面系统通知
  if (channels?.desktop) {
    try {
      await new Promise((resolve, reject) => {
        chrome.notifications.create(
          {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: title,
            message: [summary, ...(detailLines || []).slice(0, 2)].filter(Boolean).join("\n"),
            priority: 2,
          },
          (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          }
        );
      });
      results.push({ channel: "桌面通知", ok: true });
    } catch (e) {
      results.push({ channel: "桌面通知", ok: false, error: e.message });
    }
  }

  // 2. 企业微信群机器人 Webhook
  if (channels?.wecomWebhook?.trim()) {
    const url = channels.wecomWebhook.trim();
    const mentions = (channels.wecomMobiles || "")
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const isWarnLevel = level === "low" || level === "error" || level === "warn";
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: {
            content: isWarnLevel
              ? markdownText.replace(title, `<font color="warning">${title}</font>`)
              : markdownText.replace(title, `<font color="info">${title}</font>`),
          },
        }),
      });
      const data = await safeJson(resp);
      if (!resp.ok || (data && data.errcode !== 0)) {
        throw new Error(data?.errmsg || `HTTP ${resp.status}`);
      }
      // 企微 markdown 不支持直接 @手机号，如有指定 @ 人，补发一条极简 text 提醒
      if (mentions.length > 0) {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msgtype: "text",
            text: {
              content: `${title}：${summary}`,
              mentioned_mobile_list: mentions,
            },
          }),
        }).catch(() => {});
      }
      results.push({ channel: "企业微信", ok: true });
    } catch (e) {
      results.push({ channel: "企业微信", ok: false, error: e.message });
    }
  }

  // 3. PushPlus（个人微信服务号推送）
  if (channels?.pushplusToken?.trim()) {
    try {
      const resp = await fetch("https://www.pushplus.plus/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: channels.pushplusToken.trim(),
          title,
          content: markdownText,
          template: "markdown",
        }),
      });
      const data = await safeJson(resp);
      if (!resp.ok || (data && data.code !== 200)) {
        throw new Error(data?.msg || `HTTP ${resp.status}`);
      }
      results.push({ channel: "PushPlus微信", ok: true });
    } catch (e) {
      results.push({ channel: "PushPlus微信", ok: false, error: e.message });
    }
  }

  // 4. 钉钉 / 飞书群机器人 Webhook（自动识别 URL）
  if (channels?.customWebhook?.trim()) {
    const url = channels.customWebhook.trim();
    try {
      let body;
      if (url.includes("feishu.cn") || url.includes("larksuite.com")) {
        body = {
          msg_type: "text",
          content: { text: plainText },
        };
      } else {
        // 默认按钉钉机器人格式（同时兼容多数通用 webhook）
        body = {
          msgtype: "markdown",
          markdown: { title, text: markdownText },
        };
      }
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await safeJson(resp);
      const errCode = data?.errcode ?? data?.code ?? data?.StatusCode ?? 0;
      if (!resp.ok || errCode !== 0) {
        throw new Error(data?.errmsg || data?.msg || `HTTP ${resp.status}`);
      }
      results.push({ channel: "飞书/钉钉", ok: true });
    } catch (e) {
      results.push({ channel: "飞书/钉钉", ok: false, error: e.message });
    }
  }

  // 5. Bark（iPhone 强推送，自动兼容整段 curl 示例 / 带 /title/body 的链接 / 纯 Key）
  if (channels?.barkUrl?.trim()) {
    try {
      const base = normalizeBarkUrl(channels.barkUrl);
      const endpoint = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(
        [summary, ...(detailLines || []).slice(0, 2)].join(" | ")
      )}?group=ROI监控&sound=alarm`;
      const resp = await fetch(endpoint, { method: "GET" });
      const data = await safeJson(resp);
      if (!resp.ok || (data && data.code && data.code !== 200)) {
        throw new Error(data?.message || `HTTP ${resp.status}`);
      }
      results.push({ channel: "Bark", ok: true });
    } catch (e) {
      results.push({ channel: "Bark", ok: false, error: e.message });
    }
  }

  return results;
}

function normalizeBarkUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const urlMatch = s.match(/(https?:\/\/[^/\s"'`]+)\/([A-Za-z0-9_-]{8,})/i);
  if (urlMatch) {
    return `${urlMatch[1]}/${urlMatch[2]}`;
  }
  if (/^[A-Za-z0-9_-]{12,}$/.test(s)) {
    return `https://api.day.app/${s}`;
  }
  return s.replace(/\/+$/, "");
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

// ---------- AI 投流大脑：支持豆包(火山方舟) / 智谱 GLM-4-Flash / DeepSeek / 通义千问 / 硅基流动 / 自定义 OpenAI 兼容接口 ----------
const AI_PROVIDER_PRESETS = {
  doubao: {
    name: "豆包(火山方舟)",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    defaultModel: "doubao-1-5-pro-32k-250115",
  },
  zhipu: {
    name: "智谱清言(GLM-4-Flash)",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    defaultModel: "glm-4-flash",
  },
  deepseek: {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-chat",
  },
  qwen: {
    name: "通义千问",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    defaultModel: "qwen-plus",
  },
  siliconflow: {
    name: "硅基流动",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
  },
  custom: {
    name: "自定义兼容接口",
    endpoint: "",
    defaultModel: "",
  },
};

async function handleGenerateAiSummary(payload) {
  const { aiConfig = {}, metricsData = {} } = payload || {};
  const providerKey = aiConfig.provider || "doubao";
  const preset = AI_PROVIDER_PRESETS[providerKey] || AI_PROVIDER_PRESETS.custom;
  const apiKey = String(aiConfig.apiKey || "").trim();
  const rawEndpoint = String(aiConfig.endpoint || "").trim();
  // 防串台自愈：选了 DeepSeek/智谱/通义 等内置厂商，但接口地址仍是其他厂商的默认地址（如旧默认豆包地址）时，自动纠偏为当前厂商官方地址
  const otherPresetEndpoints = Object.entries(AI_PROVIDER_PRESETS)
    .filter(([k, v]) => k !== providerKey && v.endpoint)
    .map(([, v]) => v.endpoint);
  const endpoint =
    providerKey !== "custom" && (!rawEndpoint || otherPresetEndpoints.includes(rawEndpoint))
      ? preset.endpoint
      : rawEndpoint || preset.endpoint || "";
  const model = String(aiConfig.model || preset.defaultModel || "").trim();

  if (!apiKey) throw new Error("未填写 AI API Key");
  if (!endpoint) throw new Error("未配置 AI 接口地址");
  if (!model) throw new Error("未填写模型名称 / 豆包推理接入点 ID");

  const systemPrompt = [
    "你是资深巨量千川投流总监（精通千川乘方、商品卡、全域投放与直播间调控）。",
    "请根据用户提供的实时投放快照与近30分钟趋势数据，输出一份极度精炼、可直接照做的中文投流总结报告。",
    "严格按以下 4 点输出（总字数控制在 240~380 字以内，不要客套话、不要 Markdown 代码块、每点用换行分段）：",
    "1. 【大盘走势与预判】：结合总ROI、消耗增速与近30分钟变化，判断接下来半小时更可能走稳、走高还是下滑，点出核心风险。",
    "2. 【优质好计划（放量建议）】：点名 1~3 条高ROI或上升趋势的好计划，给出具体动作（加预算/追投/维持）。",
    "3. 【异常坏计划（止损与预算不足）】：点名跌破下限、预算不足或灰保过保的计划，明确谁该降出价/暂停、谁该马上补预算、谁要盯防跑偏。",
    "4. 【下个30分钟重点动作】：给出 2~3 条按优先级排好的立刻执行指令。",
  ].join("\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 22000);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 700,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(metricsData) },
        ],
      }),
      signal: controller.signal,
    });
    const data = await safeJson(resp);
    if (!resp.ok) {
      const errMsg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
      throw new Error(errMsg);
    }
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("AI 返回内容为空");
    }
    return {
      text: content,
      providerName: preset.name,
      model,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

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
});

async function handleDispatchAlert(payload) {
  const { title, summary, detailLines, channels, level } = payload;
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

  // 5. Bark（iPhone 强推送）
  if (channels?.barkUrl?.trim()) {
    try {
      const base = channels.barkUrl.trim().replace(/\/+$/, "");
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

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

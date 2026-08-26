(() => {
  const API = "/home23/api/product";
  const state = {
    token: sessionStorage.getItem("home23:product-token") || "",
    capabilities: null,
    bootstrap: null,
    bots: [],
    channels: [],
    inbox: [],
    selected: null,
    searchScope: "all",
    connection: "loading",
    pending: new Map(),
    provisioning: [],
    refreshTimer: null,
  };
  const $ = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>'"]/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        })[c],
    );
  const fmtTime = (v) => {
    if (!v) return "";
    const d = new Date(v),
      now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const toast = (text) => {
    $("toast").textContent = text;
    $("toast").classList.add("show");
    setTimeout(() => $("toast").classList.remove("show"), 2200);
  };
  const idem = (label) => `${label}-${uuidV7()}`;
  const opaqueId = (prefix) => `${prefix}_${uuidV7()}`;

  function uuidV7() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    let ms = Date.now();
    for (let i = 5; i >= 0; i--) {
      b[i] = ms & 255;
      ms = Math.floor(ms / 256);
    }
    b[6] = (b[6] & 15) | 112;
    b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  async function api(path, options = {}) {
    const headers = { accept: "application/json", ...(options.headers || {}) };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (options.body) headers["content-type"] = "application/json";
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        data.error?.message ||
          `Home23 did not complete that request (${response.status}).`,
      );
      error.code = data.error?.code;
      error.status = response.status;
      error.requestId = data.error?.requestId;
      throw error;
    }
    return data;
  }
  function availability(bot) {
    return bot?.availability || "offline";
  }
  function directChannel(bot) {
    return (
      state.channels.find((c) => c.conversationId === bot.conversationId) ||
      null
    );
  }
  function inboxFor(channelId) {
    return state.inbox.find((c) => c.channelId === channelId) || null;
  }
  function primaryBotId() {
    return (
      state.bootstrap?.home?.primaryBotId ||
      state.bootstrap?.snapshot?.bots?.find(
        (b) => b.name?.toLowerCase() === "jerry",
      )?.id ||
      state.bots.find((b) => b.name?.toLowerCase() === "jerry")?.id
    );
  }
  function rank(item) {
    return [
      item.pinned ? 0 : 1,
      item.activity?.state && item.activity.state !== "idle" ? 0 : 1,
      item.unread?.count ? 0 : 1,
      -new Date(item.updatedAt || 0).getTime(),
      String(item.title || "").toLowerCase(),
    ];
  }
  function ordered(rows) {
    return [...rows].sort((a, b) => {
      const ar = rank(a),
        br = rank(b);
      for (let i = 0; i < ar.length; i++) {
        if (ar[i] < br[i]) return -1;
        if (ar[i] > br[i]) return 1;
      }
      return 0;
    });
  }
  function setConnection(kind, message) {
    state.connection = kind;
    $("app").setAttribute("aria-busy", String(kind === "loading"));
    $("connection-label").textContent =
      kind === "online"
        ? "Connected"
        : kind === "loading"
          ? "Connecting…"
          : kind === "revoked"
            ? "Connection revoked"
            : kind === "degraded"
              ? "Reconnecting…"
              : "Offline";
    const show = !["online", "loading"].includes(kind);
    $("connection-banner").hidden = !show;
    $("banner-text").textContent =
      message ||
      (kind === "revoked"
        ? "This browser no longer has access."
        : kind === "degraded"
          ? "Home23 is reconnecting. Messages remain visible; sending is paused."
          : "Home23 is offline.");
    document
      .querySelectorAll(".ca-send")
      .forEach((b) => (b.disabled = kind !== "online"));
  }
  async function load() {
    setConnection("loading");
    try {
      state.capabilities = await api("/capabilities");
      if (!state.token) {
        setConnection("revoked", "Connect this browser to see your Home23.");
        renderRoster();
        openDialog("connection-dialog");
        return;
      }
      const requests = [api("/bots")];
      if (state.capabilities.capabilities?.channelsRead)
        requests.push(api("/channels?limit=100"));
      else requests.push(Promise.resolve({ channels: [] }));
      if (state.capabilities.capabilities?.conversationsRead)
        requests.push(api("/inbox"));
      else requests.push(Promise.resolve({ conversations: [] }));
      if (state.capabilities.capabilities?.bootstrap)
        requests.push(api("/bootstrap"));
      else requests.push(Promise.resolve(null));
      const [bots, channels, inbox, boot] = await Promise.all(requests);
      state.bots = bots.bots || [];
      state.channels = channels.channels || [];
      state.inbox = inbox.conversations || [];
      state.bootstrap = boot;
      state.provisioning = state.provisioning.filter(
        (p) => !state.bots.some((b) => b.residentBinding === p.residentBinding),
      );
      setConnection("online");
      renderRoster();
      scheduleRefresh();
      const current =
        state.selected && state.channels.some((c) => c.id === state.selected)
          ? state.selected
          : null;
      const jerry =
        state.bots.find((b) => b.id === primaryBotId()) ||
        state.bots.find((b) => b.name?.toLowerCase() === "jerry");
      const first =
        new URLSearchParams(location.search).get("channel") ||
        current ||
        (matchMedia("(min-width: 681px)").matches
          ? directChannel(jerry)?.id || ordered(state.inbox)[0]?.channelId
          : null);
      if (first) await openConversation(first);
    } catch (error) {
      setConnection(
        error.status === 401 ? "revoked" : "degraded",
        error.status === 401
          ? "Your Home23 access has expired or was revoked."
          : "Home23 could not be reached. Retrying will not create duplicate actions.",
      );
      if (error.status === 401) openDialog("connection-dialog");
      renderRoster();
      scheduleRefresh();
    }
  }
  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(async () => {
      if (document.hidden) return scheduleRefresh();
      try {
        await refreshInbox();
        if (state.selected) await refreshSelectedQuietly();
        if (state.connection !== "online") setConnection("online");
      } catch (error) {
        setConnection(error.status === 401 ? "revoked" : "degraded");
      }
      scheduleRefresh();
    }, 15000);
  }

  function row(item, kind, bot) {
    const selected = state.selected === item.channelId;
    const count = item.unread?.count || 0;
    const active = item.activity?.state && item.activity.state !== "idle";
    const primary = bot?.id === primaryBotId();
    return `<button class="ca-row${selected ? " active" : ""}" data-channel="${esc(item.channelId || "")}" data-kind="${kind}" aria-current="${selected ? "page" : "false"}"><span class="ca-avatar ${kind === "channel" ? "channel" : ""} ${primary ? "primary" : ""}" style="--row-accent:${esc(bot?.accent || "var(--accent)")}">${esc((item.title || "?").slice(0, 2).toUpperCase())}</span><span class="ca-row-main"><span class="ca-row-line"><span class="ca-row-name">${esc(item.title)}</span>${primary ? '<span class="ca-primary-label">Primary</span>' : ""}</span><span class="ca-row-preview">${esc(active ? item.activity.label || "Active now" : item.latestMessage?.preview || bot?.purpose || item.purpose || "No messages yet")}</span></span><span class="ca-row-side"><time>${esc(fmtTime(item.latestMessage?.createdAt || item.updatedAt))}</time>${count ? `<b class="ca-unread" aria-label="${count} unread">${count}</b>` : active ? '<i class="ca-activity-dot" aria-label="Active"></i>' : ""}</span></button>`;
  }
  function renderRoster() {
    const botRows = state.bots.map((bot) => {
      const channel = directChannel(bot),
        summary = inboxFor(channel?.id);
      return {
        ...(summary || {}),
        channelId: channel?.id || "",
        title: bot.name,
        purpose: bot.purpose,
        updatedAt: summary?.updatedAt || bot.updatedAt,
        bot,
      };
    });
    const channelRows = state.channels
      .filter((c) => c.kind === "group")
      .map((channel) => ({
        ...channel,
        ...inboxFor(channel.id),
        channelId: channel.id,
        title: channel.title,
        purpose: channel.purpose,
      }));
    const provisioning = state.provisioning
      .map(
        (p) =>
          `<div class="ca-row ca-provisioning" aria-label="${esc(p.name)} is provisioning"><span class="ca-avatar">${esc(p.name.slice(0, 2).toUpperCase())}</span><span class="ca-row-main"><span class="ca-row-name">${esc(p.name)}</span><span class="ca-row-preview">Getting ready…</span></span><i class="ca-activity-dot"></i></div>`,
      )
      .join("");
    $("bots-list").innerHTML =
      provisioning +
        ordered(botRows)
          .map((x) => row(x, "bot", x.bot))
          .join("") || '<div class="ca-empty-row">No Bots are available.</div>';
    $("channels-list").innerHTML =
      ordered(channelRows)
        .map((x) => row(x, "channel"))
        .join("") || '<div class="ca-empty-row">No Channels yet.</div>';
    const unread = state.inbox.reduce((n, c) => n + (c.unread?.count || 0), 0);
    $("unread-total").textContent = `${unread} unread`;
    document
      .querySelectorAll(".ca-row[data-channel]")
      .forEach((el) =>
        el.addEventListener("click", () =>
          el.dataset.channel
            ? openConversation(el.dataset.channel)
            : toast("This Bot’s conversation is still provisioning."),
        ),
      );
    renderChannelMembers();
  }
  async function openConversation(channelId, focusMessageId = null) {
    try {
      const [channelResult, transcript] = await Promise.all([
        api(`/channels/${encodeURIComponent(channelId)}`),
        api(`/channels/${encodeURIComponent(channelId)}/messages?limit=100`),
      ]);
      state.selected = channelId;
      const destination = new URL(location.href);
      destination.searchParams.set("channel", channelId);
      history.replaceState(null, "", destination);
      renderRoster();
      renderConversation(channelResult.channel, transcript.messages || []);
      $("conversation").classList.add("open");
      $("conversation").focus({ preventScroll: true });
      if (focusMessageId)
        document
          .getElementById(`message-${CSS.escape(focusMessageId)}`)
          ?.scrollIntoView({ block: "center" });
      const latest = Math.max(
        0,
        ...(transcript.messages || []).map((m) => m.sequence || 0),
      );
      if (latest && state.capabilities.capabilities?.readCursorMutation)
        markRead(channelId, latest);
    } catch (error) {
      setConnection(error.status === 401 ? "revoked" : "degraded");
      renderConversationFailure(error);
    }
  }
  async function refreshSelectedQuietly() {
    const channelId = state.selected;
    if (!channelId) return;
    const [channelResult, transcript] = await Promise.all([
      api(`/channels/${encodeURIComponent(channelId)}`),
      api(`/channels/${encodeURIComponent(channelId)}/messages?limit=100`),
    ]);
    if (state.selected !== channelId) return;
    const focused = document.activeElement?.id === "composer-text",
      draft = focused ? $("composer-text")?.value : "";
    renderConversation(channelResult.channel, transcript.messages || []);
    if (focused && $("composer-text")) {
      $("composer-text").value = draft;
      $("composer-text").focus();
    }
  }
  function renderConversation(channel, messages) {
    const activity = inboxFor(channel.id)?.activity;
    // The current dashboard body parser cannot safely stream the canonical
    // multipart upload. Keep this unavailable instead of simulating support.
    const canAttach = false;
    const members = channel.members?.filter((m) => m.kind === "bot") || [];
    $("conversation").innerHTML =
      `<header class="ca-thread-head"><button class="ca-back" id="back-button" aria-label="Back to Inbox">‹</button><span class="ca-avatar ${channel.kind === "group" ? "channel" : ""}">${esc(channel.title.slice(0, 2).toUpperCase())}</span><div class="ca-thread-identity"><h2>${esc(channel.title)}</h2><p>${channel.kind === "group" ? `${members.length} Bot${members.length === 1 ? "" : "s"}` : "Direct conversation"}</p></div><button class="ca-details-button" id="details-button">Details</button></header><div class="ca-messages" id="messages" aria-live="polite">${messages.length ? messages.map(messageHtml).join("") : '<div class="ca-welcome"><h2>Start the conversation.</h2><p>This durable thread will be here when you return.</p></div>'}</div><div class="ca-activity" id="thread-activity">${activity?.state && activity.state !== "idle" ? '<i class="ca-activity-dot"></i>' + esc(activity.label || "Active now") : ""}</div><div class="ca-composer-wrap"><form class="ca-composer" id="composer"><button class="ca-attach" type="button" id="attach-button" ${canAttach ? "" : "disabled"} aria-label="${canAttach ? "Add attachment" : "Attachments are not available"}" title="${canAttach ? "Add attachment" : "Attachments are not available"}">＋</button><textarea id="composer-text" rows="1" placeholder="Message ${esc(channel.title)}" aria-label="Message ${esc(channel.title)}" required></textarea><button class="ca-send" type="submit" aria-label="Send message">↑</button></form><input id="attachment-input" type="file" multiple hidden></div>`;
    $("back-button").addEventListener("click", () => {
      $("conversation").classList.remove("open");
      const destination = new URL(location.href);
      destination.searchParams.delete("channel");
      history.replaceState(null, "", destination);
    });
    $("details-button").addEventListener("click", () => showDetails(channel));
    $("composer").addEventListener("submit", sendMessage);
    $("composer-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        $("composer").requestSubmit();
      }
    });
    $("attach-button").addEventListener("click", () => {
      if (canAttach) $("attachment-input").click();
    });
    $("attachment-input").addEventListener("change", () =>
      toast("Attachment upload requires the active attachment capability."),
    );
    const pane = $("messages");
    pane.scrollTop = pane.scrollHeight;
  }
  function messageHtml(m) {
    const owner = m.author?.kind === "owner";
    const attachments = (m.attachments || [])
      .map(
        (a) =>
          `<div class="ca-attachment"><span class="ca-avatar channel">↗</span><span><b>${esc(a.name || "Attachment")}</b><span>${esc(a.contentType || "File")}${a.byteCount ? ` · ${Math.ceil(a.byteCount / 1024)} KB` : ""}</span></span></div>`,
      )
      .join("");
    return `<article class="ca-message ${owner ? "owner" : "bot"}" id="message-${esc(m.id)}"><div class="ca-message-meta">${owner ? "" : `<strong>${esc(m.author?.displayName || "Bot")}</strong>`}<time>${esc(fmtTime(m.createdAt))}</time>${m.visibility === "tombstoned" ? "<span>Removed</span>" : ""}</div><div>${esc(m.text || "").replace(/\n/g, "<br>")}</div>${attachments}</article>`;
  }
  function renderConversationFailure(error) {
    $("conversation").innerHTML =
      `<div class="ca-welcome"><div class="ca-house-mark">!</div><h2>Conversation unavailable</h2><p>${esc(error.message)}</p><button class="ca-details-button" id="conversation-retry">Try again</button></div>`;
    $("conversation-retry").addEventListener(
      "click",
      () => state.selected && openConversation(state.selected),
    );
  }
  async function sendMessage(event) {
    event.preventDefault();
    if (state.connection !== "online")
      return toast("Reconnect before sending.");
    const input = $("composer-text"),
      text = input.value.trim();
    if (!text) return;
    const messageId = opaqueId("msg"),
      clientMessageId = opaqueId("client");
    const pending = document.createElement("article");
    pending.className = "ca-message owner pending";
    pending.id = `message-${messageId}`;
    pending.innerHTML = `<div class="ca-message-meta"><span>Sending…</span></div><div>${esc(text).replace(/\n/g, "<br>")}</div>`;
    $("messages").append(pending);
    $("messages").scrollTop = $("messages").scrollHeight;
    input.value = "";
    input.disabled = true;
    state.pending.set(messageId, { text, clientMessageId });
    try {
      await api(`/channels/${encodeURIComponent(state.selected)}/messages`, {
        method: "POST",
        headers: { "idempotency-key": idem("web-message") },
        body: JSON.stringify({
          messageId,
          clientMessageId,
          text,
          attachmentIds: [],
          mentions: mentionsFor(text),
          replyToMessageId: null,
        }),
      });
      state.pending.delete(messageId);
      await refreshInbox();
      await openConversation(state.selected);
    } catch (error) {
      pending.className = "ca-message owner failed";
      pending.querySelector(".ca-message-meta").innerHTML =
        `<span>Not sent · ${esc(error.message)}</span>`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        input.value = text;
        pending.remove();
        $("composer").requestSubmit();
      });
      pending.append(retry);
    } finally {
      input.disabled = false;
      input.focus();
    }
  }
  function mentionsFor(text) {
    const lower = text.toLowerCase();
    return state.bots
      .filter((b) => lower.includes(`@${b.name.toLowerCase()}`))
      .map((b) => b.principalId || b.id);
  }
  async function markRead(channelId, throughSequence) {
    try {
      await api(`/channels/${encodeURIComponent(channelId)}/read`, {
        method: "POST",
        headers: { "idempotency-key": idem("web-read") },
        body: JSON.stringify({ throughSequence }),
      });
      await refreshInbox();
    } catch {
      /* read acknowledgement can safely retry on the next observation */
    }
  }
  async function refreshInbox() {
    if (!state.capabilities.capabilities?.conversationsRead) return;
    const data = await api("/inbox");
    state.inbox = data.conversations || [];
    renderRoster();
  }

  function showDetails(channel) {
    const bot = state.bots.find(
      (b) => b.conversationId === channel.conversationId,
    );
    const people = channel.members
      ?.map((m) =>
        m.kind === "owner"
          ? "You"
          : state.bots.find((b) => b.principalId === m.principalId)?.name ||
            "Bot",
      )
      .join(", ");
    $("details-pane").innerHTML =
      `<div class="ca-details-head"><h2>Details</h2><button class="ca-close" id="close-details" aria-label="Close details">×</button></div><div class="ca-avatar ca-detail-avatar ${channel.kind === "group" ? "channel" : ""}">${esc(channel.title.slice(0, 2).toUpperCase())}</div><div class="ca-detail-center"><h2>${esc(channel.title)}</h2><p>${esc(channel.purpose || bot?.purpose || "No purpose added.")}</p></div><div class="ca-detail-list"><div class="ca-detail-row"><span>Kind</span>${channel.kind === "group" ? "Channel" : "Bot conversation"}</div>${channel.kind === "group" ? `<div class="ca-detail-row"><span>Members</span>${esc(people || "You")}</div>` : `<div class="ca-detail-row"><span>Availability</span>${esc(availability(bot))}</div><div class="ca-detail-row"><span>Default execution</span>On this Mac</div>`}<div class="ca-detail-row"><span>Notifications</span>Normal</div><div class="ca-detail-row"><span>Routines</span>Schedule details are not available in this web version.</div><div class="ca-detail-row"><span>Isolation</span>Verified isolated execution is not available.</div><div class="ca-detail-row"><span>Archive</span>The Core API preserves archived Bots; archived inventory and restore controls are not yet available in this web view.</div></div>${bot && state.capabilities.capabilities?.botLifecycle ? `<div class="ca-detail-actions"><button data-control="start">Start</button><button data-control="stop">Stop</button><button data-control="restart">Restart</button></div>` : ""}<div class="ca-detail-actions"><a href="/home23/legacy">Advanced diagnostics</a></div>`;
    $("details-pane").hidden = false;
    $("app").classList.add("details-open");
    $("close-details").addEventListener("click", closeDetails);
    document
      .querySelectorAll("[data-control]")
      .forEach((b) =>
        b.addEventListener("click", () =>
          controlBot(bot.id, b.dataset.control),
        ),
      );
  }
  function closeDetails() {
    $("details-pane").hidden = true;
    $("app").classList.remove("details-open");
    $("details-button")?.focus();
  }
  async function controlBot(botId, operation) {
    try {
      await api(`/bots/${encodeURIComponent(botId)}/${operation}`, {
        method: "POST",
        headers: { "idempotency-key": idem(`web-${operation}`) },
      });
      toast(`${operation[0].toUpperCase() + operation.slice(1)} requested`);
      await load();
    } catch (error) {
      toast(error.message);
    }
  }

  function openDialog(id) {
    const dialog = $(id);
    if (!dialog.open) dialog.showModal();
    queueMicrotask(() =>
      dialog
        .querySelector("input:not([type=checkbox]),textarea,button")
        ?.focus(),
    );
  }
  function closeDialog(id) {
    $(id).close();
  }
  function renderChannelMembers() {
    $("channel-members").innerHTML =
      state.bots
        .map(
          (b, i) =>
            `<label class="ca-member"><input type="checkbox" value="${esc(b.id)}" ${i < 2 ? "checked" : ""}><span>${esc(b.name)}</span></label>`,
        )
        .join("") || "<p>No persistent Bots are available.</p>";
  }
  async function createBot(event) {
    event.preventDefault();
    const errorEl = $("bot-form-error");
    errorEl.textContent = "";
    const name = $("bot-name").value.trim(),
      purpose = $("bot-purpose").value.trim(),
      residentBinding = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 63);
    if (!residentBinding)
      return (errorEl.textContent =
        "Choose a name containing letters or numbers.");
    const submit = event.submitter;
    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      await api("/bots", {
        method: "POST",
        headers: { "idempotency-key": idem("web-create-bot") },
        body: JSON.stringify({
          displayName: name,
          residentBinding,
          purpose,
          requiredCapabilities: ["messages"],
        }),
      });
      state.provisioning.push({ name, residentBinding });
      closeDialog("bot-dialog");
      toast(`${name} is provisioning`);
      event.target.reset();
      renderRoster();
      await load();
    } catch (error) {
      errorEl.textContent = `${error.message} Your draft has been kept.`;
    } finally {
      submit.disabled = false;
      submit.textContent = "Create Bot";
    }
  }
  async function createChannel(event) {
    event.preventDefault();
    const errorEl = $("channel-form-error");
    errorEl.textContent = "";
    const memberBotIds = [
      ...$("channel-members").querySelectorAll("input:checked"),
    ].map((x) => x.value);
    if (!memberBotIds.length)
      return (errorEl.textContent = "Choose at least one Bot.");
    const name = $("channel-name").value.trim(),
      purpose = $("channel-purpose").value.trim(),
      submit = event.submitter;
    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const result = await api("/channels", {
        method: "POST",
        headers: { "idempotency-key": idem("web-create-channel") },
        body: JSON.stringify({
          kind: "group",
          memberBotIds,
          title: name,
          purpose,
          pinned: false,
          responderPolicy: {
            mode: "mention_or_coordinator",
            coordinatorBotId: memberBotIds[0],
            responseOrder: "sequential",
            maxBotTurns: Math.min(4, memberBotIds.length),
          },
        }),
      });
      closeDialog("channel-dialog");
      event.target.reset();
      toast(`${name} is ready`);
      await load();
      if (result.channel?.id) openConversation(result.channel.id);
    } catch (error) {
      errorEl.textContent = `${error.message} Your draft has been kept.`;
    } finally {
      submit.disabled = false;
      submit.textContent = "Create Channel";
    }
  }

  function localSearch(query, scope) {
    const q = query.toLowerCase(),
      results = [];
    if (["all", "bots"].includes(scope))
      for (const b of state.bots)
        if (`${b.name} ${b.purpose}`.toLowerCase().includes(q)) {
          const c = directChannel(b);
          results.push({
            type: "Bot",
            title: b.name,
            excerpt: b.purpose,
            channelId: c?.id,
            createdAt: b.updatedAt,
          });
        }
    if (["all", "channels"].includes(scope))
      for (const c of state.channels.filter((c) => c.kind === "group"))
        if (`${c.title} ${c.purpose}`.toLowerCase().includes(q))
          results.push({
            type: "Channel",
            title: c.title,
            excerpt: c.purpose,
            channelId: c.id,
            createdAt: c.updatedAt,
          });
    return results;
  }
  async function runSearch() {
    const query = $("search-input").value.trim(),
      scope = state.searchScope;
    if (!query) {
      $("search-results").innerHTML = "";
      $("search-status").textContent = "Type to search this Home23.";
      return;
    }
    if (scope === "attachments") {
      $("search-results").innerHTML = "";
      $("search-status").textContent =
        "Attachment search is not available from this server yet.";
      return;
    }
    let results = localSearch(query, scope),
      completeness = null;
    if (
      ["all", "messages"].includes(scope) &&
      state.capabilities.capabilities?.search
    ) {
      try {
        const data = await api(
          `/search?q=${encodeURIComponent(query)}&scope=all&limit=50`,
        );
        results.push(
          ...(data.results || []).map((r) => ({ ...r, type: "Message" })),
        );
        completeness = data.completeness;
      } catch (error) {
        $("search-status").textContent =
          "Message results are unavailable. Bot and Channel matches are shown.";
      }
    }
    const partial = completeness && completeness.status !== "complete";
    $("search-status").textContent = partial
      ? "Results may be incomplete. Home23 could not prove full message coverage."
      : `${results.length} result${results.length === 1 ? "" : "s"}${scope === "all" && !state.capabilities.capabilities?.search ? " · Message search unavailable" : ""}`;
    $("search-results").innerHTML =
      results
        .map(
          (r) =>
            `<button class="ca-result" data-channel="${esc(r.channelId || "")}" data-message="${esc(r.id || "")}"><span class="ca-avatar ${r.type === "Channel" ? "channel" : ""}">${esc(r.type.slice(0, 1))}</span><span><strong>${esc(r.title)}</strong><p>${esc(r.excerpt || "")}</p></span><time>${esc(fmtTime(r.createdAt))}</time></button>`,
        )
        .join("") ||
      '<div class="ca-empty-row">No matches in the available sources.</div>';
    document.querySelectorAll(".ca-result").forEach((r) =>
      r.addEventListener("click", () => {
        if (r.dataset.channel) {
          closeDialog("search-dialog");
          openConversation(r.dataset.channel, r.dataset.message);
        }
      }),
    );
  }

  $("search-button").addEventListener("click", () => {
    openDialog("search-dialog");
    $("search-input").focus();
  });
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch();
  });
  $("search-input").addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runSearch, 180);
  });
  document.querySelectorAll("[data-scope]").forEach((button) =>
    button.addEventListener("click", () => {
      state.searchScope = button.dataset.scope;
      document.querySelectorAll("[data-scope]").forEach((b) => {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-selected", String(b === button));
      });
      runSearch();
    }),
  );
  $("new-bot-button").addEventListener("click", () =>
    state.capabilities?.capabilities?.botLifecycle
      ? openDialog("bot-dialog")
      : toast("New Bot is not enabled by this Home23."),
  );
  $("new-channel-button").addEventListener("click", () =>
    state.capabilities?.capabilities?.channelsRead
      ? openDialog("channel-dialog")
      : toast("New Channel is not enabled by this Home23."),
  );
  $("settings-button").addEventListener("click", () =>
    openDialog("connection-dialog"),
  );
  $("bot-form").addEventListener("submit", createBot);
  $("channel-form").addEventListener("submit", createChannel);
  $("connection-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const token = $("token-input").value.trim();
    if (!token) return;
    state.token = token;
    sessionStorage.setItem("home23:product-token", token);
    $("token-input").value = "";
    closeDialog("connection-dialog");
    load();
  });
  $("forget-token").addEventListener("click", () => {
    state.token = "";
    sessionStorage.removeItem("home23:product-token");
    closeDialog("connection-dialog");
    load();
  });
  document
    .querySelectorAll("[data-close]")
    .forEach((b) =>
      b.addEventListener("click", () => closeDialog(b.dataset.close)),
    );
  $("banner-retry").addEventListener("click", load);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openDialog("search-dialog");
      $("search-input").focus();
    }
    if (
      event.key === "Escape" &&
      $("details-pane") &&
      !$("details-pane").hidden
    )
      closeDetails();
    const rows = [...document.querySelectorAll(".ca-row")];
    const active = document.activeElement,
      index = rows.indexOf(active);
    if (index >= 0 && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      rows[
        (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
          rows.length
      ].focus();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      clearTimeout(state.refreshTimer);
      scheduleRefresh();
    }
  });
  load();
})();

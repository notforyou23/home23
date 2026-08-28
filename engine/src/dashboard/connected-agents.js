(() => {
  const API = "/home23/api/product";
  const Inspector = window.ConnectedAgentsInspector;
  const Selection = window.ConnectedAgentsSelection;
  if (!Inspector) throw new Error("Connected Agents Inspector projection is unavailable");
  if (!Selection) throw new Error("Connected Agents execution selection is unavailable");
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
    currentChannel: null,
    currentMessages: [],
    evidence: new Inspector.EvidenceStore(),
    evidenceConversationId: null,
    evidenceCursor: 0,
    evidenceGap: null,
    evidenceError: null,
    evidenceGeneration: 0,
    evidenceSyncing: false,
    evidenceTimer: null,
    inspectorVisible: false,
    inspectorFilter: "all",
    inspectorScrollTop: 0,
    expandedEvidence: new Set(),
    presentation: Inspector.createPresentation(),
    workById: new Map(),
    workMutationKeys: new Map(),
    executionOptions: new Map(),
    executionSelection: new Map(),
    executionErrors: new Map(),
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
      error.details = data.error?.details;
      error.retryable = data.error?.retryable;
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
  function hasEvidenceCapability() {
    return state.capabilities?.capabilities?.communicationEvidence === true;
  }
  function hasModelSelectionCapability() {
    return state.capabilities?.capabilities?.modelSelection === true;
  }
  function preferenceStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }
  async function loadExecutionOptions(channelId, force = false) {
    if (!hasModelSelectionCapability()) return null;
    if (!force && state.executionOptions.has(channelId)) {
      return state.executionOptions.get(channelId);
    }
    try {
      const wire = await api(`/channels/${encodeURIComponent(channelId)}/execution-options`);
      const options = Selection.normalizeOptions(wire, channelId);
      state.executionOptions.set(channelId, options);
      state.executionErrors.delete(channelId);
      const selected = Selection.loadPreference(preferenceStorage(), channelId, options);
      state.executionSelection.set(channelId, selected);
      return options;
    } catch (error) {
      state.executionOptions.delete(channelId);
      state.executionSelection.delete(channelId);
      state.executionErrors.set(channelId, {
        message: error.message || "Execution choices are unavailable.",
        requestId: error.requestId || null,
      });
      return null;
    }
  }
  function executionSelection(channelId) {
    return state.executionSelection.get(channelId) || Selection.EMPTY;
  }
  function updateExecutionSelection(channelId) {
    const options = state.executionOptions.get(channelId);
    if (!options) return;
    const selected = Selection.normalizePreference({
      modelAlias: $("composer-model")?.value || null,
      reasoningEffort: $("composer-effort")?.value || null,
    }, options);
    state.executionSelection.set(channelId, selected);
    Selection.savePreference(preferenceStorage(), channelId, selected, options);
  }
  function resetEvidence(conversationId) {
    clearTimeout(state.evidenceTimer);
    state.evidence = new Inspector.EvidenceStore();
    state.evidenceConversationId = conversationId;
    state.evidenceCursor = 0;
    state.evidenceGap = null;
    state.evidenceError = null;
    state.evidenceGeneration += 1;
    state.workById.clear();
    state.presentation = Inspector.minimize(state.presentation);
    state.inspectorVisible = false;
    closeInspectorPane(false);
  }
  async function syncEvidence(conversationId) {
    if (!hasEvidenceCapability() || !conversationId || state.evidenceSyncing) return 0;
    if (state.evidenceConversationId !== conversationId) resetEvidence(conversationId);
    const generation = state.evidenceGeneration;
    state.evidenceSyncing = true;
    state.evidenceError = null;
    const inserted = [];
    let resetHandled = false;
    let pageCount = 0;
    try {
      for (;;) {
        if (generation !== state.evidenceGeneration) return 0;
        if (++pageCount > 1_000) {
          throw new Error("Communication evidence paging exceeded its safety boundary.");
        }
        let page;
        try {
          page = await api(
            `/communications/events?after=${state.evidenceCursor}&limit=25&conversationId=${encodeURIComponent(conversationId)}`,
          );
        } catch (error) {
          if (
            error.status !== 409 ||
            error.code !== "cursor_expired" ||
            resetHandled ||
            !error.details?.bootstrapRequired
          ) {
            throw error;
          }
          resetHandled = true;
          state.evidence = new Inspector.EvidenceStore();
          state.evidenceGap = Inspector.cursorReset(
            error.details,
            state.evidenceCursor,
          );
          state.evidenceCursor = state.evidenceGap.resumeAfterSequence;
          continue;
        }
        if (generation !== state.evidenceGeneration) return 0;
        const nextCursor = Inspector.advanceHistoryCursor(
          state.evidenceCursor,
          page,
          conversationId,
        );
        for (const event of page.events || []) {
          const result = state.evidence.ingest(event);
          if (result === "inserted") inserted.push(event);
        }
        state.evidenceCursor = nextCursor;
        if (!page.hasMore) break;
      }
      if (!state.presentation.liveTurnId) {
        state.presentation = Inspector.setLiveTurn(
          state.presentation,
          state.evidence.liveTurn()?.turnId || null,
        );
      }
      for (const event of inserted) {
        state.presentation = Inspector.observeEvent(state.presentation, event);
      }
      state.presentation = Inspector.setLiveTurn(
        state.presentation,
        state.evidence.liveTurn()?.turnId || null,
      );
      return inserted.length;
    } catch (error) {
      state.evidenceError = {
        code: error.code || "communication_evidence_unavailable",
        message: error.message || "Communication evidence is unavailable.",
        requestId: error.requestId || null,
      };
      renderEvidenceNotice();
      throw error;
    } finally {
      state.evidenceSyncing = false;
      renderEvidenceNotice();
    }
  }
  function scheduleEvidenceRefresh() {
    clearTimeout(state.evidenceTimer);
    if (!state.selected || !hasEvidenceCapability()) return;
    const delay = state.evidence.liveTurn() ? 1_200 : 5_000;
    state.evidenceTimer = setTimeout(async () => {
      if (document.hidden) {
        scheduleEvidenceRefresh();
        return;
      }
      const selected = state.selected;
      const conversationId = state.evidenceConversationId;
      try {
        const count = await syncEvidence(conversationId);
        if (selected === state.selected && count > 0) await refreshSelectedQuietly();
        else if (state.inspectorVisible) renderInspector();
      } catch {
        if (state.inspectorVisible) renderInspector();
      }
      scheduleEvidenceRefresh();
    }, delay);
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
    document.querySelectorAll(".ca-send, #composer-text").forEach((control) => {
      control.disabled = kind !== "online" ||
        state.capabilities?.capabilities?.messageSubmission !== true;
    });
    document.querySelectorAll(".ca-execution-select").forEach((control) => {
      control.disabled = kind !== "online" || !state.executionOptions.has(state.selected);
    });
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
      const requestedChannel = new URLSearchParams(location.search).get("channel");
      const first =
        requestedChannel ||
        current ||
        (matchMedia("(min-width: 681px)").matches
          ? directChannel(jerry)?.id || ordered(state.inbox)[0]?.channelId
          : null);
      if (first) {
        await openConversation(first, null, {
          historyMode: requestedChannel ? "none" : "replace",
        });
      }
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
            ? openConversation(el.dataset.channel, null, { historyMode: "push" })
            : toast("This Bot’s conversation is still provisioning."),
        ),
      );
    renderChannelMembers();
  }
  async function openConversation(channelId, focusMessageId = null, options = {}) {
    try {
      const [channelResult, transcript] = await Promise.all([
        api(`/channels/${encodeURIComponent(channelId)}`),
        api(`/channels/${encodeURIComponent(channelId)}/messages?limit=100`),
        loadExecutionOptions(channelId),
      ]);
      const channel = channelResult.channel;
      const messages = transcript.messages || [];
      state.selected = channelId;
      state.currentChannel = channel;
      state.currentMessages = messages;
      if (state.evidenceConversationId !== channel.conversationId) {
        resetEvidence(channel.conversationId);
      }
      if (options.historyMode !== "none") {
        const destination = new URL(location.href);
        destination.searchParams.set("channel", channelId);
        destination.searchParams.delete("turn");
        destination.searchParams.delete("event");
        const method = options.historyMode === "push" ? "pushState" : "replaceState";
        history[method](null, "", destination);
      }
      renderRoster();
      renderConversation(channel, messages);
      $("conversation").classList.add("open");
      $("conversation").focus({ preventScroll: true });
      if (hasEvidenceCapability()) {
        try {
          await syncEvidence(channel.conversationId);
        } catch {
          // Transcript remains usable; its Inspector displays the exact evidence failure.
        }
        if (state.selected === channelId) {
          renderConversation(channel, messages);
          applyInspectorURLState();
          scheduleEvidenceRefresh();
        }
      }
      if (focusMessageId)
        document
          .getElementById(`message-${CSS.escape(focusMessageId)}`)
          ?.scrollIntoView({ block: "center" });
      const latest = Math.max(
        0,
        ...messages.map((m) => m.sequence || 0),
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
      loadExecutionOptions(channelId),
    ]);
    if (state.selected !== channelId) return;
    const priorPane = $("messages");
    const nearBottom = priorPane
      ? priorPane.scrollHeight - priorPane.scrollTop - priorPane.clientHeight < 100
      : true;
    const focused = document.activeElement?.id === "composer-text",
      draft = focused ? $("composer-text")?.value : "";
    state.currentChannel = channelResult.channel;
    state.currentMessages = transcript.messages || [];
    renderConversation(state.currentChannel, state.currentMessages, {
      scrollToBottom: nearBottom,
    });
    if (focused && $("composer-text")) {
      $("composer-text").value = draft;
      $("composer-text").focus();
    }
  }
  function quickGlanceHtml(turn) {
    const glance = turn.quickGlance;
    const needsReview = glance.hasAttention || Boolean(state.evidenceGap);
    const status = (glance.status || (turn.terminal ? "complete" : "active"))
      .replaceAll("_", " ");
    const cue = needsReview ? "!" : turn.terminal ? "✓" : "●";
    const action = needsReview ? "Review turn issue" : "Open turn inspector";
    const facts = [
      `${glance.eventCount} event${glance.eventCount === 1 ? "" : "s"}`,
      glance.model,
      glance.effort ? `effort ${glance.effort}` : null,
      glance.toolCallCount ? `${glance.toolCallCount} tool${glance.toolCallCount === 1 ? "" : "s"}` : null,
      glance.agentAndWorkerCount
        ? `${glance.agentAndWorkerCount} agent${glance.agentAndWorkerCount === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);
    return `<button class="ca-turn-glance${needsReview ? " attention" : ""}" type="button" data-turn-id="${esc(turn.turnId)}" aria-label="${esc(action)}; ${esc(status)}; ${glance.eventCount} events"><span class="ca-glance-cue" aria-hidden="true">${cue}</span><strong>${esc(status[0]?.toUpperCase() + status.slice(1))}</strong><span>${facts.map(esc).join(" · ")}</span><span aria-hidden="true">›</span></button>`;
  }
  function renderEvidenceNotice() {
    const notice = $("evidence-notice");
    if (!notice) return;
    if (state.evidenceError) {
      notice.hidden = false;
      notice.textContent = `Turn evidence unavailable: ${state.evidenceError.message}${state.evidenceError.requestId ? ` · request ${state.evidenceError.requestId}` : ""}`;
    } else if (state.evidenceGap) {
      notice.hidden = false;
      notice.textContent = `Turn evidence history has a ${state.evidenceGap.reason.replaceAll("_", " ")} gap. Retained events are exact; open Inspector for the boundary.`;
    } else {
      notice.hidden = true;
      notice.textContent = "";
    }
  }
  function executionControlsHtml(channelId) {
    if (!hasModelSelectionCapability()) return "";
    const options = state.executionOptions.get(channelId);
    const error = state.executionErrors.get(channelId);
    if (!options) {
      return `<div class="ca-execution-controls unavailable" role="status"><span>Home defaults will be used. ${esc(error?.message || "Execution choices are loading.")}${error?.requestId ? ` · request ${esc(error.requestId)}` : ""}</span><button type="button" id="execution-options-retry">Retry choices</button></div>`;
    }
    const selected = executionSelection(channelId);
    const modelOptions = options.models.map((model) =>
      `<option value="${esc(model.alias)}"${selected.modelAlias === model.alias ? " selected" : ""}>${esc(model.alias)}</option>`).join("");
    const effortLabel = {
      none: "None",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
    };
    const effortOptions = options.reasoningEfforts.map((effort) =>
      `<option value="${esc(effort)}"${selected.reasoningEffort === effort ? " selected" : ""}>${esc(effortLabel[effort] || effort)}</option>`).join("");
    return `<div class="ca-execution-controls" aria-label="Conversation execution choices"><label><span>Model</span><select class="ca-execution-select" id="composer-model"><option value=""${selected.modelAlias === null ? " selected" : ""}>Home default · ${esc(options.defaultModel)}</option>${modelOptions}</select></label><label><span>Effort</span><select class="ca-execution-select" id="composer-effort"><option value=""${selected.reasoningEffort === null ? " selected" : ""}>Default · ${esc(effortLabel[options.defaultReasoningEffort] || options.defaultReasoningEffort)}</option>${effortOptions}</select></label><small>Saved for this conversation and captured for each send.</small></div>`;
  }
  function renderConversation(channel, messages, options = {}) {
    const activity = inboxFor(channel.id)?.activity;
    // The current dashboard body parser cannot safely stream the canonical
    // multipart upload. Keep this unavailable instead of simulating support.
    const canAttach = false;
    const members = channel.members?.filter((m) => m.kind === "bot") || [];
    const turns = state.evidence.turns();
    const linkedTurnIDs = new Set();
    const messageContent = messages
      .map((message) => {
        const matching = turns.filter((turn) => turn.messageIds.includes(message.id));
        matching.forEach((turn) => linkedTurnIDs.add(turn.turnId));
        return messageHtml(message, matching);
      })
      .join("");
    const unlinkedTurns = turns.filter((turn) => !linkedTurnIDs.has(turn.turnId));
    const responseActivity = unlinkedTurns
      .map(
        (turn) =>
          `<section class="ca-response-placeholder"><p>${turn.terminal ? "Response evidence is retained, but no matching assistant message is in this page." : "Response active. The final answer will appear in the calm transcript when committed."}</p>${quickGlanceHtml(turn)}</section>`,
      )
      .join("");
    const body =
      messageContent || responseActivity
        ? `${messageContent}${responseActivity}`
        : '<div class="ca-welcome"><h2>Start the conversation.</h2><p>This durable thread will be here when you return.</p></div>';
    const inspectorDisabled = turns.length ? "" : "disabled";
    const evidenceTitle = hasEvidenceCapability()
      ? turns.length
        ? "Open turn inspector"
        : "No turn evidence has been emitted"
      : "Turn evidence is not available from this Home23";
    const evidenceNotice = `<div class="ca-degraded" id="evidence-notice" role="status" hidden></div>`;
    const executionControls = executionControlsHtml(channel.id);
    const canSend = state.capabilities?.capabilities?.messageSubmission === true;
    $("conversation").innerHTML =
      `<header class="ca-thread-head"><button class="ca-back" id="back-button" aria-label="Back to Inbox">‹</button><span class="ca-avatar ${channel.kind === "group" ? "channel" : ""}">${esc(channel.title.slice(0, 2).toUpperCase())}</span><div class="ca-thread-identity"><h2>${esc(channel.title)}</h2><p>${channel.kind === "group" ? `${members.length} Bot${members.length === 1 ? "" : "s"}` : "Direct conversation"}</p></div><div class="ca-thread-actions"><button class="ca-details-button" id="inspector-button" ${inspectorDisabled} title="${esc(evidenceTitle)}" aria-label="${esc(evidenceTitle)}">Inspector</button><button class="ca-details-button" id="details-button">Details</button></div></header>${evidenceNotice}<div class="ca-messages" id="messages" aria-live="polite">${body}</div><div class="ca-activity" id="thread-activity">${activity?.state && activity.state !== "idle" ? '<i class="ca-activity-dot"></i>' + esc(activity.label || "Active now") : ""}</div><div class="ca-composer-wrap">${executionControls}<form class="ca-composer" id="composer"><button class="ca-attach" type="button" id="attach-button" ${canAttach ? "" : "disabled"} aria-label="${canAttach ? "Add attachment" : "Attachments are not available"}" title="${canAttach ? "Add attachment" : "Attachments are not available"}">＋</button><textarea id="composer-text" rows="1" placeholder="${canSend ? `Message ${esc(channel.title)}` : "Sending is unavailable"}" aria-label="Message ${esc(channel.title)}" ${canSend ? "required" : "disabled"}></textarea><button class="ca-send" type="submit" aria-label="Send message" ${canSend ? "" : "disabled"}>↑</button></form><input id="attachment-input" type="file" multiple hidden></div>`;
    renderEvidenceNotice();
    $("back-button").addEventListener("click", () => {
      $("conversation").classList.remove("open");
      const destination = new URL(location.href);
      destination.searchParams.delete("channel");
      destination.searchParams.delete("turn");
      destination.searchParams.delete("event");
      history.pushState(null, "", destination);
      closeInspectorPane(false);
    });
    $("inspector-button").addEventListener("click", () => {
      const turn = state.evidence.liveTurn() || turns.at(-1);
      if (turn) openInspector(turn.turnId, !turn.terminal);
    });
    $("details-button").addEventListener("click", () => showDetails(channel));
    $("composer").addEventListener("submit", sendMessage);
    $("composer-model")?.addEventListener("change", () => updateExecutionSelection(channel.id));
    $("composer-effort")?.addEventListener("change", () => updateExecutionSelection(channel.id));
    $("execution-options-retry")?.addEventListener("click", async () => {
      await loadExecutionOptions(channel.id, true);
      if (state.selected === channel.id) renderConversation(channel, state.currentMessages, { scrollToBottom: false });
    });
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
    document.querySelectorAll(".ca-turn-glance[data-turn-id]").forEach((button) =>
      button.addEventListener("click", () => {
        const turn = state.evidence.turn(button.dataset.turnId);
        if (turn) openInspector(turn.turnId, !turn.terminal);
      }),
    );
    const pane = $("messages");
    if (options.scrollToBottom !== false) pane.scrollTop = pane.scrollHeight;
    if (state.inspectorVisible) renderInspector();
  }
  function messageHtml(m, turns = []) {
    const owner = m.author?.kind === "owner";
    const attachments = (m.attachments || [])
      .map(
        (a) =>
          `<div class="ca-attachment"><span class="ca-avatar channel">↗</span><span><b>${esc(a.name || "Attachment")}</b><span>${esc(a.contentType || "File")}${a.byteCount ? ` · ${Math.ceil(a.byteCount / 1024)} KB` : ""}</span></span></div>`,
      )
      .join("");
    const glances = owner ? "" : turns.map(quickGlanceHtml).join("");
    return `<article class="ca-message ${owner ? "owner" : "bot"}" id="message-${esc(m.id)}"><div class="ca-message-meta">${owner ? "" : `<strong>${esc(m.author?.displayName || "Bot")}</strong>`}<time>${esc(fmtTime(m.createdAt))}</time>${m.visibility === "tombstoned" ? "<span>Removed</span>" : ""}</div><div>${esc(m.text || "").replace(/\n/g, "<br>")}</div>${attachments}</article>${glances}`;
  }
  function inspectorURL(turnId = null, eventId = null) {
    const destination = new URL(location.href);
    if (state.selected) destination.searchParams.set("channel", state.selected);
    if (turnId) destination.searchParams.set("turn", turnId);
    else destination.searchParams.delete("turn");
    if (turnId && eventId) destination.searchParams.set("event", eventId);
    else destination.searchParams.delete("event");
    return destination;
  }
  function applyInspectorURLState() {
    const query = new URLSearchParams(location.search);
    const turnId = query.get("turn");
    if (!turnId) {
      if (state.inspectorVisible) closeInspectorPane(false);
      return;
    }
    const turn = state.evidence.turn(turnId);
    if (!turn) return;
    const requestedEvent = query.get("event");
    const eventId = turn.events.some((event) => event.eventId === requestedEvent)
      ? requestedEvent
      : null;
    openInspector(turnId, false, eventId, { historyMode: "none" });
  }
  function openInspector(turnId, live = false, eventId = null, options = {}) {
    const turn = state.evidence.turn(turnId);
    if (!turn) return;
    if (state.presentation.selectedTurnId !== turnId) {
      state.inspectorScrollTop = 0;
      state.expandedEvidence.clear();
    }
    if (!$("details-pane").hidden) closeDetails();
    state.presentation = live && !turn.terminal
      ? Inspector.openLive(state.presentation, turnId)
      : Inspector.openTurn(state.presentation, turnId, eventId);
    if (eventId) {
      const event = turn.events.find((candidate) => candidate.eventId === eventId);
      if (event) {
        state.presentation = Inspector.markViewedThrough(
          state.presentation,
          event.eventSequence,
        );
      }
    }
    state.inspectorVisible = true;
    $("inspector-pane").hidden = false;
    $("app").classList.remove("details-open");
    $("app").classList.add("inspector-open");
    if (options.historyMode !== "none") {
      const method = options.historyMode === "replace" ? "replaceState" : "pushState";
      history[method](
        null,
        "",
        inspectorURL(turnId, state.presentation.selectedEventId),
      );
    }
    renderInspector();
  }
  function closeInspectorPane(updateHistory = true) {
    const pane = $("inspector-pane");
    if (!pane) return;
    pane.hidden = true;
    $("app").classList.remove("inspector-open");
    state.inspectorVisible = false;
    state.presentation = Inspector.minimize(state.presentation);
    if (updateHistory) history.pushState(null, "", inspectorURL());
    $("inspector-button")?.focus();
  }
  function selectionValue(provider, model, effort) {
    return [
      provider ? `provider ${provider}` : null,
      model ? `model ${model}` : null,
      effort ? `effort ${effort}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Not emitted";
  }
  function exactDisclosure(label, event, valueKind) {
    if (valueKind !== "event" && event.payload?.[valueKind] === undefined) return "";
    const expansionKey = `${event.eventId}:${valueKind}`;
    return `<details class="ca-exact-disclosure" data-evidence-review data-expansion-key="${esc(expansionKey)}"${state.expandedEvidence.has(expansionKey) ? " open" : ""}><summary>${esc(label)}</summary><pre class="ca-exact-value"><code>${esc(
      valueKind === "event"
        ? Inspector.exactJSON(event)
        : Inspector.exactJSON(event.payload[valueKind]),
    )}</code></pre><button type="button" data-copy-event="${esc(event.eventId)}" data-copy-kind="${esc(valueKind)}">Copy exact value</button></details>`;
  }
  function evidenceEventHtml(event, turn, index, total) {
    const selected = state.presentation.selectedEventId === event.eventId;
    const summary = Inspector.eventSummary(event);
    const source = [
      event.actor?.displayName || "Unknown actor",
      event.source?.system,
      event.source?.provider,
      event.source?.model,
    ]
      .filter(Boolean)
      .join(" · ");
    const cue = event.kind === "failure"
      ? "!"
      : event.kind === "receipt"
        ? "✓"
        : event.kind === "reasoning"
          ? "R"
          : event.kind.startsWith("tool_call_")
            ? "T"
            : "•";
    return `<article class="ca-inspector-event${selected ? " selected" : ""}${event.kind === "failure" ? " failure" : ""}" style="--event-depth:${Inspector.eventDepth(event, turn.events)}" id="inspector-event-${esc(event.eventId)}"><button type="button" class="ca-inspector-event-title" data-select-event="${esc(event.eventId)}" aria-label="Select exact event ${index + 1} of ${total}"><span aria-hidden="true">${cue}</span><span><strong>${esc(Inspector.eventLabel(event))}</strong>${summary ? `<small>${esc(summary)}</small>` : ""}<small>${esc(source)}</small><small>Event ${index + 1} of ${total} · #${esc(event.eventSequence)} · ${esc(event.occurredAt)}</small></span></button>${exactDisclosure("Show full arguments", event, "arguments")}${exactDisclosure("Show full result", event, "result")}${exactDisclosure("Show full event", event, "event")}</article>`;
  }
  function workControlsHtml(turn) {
    const workId = [...turn.workIds].sort().at(-1);
    if (!workId) return "";
    if (state.capabilities?.capabilities?.work !== true) {
      return `<section class="ca-inspector-card ca-inspector-controls"><h3>Response controls</h3><p><code>${esc(workId)}</code></p><p class="ca-evidence-unavailable">This Home23 did not advertise authenticated Work inspection.</p></section>`;
    }
    const record = state.workById.get(workId);
    const work = record?.work;
    const stateLabel = work?.state || (record?.loading ? "Loading…" : "Unavailable");
    const error = record?.error;
    const canMutate = state.capabilities?.capabilities?.workMutation === true;
    const retry = record?.mutation?.outcome === "retried" ? record.mutation.work : null;
    return `<section class="ca-inspector-card ca-inspector-controls"><h3>Response controls</h3><p><code>${esc(workId)}</code></p><p>State: <strong>${esc(stateLabel)}</strong></p>${retry ? `<p>Retry queued as <code>${esc(retry.id)}</code>.</p>` : ""}${error ? `<p class="ca-inspector-error">${esc(error.message)}${error.requestId ? ` · request ${esc(error.requestId)}` : ""}</p>` : ""}<div class="ca-inspector-actions">${work?.cancelAvailable ? `<button class="danger" type="button" data-work-operation="cancel" data-work-id="${esc(workId)}" ${canMutate ? "" : "disabled"}>Cancel response</button>` : ""}${work?.state === "stopping" ? "<span>Cancellation requested</span>" : ""}${work?.retryAvailable && !retry ? `<button type="button" data-work-operation="retry" data-work-id="${esc(workId)}" ${canMutate ? "" : "disabled"}>Retry response</button>` : ""}</div></section>`;
  }
  function modeControlsHtml(turn) {
    const presentation = state.presentation;
    const mode = {
      quick_glance: "Quick glance",
      selected_turn_detail: "Selected-turn detail",
      live_control_room: "Live control room",
    }[presentation.mode];
    let action = "";
    if (presentation.liveTurnId === turn.turnId) {
      action = presentation.followsLive
        ? "<span>● Follow live</span>"
        : `<button type="button" id="jump-live">${presentation.unseenEventCount ? `New events (${presentation.unseenEventCount})` : "Jump to live turn"}</button>`;
    } else if (presentation.liveTurnId) {
      action = '<button type="button" id="jump-live">Another turn is live</button>';
    }
    return `<section class="ca-inspector-card ca-inspector-mode"><span><strong>${esc(mode)}</strong>${presentation.unseenEventCount ? ` <span class="unseen">· ${presentation.unseenEventCount} unseen</span>` : ""}</span>${action}</section>`;
  }
  function renderInspector() {
    if (!state.inspectorVisible) return;
    const pane = $("inspector-pane");
    const previousScrollTop = $("inspector-scroll")?.scrollTop ?? state.inspectorScrollTop;
    const turn = state.evidence.turn(state.presentation.selectedTurnId);
    if (!turn) {
      pane.innerHTML = '<div class="ca-inspector-head"><h2>Turn inspector</h2><button class="ca-close" id="close-inspector" aria-label="Close inspector">×</button></div><div class="ca-inspector-scroll"><section class="ca-inspector-card ca-inspector-error"><h3>Evidence unavailable</h3><p>The selected turn is no longer present in the retained communication history.</p></section></div>';
      $("close-inspector").addEventListener("click", () => closeInspectorPane());
      return;
    }
    const glance = turn.quickGlance;
    const receipt = Inspector.selectionReceipt(turn);
    const status = (glance.status || (turn.terminal ? "complete" : "active"))
      .replaceAll("_", " ");
    const filter = state.inspectorFilter;
    const events = turn.events.filter((event) => Inspector.includesFilter(event, filter));
    const filterOptions = [
      ["all", "All events"],
      ["reasoning", "Reasoning"],
      ["tools", "Tool calls"],
      ["agents", "Agents and background work"],
      ["progress", "Progress"],
      ["errors", "Errors"],
      ["artifacts", "Artifacts and media"],
      ["usage", "Usage and cache"],
      ["receipts", "Receipts"],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}"${filter === value ? " selected" : ""}>${label}</option>`,
      )
      .join("");
    const conflicts = state.evidence.integrityConflicts.filter(
      (conflict) =>
        conflict.existing.turnId === turn.turnId ||
        conflict.incoming.turnId === turn.turnId,
    );
    const gap = state.evidenceGap
      ? `<section class="ca-inspector-card ca-inspector-gap"><h3>! Evidence history gap</h3><p>Core could not replay a contiguous evidence prefix. Retained events remain exact, but this turn inspector must not be treated as complete across the gap.</p><p><code>Reason: ${esc(state.evidenceGap.reason)}; requested after ${esc(state.evidenceGap.requestedAfterSequence)}; retention floor ${esc(state.evidenceGap.retentionFloorSequence)}</code></p></section>`
      : "";
    const evidenceError = state.evidenceError
      ? `<section class="ca-inspector-card ca-inspector-error"><h3>! Evidence refresh unavailable</h3><p>${esc(state.evidenceError.message)}</p>${state.evidenceError.requestId ? `<p><code>Request ${esc(state.evidenceError.requestId)}</code></p>` : ""}</section>`
      : "";
    const conflictNotice = conflicts.length
      ? `<section class="ca-inspector-card ca-inspector-error"><h3>! Evidence identity conflict</h3><p>${conflicts.length} replayed event identit${conflicts.length === 1 ? "y has" : "ies have"} conflicting exact values. Both versions are retained in the full evidence export.</p></section>`
      : "";
    pane.innerHTML = `<div class="ca-inspector-head"><div><h2>Turn inspector</h2><p>${esc(state.currentChannel?.title || "Conversation")}</p></div><div class="ca-inspector-head-actions"><button type="button" id="export-full" title="Export full evidence">Full export</button><button type="button" id="export-compact" title="Export compact conversation">Compact export</button><button class="ca-close" id="close-inspector" aria-label="Close inspector">×</button></div></div><div class="ca-inspector-scroll" id="inspector-scroll"><section class="ca-inspector-card"><div class="ca-inspector-status"><strong>${glance.hasAttention ? "! " : turn.terminal ? "✓ " : "● "}${esc(status[0]?.toUpperCase() + status.slice(1))}</strong><span>${glance.eventCount} events</span></div><div class="ca-inspector-pills">${glance.model ? `<span class="ca-inspector-pill">Model: ${esc(glance.model)}</span>` : ""}${glance.effort ? `<span class="ca-inspector-pill">Effort: ${esc(glance.effort)}</span>` : ""}<span class="ca-inspector-pill">Tools: ${glance.toolCallCount}</span><span class="ca-inspector-pill">Agents: ${glance.agentAndWorkerCount}</span></div><p><code>Turn ${esc(turn.turnId)}</code></p><p><code>${esc(turn.events[0]?.occurredAt || "")} – ${esc(turn.events.at(-1)?.occurredAt || "")}</code></p></section>${gap}${evidenceError}${conflictNotice}${workControlsHtml(turn)}<section class="ca-inspector-card"><h3>Selection receipt</h3><dl class="ca-inspector-receipt"><dt>Actor</dt><dd>${esc(receipt.actor)}</dd><dt>Active attempt</dt><dd>${esc(receipt.attemptId || "Not emitted")}</dd><dt>Requested</dt><dd>${esc(selectionValue(receipt.requestedProvider, receipt.requestedModel, receipt.requestedEffort))}</dd><dt>Resolved</dt><dd>${esc(selectionValue(receipt.resolvedProvider, receipt.resolvedModel, receipt.resolvedEffort))}</dd><dt>Actual</dt><dd>${esc(selectionValue(receipt.actualProvider, receipt.actualModel, receipt.actualEffort))}</dd></dl></section>${modeControlsHtml(turn)}<div class="ca-inspector-filter"><label for="inspector-filter">Evidence</label><select id="inspector-filter" aria-label="Evidence section">${filterOptions}</select></div><div id="inspector-events">${events.length ? events.map((event, index) => evidenceEventHtml(event, turn, index, events.length)).join("") : '<section class="ca-inspector-card ca-evidence-unavailable">No events match this evidence section.</section>'}</div></div>`;
    $("close-inspector").addEventListener("click", () => closeInspectorPane());
    $("export-full").addEventListener("click", () =>
      downloadText(
        `home23-turn-${safeFilePart(turn.turnId)}-evidence.json`,
        state.evidence.exportFullEvidence(turn.turnId),
        "application/json",
      ),
    );
    $("export-compact").addEventListener("click", () =>
      downloadText(
        `home23-${safeFilePart(state.currentChannel?.title || "conversation")}.md`,
        Inspector.compactConversation(state.currentChannel, state.currentMessages),
        "text/markdown",
      ),
    );
    $("inspector-filter").addEventListener("change", (event) => {
      state.inspectorFilter = event.target.value;
      state.presentation = Inspector.pauseFollowing(state.presentation);
      renderInspector();
    });
    $("jump-live")?.addEventListener("click", () => {
      state.presentation = Inspector.jumpToLive(state.presentation);
      const live = state.evidence.turn(state.presentation.selectedTurnId);
      if (live?.quickGlance.latestEventSequence) {
        state.presentation = Inspector.markViewedThrough(
          state.presentation,
          live.quickGlance.latestEventSequence,
        );
      }
      history.pushState(
        null,
        "",
        inspectorURL(state.presentation.selectedTurnId),
      );
      renderInspector();
    });
    pane.querySelectorAll("[data-select-event]").forEach((button) =>
      button.addEventListener("click", () => {
        const event = turn.events.find(
          (candidate) => candidate.eventId === button.dataset.selectEvent,
        );
        if (!event) return;
        state.presentation = Inspector.openTurn(
          state.presentation,
          turn.turnId,
          event.eventId,
        );
        state.presentation = Inspector.markViewedThrough(
          state.presentation,
          event.eventSequence,
        );
        history.pushState(null, "", inspectorURL(turn.turnId, event.eventId));
        renderInspector();
      }),
    );
    pane.querySelectorAll("details[data-evidence-review]").forEach((details) =>
      details.querySelector("summary")?.addEventListener("click", () => {
        if (!details.open) {
          state.expandedEvidence.add(details.dataset.expansionKey);
          state.presentation = Inspector.pauseFollowing(state.presentation);
        } else {
          state.expandedEvidence.delete(details.dataset.expansionKey);
        }
      }),
    );
    pane.querySelectorAll("[data-copy-event]").forEach((button) =>
      button.addEventListener("click", async () => {
        const event = turn.events.find(
          (candidate) => candidate.eventId === button.dataset.copyEvent,
        );
        if (!event) return;
        const kind = button.dataset.copyKind;
        const value = kind === "event" ? event : event.payload?.[kind];
        await copyText(Inspector.exactJSON(value));
        state.presentation = Inspector.pauseFollowing(state.presentation);
        toast("Exact value copied");
      }),
    );
    pane.querySelectorAll("[data-work-operation]").forEach((button) =>
      button.addEventListener("click", () =>
        mutateWork(button.dataset.workId, button.dataset.workOperation),
      ),
    );
    const scroll = $("inspector-scroll");
    scroll.addEventListener("scroll", () => {
      const awayFromLive =
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 80;
      if (awayFromLive && state.presentation.followsLive) {
        state.presentation = Inspector.pauseFollowing(state.presentation);
      }
      state.inspectorScrollTop = scroll.scrollTop;
    }, { passive: true });
    if (state.presentation.followsLive) scroll.scrollTop = scroll.scrollHeight;
    else if (state.presentation.selectedEventId) {
      document
        .getElementById(`inspector-event-${CSS.escape(state.presentation.selectedEventId)}`)
        ?.scrollIntoView({ block: "center" });
    } else scroll.scrollTop = previousScrollTop;
    state.inspectorScrollTop = scroll.scrollTop;
    const workId = [...turn.workIds].sort().at(-1);
    if (
      workId &&
      state.capabilities?.capabilities?.work === true &&
      !state.workById.has(workId)
    ) loadWork(workId);
  }
  async function loadWork(workId) {
    state.workById.set(workId, { loading: true, work: null, error: null });
    if (state.inspectorVisible) renderInspector();
    try {
      const result = await api(`/work/${encodeURIComponent(workId)}`);
      state.workById.set(workId, { loading: false, work: result.work, error: null });
    } catch (error) {
      state.workById.set(workId, {
        loading: false,
        work: null,
        error: { message: error.message, requestId: error.requestId || null },
      });
    }
    if (
      state.inspectorVisible &&
      state.evidence.turn(state.presentation.selectedTurnId)?.workIds.includes(workId)
    ) {
      renderInspector();
    }
  }
  async function mutateWork(workId, operation) {
    const current = state.workById.get(workId);
    state.workById.set(workId, { ...current, loading: true, error: null });
    renderInspector();
    const mutationKey = `${workId}:${operation}`;
    if (!state.workMutationKeys.has(mutationKey)) {
      state.workMutationKeys.set(mutationKey, idem(`web-work-${operation}`));
    }
    try {
      const result = await api(
        `/work/${encodeURIComponent(workId)}/${encodeURIComponent(operation)}`,
        {
          method: "POST",
          headers: { "idempotency-key": state.workMutationKeys.get(mutationKey) },
        },
      );
      const retainedWork = operation === "retry" ? current?.work || null : result.work;
      state.workById.set(workId, {
        loading: false,
        work: retainedWork,
        mutation: result,
        error: null,
      });
      if (result.work?.id && result.work.id !== workId) {
        state.workById.set(result.work.id, {
          loading: false,
          work: result.work,
          error: null,
        });
      }
      toast(operation === "cancel" ? "Cancellation requested" : "Response retry queued");
      await syncEvidence(state.evidenceConversationId).catch(() => {});
      await refreshSelectedQuietly();
    } catch (error) {
      state.workById.set(workId, {
        loading: false,
        work: current?.work || null,
        mutation: current?.mutation,
        error: { message: error.message, requestId: error.requestId || null },
      });
      renderInspector();
    }
  }
  function safeFilePart(value) {
    return String(value).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "export";
  }
  function downloadText(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Fall through to the local selection path when Clipboard permission is absent.
      }
    }
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  function renderConversationFailure(error) {
    $("conversation").innerHTML =
      `<div class="ca-welcome"><div class="ca-house-mark">!</div><h2>Conversation unavailable</h2><p>${esc(error.message)}</p><button class="ca-details-button" id="conversation-retry">Try again</button></div>`;
    $("conversation-retry").addEventListener(
      "click",
      () => state.selected && openConversation(state.selected),
    );
  }
  async function sendMessage(event, retryRecord = null) {
    event?.preventDefault();
    if (state.connection !== "online")
      return toast("Reconnect before sending.");
    if (state.capabilities?.capabilities?.messageSubmission !== true)
      return toast("Sending is not available from this Home23.");
    const input = $("composer-text"),
      text = retryRecord?.text || input.value.trim();
    if (!text) return;
    const capturedSelection = retryRecord || Selection.capture(executionSelection(state.selected));
    const record = retryRecord || {
      text,
      messageId: opaqueId("msg"),
      clientMessageId: opaqueId("client"),
      idempotencyKey: idem("web-message"),
      modelAlias: capturedSelection.modelAlias,
      reasoningEffort: capturedSelection.reasoningEffort,
    };
    const { messageId, clientMessageId } = record;
    const pending = document.createElement("article");
    pending.className = "ca-message owner pending";
    pending.id = `message-${messageId}`;
    const selectionFacts = [
      record.modelAlias ? `model ${record.modelAlias}` : null,
      record.reasoningEffort ? `effort ${record.reasoningEffort}` : null,
    ].filter(Boolean).join(" · ");
    pending.innerHTML = `<div class="ca-message-meta"><span>Sending…${selectionFacts ? ` · ${esc(selectionFacts)}` : ""}</span></div><div>${esc(text).replace(/\n/g, "<br>")}</div>`;
    $("messages").append(pending);
    $("messages").scrollTop = $("messages").scrollHeight;
    if (!retryRecord) input.value = "";
    document.querySelectorAll("#composer-text, .ca-send, .ca-execution-select")
      .forEach((control) => { control.disabled = true; });
    state.pending.set(messageId, record);
    try {
      await api(`/channels/${encodeURIComponent(state.selected)}/messages`, {
        method: "POST",
        headers: { "idempotency-key": record.idempotencyKey },
        body: JSON.stringify({
          messageId,
          clientMessageId,
          text,
          attachmentIds: [],
          mentions: mentionsFor(text),
          replyToMessageId: null,
          ...Selection.requestFields(record),
        }),
      });
      state.pending.delete(messageId);
      await refreshInbox();
      await refreshSelectedQuietly();
      await syncEvidence(state.evidenceConversationId).catch(() => {});
      scheduleEvidenceRefresh();
    } catch (error) {
      pending.className = "ca-message owner failed";
      pending.querySelector(".ca-message-meta").innerHTML =
        `<span>Not sent · ${esc(error.message)}${error.requestId ? ` · request ${esc(error.requestId)}` : ""}</span>`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        if (state.connection !== "online") {
          toast("Reconnect before retrying.");
          return;
        }
        pending.remove();
        sendMessage(null, record);
      });
      pending.append(retry);
    } finally {
      const currentInput = $("composer-text");
      if (currentInput) {
        const canSend = state.connection === "online" &&
          state.capabilities?.capabilities?.messageSubmission === true;
        currentInput.disabled = !canSend;
        $("conversation")?.querySelectorAll(".ca-send")
          .forEach((control) => { control.disabled = !canSend; });
        $("conversation")?.querySelectorAll(".ca-execution-select")
          .forEach((control) => {
            control.disabled = !canSend || !state.executionOptions.has(state.selected);
          });
        currentInput.focus();
      }
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
    if (state.inspectorVisible) closeInspectorPane();
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
    state.selected = null;
    state.currentChannel = null;
    state.currentMessages = [];
    resetEvidence(null);
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
      event.altKey &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "i"
    ) {
      event.preventDefault();
      if (state.inspectorVisible) closeInspectorPane();
      else {
        const turn = state.evidence.liveTurn() || state.evidence.turns().at(-1);
        if (turn) openInspector(turn.turnId, !turn.terminal);
      }
    }
    if (
      event.altKey &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "l"
    ) {
      const live = state.evidence.liveTurn();
      if (live) {
        event.preventDefault();
        openInspector(live.turnId, true);
      }
    }
    if (event.key === "Escape" && state.inspectorVisible) {
      event.preventDefault();
      closeInspectorPane();
      return;
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
      scheduleEvidenceRefresh();
    }
  });
  window.addEventListener("popstate", async () => {
    const query = new URLSearchParams(location.search);
    const channelId = query.get("channel");
    if (channelId && channelId !== state.selected) {
      await openConversation(channelId, null, { historyMode: "none" });
      return;
    }
    if (!channelId) {
      state.selected = null;
      state.currentChannel = null;
      state.currentMessages = [];
      resetEvidence(null);
      $("conversation").classList.remove("open");
      $("conversation").innerHTML =
        '<div class="ca-welcome"><div class="ca-house-mark">H23</div><h2>Your conversations live here.</h2><p>Choose Jerry, Forrest, another Bot, or a Channel.</p></div>';
      renderRoster();
      return;
    }
    applyInspectorURLState();
  });
  load();
})();

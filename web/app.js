"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const activeStatuses = new Set(["queued", "preparing", "running", "needs_input", "validating"]);
  const statusLabels = {
    queued: "等待開始", preparing: "準備中", running: "研究中", needs_input: "需要回覆",
    validating: "核對報告", completed: "已完成", partial: "部分完成", failed: "執行失敗",
    cancelled: "已取消", interrupted: "已中斷"
  };
  const statusDescriptions = {
    queued: "任務已建立，等待執行。", preparing: "正在準備研究環境。",
    running: "依實際執行內容更新，下方可查看研究紀錄。", needs_input: "請查看下方訊息，回覆後才能繼續。",
    validating: "正在核對報告、引用來源與圖表。", completed: "研究已完成，可閱讀報告與下載 Markdown。",
    partial: "已保留可用成果；未完成的部分請參考執行紀錄。", failed: "請查看錯誤訊息與執行紀錄。",
    cancelled: "研究已取消，已產出的內容會保留。", interrupted: "執行已中斷，可參考紀錄後重新研究。"
  };
  const effortLabels = { none: "無", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高", ultra: "極高" };
  const state = {
    environment: null, jobs: [], selectedJobId: null, job: null, displayJobId: null,
    creating: false, cancelling: false, checking: false, refreshing: false,
    responding: new Set(), jobRequest: 0, reportRequest: 0, reportKey: "",
    historyKey: "", eventsKey: "", requestsKey: "", pollTimer: null, cycleRunning: false,
    connectionError: "", model: "", reasoningEffort: null, modelInitialized: false, modelCatalogKey: ""
  };

  function setError(element, message) {
    element.textContent = message || "";
    element.hidden = !message;
  }

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error || "發生未知錯誤");
  }

  async function requestJSON(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(path, {
        credentials: "same-origin", cache: "no-store", ...options,
        headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
        signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const detail = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message;
        throw new Error(detail || `請求未成功（HTTP ${response.status}）。`);
      }
      if (!data || typeof data !== "object") throw new Error("伺服器傳回的資料格式不正確。");
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("連線等待逾時。原有資料已保留，稍後會再更新。");
      if (error instanceof TypeError) throw new Error("無法連線至本機研究服務。請確認程式仍在執行。");
      throw error;
    } finally { clearTimeout(timer); }
  }

  function postJSON(path, body = {}) {
    return requestJSON(path, { method: "POST", body: JSON.stringify(body) });
  }

  function formatDate(value, compact = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-TW", compact
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
      : { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    ).format(date);
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  }

  function activeJobId() {
    if (state.environment?.activeJobId) return state.environment.activeJobId;
    if (state.job && activeStatuses.has(state.job.status)) return state.job.id;
    return state.jobs.find((job) => activeStatuses.has(job.status))?.id || null;
  }

  function sameOriginURL(value) {
    if (!value || typeof value !== "string") return null;
    try {
      const url = new URL(value, window.location.href);
      return url.origin === window.location.origin && ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function modelCatalog() {
    const models = Array.isArray(state.environment?.models) ? state.environment.models : [];
    const seen = new Set();
    return models.filter((item) => {
      if (typeof item?.model !== "string" || !item.model || seen.has(item.model)) return false;
      seen.add(item.model);
      return true;
    });
  }

  function supportedEfforts(model) {
    const efforts = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    return efforts.filter((item) => typeof item?.reasoningEffort === "string" && item.reasoningEffort);
  }

  function effortLabel(effort, includeCode = false) {
    const label = effortLabels[effort];
    return label ? `${label}${includeCode ? `（${effort}）` : ""}` : String(effort);
  }

  function renderEffortOptions() {
    const model = modelCatalog().find((item) => item.model === state.model);
    const efforts = supportedEfforts(model);
    if (model && state.reasoningEffort !== null && !efforts.some((item) => item.reasoningEffort === state.reasoningEffort)) state.reasoningEffort = null;
    const fragment = document.createDocumentFragment();
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "模型預設";
    defaultOption.title = model?.defaultReasoningEffort ? `模型預設：${effortLabel(model.defaultReasoningEffort, true)}` : "由所選模型決定推理深度";
    fragment.append(defaultOption);
    for (const effort of efforts) {
      const option = document.createElement("option");
      option.value = effort.reasoningEffort;
      option.textContent = effortLabel(effort.reasoningEffort);
      option.title = `${effortLabel(effort.reasoningEffort, true)}${effort.description ? ` · ${effort.description}` : ""}`;
      fragment.append(option);
    }
    $("reasoning-effort").replaceChildren(fragment);
    $("reasoning-effort").value = state.reasoningEffort ?? "";
    const selected = efforts.find((item) => item.reasoningEffort === state.reasoningEffort);
    $("reasoning-effort").title = selected ? `${effortLabel(selected.reasoningEffort, true)}${selected.description ? ` · ${selected.description}` : ""}` : defaultOption.title;
  }

  function renderModelControls() {
    const models = modelCatalog();
    const loading = !state.environment || state.environment.modelsLoading === true
      || (!models.length && (state.environment.checks || []).some((check) => check.status === "checking"));
    const key = JSON.stringify([models, loading, state.environment?.defaultModel, state.environment?.defaultReasoningEffort]);
    if (key !== state.modelCatalogKey) {
      state.modelCatalogKey = key;
      const fragment = document.createDocumentFragment();
      if (!models.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = loading ? "讀取模型中…" : "尚無可用模型";
        fragment.append(option);
      } else {
        const firstSelection = !state.modelInitialized;
        if (!models.some((item) => item.model === state.model)) {
          state.model = models.find((item) => item.model === state.environment.defaultModel)?.model || models[0].model;
        }
        if (firstSelection) {
          const model = models.find((item) => item.model === state.model);
          const preferredEffort = state.environment.defaultReasoningEffort;
          state.reasoningEffort = supportedEfforts(model).some((item) => item.reasoningEffort === preferredEffort) ? preferredEffort : null;
          state.modelInitialized = true;
        }
        for (const model of models) {
          const option = document.createElement("option");
          option.value = model.model;
          option.textContent = model.displayName || model.model;
          option.title = model.model;
          fragment.append(option);
        }
      }
      $("model").replaceChildren(fragment);
      if (models.length) $("model").value = state.model;
      $("model").title = models.length ? state.model : "尚未取得可用模型";
      renderEffortOptions();
    }
    $("model-hint").textContent = loading ? "正在向 Codex 取得可用模型…" : !models.length ? "尚未取得可用模型，請重新檢查研究環境。" : "模型與推理選項由 Codex 即時提供。";
  }

  function renderJobModels(job) {
    $("job-models").hidden = !job;
    if (!job) return;
    const selected = job.model || "當時預設";
    const selectedEffort = job.reasoningEffort ? effortLabel(job.reasoningEffort, true) : job.model ? "模型預設" : "當時預設";
    $("job-requested-model").textContent = `${selected} · 推理：${selectedEffort}`;
    if (job.actualModel) {
      const actualEffort = job.actualReasoningEffort ? effortLabel(job.actualReasoningEffort, true) : activeStatuses.has(job.status) ? "尚待回報" : "未記錄";
      $("job-actual-model").textContent = `${job.actualModel} · 推理：${actualEffort}`;
    } else {
      $("job-actual-model").textContent = job.model ? activeStatuses.has(job.status) ? "等待執行端回報" : "未記錄" : "當時預設（未記錄型號）";
    }
  }

  function renderStart() {
    const active = activeJobId();
    const ready = state.environment?.ready === true;
    const checking = environmentChecking();
    const availableModel = modelCatalog().some((item) => item.model === state.model);
    const loadingModels = state.environment?.modelsLoading === true;
    $("start-button").disabled = state.creating || state.checking || !ready || !availableModel || loadingModels;
    $("model").disabled = $("reasoning-effort").disabled = state.creating || !availableModel || loadingModels;
    $("start-button").querySelector("span").textContent = state.creating ? "正在建立任務…" : active ? "加入研究佇列" : "開始研究";
    $("start-hint").textContent = state.creating ? "正在送出研究主題…"
      : loadingModels ? "正在取得可用模型…"
      : checking ? "正在檢查研究環境…"
      : !availableModel ? "請先取得可用模型，再開始研究。"
      : active && ready ? "已有研究執行中，新任務會依序開始。"
      : ready ? "⌘ / Ctrl + Enter 開始研究"
      : state.environment ? "請展開研究環境，查看需要處理的項目。" : "正在檢查研究環境…";
  }

  function environmentChecking() {
    return state.checking || !state.environment || (!state.environment.ready && !state.environment.checkedAt && !(state.environment.checks || []).some(check => check.status === "error"));
  }

  function renderEnvironment() {
    renderModelControls();
    const environment = state.environment;
    const ready = environment?.ready === true;
    const checking = environmentChecking();
    $("environment-dot").className = `status-dot ${checking ? "checking" : ready ? "ok" : "error"}`;
    $("environment-label").textContent = checking ? "正在檢查研究環境…" : ready ? "研究環境已就緒" : "研究環境需要處理";
    $("preflight-button").disabled = state.checking;
    $("preflight-button").textContent = state.checking ? "檢查中…" : "重新檢查";
    $("app-version").textContent = environment?.version ? `v${String(environment.version).replace(/^v/, "")}` : "";
    if (environment) {
      const fragment = document.createDocumentFragment();
      for (const check of environment.checks || []) {
        const li = document.createElement("li");
        const icon = document.createElement("span");
        icon.className = `check-icon ${["ok", "error"].includes(check.status) ? check.status : ""}`;
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = check.status === "ok" ? "✓" : check.status === "error" ? "!" : "·";
        const content = document.createElement("span");
        const name = document.createElement("span");
        name.className = "check-name";
        name.textContent = `${check.label || check.key || "環境檢查"}${check.status === "error" ? " · 需要處理" : check.status === "checking" ? " · 檢查中" : check.status === "unknown" ? " · 尚未確認" : ""}`;
        const detail = document.createElement("span");
        detail.className = "check-detail";
        detail.textContent = check.detail || "";
        content.append(name, detail);
        li.append(icon, content);
        fragment.append(li);
      }
      if (!fragment.childNodes.length) {
        const li = document.createElement("li");
        li.className = "check-placeholder";
        li.textContent = ready ? "研究環境可供使用。" : "尚未取得環境檢查資訊。";
        fragment.append(li);
      }
      $("environment-checks").replaceChildren(fragment);
    }
    renderStart();
  }

  function renderHistory() {
    const key = JSON.stringify([state.selectedJobId, state.jobs.map((job) => [job.id, job.topic, job.status, job.createdAt, job.model, job.actualModel, job.reasoningEffort, job.actualReasoningEffort])]);
    if (key === state.historyKey) return;
    state.historyKey = key;
    $("history-empty").hidden = state.jobs.length > 0;
    const focusedId = document.activeElement?.closest(".history-job")?.dataset.jobId;
    const oldScrollTop = $("job-list").scrollTop;
    const oldScrollLeft = $("job-list").scrollLeft;
    const fragment = document.createDocumentFragment();
    for (const job of state.jobs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `history-job${job.id === state.selectedJobId ? " is-selected" : ""}`;
      button.dataset.jobId = job.id;
      button.setAttribute("aria-pressed", String(job.id === state.selectedJobId));
      button.setAttribute("aria-label", `${job.topic || "未命名研究"}，${statusLabels[job.status] || "狀態未確認"}`);
      const title = document.createElement("span");
      title.className = "history-topic";
      title.textContent = job.topic || "未命名研究";
      const model = document.createElement("span");
      model.className = "history-model";
      model.textContent = job.actualModel ? `實際：${job.actualModel}` : job.model ? `選定：${job.model}` : "當時預設";
      model.title = model.textContent;
      const bottom = document.createElement("span");
      bottom.className = "history-bottom";
      const date = document.createElement("time");
      date.dateTime = job.createdAt || "";
      date.textContent = formatDate(job.createdAt, true);
      const status = document.createElement("span");
      status.className = `history-status ${Object.hasOwn(statusLabels, job.status) ? job.status : ""}`;
      status.textContent = statusLabels[job.status] || "狀態未確認";
      bottom.append(date, status);
      button.append(title, model, bottom);
      button.addEventListener("click", () => selectJob(job.id));
      fragment.append(button);
    }
    $("job-list").replaceChildren(fragment);
    $("job-list").scrollTop = oldScrollTop;
    $("job-list").scrollLeft = oldScrollLeft;
    if (focusedId) [...$("job-list").children].find((button) => button.dataset.jobId === focusedId)?.focus({ preventScroll: true });
  }

  function renderEvents(job) {
    const events = Array.isArray(job.events) ? job.events : [];
    const key = JSON.stringify([job.id, events]);
    if (key === state.eventsKey) return;
    state.eventsKey = key;
    const list = $("event-list");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
    const oldScroll = list.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const event of events) {
      const item = document.createElement("div");
      item.className = `event-item ${["error", "warning"].includes(event.kind) ? event.kind : ""}`;
      const time = document.createElement("time");
      time.className = "event-time";
      time.dateTime = event.at || "";
      time.textContent = formatTime(event.at);
      time.title = formatDate(event.at);
      const message = document.createElement("div");
      message.className = "event-message";
      message.textContent = event.message || "";
      item.append(time, message);
      fragment.append(item);
    }
    if (!events.length) {
      const empty = document.createElement("p");
      empty.className = "events-empty";
      empty.textContent = "尚未收到執行紀錄。";
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    $("event-count").textContent = events.length ? `${events.length} 則` : "";
    list.scrollTop = atBottom ? list.scrollHeight : oldScroll;
  }

  function renderRequests(job) {
    const requests = Array.isArray(job.pendingRequests) ? job.pendingRequests : [];
    const key = JSON.stringify([job.id, requests]);
    if (key === state.requestsKey) return;
    state.requestsKey = key;
    const region = $("pending-requests");
    region.hidden = requests.length === 0;
    const fragment = document.createDocumentFragment();
    requests.forEach((request, index) => {
      const card = document.createElement("form");
      card.className = "request-card";
      const eyebrow = document.createElement("p");
      eyebrow.className = "request-eyebrow";
      eyebrow.textContent = request.kind === "approval" ? "需要你的允許" : "需要你的回覆";
      const title = document.createElement("h3");
      title.textContent = request.title || "請協助確認";
      const description = document.createElement("p");
      description.className = "request-description";
      description.textContent = request.description || "";
      card.append(eyebrow, title, description);
      let answerInput = null;
      const choiceInputs = [];
      if (request.kind !== "approval") {
        const choices = Array.isArray(request.choices) ? request.choices : [];
        if (choices.length) {
          const fieldset = document.createElement("fieldset");
          fieldset.className = "request-choices";
          const legend = document.createElement("legend");
          legend.textContent = "選擇回覆";
          fieldset.append(legend);
          choices.forEach((choice, choiceIndex) => {
            const label = document.createElement("label");
            const input = document.createElement("input");
            input.type = "radio";
            input.name = `request-choice-${index}`;
            input.value = String(choice.value ?? choice.label ?? choiceIndex);
            const text = document.createElement("span");
            text.textContent = choice.label || input.value;
            label.append(input, text);
            fieldset.append(label);
            choiceInputs.push(input);
          });
          card.append(fieldset);
        }
        const label = document.createElement("label");
        label.htmlFor = `request-answer-${index}`;
        label.textContent = choices.length ? "或直接輸入回答" : "你的回答";
        answerInput = document.createElement("textarea");
        answerInput.id = `request-answer-${index}`;
        answerInput.rows = 3;
        answerInput.maxLength = 5000;
        answerInput.placeholder = "輸入希望 Codex 依據的資訊…";
        card.append(label, answerInput);
      }
      const actions = document.createElement("div");
      actions.className = "request-actions";
      const accept = document.createElement("button");
      accept.type = "submit";
      accept.className = "button button-primary";
      accept.textContent = request.kind === "approval" ? "允許並繼續" : "送出回答";
      const decline = document.createElement("button");
      decline.type = "button";
      decline.className = "button button-secondary";
      decline.textContent = request.kind === "approval" ? "不允許" : "無法提供";
      const error = document.createElement("p");
      error.className = "inline-error";
      error.setAttribute("role", "alert");
      error.hidden = true;
      actions.append(accept, decline);
      card.append(actions, error);
      async function respond(decision) {
        const responseKey = `${job.id}:${request.id}`;
        if (state.responding.has(responseKey)) return;
        const answer = answerInput?.value.trim() || choiceInputs.find((input) => input.checked)?.value;
        if (decision === "accept" && request.kind !== "approval" && !answer) {
          setError(error, "請選擇一個回覆，或輸入你的回答。");
          answerInput?.focus();
          return;
        }
        setError(error, "");
        state.responding.add(responseKey);
        accept.disabled = decline.disabled = true;
        try {
          const result = await postJSON(`/api/jobs/${encodeURIComponent(job.id)}/respond`, { requestId: request.id, decision, ...(answer ? { answer } : {}) });
          if (result.job) applyJob(result.job);
          else await loadSelectedJob();
          schedulePoll(200);
        } catch (failure) {
          setError(error, messageOf(failure));
        } finally {
          state.responding.delete(responseKey);
          accept.disabled = decline.disabled = false;
        }
      }
      card.addEventListener("submit", (event) => { event.preventDefault(); void respond("accept"); });
      decline.addEventListener("click", () => { void respond("decline"); });
      fragment.append(card);
    });
    region.replaceChildren(fragment);
  }

  function resetReport() {
    state.reportRequest += 1;
    state.reportKey = "";
    $("report-content").replaceChildren();
    $("report-content").hidden = true;
    $("report-placeholder").hidden = false;
    $("download-report").hidden = true;
    setError($("report-error"), "");
  }

  async function renderReport(job) {
    const available = job.report?.available === true;
    const markdownURL = available ? sameOriginURL(job.report.markdownUrl) : null;
    const htmlURL = available ? sameOriginURL(job.report.htmlUrl) : null;
    $("download-report").hidden = !markdownURL;
    if (markdownURL) $("download-report").href = markdownURL;
    if (!htmlURL) {
      $("report-placeholder-title").textContent = available ? "報告已產出" : activeStatuses.has(job.status) ? "正在整理研究內容" : "尚未產生可讀報告";
      $("report-placeholder-description").textContent = available
        ? "目前未提供線上閱讀內容，可使用上方按鈕下載 Markdown。"
        : activeStatuses.has(job.status) ? "報告產出後，會在這裡呈現原始圖表、研究分析與來源連結。" : "請查看上方執行紀錄，確認本次研究的狀態。";
      return;
    }
    const key = JSON.stringify([job.id, htmlURL, job.status, job.stats?.sources, job.stats?.figures]);
    if (key === state.reportKey) return;
    state.reportKey = key;
    const requestId = ++state.reportRequest;
    const selectedId = state.selectedJobId;
    const hasPreviousReport = !$("report-content").hidden;
    if (!hasPreviousReport) {
      $("report-placeholder").hidden = false;
      $("report-placeholder-title").textContent = "正在讀取報告…";
      $("report-placeholder-description").textContent = "正在載入圖文內容與引用來源。";
    }
    setError($("report-error"), "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(htmlURL, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`無法讀取報告（HTTP ${response.status}）。`);
      const html = await response.text();
      if (requestId !== state.reportRequest || selectedId !== state.selectedJobId || job.id !== state.selectedJobId) return;
      // The report endpoint returns a sanitized HTML fragment. Job metadata and logs never use HTML insertion.
      $("report-content").innerHTML = html;
      for (const link of $("report-content").querySelectorAll("a")) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      for (const img of $("report-content").querySelectorAll("img")) {
        img.loading = "lazy";
        img.decoding = "async";
        img.tabIndex = 0;
        img.setAttribute("role", "button");
        img.setAttribute("aria-label", `放大圖表${img.alt ? `：${img.alt}` : ""}`);
      }
      $("report-content").hidden = false;
      $("report-placeholder").hidden = true;
    } catch (error) {
      if (requestId !== state.reportRequest || selectedId !== state.selectedJobId) return;
      state.reportKey = "";
      setError($("report-error"), error.name === "AbortError" ? "報告載入逾時，稍後會再試。" : `${messageOf(error)} 稍後會再試。`);
      if (!hasPreviousReport) {
        $("report-placeholder-title").textContent = "報告暫時無法載入";
        $("report-placeholder-description").textContent = "已產出的檔案不受影響，也可使用上方按鈕下載 Markdown。";
      }
    } finally { clearTimeout(timer); }
  }

  function renderJob() {
    const job = state.job;
    $("empty-state").hidden = Boolean(state.selectedJobId);
    $("job-view").hidden = !state.selectedJobId;
    if (!state.selectedJobId) return;
    if (state.displayJobId !== state.selectedJobId) {
      state.displayJobId = state.selectedJobId;
      state.eventsKey = "";
      state.requestsKey = "";
      resetReport();
      $("events-details").open = job ? activeStatuses.has(job.status) : true;
    }
    if (!job || job.id !== state.selectedJobId) {
      $("job-title").textContent = "正在讀取研究任務…";
      $("job-status").textContent = "讀取中";
      $("job-status").className = "status-badge";
      $("job-date").textContent = "";
      renderJobModels(null);
      $("job-progress").hidden = true;
      $("pending-requests").hidden = true;
      $("cancel-button").hidden = true;
      $("reuse-button").disabled = true;
      $("report-placeholder-title").textContent = "正在讀取任務…";
      $("report-placeholder-description").textContent = "正在取得本次研究的狀態與成果。";
      return;
    }
    $("job-progress").hidden = false;
    $("job-title").textContent = job.topic || "未命名研究";
    $("job-status").className = `status-badge ${Object.hasOwn(statusLabels, job.status) ? job.status : ""}`;
    $("job-status").textContent = statusLabels[job.status] || "狀態未確認";
    const created = formatDate(job.createdAt);
    $("job-date").textContent = created ? `建立於 ${created}` : "";
    renderJobModels(job);
    $("reuse-button").disabled = false;
    $("cancel-button").hidden = !activeStatuses.has(job.status);
    $("cancel-button").disabled = state.cancelling;
    $("cancel-button").textContent = state.cancelling ? "正在取消…" : "取消研究";
    $("progress-label").textContent = job.progress?.label || statusLabels[job.status] || "等待狀態更新";
    $("progress-detail").textContent = statusDescriptions[job.status] || "依實際任務狀態更新。";
    $("progress-indicator").className = `progress-indicator ${["partial", "needs_input"].includes(job.status) ? "is-attention" : job.status === "failed" ? "is-failed" : job.status === "completed" ? "is-completed" : activeStatuses.has(job.status) ? "is-running" : ""}`;
    const awaitingReport = activeStatuses.has(job.status) && !job.report?.available;
    $("source-stat").textContent = !awaitingReport && Number.isFinite(job.stats?.sources) ? String(job.stats.sources) : "—";
    $("figure-stat").textContent = !awaitingReport && Number.isFinite(job.stats?.figures) ? String(job.stats.figures) : "—";
    $("source-stat").title = $("figure-stat").title = awaitingReport ? "報告尚待整理與驗證" : "報告中經驗證的實際數量";
    setError($("job-error"), typeof job.error === "string" ? job.error : job.error?.message || "");
    renderEvents(job);
    renderRequests(job);
    void renderReport(job);
  }

  function upsertJob(job) {
    const index = state.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) state.jobs[index] = job;
    else state.jobs.unshift(job);
  }

  function applyJob(job) {
    if (!job?.id) return;
    upsertJob(job);
    if (job.id === state.selectedJobId) {
      const previousStatus = state.job?.status;
      state.jobRequest += 1;
      state.job = job;
      setError($("job-load-error"), "");
      renderJob();
      if (activeStatuses.has(previousStatus) && ["completed", "partial"].includes(job.status)) $("events-details").open = false;
    }
    if (state.environment?.activeJobId === job.id && !activeStatuses.has(job.status)) state.environment.activeJobId = null;
    renderHistory();
    renderStart();
  }

  async function loadSelectedJob() {
    const id = state.selectedJobId;
    if (!id) return;
    const requestId = ++state.jobRequest;
    try {
      const result = await requestJSON(`/api/jobs/${encodeURIComponent(id)}`);
      if (id !== state.selectedJobId || requestId !== state.jobRequest) return;
      if (!result.job?.id || result.job.id !== id) throw new Error("任務資料不完整，稍後會再更新。");
      applyJob(result.job);
    } catch (error) {
      if (id !== state.selectedJobId || requestId !== state.jobRequest) return;
      setError($("job-load-error"), `${messageOf(error)} 已保留目前畫面。`);
    }
  }

  async function selectJob(id) {
    if (!id) return;
    const changed = state.selectedJobId !== id;
    state.selectedJobId = id;
    if (changed) {
      state.jobRequest += 1;
      state.job = state.jobs.find((job) => job.id === id) || null;
      setError($("job-load-error"), "");
      try { localStorage.setItem("pdf-research-selected-job", id); } catch { /* Storage is optional. */ }
    }
    renderHistory();
    renderJob();
    await loadSelectedJob();
    schedulePoll();
  }

  async function refreshAll() {
    if (state.cycleRunning) return;
    state.cycleRunning = true;
    const results = await Promise.allSettled([requestJSON("/api/status"), requestJSON("/api/jobs")]);
    const failures = [];
    if (results[0].status === "fulfilled") {
      state.environment = results[0].value;
      renderEnvironment();
    } else failures.push(messageOf(results[0].reason));
    if (results[1].status === "fulfilled") {
      if (Array.isArray(results[1].value.jobs)) {
        state.jobs = results[1].value.jobs;
        renderHistory();
        setError($("history-error"), "");
      } else {
        setError($("history-error"), "任務清單格式不正確，已保留先前資料。");
      }
    } else {
      failures.push(messageOf(results[1].reason));
    }
    state.connectionError = [...new Set(failures)].join(" ");
    setError($("connection-notice"), state.connectionError);
    if (!state.selectedJobId && state.jobs.length) {
      let savedId;
      try { savedId = localStorage.getItem("pdf-research-selected-job"); } catch { /* Storage is optional. */ }
      const id = state.environment?.activeJobId || (state.jobs.some((job) => job.id === savedId) ? savedId : state.jobs[0].id);
      await selectJob(id);
    } else await loadSelectedJob();
    renderStart();
    state.cycleRunning = false;
  }

  function schedulePoll(delay) {
    clearTimeout(state.pollTimer);
    const wait = delay ?? (activeJobId() ? 2000 : 10000);
    state.pollTimer = setTimeout(async () => {
      try { await refreshAll(); }
      finally { schedulePoll(); }
    }, wait);
  }

  $("research-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.creating || $("start-button").disabled) return;
    const topic = $("topic").value.trim();
    if (!topic) {
      setError($("form-error"), "請先輸入想研究的主題。");
      $("topic").focus();
      return;
    }
    const model = modelCatalog().find((item) => item.model === $("model").value);
    const effort = $("reasoning-effort").value || null;
    if (!model || (effort !== null && !supportedEfforts(model).some((item) => item.reasoningEffort === effort))) {
      setError($("form-error"), "請從目前可用的模型與推理選項中重新選擇。");
      return;
    }
    state.creating = true;
    setError($("form-error"), "");
    renderStart();
    try {
      const result = await postJSON("/api/jobs", {
        topic, model: model.model, reasoningEffort: effort,
        sourceCount: $("source-count").value === "" ? null : Number($("source-count").value),
        figureTarget: $("figure-target").value === "" ? null : Number($("figure-target").value)
      });
      if (!result.job?.id) throw new Error("未收到任務識別資訊。請重新整理任務清單確認是否已建立。");
      upsertJob(result.job);
      if (state.environment && !state.environment.activeJobId) state.environment.activeJobId = result.job.id;
      await selectJob(result.job.id);
      if (window.matchMedia("(max-width: 680px)").matches) $("main-content").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setError($("form-error"), messageOf(error));
      schedulePoll(300);
    } finally {
      state.creating = false;
      renderStart();
      schedulePoll();
    }
  });

  $("topic").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (!$("start-button").disabled) $("research-form").requestSubmit();
    }
  });

  $("model").addEventListener("change", () => {
    const model = modelCatalog().find((item) => item.model === $("model").value);
    if (!model) return;
    state.model = model.model;
    $("model").title = model.model;
    renderEffortOptions();
    renderStart();
  });
  $("reasoning-effort").addEventListener("change", () => {
    state.reasoningEffort = $("reasoning-effort").value || null;
    const model = modelCatalog().find((item) => item.model === state.model);
    const effort = supportedEfforts(model).find((item) => item.reasoningEffort === state.reasoningEffort);
    $("reasoning-effort").title = effort ? `${effortLabel(effort.reasoningEffort, true)}${effort.description ? ` · ${effort.description}` : ""}` : model?.defaultReasoningEffort ? `模型預設：${effortLabel(model.defaultReasoningEffort, true)}` : "由所選模型決定推理深度";
  });

  $("preflight-button").addEventListener("click", async () => {
    if (state.checking) return;
    state.checking = true;
    setError($("environment-error"), "");
    renderEnvironment();
    try {
      state.environment = await postJSON("/api/preflight");
      setError($("connection-notice"), "");
      if (!state.environment.ready) $("environment-details").open = true;
    } catch (error) {
      setError($("environment-error"), messageOf(error));
    } finally {
      state.checking = false;
      renderEnvironment();
      schedulePoll();
    }
  });

  $("refresh-button").addEventListener("click", async () => {
    if (state.refreshing) return;
    state.refreshing = true;
    $("refresh-button").disabled = true;
    $("refresh-button").setAttribute("aria-label", "正在重新整理任務");
    try { await refreshAll(); }
    finally {
      state.refreshing = false;
      $("refresh-button").disabled = false;
      $("refresh-button").setAttribute("aria-label", "重新整理任務");
      schedulePoll();
    }
  });

  $("cancel-button").addEventListener("click", async () => {
    const id = state.selectedJobId;
    if (!id || state.cancelling) return;
    state.cancelling = true;
    setError($("job-load-error"), "");
    renderJob();
    try {
      const result = await postJSON(`/api/jobs/${encodeURIComponent(id)}/cancel`);
      if (result.job) applyJob(result.job);
      else await loadSelectedJob();
    } catch (error) {
      if (id === state.selectedJobId) setError($("job-load-error"), messageOf(error));
    } finally {
      state.cancelling = false;
      renderJob();
      schedulePoll(300);
    }
  });

  $("reuse-button").addEventListener("click", () => {
    if (!state.job) return;
    $("topic").value = state.job.topic || "";
    if (modelCatalog().some((item) => item.model === state.job.model)) {
      state.model = state.job.model;
      state.reasoningEffort = state.job.reasoningEffort || null;
      $("model").value = state.model;
      $("model").title = state.model;
      renderEffortOptions();
    }
    for (const [field, key] of [["source-count", "sourceCount"], ["figure-target", "figureTarget"]]) {
      if (!Object.hasOwn(state.job, key)) continue;
      const value = state.job[key] === null ? "" : String(state.job[key]);
      if ([...$(field).options].some((option) => option.value === value)) $(field).value = value;
    }
    renderStart();
    $("topic").focus();
    $("topic").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  function showImage(img) {
    if (!img?.src || typeof $("image-dialog").showModal !== "function") return;
    $("image-dialog-image").src = img.currentSrc || img.src;
    $("image-dialog-image").alt = img.alt || "研究報告圖表";
    $("image-dialog-caption").textContent = img.closest("figure")?.querySelector("figcaption")?.textContent || img.alt || "研究報告圖表";
    $("image-dialog").showModal();
  }
  $("report-content").addEventListener("click", (event) => {
    if (event.target instanceof HTMLImageElement) { event.preventDefault(); showImage(event.target); }
  });
  $("report-content").addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLImageElement && ["Enter", " "].includes(event.key)) { event.preventDefault(); showImage(event.target); }
  });
  $("close-image").addEventListener("click", () => $("image-dialog").close());
  $("image-dialog").addEventListener("click", (event) => {
    if (event.target === $("image-dialog")) {
      const bounds = $("image-dialog").getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $("image-dialog").close();
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedulePoll(100); });
  window.addEventListener("pagehide", () => clearTimeout(state.pollTimer));
  window.addEventListener("pageshow", (event) => { if (event.persisted) schedulePoll(100); });

  renderEnvironment();
  renderHistory();
  void refreshAll().finally(() => schedulePoll());
})();

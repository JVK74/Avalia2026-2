const SETTINGS_KEY = "focusflow.settings.v1";
const POMODORO_SERIES_KEY_PREFIX = "focusflow.pomodoro.series.v1:";
const DEFAULT_SETTINGS = Object.freeze({
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakAfter: 4,
});
const SETTINGS_LIMITS = Object.freeze({
  focusMinutes: [1, 120],
  shortBreakMinutes: [1, 30],
  longBreakMinutes: [1, 60],
  longBreakAfter: [2, 8],
});
const OAUTH_MESSAGES = Object.freeze({
  invalid_oauth_state: "A tentativa de autenticação expirou ou não pôde ser validada. Tente entrar novamente.",
  missing_code: "O Discord não retornou o código de autenticação. Tente novamente.",
  token_exchange_failed: "O Discord não conseguiu concluir a autenticação. Tente novamente.",
  profile_fetch_failed: "Não foi possível obter seu perfil do Discord. Tente novamente.",
  invalid_profile: "O Discord retornou um perfil inválido.",
  oauth_failed: "Não foi possível concluir o login com o Discord.",
});
const API_STATUS_MESSAGES = Object.freeze({
  400: "Confira os dados enviados e tente novamente.",
  401: "Sua sessão expirou. Entre novamente com o Discord.",
  403: "A requisição foi recusada. Atualize a página e tente novamente.",
  404: "O item não foi encontrado ou não está mais disponível.",
  409: "Há um conflito com o estado atual. Atualize os dados e tente novamente.",
  500: "O servidor não conseguiu concluir a operação. Tente novamente.",
  503: "O serviço está temporariamente indisponível. Tente novamente mais tarde.",
});

const elements = {
  appNav: document.getElementById("appNav"),
  appView: document.getElementById("appView"),
  avatarFallback: document.getElementById("avatarFallback"),
  breakdownList: document.getElementById("breakdownList"),
  breakdownTotal: document.getElementById("breakdownTotal"),
  cancelFocusButton: document.getElementById("cancelFocusButton"),
  cycleCount: document.getElementById("cycleCount"),
  cycleDots: document.getElementById("cycleDots"),
  focusMinutes: document.getElementById("focusMinutes"),
  loginButton: document.getElementById("loginButton"),
  loginView: document.getElementById("loginView"),
  longBreakAfter: document.getElementById("longBreakAfter"),
  longBreakMinutes: document.getElementById("longBreakMinutes"),
  logoutButton: document.getElementById("logoutButton"),
  metricsEmpty: document.getElementById("metricsEmpty"),
  metricsError: document.getElementById("metricsError"),
  modeLabel: document.getElementById("modeLabel"),
  newSubjectName: document.getElementById("newSubjectName"),
  notice: document.getElementById("notice"),
  refreshButton: document.getElementById("refreshButton"),
  settingsForm: document.getElementById("settingsForm"),
  settingsStatus: document.getElementById("settingsStatus"),
  shortBreakMinutes: document.getElementById("shortBreakMinutes"),
  skipBreakButton: document.getElementById("skipBreakButton"),
  startFocusButton: document.getElementById("startFocusButton"),
  subjectForm: document.getElementById("subjectForm"),
  subjectList: document.getElementById("subjectList"),
  subjectSelect: document.getElementById("subjectSelect"),
  subjectsError: document.getElementById("subjectsError"),
  subjectsEmpty: document.getElementById("subjectsEmpty"),
  timeDisplay: document.getElementById("timeDisplay"),
  timerCaption: document.getElementById("timerCaption"),
  timerMessage: document.getElementById("timerMessage"),
  timerProgress: document.getElementById("timerProgress"),
  timerStatePill: document.getElementById("timerStatePill"),
  timerWrap: document.querySelector(".timer-wrap"),
  userAvatar: document.getElementById("userAvatar"),
  userDisplayName: document.getElementById("userDisplayName"),
  userProfile: document.getElementById("userProfile"),
  userTag: document.getElementById("userTag"),
  welcomeTitle: document.getElementById("welcomeTitle"),
  weekRange: document.getElementById("weekRange"),
  weeklyCycles: document.getElementById("weeklyCycles"),
  weeklyHours: document.getElementById("weeklyHours"),
};

class ApiError extends Error {
  constructor(status, payload) {
    super(API_STATUS_MESSAGES[status] || "Não foi possível concluir a operação.");
    this.name = "ApiError";
    this.status = status;
    this.code = typeof payload?.error === "string" ? payload.error : "";
    this.payload = payload;
  }
}

function validSubject(subject) {
  return subject
    && Number.isSafeInteger(subject.id)
    && subject.id > 0
    && typeof subject.name === "string";
}

function validRunningCycle(cycle) {
  return cycle
    && Number.isSafeInteger(cycle.id)
    && cycle.id > 0
    && Number.isSafeInteger(cycle.subject_id)
    && cycle.subject_id > 0
    && Number.isInteger(cycle.duration_seconds)
    && cycle.duration_seconds >= 60
    && cycle.duration_seconds <= 7200
    && cycle.status === "running"
    && typeof cycle.started_at === "string"
    && Number.isFinite(Date.parse(cycle.started_at));
}

function validWeeklyMetrics(metrics) {
  return metrics?.ok === true
    && typeof metrics.week?.starts_on === "string"
    && typeof metrics.week?.ends_on === "string"
    && Number.isFinite(metrics.total_seconds)
    && metrics.total_seconds >= 0
    && Number.isFinite(metrics.total_hours)
    && metrics.total_hours >= 0
    && Number.isInteger(metrics.completed_cycles)
    && metrics.completed_cycles >= 0
    && Array.isArray(metrics.subjects)
    && metrics.subjects.every((subject) => (
      Number.isSafeInteger(subject.subject_id)
      && typeof subject.name === "string"
      && Number.isFinite(subject.total_seconds)
      && Number.isFinite(subject.total_hours)
      && Number.isInteger(subject.completed_cycles)
    ));
}

const state = {
  user: null,
  subjects: [],
  subjectsError: "",
  metrics: null,
  activeCycle: null,
  activeCycleLoaded: false,
  selectedSubjectId: "",
  phase: "focus",
  timerMessage: "",
  breakDeadline: null,
  breakDurationSeconds: 0,
  completedInSeries: 0,
  pomodoroSeriesStorageUnavailable: false,
  editingSubjectId: null,
  isLoadingSubjects: true,
  isStarting: false,
  isCancelling: false,
  isCompleting: false,
  nextCompletionAttemptAt: 0,
  settings: { ...DEFAULT_SETTINGS },
  settingsStorageUnavailable: false,
  noticeTimer: null,
};

function showNotice(message, kind = "info") {
  window.clearTimeout(state.noticeTimer);
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
  elements.notice.hidden = false;
  state.noticeTimer = window.setTimeout(() => {
    elements.notice.hidden = true;
  }, kind === "error" ? 10000 : 6000);
}

function hideNotice() {
  window.clearTimeout(state.noticeTimer);
  elements.notice.hidden = true;
}

function apiMessage(error) {
  if (error instanceof ApiError && error.code === "subject_name_conflict") {
    return "Já existe uma disciplina ativa com esse nome.";
  }
  if (error instanceof ApiError && error.code === "cycle_already_running") {
    return "Já existe um foco ativo. O estado foi sincronizado com o servidor.";
  }
  if (error instanceof ApiError && error.code === "cycle_too_early") {
    return "O servidor ainda não confirmou o fim do foco. O temporizador continuará verificando.";
  }
  if (error instanceof ApiError && error.status === 0) {
    return "Não foi possível conectar à API. Verifique a conexão e tente novamente.";
  }
  return error instanceof ApiError
    ? error.message
    : "Ocorreu um erro inesperado. Tente novamente.";
}

async function apiRequest(path, { method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, null);
  }

  let payload = null;
  const responseText = await response.text();
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = new ApiError(response.status, payload);
    if (response.status === 401 && state.user) {
      showLoginView();
      showNotice(apiMessage(error), "error");
    }
    throw error;
  }
  return payload;
}

function readSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw);
    const settings = { ...DEFAULT_SETTINGS };
    for (const [key, [min, max]] of Object.entries(SETTINGS_LIMITS)) {
      const value = Number(saved?.[key]);
      if (Number.isInteger(value) && value >= min && value <= max) {
        settings[key] = value;
      }
    }
    return settings;
  } catch {
    state.settingsStorageUnavailable = true;
    return { ...DEFAULT_SETTINGS };
  }
}

function pomodoroSeriesStorageKey(userId) {
  return `${POMODORO_SERIES_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

function validPomodoroSeries(series) {
  if (!series || series.version !== 1
    || !Number.isSafeInteger(series.completedInSeries)
    || series.completedInSeries < 0) {
    return false;
  }
  if (series.phase === "focus") {
    return series.breakDeadline === null && series.breakDurationSeconds === 0;
  }
  return (series.phase === "break-short" || series.phase === "break-long")
    && Number.isSafeInteger(series.breakDeadline)
    && series.breakDeadline > 0
    && Number.isInteger(series.breakDurationSeconds)
    && series.breakDurationSeconds >= 60
    && series.breakDurationSeconds <= 3600;
}

function restorePomodoroSeries(userId) {
  state.pomodoroSeriesStorageUnavailable = false;
  state.completedInSeries = 0;
  state.phase = "focus";
  state.breakDeadline = null;
  state.breakDurationSeconds = 0;
  if (typeof userId !== "string" || !userId) return;

  try {
    const raw = window.localStorage.getItem(pomodoroSeriesStorageKey(userId));
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!validPomodoroSeries(saved)) return;

    state.completedInSeries = saved.completedInSeries;
    state.phase = saved.phase;
    state.breakDeadline = saved.breakDeadline;
    state.breakDurationSeconds = saved.breakDurationSeconds;
  } catch {
    state.pomodoroSeriesStorageUnavailable = true;
  }
}

function persistPomodoroSeries() {
  const userId = state.user?.user_id;
  if (typeof userId !== "string" || !userId) return;

  try {
    window.localStorage.setItem(pomodoroSeriesStorageKey(userId), JSON.stringify({
      version: 1,
      completedInSeries: state.completedInSeries,
      phase: state.phase,
      breakDeadline: state.breakDeadline,
      breakDurationSeconds: state.breakDurationSeconds,
    }));
    state.pomodoroSeriesStorageUnavailable = false;
  } catch {
    state.pomodoroSeriesStorageUnavailable = true;
    setSettingsStatus("Não foi possível salvar a sequência do Pomodoro neste navegador.", true);
  }
}

function renderSettings() {
  elements.focusMinutes.value = state.settings.focusMinutes;
  elements.shortBreakMinutes.value = state.settings.shortBreakMinutes;
  elements.longBreakMinutes.value = state.settings.longBreakMinutes;
  elements.longBreakAfter.value = state.settings.longBreakAfter;
  renderCycleProgress();
  updateTimer();
}

function showLoginView() {
  state.user = null;
  state.activeCycle = null;
  state.activeCycleLoaded = false;
  state.phase = "focus";
  state.breakDeadline = null;
  state.breakDurationSeconds = 0;
  state.completedInSeries = 0;
  state.timerMessage = "";
  elements.loginView.hidden = false;
  elements.appView.hidden = true;
  elements.appNav.hidden = true;
  elements.loginButton.hidden = false;
  elements.userProfile.hidden = true;
  updateTimer();
}

function showAppView(user) {
  state.user = user;
  restorePomodoroSeries(user.user_id);
  renderCycleProgress();
  updateTimer();
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  elements.appNav.hidden = false;
  elements.loginButton.hidden = true;
  elements.userProfile.hidden = false;

  const displayName = user.global_name || user.username;
  elements.userDisplayName.textContent = displayName;
  elements.userTag.textContent = `@${user.username}`;
  elements.welcomeTitle.textContent = `Bom estudo, ${displayName}.`;

  const avatarUrl = safeAvatarUrl(user.avatar);
  elements.userAvatar.hidden = !avatarUrl;
  elements.avatarFallback.hidden = Boolean(avatarUrl);
  if (avatarUrl) elements.userAvatar.src = avatarUrl;
}

function safeAvatarUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "cdn.discordapp.com" ? url.href : "";
  } catch {
    return "";
  }
}

elements.userAvatar.addEventListener("error", () => {
  elements.userAvatar.hidden = true;
  elements.avatarFallback.hidden = false;
});

function formatTime(seconds) {
  const wholeSeconds = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function currentFocusSeconds() {
  return state.settings.focusMinutes * 60;
}

function modeText() {
  if (state.phase === "break-short") return "Descanso Curto";
  if (state.phase === "break-long") return "Descanso Longo";
  return "Foco";
}

function renderTimer(remaining, duration) {
  const safeDuration = Math.max(1, duration);
  const safeRemaining = Math.max(0, remaining);
  const elapsedRatio = Math.min(1, Math.max(0, (safeDuration - safeRemaining) / safeDuration));
  const circumference = 2 * Math.PI * 102;

  elements.modeLabel.textContent = modeText();
  elements.timerWrap.dataset.mode = state.phase;
  elements.timeDisplay.textContent = formatTime(safeRemaining);
  elements.timeDisplay.setAttribute("aria-label", `${formatTime(safeRemaining)} restantes`);
  elements.timerCaption.textContent = state.phase === "focus" ? "TEMPO DE FOCO" : "TEMPO DE DESCANSO";
  elements.timerProgress.style.strokeDasharray = String(circumference);
  elements.timerProgress.style.strokeDashoffset = String(circumference * (1 - elapsedRatio));

  if (state.activeCycle) {
    elements.timerStatePill.dataset.state = "running";
    elements.timerStatePill.lastChild.textContent = state.isCompleting ? " Confirmando" : " Foco ativo";
    elements.timerMessage.textContent = state.isCompleting
      ? "Aguardando confirmação segura do servidor."
      : state.timerMessage || `Foco em andamento · ${activeSubjectName()}`;
  } else if (state.phase.startsWith("break-")) {
    elements.timerStatePill.dataset.state = "break";
    elements.timerStatePill.lastChild.textContent = " Descanso";
    elements.timerMessage.textContent = state.timerMessage || "Descanse. Este intervalo não é registrado como estudo.";
  } else {
    elements.timerStatePill.dataset.state = "ready";
    elements.timerStatePill.lastChild.textContent = " Pronto";
    elements.timerMessage.textContent = !state.activeCycleLoaded
      ? "Não foi possível confirmar o estado do servidor. Atualize os dados antes de iniciar."
      : state.timerMessage || (state.subjects.length
        ? "Tudo pronto para iniciar seu próximo foco."
        : "Adicione uma disciplina para começar.");
  }
  renderTimerControls();
}

function activeSubjectName() {
  const activeId = String(state.activeCycle?.subject_id ?? "");
  const subject = state.subjects.find((item) => String(item.id) === activeId);
  return subject?.name || state.activeCycle?.subject_name || "disciplina selecionada";
}

function renderTimerControls() {
  const hasActiveCycle = Boolean(state.activeCycle);
  const inBreak = state.phase.startsWith("break-");
  elements.startFocusButton.hidden = hasActiveCycle || inBreak;
  elements.cancelFocusButton.hidden = !hasActiveCycle;
  elements.skipBreakButton.hidden = !inBreak;
  elements.startFocusButton.disabled = state.isStarting || state.isLoadingSubjects || !state.activeCycleLoaded || !state.subjects.length;
  elements.startFocusButton.textContent = state.isStarting ? "Iniciando foco..." : "Iniciar foco";
  elements.cancelFocusButton.disabled = state.isCancelling || state.isCompleting;
  elements.cancelFocusButton.textContent = state.isCompleting
    ? "Confirmando conclusão..."
    : state.isCancelling ? "Cancelando..." : "Cancelar foco";
  elements.skipBreakButton.disabled = false;
  elements.subjectSelect.disabled = state.isLoadingSubjects || hasActiveCycle || state.isStarting || !state.subjects.length;
}

function updateTimer() {
  if (state.activeCycle) {
    const startedAt = Date.parse(state.activeCycle.started_at);
    const duration = Number(state.activeCycle.duration_seconds);
    if (!Number.isFinite(startedAt) || !Number.isInteger(duration) || duration < 1) {
      elements.timerMessage.textContent = "O servidor retornou dados inválidos para este ciclo. Atualize os dados.";
      elements.timeDisplay.textContent = "--:--";
      renderTimerControls();
      return;
    }
    const deadline = startedAt + duration * 1000;
    const remaining = Math.max(0, (deadline - Date.now()) / 1000);
    renderTimer(remaining, duration);
    if (remaining <= 0 && !state.isCompleting && Date.now() >= state.nextCompletionAttemptAt) {
      void completeActiveCycle();
    }
    return;
  }

  if (state.phase.startsWith("break-") && state.breakDeadline) {
    const remaining = Math.max(0, (state.breakDeadline - Date.now()) / 1000);
    renderTimer(remaining, state.breakDurationSeconds);
    if (remaining <= 0) finishBreak();
    return;
  }

  renderTimer(currentFocusSeconds(), currentFocusSeconds());
}

function renderCycleProgress() {
  const goal = state.settings.longBreakAfter;
  const completed = Math.min(state.completedInSeries, goal);
  elements.cycleCount.textContent = `${completed} de ${goal}`;
  elements.cycleDots.replaceChildren();
  for (let index = 0; index < goal; index += 1) {
    const dot = document.createElement("span");
    dot.className = index < completed ? "cycle-dot is-complete" : "cycle-dot";
    dot.setAttribute("aria-hidden", "true");
    elements.cycleDots.append(dot);
  }
  elements.cycleDots.setAttribute("aria-label", `${completed} de ${goal} focos concluídos`);
}

function startBreak(isLong) {
  state.activeCycle = null;
  state.phase = isLong ? "break-long" : "break-short";
  state.breakDurationSeconds = isLong
    ? state.settings.longBreakMinutes * 60
    : state.settings.shortBreakMinutes * 60;
  state.breakDeadline = Date.now() + state.breakDurationSeconds * 1000;
  state.nextCompletionAttemptAt = 0;
  persistPomodoroSeries();
  elements.timerMessage.textContent = isLong
    ? "Foco confirmado pelo servidor. Hora de um descanso longo."
    : "Foco confirmado pelo servidor. Hora de um descanso curto.";
  showNotice(isLong ? "Foco concluído. Seu descanso longo começou." : "Foco concluído. Seu descanso curto começou.", "success");
  updateTimer();
}

function finishBreak(completed = true) {
  const wasLong = state.phase === "break-long";
  state.phase = "focus";
  state.breakDeadline = null;
  state.breakDurationSeconds = 0;
  if (wasLong && completed) state.completedInSeries = 0;
  persistPomodoroSeries();
  renderCycleProgress();
  elements.timerMessage.textContent = completed
    ? "Descanso encerrado. Escolha quando começar o próximo foco."
    : "Descanso interrompido. Escolha quando começar o próximo foco.";
  showNotice(completed
    ? "Descanso concluído. Você pode iniciar um novo foco."
    : "Descanso interrompido. Você pode iniciar um novo foco.", "info");
  updateTimer();
}

function skipBreak() {
  if (!state.phase.startsWith("break-")) return;
  finishBreak(state.breakDeadline !== null && state.breakDeadline <= Date.now());
}

function makeIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function startFocus() {
  if (!state.user || state.activeCycle || !state.activeCycleLoaded || state.phase !== "focus" || state.isStarting) return;
  const subjectId = Number(elements.subjectSelect.value);
  if (!Number.isSafeInteger(subjectId) || subjectId < 1) {
    showNotice("Selecione uma disciplina antes de iniciar o foco.", "error");
    elements.subjectSelect.focus();
    return;
  }

  hideNotice();
  state.isStarting = true;
  state.timerMessage = "";
  renderTimerControls();
  try {
    const activeResult = await apiRequest("/api/pomodoro/active");
    if (activeResult?.ok !== true || !("cycle" in activeResult)
      || (activeResult.cycle !== null && !validRunningCycle(activeResult.cycle))) {
      throw new ApiError(500, null);
    }
    state.activeCycleLoaded = true;
    if (activeResult?.cycle?.status === "running") {
      state.activeCycle = activeResult.cycle;
      state.phase = "focus";
      state.timerMessage = "Um foco já estava ativo e foi restaurado do servidor.";
      updateTimer();
      showNotice("Já existe um foco ativo. O temporizador foi sincronizado.", "info");
      return;
    }

    const result = await apiRequest("/api/pomodoro/cycles", {
      method: "POST",
      headers: { "Idempotency-Key": makeIdempotencyKey() },
      body: { subject_id: subjectId, duration_seconds: currentFocusSeconds() },
    });
    if (result?.ok !== true || !validRunningCycle(result.cycle)) {
      throw new ApiError(500, null);
    }
    state.activeCycle = result.cycle;
    state.activeCycleLoaded = true;
    state.phase = "focus";
    state.timerMessage = "Foco registrado. O prazo é calculado a partir do horário do servidor.";
    state.nextCompletionAttemptAt = 0;
    updateTimer();
  } catch (error) {
    showNotice(apiMessage(error), "error");
    state.timerMessage = apiMessage(error);
    if (error instanceof ApiError && error.status === 409) {
      await synchronizeActiveCycle();
    } else if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) {
      await synchronizeActiveCycle();
    }
  } finally {
    state.isStarting = false;
    renderTimerControls();
  }
}

async function synchronizeActiveCycle(expectedId = null) {
  try {
    const result = await apiRequest("/api/pomodoro/active");
    if (result?.ok !== true || !("cycle" in result)
      || (result.cycle !== null && !validRunningCycle(result.cycle))) {
      throw new ApiError(500, null);
    }
    state.activeCycleLoaded = true;
    const cycle = result?.cycle || null;
    if (cycle && cycle.status === "running") {
      state.activeCycle = cycle;
      state.phase = "focus";
      state.breakDeadline = null;
      state.breakDurationSeconds = 0;
      persistPomodoroSeries();
      state.timerMessage = expectedId && String(cycle.id) === String(expectedId)
        ? "O servidor ainda informa este foco ativo; nova confirmação será tentada em instantes."
        : "Ciclo ativo restaurado do servidor.";
      if (expectedId && String(cycle.id) === String(expectedId)) {
        state.nextCompletionAttemptAt = Date.now() + 5000;
      } else {
        state.nextCompletionAttemptAt = 0;
      }
    } else {
      state.activeCycle = null;
      state.nextCompletionAttemptAt = 0;
      if (expectedId) {
        state.phase = "focus";
        state.breakDeadline = null;
        state.breakDurationSeconds = 0;
        persistPomodoroSeries();
        state.timerMessage = "O servidor não informa um foco ativo. Métricas serão sincronizadas sem presumir conclusão.";
        void loadMetrics();
      } else if (!state.phase.startsWith("break-")) {
        state.phase = "focus";
        state.breakDeadline = null;
        state.timerMessage = "";
      }
    }
    renderSubjectSelect();
    updateTimer();
  } catch (error) {
    showNotice(apiMessage(error), "error");
    state.activeCycleLoaded = false;
    state.timerMessage = "Não foi possível consultar o ciclo ativo. Atualize os dados antes de iniciar.";
    renderTimerControls();
    updateTimer();
  }
}

async function completeActiveCycle() {
  if (!state.activeCycle || state.isCompleting) return;
  const cycleId = state.activeCycle.id;
  state.isCompleting = true;
  renderTimerControls();
  try {
    const result = await apiRequest(`/api/pomodoro/cycles/${encodeURIComponent(cycleId)}/complete`, {
      method: "POST",
    });
    if (result?.ok !== true || result.cycle?.status !== "completed") {
      throw new ApiError(500, null);
    }
    state.completedInSeries += 1;
    state.timerMessage = "";
    renderCycleProgress();
    const needsLongBreak = state.completedInSeries >= state.settings.longBreakAfter;
    startBreak(needsLongBreak);
    void loadMetrics();
  } catch (error) {
    state.nextCompletionAttemptAt = Date.now() + 5000;
    state.timerMessage = error instanceof ApiError && error.status === 409
      ? apiMessage(error)
      : "Não foi possível confirmar a conclusão no servidor. O ciclo permanece sujeito à confirmação.";
    showNotice(apiMessage(error), "error");
    await synchronizeActiveCycle(cycleId);
  } finally {
    state.isCompleting = false;
    renderTimerControls();
  }
}

async function cancelActiveCycle() {
  if (!state.activeCycle || state.isCancelling || state.isCompleting) return;
  if (!window.confirm("Cancelar este foco? O ciclo não será contado como estudo concluído.")) return;

  const cycleId = state.activeCycle.id;
  state.isCancelling = true;
  renderTimerControls();
  try {
    const result = await apiRequest(`/api/pomodoro/cycles/${encodeURIComponent(cycleId)}/cancel`, {
      method: "POST",
    });
    if (result?.ok !== true || result.cycle?.status !== "cancelled") {
      throw new ApiError(500, null);
    }
    state.activeCycle = null;
    state.phase = "focus";
    state.timerMessage = "Foco cancelado pelo servidor. Nenhum tempo foi somado às métricas.";
    state.nextCompletionAttemptAt = 0;
    showNotice("Foco cancelado. Você pode começar novamente quando quiser.", "info");
    updateTimer();
  } catch (error) {
    showNotice(apiMessage(error), "error");
    if (error instanceof ApiError && [404, 409].includes(error.status)) {
      await synchronizeActiveCycle(cycleId);
    }
  } finally {
    state.isCancelling = false;
    renderTimerControls();
  }
}

function renderSubjectSelect() {
  const previous = state.selectedSubjectId;
  const fragment = document.createDocumentFragment();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.isLoadingSubjects ? "Carregando disciplinas..." : "Selecione uma disciplina";
  fragment.append(placeholder);

  state.subjects.forEach((subject) => {
    const option = document.createElement("option");
    option.value = String(subject.id);
    option.textContent = subject.name;
    fragment.append(option);
  });

  if (state.activeCycle && !state.subjects.some((subject) => String(subject.id) === String(state.activeCycle.subject_id))) {
    const activeOption = document.createElement("option");
    activeOption.value = String(state.activeCycle.subject_id);
    activeOption.textContent = state.activeCycle.subject_name || "Disciplina do ciclo ativo";
    fragment.append(activeOption);
  }

  elements.subjectSelect.replaceChildren(fragment);
  const activeId = state.activeCycle ? String(state.activeCycle.subject_id) : previous;
  if (activeId && [...elements.subjectSelect.options].some((option) => option.value === activeId)) {
    elements.subjectSelect.value = activeId;
  } else if (!state.activeCycle && state.subjects.length) {
    state.selectedSubjectId = String(state.subjects[0].id);
    elements.subjectSelect.value = state.selectedSubjectId;
  } else {
    elements.subjectSelect.value = "";
  }
  renderTimerControls();
}

function renderSubjects() {
  const fragment = document.createDocumentFragment();
  elements.subjectList.replaceChildren();
  elements.subjectsError.textContent = state.subjectsError;
  elements.subjectsError.hidden = !state.subjectsError;
  elements.subjectsEmpty.hidden = state.isLoadingSubjects || state.subjects.length > 0 || Boolean(state.subjectsError);

  state.subjects.forEach((subject) => {
    const item = document.createElement("li");
    item.className = "subject-row";
    item.dataset.subjectId = String(subject.id);

    if (state.editingSubjectId === String(subject.id)) {
      const form = document.createElement("form");
      form.className = "subject-edit-form";
      form.dataset.action = "edit";
      form.dataset.subjectId = String(subject.id);
      const label = document.createElement("label");
      label.className = "visually-hidden";
      label.textContent = `Editar disciplina ${subject.name}`;
      const input = document.createElement("input");
      input.className = "field-control";
      input.name = "name";
      input.type = "text";
      input.maxLength = 80;
      input.required = true;
      input.value = subject.name;
      label.htmlFor = `edit-subject-${subject.id}`;
      input.id = `edit-subject-${subject.id}`;
      const save = document.createElement("button");
      save.className = "button button-secondary";
      save.type = "submit";
      save.textContent = "Salvar";
      const cancel = document.createElement("button");
      cancel.className = "button button-quiet";
      cancel.type = "button";
      cancel.dataset.action = "stop-edit";
      cancel.textContent = "Cancelar";
      form.append(label, input, save, cancel);
      item.append(form);
    } else {
      const name = document.createElement("span");
      name.className = "subject-name";
      name.textContent = subject.name;

      const actions = document.createElement("div");
      actions.className = "subject-actions";
      const select = document.createElement("button");
      select.className = "button button-quiet";
      select.type = "button";
      select.dataset.action = "select";
      select.textContent = "Estudar";
      const edit = document.createElement("button");
      edit.className = "button button-quiet";
      edit.type = "button";
      edit.dataset.action = "edit";
      edit.textContent = "Editar";
      const archive = document.createElement("button");
      archive.className = "button button-quiet";
      archive.type = "button";
      archive.dataset.action = "archive";
      archive.textContent = "Arquivar";
      actions.append(select, edit, archive);
      item.append(name, actions);
    }
    fragment.append(item);
  });

  elements.subjectList.append(fragment);
  renderSubjectSelect();
}

async function loadSubjects() {
  state.isLoadingSubjects = true;
  renderTimerControls();
  try {
    const result = await apiRequest("/api/subjects");
    if (result?.ok !== true || !Array.isArray(result.subjects) || !result.subjects.every(validSubject)) {
      throw new ApiError(500, null);
    }
    state.subjects = result.subjects;
    state.subjectsError = "";
    state.subjects.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
    if (!state.subjects.some((subject) => String(subject.id) === state.selectedSubjectId)) {
      state.selectedSubjectId = state.subjects.length ? String(state.subjects[0].id) : "";
    }
    renderSubjects();
  } catch (error) {
    state.subjects = [];
    state.selectedSubjectId = "";
    state.subjectsError = apiMessage(error);
    renderSubjects();
    showNotice(apiMessage(error), "error");
  } finally {
    state.isLoadingSubjects = false;
    renderSubjects();
  }
}

async function createSubject(event) {
  event.preventDefault();
  const name = elements.newSubjectName.value.trim();
  if (!name || name.length > 80) {
    elements.newSubjectName.setCustomValidity("Informe um nome com até 80 caracteres.");
    elements.newSubjectName.reportValidity();
    return;
  }
  elements.newSubjectName.setCustomValidity("");
  const button = document.getElementById("addSubjectButton");
  button.disabled = true;
  try {
    const result = await apiRequest("/api/subjects", { method: "POST", body: { name } });
    if (result?.ok !== true || !validSubject(result.subject)) throw new ApiError(500, null);
    state.subjects.push(result.subject);
    state.subjects.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
    state.selectedSubjectId = String(result.subject.id);
    elements.newSubjectName.value = "";
    state.editingSubjectId = null;
    hideNotice();
    renderSubjects();
    showNotice("Disciplina adicionada.", "success");
  } catch (error) {
    showNotice(apiMessage(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function updateSubject(id, name) {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 80) {
    showNotice("Informe um nome de disciplina entre 1 e 80 caracteres.", "error");
    return;
  }
  try {
    const result = await apiRequest(`/api/subjects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name: normalizedName },
    });
    if (result?.ok !== true || !validSubject(result.subject)) throw new ApiError(500, null);
    state.subjects = state.subjects.map((subject) => String(subject.id) === String(id) ? result.subject : subject);
    state.subjects.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
    state.editingSubjectId = null;
    renderSubjects();
    showNotice("Disciplina atualizada.", "success");
  } catch (error) {
    showNotice(apiMessage(error), "error");
  }
}

async function archiveSubject(id) {
  const subject = state.subjects.find((item) => String(item.id) === String(id));
  if (!subject || !window.confirm(`Arquivar a disciplina “${subject.name}”?`)) return;
  try {
    const result = await apiRequest(`/api/subjects/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (result?.ok !== true || !validSubject(result.subject) || result.subject.archived_at == null) {
      throw new ApiError(500, null);
    }
    state.subjects = state.subjects.filter((item) => String(item.id) !== String(id));
    if (state.selectedSubjectId === String(id)) {
      state.selectedSubjectId = state.subjects.length ? String(state.subjects[0].id) : "";
    }
    renderSubjects();
    showNotice("Disciplina arquivada.", "success");
  } catch (error) {
    showNotice(apiMessage(error), "error");
  }
}

function formatHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) return "—";
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(hours)} h`;
}

function displayWeekRange(week) {
  if (!week?.starts_on || !week?.ends_on) return "Período semanal retornado pelo servidor.";
  const start = new Date(`${week.starts_on}T12:00:00Z`);
  const end = new Date(`${week.ends_on}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Período semanal retornado pelo servidor.";
  }
  end.setUTCDate(end.getUTCDate() - 1);
  const options = { day: "numeric", month: "short", timeZone: "UTC" };
  return `${start.toLocaleDateString("pt-BR", options)} – ${end.toLocaleDateString("pt-BR", options)} · São Paulo`;
}

function renderMetrics() {
  if (!state.metrics) {
    elements.weeklyHours.textContent = "—";
    elements.weeklyCycles.textContent = "—";
    elements.breakdownTotal.textContent = "";
    elements.breakdownList.replaceChildren();
    elements.metricsEmpty.hidden = true;
    return;
  }

  const metrics = state.metrics;
  elements.weeklyHours.textContent = formatHours(metrics.total_hours);
  elements.weeklyCycles.textContent = String(Number(metrics.completed_cycles) || 0);
  elements.breakdownTotal.textContent = formatHours(metrics.total_hours);
  elements.weekRange.textContent = displayWeekRange(metrics.week);
  elements.breakdownList.replaceChildren();

  const subjects = Array.isArray(metrics.subjects) ? metrics.subjects : [];
  elements.metricsEmpty.hidden = subjects.length > 0;
  const totalSeconds = Math.max(0, Number(metrics.total_seconds) || 0);
  const tones = ["violet", "blue", "green"];
  const fragment = document.createDocumentFragment();

  subjects.forEach((subject, index) => {
    const seconds = Math.max(0, Number(subject.total_seconds) || 0);
    const percentage = totalSeconds > 0 ? Math.min(100, (seconds / totalSeconds) * 100) : 0;
    const row = document.createElement("div");
    row.className = "breakdown-row";
    const name = document.createElement("span");
    name.className = "breakdown-subject";
    name.textContent = subject.name;
    const track = document.createElement("div");
    track.className = "bar-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `Distribuição de tempo para ${subject.name}`);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(percentage)));
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.dataset.tone = tones[index % tones.length];
    fill.style.width = `${percentage}%`;
    track.append(fill);
    const value = document.createElement("span");
    value.className = "breakdown-value";
    value.textContent = `${formatHours(Number(subject.total_hours) || 0)} · ${Number(subject.completed_cycles) || 0} focos`;
    row.append(name, track, value);
    fragment.append(row);
  });

  elements.breakdownList.append(fragment);
}

async function loadMetrics() {
  elements.metricsError.hidden = true;
  try {
    const result = await apiRequest("/api/metrics/weekly");
    if (!validWeeklyMetrics(result)) throw new ApiError(500, null);
    state.metrics = result;
    renderMetrics();
  } catch (error) {
    state.metrics = null;
    renderMetrics();
    elements.metricsError.textContent = apiMessage(error);
    elements.metricsError.hidden = false;
  }
}

async function refreshAppData() {
  await Promise.allSettled([
    loadSubjects(),
    loadMetrics(),
    synchronizeActiveCycle(),
  ]);
}

function setSettingsStatus(message, isError = false) {
  elements.settingsStatus.textContent = message;
  elements.settingsStatus.style.color = isError ? "var(--red)" : "";
}

function saveSettings(event) {
  event.preventDefault();
  const formValues = {
    focusMinutes: elements.focusMinutes.valueAsNumber,
    shortBreakMinutes: elements.shortBreakMinutes.valueAsNumber,
    longBreakMinutes: elements.longBreakMinutes.valueAsNumber,
    longBreakAfter: elements.longBreakAfter.valueAsNumber,
  };
  const valid = Object.entries(SETTINGS_LIMITS).every(([key, [min, max]]) => (
    Number.isInteger(formValues[key]) && formValues[key] >= min && formValues[key] <= max
  ));
  if (!valid) {
    showNotice("Confira os limites de cada configuração antes de salvar.", "error");
    return;
  }

  state.settings = formValues;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    state.settingsStorageUnavailable = false;
    setSettingsStatus("Preferências salvas neste navegador. O ciclo ativo não foi alterado.");
  } catch {
    setSettingsStatus("Não foi possível salvar neste navegador; as preferências valem apenas até fechar a página.", true);
    showNotice("Armazenamento local indisponível. Configurações aplicadas somente nesta sessão.", "error");
  }
  renderSettings();
}

async function logout() {
  elements.logoutButton.disabled = true;
  try {
    const result = await apiRequest("/api/auth/logout", { method: "POST" });
    if (result?.ok !== true) throw new ApiError(500, null);
    showLoginView();
    showNotice("Sessão encerrada.", "success");
  } catch (error) {
    showNotice(apiMessage(error), "error");
  } finally {
    elements.logoutButton.disabled = false;
  }
}

function oauthNoticeFromUrl() {
  const url = new URL(window.location.href);
  const success = url.searchParams.get("login") === "success";
  const oauthError = url.searchParams.get("auth_error");
  if (success || oauthError) {
    url.searchParams.delete("login");
    url.searchParams.delete("auth_error");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  if (success) return { message: "Login concluído. Seus dados foram carregados do servidor.", kind: "success" };
  if (oauthError) {
    return {
      message: OAUTH_MESSAGES[oauthError] || "Não foi possível concluir o login com o Discord.",
      kind: "error",
    };
  }
  return null;
}

function bindEvents() {
  elements.startFocusButton.addEventListener("click", startFocus);
  elements.cancelFocusButton.addEventListener("click", cancelActiveCycle);
  elements.skipBreakButton.addEventListener("click", skipBreak);
  elements.subjectForm.addEventListener("submit", createSubject);
  elements.settingsForm.addEventListener("submit", saveSettings);
  elements.subjectSelect.addEventListener("change", () => {
    state.selectedSubjectId = elements.subjectSelect.value;
  });
  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", refreshAppData);
  elements.subjectList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const item = button.closest("[data-subject-id]");
    if (!item) return;
    const id = item.dataset.subjectId;
    const subject = state.subjects.find((entry) => String(entry.id) === String(id));

    if (button.dataset.action === "select" && subject) {
      state.selectedSubjectId = String(subject.id);
      renderSubjectSelect();
      elements.subjectSelect.focus();
      showNotice(`${subject.name} selecionada para o próximo foco.`, "info");
    } else if (button.dataset.action === "edit" && subject) {
      state.editingSubjectId = String(subject.id);
      renderSubjects();
      elements.subjectList.querySelector("input[name='name']")?.focus();
    } else if (button.dataset.action === "stop-edit") {
      state.editingSubjectId = null;
      renderSubjects();
    } else if (button.dataset.action === "archive") {
      void archiveSubject(id);
    }
  });
  elements.subjectList.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-action='edit']");
    if (!form) return;
    event.preventDefault();
    const input = form.elements.namedItem("name");
    void updateSubject(form.dataset.subjectId, input.value);
  });
  elements.newSubjectName.addEventListener("input", () => {
    elements.newSubjectName.setCustomValidity("");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateTimer();
  });
}

async function bootstrap() {
  const oauthNotice = oauthNoticeFromUrl();
  state.settings = readSettings();
  renderSettings();
  bindEvents();
  window.setInterval(updateTimer, 1000);

  try {
    const result = await apiRequest("/api/auth/me");
    if (result?.ok !== true || !result.user || typeof result.user.user_id !== "string"
      || typeof result.user.username !== "string"
      || (result.user.global_name !== null && typeof result.user.global_name !== "string")
      || (result.user.avatar !== null && typeof result.user.avatar !== "string")) {
      throw new ApiError(500, null);
    }
    showAppView(result.user);
    await refreshAppData();
    if (oauthNotice && (state.user || oauthNotice.kind === "error")) {
      showNotice(oauthNotice.message, oauthNotice.kind);
    }
    if (state.settingsStorageUnavailable) {
      setSettingsStatus("Não foi possível ler preferências salvas; padrões aplicados nesta sessão.", true);
    }
    if (state.pomodoroSeriesStorageUnavailable) {
      showNotice("Não foi possível ler a sequência salva do Pomodoro; ela vale apenas nesta sessão.", "error");
    }
  } catch (error) {
    showLoginView();
    if (oauthNotice?.kind === "error") {
      showNotice(oauthNotice.message, oauthNotice.kind);
    } else if (oauthNotice?.kind === "success") {
      showNotice("O retorno do Discord ocorreu, mas a API não confirmou uma sessão autenticada.", "error");
    } else if (!(error instanceof ApiError && error.status === 401)) {
      showNotice(apiMessage(error), "error");
    }
    if (state.settingsStorageUnavailable) {
      setSettingsStatus("Não foi possível ler preferências salvas; padrões aplicados nesta sessão.", true);
    }
    if (state.pomodoroSeriesStorageUnavailable) {
      showNotice("Não foi possível ler a sequência salva do Pomodoro; ela vale apenas nesta sessão.", "error");
    }
  }
}

bootstrap();

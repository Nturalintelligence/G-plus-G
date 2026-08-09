import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

import logoDark from "./assets/brand/gg-logo-dark.svg";
import logoLight from "./assets/brand/gg-logo-light.svg";

import { validateFileForProviders } from "../../../src/files/file-manager.js";
import { DeleteProjectDialog } from "./components/DeleteProjectDialog.js";
import { ErrorModal } from "./components/ErrorModal.js";
import { AttachmentIcon, CloseIcon, ProfileIcon, SendIcon, SettingsIcon, StopIcon, TargetIcon, TrashIcon } from "./components/Icon.js";
import { ModelStatusRow } from "./components/ModelStatusRow.js";
import { ProjectRequiredToast } from "./components/ProjectRequiredToast.js";
import { QualityCenterView } from "./components/QualityCenterView.js";
import { RunSummaryBar } from "./components/RunSummaryBar.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { CliTaskPanel, type CliTaskView } from "./components/CliTaskPanel.js";
import { formatProviderList, getProviderDisplayName, getProviderMetadata } from "./provider-metadata.js";
import { selectReadyAnswerEntries } from "./ready-answer.js";
import { toUserFacingError, UserFacingError } from "./user-errors.js";

const initialState: ProjectStateView = {
  requirements: [],
  constraints: [],
  decisions: [],
  rejectedOptions: [],
  openQuestions: [],
  acceptanceCriteria: [
    { id: "acceptance-1", text: "Define acceptance criterion", sourceTurnIds: [] },
  ],
};

type StateSection = keyof ProjectStateView;
const stateSections: Array<{
  key: StateSection;
  title: string;
  empty: string;
  rationale: boolean;
}> = [
  { key: "requirements", title: "Требования", empty: "Добавьте требование", rationale: false },
  { key: "constraints", title: "Ограничения", empty: "Добавьте ограничение", rationale: false },
  { key: "decisions", title: "Принятые решения", empty: "Зафиксируйте решение", rationale: true },
  { key: "rejectedOptions", title: "Отклонённые варианты", empty: "Зафиксируйте отклонённый вариант", rationale: true },
  { key: "openQuestions", title: "Открытые вопросы", empty: "Добавьте вопрос", rationale: false },
  { key: "acceptanceCriteria", title: "Критерии приёмки", empty: "Добавьте критерий", rationale: false },
];

const metricLabels: Record<string, string> = {
  "provider.turn.success": "Успешность",
  "provider.turn.elapsed_ms": "Время ответа",
  "provider.turn.retry_count": "Повторные попытки",
  "orchestration.run.success": "Успешность запусков",
  "orchestration.run.elapsed_ms": "Время запуска",
};

function metricValue(metric: MetricSummaryView): string {
  if (metric.name.endsWith(".success")) return `${Math.round(metric.average * 100)}%`;
  if (metric.name.endsWith("_ms")) {
    return metric.average >= 60_000
      ? `${(metric.average / 60_000).toFixed(1)} мин`
      : `${(metric.average / 1_000).toFixed(1)} сек`;
  }
  return metric.average.toFixed(metric.average % 1 === 0 ? 0 : 1);
}

export type AttachedFileItem = AttachmentRefView & { previewUrl?: string };

const fallbackSettings: AppSettingsView = {
  schemaVersion: 1,
  profile: { displayName: "", realName: "", greetingStyle: "generic" },
  defaults: {
    mode: "DEBATE",
    providers: ["chatgpt", "gemini"],
    limits: {
      maxTurns: 6,
      maxTurnMs: 180_000,
      maxSessionMs: 900_000,
      maxRetries: 1,
      confirmationEvery: 2,
      requireConfirmation: false,
    },
  },
  appearance: { theme: "dark", density: "comfortable", fontScale: 100 },
};

function getSessionStatusDisplay(session?: string): { text: string; type: "online" | "warning" | "busy" | "offline" } {
  switch (session) {
    case "AUTHENTICATED":
      return { text: "Авторизован", type: "online" };
    case "LOGIN_REQUIRED":
      return { text: "Требуется вход", type: "offline" };
    case "CHALLENGE_REQUIRED":
      return { text: "Проверка капчи", type: "warning" };
    case "RATE_LIMITED":
      return { text: "Лимит запросов", type: "warning" };
    case "CHECKING":
      return { text: "Проверяем…", type: "busy" };
    default:
      return { text: "Неизвестно", type: "offline" };
  }
}

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [current, setCurrent] = useState<ProjectDetails | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<Record<string, { session: string; ready: boolean }>>({
    chatgpt: { session: "UNKNOWN", ready: false },
    gemini: { session: "UNKNOWN", ready: false },
    deepseek: { session: "UNKNOWN", ready: false },
  });
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<string>("DEBATE");
  const [continuationPolicy, setContinuationPolicy] = useState<"autonomous" | "approval">("autonomous");
  const [starter, setStarter] = useState<string>("chatgpt");
  const [providers, setProviders] = useState<string[]>(["chatgpt", "gemini"]);
  const [stateText, setStateText] = useState(JSON.stringify(initialState, null, 2));
  const [projectState, setProjectState] = useState<ProjectStateView>(initialState);
  const [advancedStateOpen, setAdvancedStateOpen] = useState(false);
  const [openStateSections, setOpenStateSections] = useState<Set<StateSection>>(
    () => new Set(["acceptanceCriteria"]),
  );
  const [status, setStatus] = useState("Готово");
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<AppSettingsView>(fallbackSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"profile" | "models" | "behavior" | "appearance" | "quality" | "diagnostics">("profile");
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfoView | null>(null);
  const [preflight, setPreflight] = useState<Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }>>([]);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [qualityDashboard, setQualityDashboard] = useState<QualityDashboardView | null>(null);
  const [showSplash, setShowSplash] = useState(true);
  const [creationProviders, setCreationProviders] = useState<string[]>(["chatgpt", "gemini"]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [optimisticUserTask, setOptimisticUserTask] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [activeSpecSection, setActiveSpecSection] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileItem[]>([]);
  const [draftMessageId, setDraftMessageId] = useState(
    () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  const [viewMode, setViewMode] = useState<"SYNTHESIZED" | "LIVE">("SYNTHESIZED");
  const [showTurnsSpoiler, setShowTurnsSpoiler] = useState(false);
  const [finalizerMode, setFinalizerMode] = useState<"MANUAL" | "LEAD_SELECTS" | "PEER_AGREEMENT">("MANUAL");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [newProjectDescriptionInput, setNewProjectDescriptionInput] = useState("");
  const [activeStage, setActiveStage] = useState<string>("Анализ задачи");
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  const [newProjectModalOpen, setNewProjectModalOpen] = useState(false);
  const [newProjectNameInput, setNewProjectNameInput] = useState("");
  const [previewImageModalUrl, setPreviewImageModalUrl] = useState<string | null>(null);
  const [webChatsDrawerOpen, setWebChatsDrawerOpen] = useState(false);
  const [finalResponder, setFinalResponder] = useState<string>("auto");
  const [cliTasks, setCliTasks] = useState<CliTaskView[]>([]);
  const [busyCliTaskId, setBusyCliTaskId] = useState<string | null>(null);
  const outputRef = useRef<HTMLElement>(null);

  async function addAttachmentRefs(refs: AttachmentRefView[]): Promise<void> {
    const accepted: AttachedFileItem[] = [];
    const rejected: AttachmentRefView[] = [];
    for (const ref of refs) {
      if (ref.status === "QUARANTINED" || ref.status === "FAILED") {
        rejected.push(ref);
        continue;
      }
      const previewUrl = ref.kind === "image"
        ? await window.orchestrator.attachments.getPreviewUrl(ref.id)
        : null;
      accepted.push({ ...ref, ...(previewUrl ? { previewUrl } : {}) });
    }
    if (accepted.length > 0) {
      setAttachedFiles((previous) => [...previous, ...accepted]);
      setStatus(`Прикреплено файлов: ${accepted.length}`);
    }
    if (rejected.length > 0) {
      setStatus(`Отклонено вложений: ${rejected.map((item) => item.fileName).join(", ")}`);
    }
  }

  async function handlePickFiles() {
    if (!current) {
      setShowNoProjectToast(true);
      return;
    }
    try {
      const refs = await window.orchestrator.attachments.pickFiles(current.project.id, draftMessageId);
      await addAttachmentRefs(refs);
    } catch (err: any) {
      setStatus(`Ошибка выбора файла: ${err.message}`);
    }
  }

  async function handleDropFiles(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    if (!current || !e.dataTransfer.files.length) return;
    const projectId = current.project.id;
    const messageId = draftMessageId;
    const newRefs: AttachmentRefView[] = [];

    for (const file of Array.from(e.dataTransfer.files)) {
      try {
        const ref = await window.orchestrator.attachments.stageDroppedFile(projectId, messageId, file);
        newRefs.push(ref);
      } catch (err: any) {
        setStatus(`Ошибка прикрепления файла: ${err.message}`);
      }
    }

    if (newRefs.length > 0) {
      await addAttachmentRefs(newRefs);
    }
  }

  async function removeFile(attachmentId: string) {
    try {
      await window.orchestrator.attachments.removeDraft(attachmentId);
    } catch {
      // Ignore cleanup error
    }
    setAttachedFiles((prev: any[]) => prev.filter((f: any) => f.id !== attachmentId));
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!current) return;
    const items = Array.from(e.clipboardData.items || []);
    const fileItems = items.filter((item) => item.kind === "file");
    if (fileItems.length === 0) return;

    for (const item of fileItems) {
      const file = item.getAsFile();
      if (!file) continue;

      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64Data = event.target?.result as string;
          if (base64Data) {
            try {
              const ref = await window.orchestrator.attachments.stageClipboardImage(
                current.project.id,
                draftMessageId,
                base64Data
              );
              await addAttachmentRefs([ref]);
            } catch (err: any) {
              setStatus(`Ошибка вставки из буфера: ${err.message}`);
            }
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }

  async function confirmDeleteProject(deleteRemote: boolean): Promise<void> {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    setStatus(deleteRemote ? "Удаление проекта и чатов в веб-сервисах ИИ…" : "Удаление проекта из G+G…");
    try {
      await window.orchestrator.projects.delete(deleteTarget.id, deleteRemote);
      if (current?.project.id === deleteTarget.id) {
        setCurrent(null);
      }
      setDeleteTarget(null);
      await refresh();
      setStatus("Проект успешно удалён");
    } catch (err) {
      setStatus(`Ошибка удаления: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleteBusy(false);
    }
  }

  useEffect(() => {
    return window.orchestrator.orchestration.onProgress((data) => {
      setStreaming((currentStreaming) => ({
        ...currentStreaming,
        [data.providerId]: data.text,
      }));
    });
  }, []);

  useEffect(() => {
    if (typeof window.orchestrator.events?.onEvent !== "function") return;
    return window.orchestrator.events.onEvent((event) => {
      if (event?.event_type === "phase:changed" && event.payload) {
        const details = event.payload.details || event.payload.phase;
        if (details) setStatus(details);
      }
    });
  }, []);

  const refresh = async (): Promise<void> => setProjects(await window.orchestrator.projects.list());
  useEffect(() => {
    void refresh();
    const timer = setTimeout(() => setShowSplash(false), 2500);
    return () => clearTimeout(timer);
  }, []);
  const hasActiveCliTask = cliTasks.some((item) =>
    ["QUEUED", "RUNNING", "VERIFYING"].includes(item.status),
  );
  useEffect(() => {
    const projectId = current?.project.id;
    if (!projectId || !hasActiveCliTask) return;
    const timer = window.setInterval(() => {
      void refreshCliTasks(projectId).catch((error) => {
        setStatus(`Не удалось обновить CLI-задачи: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [current?.project.id, hasActiveCliTask]);
  useEffect(() => {
    void window.orchestrator.settings.get().then((value) => {
      setSettings(value);
      setMode(value.defaults.mode);
      setProviders(value.defaults.providers);
      setCreationProviders(value.defaults.providers);
      if (value.defaults.providers[0]) {
        setStarter(value.defaults.providers[0]);
      }
    }).catch((error) => setStatus(`Настройки не загружены: ${String(error)}`));
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.appearance.theme;
    root.dataset.density = settings.appearance.density;
    root.style.fontSize = `${settings.appearance.fontScale}%`;
  }, [settings.appearance]);
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [current?.transcript.length, optimisticUserTask, Object.values(streaming).join("").length, running]);
  useEffect(() => {
    if (!running || !current) return;
    const projectId = current.project.id;
    const timer = window.setInterval(() => {
      void window.orchestrator.projects.open(projectId).then(setCurrent).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [running, current?.project.id]);
  useEffect(() => {
    if (settingsOpen) void loadQualityDashboard();
  }, [settingsOpen]);

  async function openProject(id: string): Promise<void> {
    const [details, tasks] = await Promise.all([
      window.orchestrator.projects.open(id),
      window.orchestrator.cliTasks.list(id),
    ]);
    setCurrent(details);
    setCliTasks(tasks);
    setAttachedFiles([]);
    setDraftMessageId(`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const nextState = details.state?.state ?? structuredClone(initialState);
    setProjectState(nextState);
    setStateText(JSON.stringify(nextState, null, 2));
  }

  const [showNoProjectToast, setShowNoProjectToast] = useState(false);
  const [activeUserError, setActiveUserError] = useState<UserFacingError | null>(null);

  async function run(): Promise<void> {
    const submittedTask = task.trim();
    if (!current) {
      setShowNoProjectToast(true);
      return;
    }
    if (!submittedTask || running || providers.length === 0) return;
    const projectId = current.project.id;
    setOptimisticUserTask(submittedTask);
    setTask("");
    setStreaming({});
    setRunning(true);
    setStatus("Модели обсуждают сообщение…");
    try {
      const orderedProviders = [
        ...(providers.includes(starter) ? [starter] : []),
        ...providers.filter((provider) => provider !== starter),
      ];
      const output = await window.orchestrator.orchestration.run({
        projectId,
        mode,
        task: submittedTask,
        providers: orderedProviders,
        limits: settings.defaults.limits,
        finalizerMode,
        finalResponder,
        userMessageId: draftMessageId,
        attachments: attachedFiles,
        promptCustomizations: settings.models,
      });
      setAttachedFiles([]);
      setDraftMessageId(`msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      setStatus(
        output.consensusReached
          ? "Модели независимо подтвердили согласованное решение"
          : output.status,
      );
      await openProject(projectId);
    } catch (error) {
      const userErr = toUserFacingError(error, "Запуск оркестратора");
      setActiveUserError(userErr);
      setStatus(userErr.message);
      await openProject(projectId);
    } finally {
      setRunning(false);
      setStreaming({});
      setOptimisticUserTask(null);
    }
  }

  async function login(provider: string): Promise<void> {
    setStatus(`Войдите в ${getProviderDisplayName(provider)} в открывшемся окне…`);
    setProviderStatuses((previous) => ({
      ...previous,
      [provider]: { session: "BUSY", ready: false },
    }));
    try {
      const session = await window.orchestrator.provider.login(provider);
      setProviderStatuses((previous) => ({
        ...previous,
        [provider]: { session, ready: session === "AUTHENTICATED" },
      }));
      setStatus(`Сессия ${getProviderDisplayName(provider)} активна: ${session}`);
    } catch (error: any) {
      const errorText = String(error?.message ?? error);
      const failedSession = /challenge|captcha|капч|traffic_blocked/i.test(errorText)
        ? "CHALLENGE_REQUIRED"
        : "UNKNOWN";
      setProviderStatuses((previous) => ({
        ...previous,
        [provider]: { session: failedSession, ready: false },
      }));
      if (error?.code === "LOGIN_ALREADY_ACTIVE" || String(error).includes("LOGIN_ALREADY_ACTIVE")) {
        setStatus(error.message || "Уже выполняется вход в другой браузер.");
        return;
      }
      const userErr = toUserFacingError(error, `Авторизация ${provider}`);
      setActiveUserError(userErr);
      setStatus(userErr.message);
    }
  }

  async function saveSettings(): Promise<void> {
    try {
      const saved = await window.orchestrator.settings.save(settings);
      setSettings(saved);
      setMode(saved.defaults.mode);
      setProviders(saved.defaults.providers);
      setSettingsOpen(false);
      setStatus("Настройки сохранены");
    } catch (error) {
      setStatus(`Настройки не сохранены: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function refreshCliTasks(projectId = current?.project.id): Promise<void> {
    if (!projectId) {
      setCliTasks([]);
      return;
    }
    setCliTasks(await window.orchestrator.cliTasks.list(projectId));
  }

  async function approveCliTask(taskRecord: CliTaskView): Promise<void> {
    const approved = window.confirm(
      `Запустить локальный CLI executor '${taskRecord.executor}'?\n\n${taskRecord.title}\nRisk: ${taskRecord.risk}\n\n` +
      "CLI работает как текущий пользователь Windows. Подтверждайте только полностью понятные задачи и пути.",
    );
    if (!approved) return;
    setBusyCliTaskId(taskRecord.taskId);
    try {
      await window.orchestrator.cliTasks.approve(taskRecord.projectId, taskRecord.taskId);
      setStatus(`CLI-задача ${taskRecord.taskId} поставлена в очередь`);
    } catch (error) {
      setStatus(`CLI-задача не одобрена: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyCliTaskId(null);
      await refreshCliTasks(taskRecord.projectId);
    }
  }

  async function rejectCliTask(taskRecord: CliTaskView): Promise<void> {
    const reason = window.prompt("Причина отклонения CLI-задачи:", "Отклонено пользователем");
    if (reason === null) return;
    setBusyCliTaskId(taskRecord.taskId);
    try {
      await window.orchestrator.cliTasks.reject(taskRecord.projectId, taskRecord.taskId, reason);
      setStatus(`CLI-задача ${taskRecord.taskId} отклонена`);
    } finally {
      setBusyCliTaskId(null);
      await refreshCliTasks(taskRecord.projectId);
    }
  }

  async function cancelCliTask(taskRecord: CliTaskView): Promise<void> {
    setBusyCliTaskId(taskRecord.taskId);
    try {
      await window.orchestrator.cliTasks.cancel(taskRecord.projectId, taskRecord.taskId);
      setStatus(`Остановка CLI-задачи ${taskRecord.taskId} запрошена`);
    } finally {
      setBusyCliTaskId(null);
      await refreshCliTasks(taskRecord.projectId);
    }
  }

  async function retryCliTask(taskRecord: CliTaskView): Promise<void> {
    setBusyCliTaskId(taskRecord.taskId);
    try {
      await window.orchestrator.cliTasks.retry(taskRecord.projectId, taskRecord.taskId);
      setStatus(`CLI-задача ${taskRecord.taskId} ожидает нового подтверждения`);
    } finally {
      setBusyCliTaskId(null);
      await refreshCliTasks(taskRecord.projectId);
    }
  }

  async function refreshDiagnostics(): Promise<void> {
    setMaintenanceBusy(true);
    try {
      const [info, checks] = await Promise.all([
        window.orchestrator.system.info(),
        window.orchestrator.system.preflight(),
      ]);
      setReleaseInfo(info);
      setPreflight(checks);
      setStatus(checks.some((check) => check.status === "fail")
        ? "Диагностика обнаружила ошибку"
        : "Диагностика завершена");
    } catch (error) {
      setStatus(`Диагностика не выполнена: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function loadQualityDashboard(): Promise<void> {
    try {
      setQualityDashboard(await window.orchestrator.quality.dashboard());
    } catch (error) {
      setStatus(`Метрики не загружены: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function createBackup(): Promise<void> {
    setMaintenanceBusy(true);
    try {
      const path = await window.orchestrator.maintenance.backup();
      setStatus(`Резервная копия создана: ${path}`);
    } catch (error) {
      setStatus(`Копия не создана: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMaintenanceBusy(false);
    }
  }



  async function resetSession(provider: any): Promise<void> {
    setMaintenanceBusy(true);
    try {
      const result = await window.orchestrator.maintenance.resetSession(provider);
      if (result.reset) {
        setProviderStatuses((previous) => ({
          ...previous,
          [provider]: { session: "UNKNOWN", ready: false },
        }));
      }
      setStatus(result.reset ? `Сессия ${provider} сброшена` : "Сброс сессии отменён");
    } catch (error) {
      setStatus(`Сессия не сброшена: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function openDataFolder(): Promise<void> {
    try {
      const path = await window.orchestrator.system.openDataFolder();
      setStatus(`Открыта папка: ${path}`);
    } catch (error) {
      setStatus(`Папка не открыта: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function updateLimit(name: keyof AppSettingsView["defaults"]["limits"], value: string): void {
    setSettings((currentSettings) => ({
      ...currentSettings,
      defaults: {
        ...currentSettings.defaults,
        limits: { ...currentSettings.defaults.limits, [name]: Number(value) },
      },
    }));
  }

  async function saveState(): Promise<void> {
    if (!current) return;
    try {
      await window.orchestrator.state.save(current.project.id, projectState);
      await openProject(current.project.id);
      setStatus("Черновик Project State сохранён");
    } catch (error) {
      setStatus(
        `Project State не сохранён: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function replaceProjectState(next: ProjectStateView): void {
    setProjectState(next);
    setStateText(JSON.stringify(next, null, 2));
  }

  function addStateItem(section: StateSection): void {
    const item: ProjectStateItemView = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: "",
      sourceTurnIds: [],
      ...(section === "decisions" || section === "rejectedOptions"
        ? { rationale: "" }
        : {}),
    };
    replaceProjectState({ ...projectState, [section]: [...projectState[section], item] });
  }

  function updateStateItem(
    section: StateSection,
    id: string,
    patch: Partial<ProjectStateItemView>,
  ): void {
    replaceProjectState({
      ...projectState,
      [section]: projectState[section].map((item) =>
        item.id === id ? { ...item, ...patch } : item),
    });
  }

  function removeStateItem(section: StateSection, id: string): void {
    replaceProjectState({
      ...projectState,
      [section]: projectState[section].filter((item) => item.id !== id),
    });
  }

  function applyAdvancedState(): void {
    try {
      const parsed = JSON.parse(stateText) as ProjectStateView;
      replaceProjectState(parsed);
      setStatus("JSON применён к конструктору");
    } catch (error) {
      setStatus(`Некорректный JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function relay(entry: ConversationEntryView): Promise<void> {
    if (!current || running) return;
    setRunning(true);
    setStatus("Передача контекста следующему участнику…");
    try {
      const nextMessage = `<HANDOFF_CONTEXT>\nИсходная задача: ${current.project.name}\nПоследний принятый ответ (${entry.providerId ?? "peer"}):\n${entry.content}\n</HANDOFF_CONTEXT>\n\nПожалуйста, развей это решение и выдели ключевые моменты.`;
      const nextProviders = (current.project.providers && current.project.providers.length > 0
        ? current.project.providers
        : ["gemini", "chatgpt"]
      ).filter(p => p !== entry.providerId);
      const targetProvider = nextProviders[0] || (entry.providerId === "chatgpt" ? "gemini" : "chatgpt");
      await window.orchestrator.orchestration.run({
        projectId: current.project.id,
        mode: "MANUAL",
        task: nextMessage,
        providers: [targetProvider],
        limits: { ...settings.defaults.limits, maxTurns: 1 },
      });
      await openProject(current.project.id);
    } catch (err: any) {
      setStatus(`Ошибка передачи: ${err.message}`);
    } finally {
      setRunning(false);
    }
  }

  if (showSplash) {
    const logoSrc = settings.appearance.theme === "light" ? logoLight : logoDark;
    return (
      <div className="splash-overlay">
        <img src={logoSrc} className="splash-logo" alt="G+G Workspace Logo" />
        <h1 className="splash-greeting">G+G Workspace</h1>
        <p className="splash-subtitle">Подготовка рабочего пространства…</p>
        <div className="splash-loader" />
      </div>
    );
  }

  const assistantTranscript = (current?.transcript ?? []).filter((entry) => entry.role === "ASSISTANT");
  const {
    finalEntry: explicitFinalEntry,
    visibleEntries: readyAnswerEntries,
  } = selectReadyAnswerEntries(current?.transcript ?? []);

  return (
    <main>
      <header>
        <div className="header-left">
          <button
            className="icon-header-btn hamburger-btn"
            title="Переключить боковую панель"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h1 className="header-title">G+G Workspace</h1>
        </div>
        <div className="header-actions">
          <span className="status" role="status" aria-live="polite">{status}</span>
          <button
            className={`icon-header-btn ${inspectorOpen ? "active" : ""}`}
            title="Конструктор спецификации"
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" />
            </svg>
            <span>Спецификация</span>
          </button>
        </div>
      </header>
      <div className={`layout ${!sidebarOpen ? "collapsed-sidebar" : ""} ${inspectorOpen ? "has-inspector" : ""}`}>
        {sidebarOpen ? (
          <aside className="sidebar-pane">
            <div className="sidebar-header">
              <h2>Проекты</h2>
              <button
                className="new-project-btn"
                title="Создать новый проект"
                onClick={() => {
                  setNewProjectNameInput("");
                  setNewProjectDescriptionInput("");
                  setNewProjectModalOpen(true);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Новый</span>
              </button>
            </div>
            <nav className="projects-list-nav">
              {projects.map((project) => (
                <div className={`project-row ${current?.project.id === project.id ? "selected" : ""}`} key={project.id}>
                  <button
                    className="project-btn"
                    onClick={() => void openProject(project.id)}
                  >
                    <span className="project-name">{project.name}</span>
                  </button>
                  <button
                    className="project-menu-btn"
                    title="Действия с проектом"
                    onClick={(event) => {
                      event.stopPropagation();
                      setProjectMenuOpenId(projectMenuOpenId === project.id ? null : project.id);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                  {projectMenuOpenId === project.id ? (
                    <div className="project-context-menu">
                      <button
                        onClick={() => {
                          setProjectMenuOpenId(null);
                          setDeleteTarget(project);
                        }}
                      >
                        Удалить проект
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </nav>

            <div className="sidebar-models-section">
              <h3 className="sidebar-section-title">Модели</h3>
              <div className="sidebar-models-list">
                {["chatgpt", "gemini", "deepseek"].map((pId) => {
                  const statusInfo = getSessionStatusDisplay(providerStatuses[pId]?.session);
                  return (
                    <ModelStatusRow
                      key={pId}
                      providerId={pId}
                      statusText={statusInfo.text}
                      statusType={statusInfo.type}
                      onClick={() => setSettingsOpen(true)}
                    />
                  );
                })}
              </div>
            </div>

            <footer className="sidebar-footer">
              <div
                className="profile-chip interactive"
                onClick={() => setSettingsOpen(true)}
                title="Нажмите для настройки профиля и системы"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span>{settings.profile.displayName || "Пользователь"}</span>
              </div>
            </footer>
          </aside>
        ) : null}
        <section className="workspace">
          {current?.conversations && current.conversations.length > 0 ? (
            <div className="web-chats-bar interactive" onClick={() => setWebChatsDrawerOpen(true)} title="Нажмите для открытия сессий ИИ в боковой панели">
              <span className="web-chats-label">🔗 Закреплённые веб-чаты ({current.conversations.length}):</span>
              {current.conversations.map((c) => (
                <div className="web-chat-chip" key={c.providerId}>
                  <span className="web-chat-provider">{c.providerId}</span>
                  {c.externalRef ? (
                    <span className="web-chat-link">Активен ↗</span>
                  ) : (
                    <small className="web-chat-pending">ожидает</small>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          <CliTaskPanel
            tasks={cliTasks}
            busyTaskId={busyCliTaskId}
            onApprove={approveCliTask}
            onReject={rejectCliTask}
            onCancel={cancelCliTask}
            onRetry={retryCliTask}
          />
          <article className="panel output" ref={outputRef}>
            {current?.transcript.length || optimisticUserTask || Object.values(streaming).some(t => t.trim()) ? (
              <>
                {viewMode === "SYNTHESIZED" ? (
                  <>
                    <details className="turns-spoiler" open={showTurnsSpoiler} onToggle={(e) => setShowTurnsSpoiler((e.target as HTMLDetailsElement).open)}>
                      <summary className="turns-spoiler-summary">
                        🔍 {showTurnsSpoiler ? "Скрыть ход обсуждения ИИ-моделей" : "Показать ход обсуждения ИИ-моделей"} ({(current?.transcript || []).filter(t => t.role === "ASSISTANT").length} ходов)
                      </summary>
                      <div className="turns-spoiler-content">
                        {assistantTranscript.filter((entry) => entry.id !== explicitFinalEntry?.id).map((entry) => (
                          <section className={`message assistant ${entry.providerId ?? ""}`} key={`spoiler-${entry.id}`}>
                            <header>
                              <strong>{entry.providerId ?? "ASSISTANT"}</strong>
                              {entry.round ? <small>ход {entry.round}</small> : null}
                            </header>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.content}</ReactMarkdown>
                          </section>
                        ))}
                      </div>
                    </details>
                    {readyAnswerEntries.map((entry) => (
                      <section className={`message ${entry.role.toLowerCase()} ${entry.providerId ?? ""}`} key={entry.id}>
                        <header>
                          <strong>{entry.role === "USER" ? "Вы" : entry.providerId === "system" ? "Системный отчёт" : `Итоговый ответ (${entry.providerId})`}</strong>
                          {entry.round ? <small>ход {entry.round}</small> : null}
                        </header>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.content}</ReactMarkdown>
                      </section>
                    ))}
                  </>
                ) : (
                  (current?.transcript || []).map((entry) => (
                    <section className={`message ${entry.role.toLowerCase()} ${entry.providerId ?? ""}`} key={entry.id}>
                      <header>
                        <strong>{entry.role === "USER" ? "Вы" : entry.providerId ?? entry.role}</strong>
                        {entry.round ? <small>ход {entry.round}</small> : null}
                      </header>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.content}</ReactMarkdown>
                      {entry.role === "ASSISTANT" ? (
                        <button className="relay" onClick={() => relay(entry)}>
                          Передать дальше
                        </button>
                      ) : null}
                    </section>
                  ))
                )}
                {optimisticUserTask && !(current?.transcript || []).some(t => t.role === "USER" && t.content === optimisticUserTask) ? (
                  <section className="message user optimistic" key="optimistic-user-task">
                    <header>
                      <strong>Вы</strong>
                      <small>отправка…</small>
                    </header>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{optimisticUserTask}</ReactMarkdown>
                  </section>
                ) : null}
                {running ? (
                  <div className="discussion-status-card" key="discussion-status">
                    <div className="discussion-pulse-loader">
                      <span className="dot"></span>
                      <span className="dot"></span>
                      <span className="dot"></span>
                    </div>
                    <div className="discussion-status-text">
                      <strong>ИИ-совет вырабатывает единое структурированное решение…</strong>
                      <small>{status}</small>
                    </div>
                  </div>
                ) : null}
                {viewMode === "LIVE" ? Object.entries(streaming).map(([providerId, text]) => {
                  if (!text.trim()) return null;
                  const alreadyPersisted = current?.transcript.some(
                    t => t.role === "ASSISTANT" && t.providerId === providerId && t.content.slice(-20) === text.slice(-20)
                  );
                  if (alreadyPersisted) return null;
                  return (
                    <section className={`message assistant ${providerId}`} key={`streaming-${providerId}`}>
                      <header>
                        <strong>{providerId}</strong>
                        <small>печатает...</small>
                      </header>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>
                    </section>
                  );
                }) : null}
              </>
            ) : (
              <p className="empty">Напишите ваш первый запрос, чтобы запустить обсуждение ИИ-моделей.</p>
            )}
          </article>

          <div
            className="composer panel composer-bottom"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => void handleDropFiles(e)}
          >
            <RunSummaryBar
              viewMode={viewMode}
              setViewMode={setViewMode}
              mode={mode}
              setMode={setMode}
              finalizerMode={finalizerMode}
              setFinalizerMode={setFinalizerMode}
              finalResponder={finalResponder}
              setFinalResponder={setFinalResponder}
              providers={providers}
              setProviders={setProviders}
              availableProviders={current?.project.providers && current.project.providers.length > 0 ? current.project.providers : ["chatgpt", "gemini", "deepseek"]}
              expanded={composerExpanded}
              setExpanded={setComposerExpanded}
            />

            <div className="composer-input-row">
              <button
                type="button"
                className="file-attach-btn"
                onClick={() => void handlePickFiles()}
                title="Прикрепить файл или картинку"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <textarea
                aria-label="Сообщение для моделей"
                value={task}
                onChange={(event) => setTask(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void run();
                  }
                }}
                placeholder="Напишите запрос для ИИ-моделей… Enter — отправить, Shift+Enter — новая строка"
              />
              <div className="composer-action-cell">
                {running ? (
                  <button
                    className="action-btn stop telegram-btn"
                    onClick={() => void window.orchestrator.orchestration.stop()}
                    title="Остановить генерацию"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                    </svg>
                  </button>
                ) : (
                  <button
                    className="action-btn send primary telegram-btn"
                    disabled={!current || !task.trim() || providers.length === 0}
                    onClick={() => void run()}
                    title="Отправить сообщение"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {attachedFiles.length > 0 ? (
              <div className="attached-files-row">
                {attachedFiles.map((f) => (
                  <span key={f.id} className="attached-file-tag">
                    {f.previewUrl ? (
                      <img
                        src={f.previewUrl}
                        alt={f.fileName}
                        className="attached-file-preview interactive"
                        onClick={() => setPreviewImageModalUrl(f.previewUrl!)}
                        title="Нажмите для полноэкранного просмотра"
                      />
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                        <polyline points="13 2 13 9 20 9" />
                      </svg>
                    )}{" "}
                    <span className="attached-file-name">{f.fileName}</span>
                    <button aria-label={`Удалить вложение ${f.fileName}`} onClick={() => removeFile(f.id)}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </section>
        {inspectorOpen ? (
          <aside className="inspector">
          <div className="state-heading">
            <div>
              <h2>Конструктор спецификации</h2>
              <small>
                {current?.state
                  ? `Версия ${current.state.version} · ${current.state.status}`
                  : "Новый черновик"}
              </small>
            </div>
            <span className="state-progress">
              {Object.values(projectState).flat().filter((item) => item.text.trim()).length} пунктов
            </span>
          </div>
          <div className="spec-cards-grid">
            {stateSections.map((section) => {
              const count = projectState[section.key].length;
              return (
                <button
                  className="spec-category-chip"
                  key={section.key}
                  onClick={() => setActiveSpecSection(section.key)}
                >
                  <div className="spec-chip-header">
                    <strong>
                      {section.key === "requirements" && "📋 "}
                      {section.key === "constraints" && "🛑 "}
                      {section.key === "decisions" && "✅ "}
                      {section.key === "rejectedOptions" && "❌ "}
                      {section.key === "openQuestions" && "❓ "}
                      {section.key === "acceptanceCriteria" && "🎯 "}
                      {section.title}
                    </strong>
                    <span className="spec-chip-badge">{count}</span>
                  </div>
                  <small className="spec-chip-desc">{count > 0 ? `${count} пунктов заполнено` : "Нажмите для добавления"}</small>
                </button>
              );
            })}
          </div>
          <details className="advanced-state" open={advancedStateOpen} onToggle={(event) =>
            setAdvancedStateOpen((event.currentTarget as HTMLDetailsElement).open)}>
            <summary>Экспертный режим JSON</summary>
            <textarea
              aria-label="Project State JSON"
              value={stateText}
              onChange={(event) => setStateText(event.target.value)}
            />
            <button onClick={applyAdvancedState}>Применить JSON</button>
          </details>
          <div className="controls state-actions">
            <button
              disabled={!current}
              onClick={() => void saveState()}
            >Сохранить черновик</button>
            <button
              disabled={!current?.state || current.state.status === "APPROVED"}
              onClick={() =>
                current?.state &&
                void window.orchestrator.state
                  .approve(current.state.id)
                  .then(() => openProject(current.project.id))
              }
            >Утвердить</button>
            <button
              disabled={!current}
              onClick={() =>
                current &&
                void window.orchestrator.exports
                  .spec(current.project.id)
                  .then((value) => setStatus(`Экспортировано: ${value.directory}`))
              }
            >Экспорт</button>
          </div>
          <h2>События</h2>
          <ol className="timeline">
            {current?.events.slice().reverse().map((event) => (
              <li key={event.sequence}><strong>{event.eventType}</strong><small>{event.occurredAt}</small></li>
            ))}
          </ol>
        </aside>
        ) : null}
      </div>
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
        onSave={() => void saveSettings()}
        login={login}
        resetSession={resetSession}
        qualityDashboard={qualityDashboard}
        preflight={preflight}
        runPreflight={refreshDiagnostics}
        maintenanceBusy={maintenanceBusy}
        createBackup={createBackup}
        providerStatuses={providerStatuses}
      />

      <DeleteProjectDialog
        isOpen={!!deleteTarget}
        project={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirmDelete={confirmDeleteProject}
        isDeleting={deleteBusy}
      />

      <ProjectRequiredToast
        isOpen={showNoProjectToast}
        onClose={() => setShowNoProjectToast(false)}
        onSelectProject={() => {
          setShowNoProjectToast(false);
          setSidebarOpen(true);
        }}
      />

      <ErrorModal
        error={activeUserError}
        onClose={() => setActiveUserError(null)}
      />
      {activeSpecSection ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setActiveSpecSection(null)}>
          <section className="settings-modal spec-modal" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>
                {activeSpecSection === "requirements" && "📋 Требования"}
                {activeSpecSection === "constraints" && "🛑 Ограничения"}
                {activeSpecSection === "decisions" && "✅ Принятые решения"}
                {activeSpecSection === "rejectedOptions" && "❌ Отклонения"}
                {activeSpecSection === "openQuestions" && "❓ Открытые вопросы"}
                {activeSpecSection === "acceptanceCriteria" && "🎯 Критерии приёмки"}
              </h2>
              <button onClick={() => setActiveSpecSection(null)}>×</button>
            </header>
            <div className="settings-pane spec-modal-body">
              {projectState[activeSpecSection as keyof typeof projectState].map((item, index) => (
                <article className="state-card tree-leaf" key={item.id}>
                  <header>
                    <strong>Пункт {index + 1}</strong>
                    <button
                      aria-label={`Удалить пункт ${index + 1}`}
                      onClick={() => removeStateItem(activeSpecSection as any, item.id)}
                    >×</button>
                  </header>
                  <textarea
                    aria-label={`Пункт ${index + 1}`}
                    placeholder="Описание пункта..."
                    value={item.text}
                    onChange={(event) =>
                      updateStateItem(activeSpecSection as any, item.id, { text: event.target.value })}
                  />
                  {activeSpecSection === "decisions" || activeSpecSection === "rejectedOptions" ? (
                    <textarea
                      className="rationale-input"
                      aria-label={`Обоснование пункта ${index + 1}`}
                      placeholder="Почему принято такое решение?"
                      value={(item as any).rationale ?? ""}
                      onChange={(event) =>
                        updateStateItem(activeSpecSection as any, item.id, {
                          rationale: event.target.value,
                        })}
                    />
                  ) : null}
                  <div className="source-picker">
                    <select
                      aria-label={`Источник пункта ${index + 1}`}
                      value=""
                      onChange={(event) => {
                        const source = event.target.value;
                        if (source && !item.sourceTurnIds.includes(source)) {
                          updateStateItem(activeSpecSection as any, item.id, {
                            sourceTurnIds: [...item.sourceTurnIds, source],
                          });
                        }
                      }}
                    >
                      <option value="">Привязать к ответу…</option>
                      {current?.transcript
                        .filter((entry) => entry.role === "ASSISTANT")
                        .map((entry) => (
                          <option value={entry.id} key={entry.id}>
                            {entry.providerId ?? "модель"} · {entry.content.slice(0, 55)}
                          </option>
                        ))}
                    </select>
                    <div className="source-tags">
                      {item.sourceTurnIds.map((sourceId) => {
                        const source = current?.transcript.find((entry) => entry.id === sourceId);
                        return (
                          <button
                            key={sourceId}
                            title="Убрать источник"
                            onClick={() => updateStateItem(activeSpecSection as any, item.id, {
                              sourceTurnIds: item.sourceTurnIds.filter((id) => id !== sourceId),
                            })}
                          >
                            {source?.providerId ?? "источник"} ×
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </article>
              ))}
              <button
                className="add-state-item primary"
                style={{ width: "100%", marginTop: "10px" }}
                onClick={() => addStateItem(activeSpecSection as any)}
              >
                + Добавить пункт
              </button>
            </div>
            <footer>
              <button className="primary" onClick={() => setActiveSpecSection(null)}>Готово</button>
            </footer>
          </section>
        </div>
      ) : null}
      {newProjectModalOpen ? (
        <div className="modal-backdrop" onClick={() => setNewProjectModalOpen(false)}>
          <div className="custom-modal-card" onClick={(e) => e.stopPropagation()}>
            <header className="custom-modal-header">
              <h3>📁 Создание нового проекта</h3>
              <button className="close-modal-btn" onClick={() => setNewProjectModalOpen(false)}>×</button>
            </header>
            <div className="custom-modal-body">
              <label className="form-label">
                Название проекта (обязательно):
                <input
                  type="text"
                  value={newProjectNameInput}
                  onChange={(e) => setNewProjectNameInput(e.target.value)}
                  placeholder="Например: Мой Салон Красоты"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newProjectNameInput.trim()) {
                      e.preventDefault();
                      void window.orchestrator.projects.create(newProjectNameInput.trim(), creationProviders, newProjectDescriptionInput).then(async (project) => {
                        setNewProjectNameInput("");
                        setNewProjectDescriptionInput("");
                        setNewProjectModalOpen(false);
                        await refresh();
                        await openProject(project.id);
                      });
                    }
                  }}
                />
              </label>
              <label className="form-label">
                Описание проекта (необязательно):
                <input
                  type="text"
                  value={newProjectDescriptionInput}
                  onChange={(e) => setNewProjectDescriptionInput(e.target.value)}
                  placeholder="Короткая цель или специфика проекта"
                />
              </label>
              <div className="creation-providers-section">
                <label className="form-label">Модели ИИ в проекте:</label>
                <div className="creation-providers-grid">
                  {(["chatgpt", "gemini", "deepseek", "claude", "copilot", "perplexity", "groq", "mistral"] as const).map((prov) => (
                    <label key={prov} className={`provider-chip-label ${creationProviders.includes(prov) ? "active" : ""}`}>
                      <input
                        type="checkbox"
                        checked={creationProviders.includes(prov)}
                        onChange={() =>
                          setCreationProviders((currentList) =>
                            currentList.includes(prov)
                              ? currentList.filter((item) => item !== prov)
                              : [...currentList, prov],
                          )
                        }
                      /> {prov}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <footer className="custom-modal-footer">
              <button className="btn" onClick={() => setNewProjectModalOpen(false)}>Отмена</button>
              <button
                className="btn btn-primary"
                disabled={!newProjectNameInput.trim()}
                onClick={() => {
                  void window.orchestrator.projects.create(newProjectNameInput.trim(), creationProviders, newProjectDescriptionInput).then(async (project) => {
                    setNewProjectNameInput("");
                    setNewProjectDescriptionInput("");
                    setNewProjectModalOpen(false);
                    await refresh();
                    await openProject(project.id);
                  });
                }}
              >
                Создать проект
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {previewImageModalUrl ? (
        <div className="modal-backdrop" onClick={() => setPreviewImageModalUrl(null)}>
          <div className="image-preview-modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="close-modal-btn" onClick={() => setPreviewImageModalUrl(null)}>×</button>
            <img src={previewImageModalUrl} alt="Полноэкранный просмотр" className="full-preview-image" />
          </div>
        </div>
      ) : null}

      {webChatsDrawerOpen ? (
        <div className="modal-backdrop" onClick={() => setWebChatsDrawerOpen(false)}>
          <div className="web-chats-drawer-card" onClick={(e) => e.stopPropagation()}>
            <header className="custom-modal-header">
              <h3>🔗 Закреплённые Веб-Чаты Проекта</h3>
              <button className="close-modal-btn" onClick={() => setWebChatsDrawerOpen(false)}>×</button>
            </header>
            <div className="drawer-body">
              {current?.conversations && current.conversations.length > 0 ? (
                current.conversations.map((c) => (
                  <div key={c.providerId} className="drawer-chat-item">
                    <strong className="drawer-provider-title">{c.providerId.toUpperCase()}</strong>
                    {c.externalRef ? (
                      <a href={c.externalRef} target="_blank" rel="noreferrer noopener" className="btn btn-primary">
                        Открыть сессию в браузере ↗
                      </a>
                    ) : (
                      <span className="text-muted">Сессия создастся после первого хода</span>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-muted">Разговоры еще не начаты</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { RunSummaryBar } from "./components/RunSummaryBar.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { CliTaskPanel, type CliTaskView } from "./components/CliTaskPanel.js";
import { formatProviderList, getProviderDisplayName, getProviderMetadata } from "./provider-metadata.js";
import { selectReadyAnswerEntries } from "./ready-answer.js";
import { toUserFacingError, UserFacingError } from "./user-errors.js";
import { messageTextForClipboard } from "./message-copy.js";

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

type SpecIconId = StateSection;

function SpecIcon({ id }: { id: SpecIconId }) {
  const paths: Record<SpecIconId, React.ReactNode> = {
    requirements: <><path d="M9 5h6"/><path d="M9 9h6"/><path d="M9 13h4"/><path d="M5 3h14v18H5z"/></>,
    constraints: <><circle cx="12" cy="12" r="9"/><path d="m8 8 8 8"/></>,
    decisions: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
    rejectedOptions: <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></>,
    openQuestions: <><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.3 2.3 0 1 1 3.5 2c-.8.5-1.3 1-1.3 2"/><path d="M12 16h.01"/></>,
    acceptanceCriteria: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 3v3m9 6h-3m-6 6v3M6 12H3"/></>,
  };
  return <svg className="spec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[id]}</svg>;
}

function eventTitle(type: string): string {
  const titles: Record<string, string> = {
    TRANSCRIPT_ENTRY_RECORDED: "Сообщение сохранено",
    TRANSCRIPT_ENTRY_UPDATED: "Ответ обновлён",
    TURN_STATUS_CHANGED: "Статус хода изменён",
    CONVERSATION_CREATED: "Диалог создан",
    CONVERSATION_REF_UPDATED: "Диалог привязан",
    PROJECT_STATE_SAVED: "Спецификация сохранена",
  };
  return titles[type] ?? type.replaceAll("_", " ").toLocaleLowerCase("ru-RU");
}

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

export type AttachedFileItem = AttachmentRefView;

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MessageAttachments({ files, onPreview }: { files: AttachmentRefView[]; onPreview: (url: string) => void }): React.JSX.Element {
  return <div className="message-attachments">
    {files.map((file) => (
      <div className="message-attachment-card" key={file.id}>
        <button type="button" className="message-attachment-open" onClick={() => file.previewUrl ? onPreview(file.previewUrl) : void window.orchestrator.attachments.open(file.id)}>
          {file.previewUrl ? <img src={file.previewUrl} alt="" /> : <AttachmentIcon />}
          <span><strong>{file.fileName}</strong><small>{file.source !== "user" ? `Файл от ${file.source} · ` : ""}{file.mimeType} · {formatAttachmentSize(file.sizeBytes)} · {file.status}</small></span>
        </button>
        {file.source !== "user" && file.status === "READY" ? (
          <button type="button" className="message-attachment-save" onClick={() => void window.orchestrator.attachments.saveAs(file.id)}>Сохранить как…</button>
        ) : null}
      </div>
    ))}
  </div>;
}

function MessageCopyAction({ content, copied, onCopy }: { content: string; copied: boolean; onCopy: (content: string) => void }): React.JSX.Element {
  return <div className="message-actions">
    <button type="button" className="message-copy" onClick={() => onCopy(content)} aria-label="Копировать текст сообщения" title="Копировать текст сообщения">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
      <span>{copied ? "Скопировано" : "Копировать"}</span>
    </button>
  </div>;
}

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
  appearance: { theme: "dark", density: "comfortable", fontScale: 100, discussionView: "RIGHT_DRAWER" },
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
    case "BUSY":
      return { text: "Открывается вход…", type: "busy" };
    case "UNSUPPORTED":
      return { text: "Недоступен", type: "offline" };
    case "UNKNOWN":
      return { text: "Не проверено", type: "offline" };
    default:
      return { text: "Неизвестно", type: "offline" };
  }
}

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectSelectionMode, setProjectSelectionMode] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  const [showProjectTrash, setShowProjectTrash] = useState(false);
  const [trashSummaries, setTrashSummaries] = useState<Array<{ projectId: string; trashedAt: string; localFileCount: number }>>([]);
  const [current, setCurrent] = useState<ProjectDetails | null>(null);
  const selectedProjectRowRef = useRef<HTMLDivElement | null>(null);
  const restoredProjectSelectionRef = useRef(false);
  const [providerStatuses, setProviderStatuses] = useState<Record<string, { session: string; ready: boolean; checkedAt?: string; lastError?: string }>>({
    chatgpt: { session: "UNKNOWN", ready: false },
    gemini: { session: "UNKNOWN", ready: false },
    deepseek: { session: "UNSUPPORTED", ready: false },
  });
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<ComposerDraftView["mode"]>("DEBATE");
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
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [statusNotificationVisible, setStatusNotificationVisible] = useState(false);
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<AppSettingsView>(fallbackSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"profile" | "models" | "behavior" | "appearance" | "quality" | "diagnostics">("profile");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
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
  const [eventFilter, setEventFilter] = useState("ALL");
  const [eventLimit, setEventLimit] = useState(20);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFileItem[]>([]);
  const [draftMessageId, setDraftMessageId] = useState(
    () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  const [viewMode, setViewMode] = useState<"SYNTHESIZED" | "LIVE">("SYNTHESIZED");
  const [discussionOpen, setDiscussionOpen] = useState(false);
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
  const specificationButtonRef = useRef<HTMLButtonElement>(null);
  const specModalRef = useRef<HTMLElement>(null);
  const draftHydratedProjectRef = useRef<string | null>(null);
  const draftPersistenceSuspendedRef = useRef(false);
  const effectiveAppearanceTheme: "dark" | "light" = settings.appearance.theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : settings.appearance.theme;

  function closeSpecSection(): void {
    setActiveSpecSection(null);
    window.setTimeout(() => specificationButtonRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!activeSpecSection || !specModalRef.current) return;
    const modal = specModalRef.current;
    const focusable = () => [...modal.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSpecSection();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener("keydown", trapFocus);
    return () => modal.removeEventListener("keydown", trapFocus);
  }, [activeSpecSection]);

  function composerDraftPayload(projectId: string): Omit<ComposerDraftView, "updatedAt"> {
    return {
      projectId,
      text: task,
      messageId: draftMessageId,
      attachmentIds: attachedFiles.map((file) => file.id),
      mode,
      continuationPolicy,
      starter,
      providers,
      viewMode,
      finalizerMode,
      finalResponder,
      composerExpanded,
    };
  }

  async function addAttachmentRefs(refs: AttachmentRefView[]): Promise<void> {
    if (refs.length === 0) return;
    setAttachedFiles((previous) => {
      const byId = new Map(previous.map((item) => [item.id, item]));
      for (const ref of refs) byId.set(ref.id, ref);
      return [...byId.values()];
    });
    const rejected = refs.filter((ref) => ref.status === "QUARANTINED" || ref.status === "FAILED" || ref.status === "UNSUPPORTED");
    setStatus(rejected.length > 0
      ? `Есть вложения с ошибкой: ${rejected.map((item) => item.fileName).join(", ")}`
      : `Прикреплено файлов: ${refs.length}`);
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
      setAttachedFiles((previous) => previous.filter((item) => item.id !== attachmentId));
    } catch (error) {
      setStatus(`Не удалось удалить вложение: ${String(error)}`);
    }
  }

  async function retryFile(attachmentId: string) {
    try {
      const retried = await window.orchestrator.attachments.retryDraft(attachmentId);
      setAttachedFiles((previous) => previous.map((item) => item.id === attachmentId ? retried : item));
      setStatus(retried.status === "STAGED" ? "Вложение снова готово к отправке" : retried.error ?? retried.status);
    } catch (error) {
      setStatus(`Повторная проверка не удалась: ${String(error)}`);
    }
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!current) return;
    const items = Array.from(e.clipboardData.items || []);
    const fileItems = items.filter((item) => item.kind === "file");
    if (fileItems.length === 0) return;

    for (const item of fileItems) {
      const file = item.getAsFile();
      if (!file) continue;

      try {
        const ref = file.type.startsWith("image/")
          ? await window.orchestrator.attachments.stageClipboard(
              current.project.id,
              draftMessageId,
              new Uint8Array(await file.arrayBuffer()),
              file.type,
              file.name || undefined,
            )
          : await window.orchestrator.attachments.stageDroppedFile(current.project.id, draftMessageId, file);
        await addAttachmentRefs([ref]);
      } catch (err: any) {
        setStatus(file.type.startsWith("image/")
          ? `Ошибка вставки из буфера: ${err.message}`
          : `Буфер Windows не предоставил безопасный путь к документу. Используйте скрепку или перетащите файл.`);
      }
    }
  }

  async function confirmDeleteProject(deleteRemote: boolean): Promise<void> {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    setStatus(deleteRemote ? "Удаление проекта и чатов в веб-сервисах ИИ…" : "Удаление проекта из G+G…");
    try {
      const result = await window.orchestrator.projects.delete(deleteTarget.id, deleteRemote);
      if (current?.project.id === deleteTarget.id) {
        setCurrent(null);
      }
      setDeleteTarget(null);
      await refresh();
      const remoteFailures = result.remoteResults?.filter((item) => !item.deleted) ?? [];
      setStatus(remoteFailures.length > 0
        ? `Проект удалён локально. Приложение не увидело ${remoteFailures.length} веб-диалог(а); остальные доступные диалоги удалены.`
        : "Проект успешно удалён");
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

  const refresh = async (): Promise<void> => {
    const [nextProjects, nextTrash] = await Promise.all([
      window.orchestrator.projects.list(),
      window.orchestrator.projects.trashList(),
    ]);
    setProjects(nextProjects);
    setTrashSummaries(nextTrash);
  };
  useEffect(() => {
    void refresh();
    const timer = setTimeout(() => setShowSplash(false), 2500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    selectedProjectRowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current?.project.id]);
  useEffect(() => {
    if (restoredProjectSelectionRef.current || current || projects.length === 0) return;
    restoredProjectSelectionRef.current = true;
    const selectedId = window.localStorage.getItem("gplusg.selectedProjectId");
    if (selectedId && projects.some((project) => project.id === selectedId && project.status !== "ARCHIVED")) {
      void openProject(selectedId).catch(() => window.localStorage.removeItem("gplusg.selectedProjectId"));
    } else if (selectedId) {
      window.localStorage.removeItem("gplusg.selectedProjectId");
    }
  }, [projects, current]);
  useEffect(() => {
    let cancelled = false;

    const checkProviderStatus = async (provider: "chatgpt" | "gemini"): Promise<void> => {
      if (cancelled) return;
      setProviderStatuses((previous) => ({
        ...previous,
        [provider]: { session: "CHECKING", ready: false },
      }));
      try {
        const result = await window.orchestrator.provider.status(provider);
        if (cancelled) return;
        setProviderStatuses((previous) => ({
          ...previous,
          [provider]: { session: result.session, ready: result.ready, checkedAt: new Date().toISOString() },
        }));
      } catch (error) {
        if (cancelled) return;
        setProviderStatuses((previous) => ({
          ...previous,
          [provider]: { session: "UNKNOWN", ready: false, checkedAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) },
        }));
      }
    };

    void (async () => {
      await checkProviderStatus("chatgpt");
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      await checkProviderStatus("gemini");
    })();

    return () => {
      cancelled = true;
    };
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
    root.dataset.theme = effectiveAppearanceTheme;
    root.dataset.density = settings.appearance.density;
    root.style.fontSize = `${settings.appearance.fontScale}%`;
    void window.orchestrator.window.setTheme(effectiveAppearanceTheme).catch(() => undefined);
  }, [settings.appearance, effectiveAppearanceTheme]);
  useEffect(() => {
    if (status === "Готово") {
      setStatusNotificationVisible(false);
      return;
    }
    setStatusNotificationVisible(true);
    if (/ошиб|не удалось|failed|captcha|капч|недоступ/i.test(status)) return;
    const timer = window.setTimeout(() => setStatusNotificationVisible(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [status]);
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
  useEffect(() => {
    if (!previewImageModalUrl && !discussionOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (previewImageModalUrl) setPreviewImageModalUrl(null);
      else setDiscussionOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewImageModalUrl, discussionOpen]);
  useEffect(() => {
    const projectId = current?.project.id;
    if (!projectId || draftHydratedProjectRef.current !== projectId || draftPersistenceSuspendedRef.current) return;
    const timer = window.setTimeout(() => {
      void window.orchestrator.composerDraft.save(composerDraftPayload(projectId)).catch((error) => {
        setStatus(`Черновик не сохранён: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [current?.project.id, task, draftMessageId, attachedFiles, mode, continuationPolicy, starter, providers, viewMode, finalizerMode, finalResponder, composerExpanded]);
  useEffect(() => {
    const flushDraft = () => {
      const projectId = current?.project.id;
      if (!projectId || draftHydratedProjectRef.current !== projectId || draftPersistenceSuspendedRef.current) return;
      void window.orchestrator.composerDraft.save(composerDraftPayload(projectId));
    };
    window.addEventListener("beforeunload", flushDraft);
    return () => window.removeEventListener("beforeunload", flushDraft);
  }, [current?.project.id, task, draftMessageId, attachedFiles, mode, continuationPolicy, starter, providers, viewMode, finalizerMode, finalResponder, composerExpanded]);

  async function openProject(id: string): Promise<void> {
    draftHydratedProjectRef.current = null;
    const [details, tasks, savedDraft] = await Promise.all([
      window.orchestrator.projects.open(id),
      window.orchestrator.cliTasks.list(id),
      window.orchestrator.composerDraft.get(id),
    ]);
    const attachmentDraft = details.attachmentDraft;
    const attachmentOrder = new Map((savedDraft?.attachmentIds ?? []).map((attachmentId, index) => [attachmentId, index]));
    const restoredAttachments = [...(attachmentDraft?.attachments ?? [])].sort((left, right) =>
      (attachmentOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (attachmentOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    setCurrent(details);
    window.localStorage.setItem("gplusg.selectedProjectId", id);
    setCliTasks(tasks);
    setAttachedFiles(restoredAttachments);
    setDraftMessageId(savedDraft?.messageId ?? attachmentDraft?.messageId ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    setTask(savedDraft?.text ?? "");
    setMode(savedDraft?.mode ?? settings.defaults.mode);
    setContinuationPolicy(savedDraft?.continuationPolicy ?? "autonomous");
    setProviders(savedDraft?.providers.length ? savedDraft.providers : (details.project.providers?.length ? details.project.providers : settings.defaults.providers));
    setStarter(savedDraft?.starter ?? details.project.providers?.[0] ?? settings.defaults.providers[0] ?? "chatgpt");
    setViewMode(savedDraft?.viewMode ?? "SYNTHESIZED");
    setFinalizerMode(savedDraft?.finalizerMode ?? "MANUAL");
    setFinalResponder(savedDraft?.finalResponder ?? "auto");
    setComposerExpanded(savedDraft?.composerExpanded ?? false);
    const nextState = details.state?.state ?? structuredClone(initialState);
    setProjectState(nextState);
    setStateText(JSON.stringify(nextState, null, 2));
    draftHydratedProjectRef.current = id;
  }

  const [showNoProjectToast, setShowNoProjectToast] = useState(false);
  const [activeUserError, setActiveUserError] = useState<UserFacingError | null>(null);

  async function run(): Promise<void> {
    const submittedTask = task.trim() || (attachedFiles.length > 0 ? "Пожалуйста, проанализируй прикреплённые файлы." : "");
    if (!current) {
      setShowNoProjectToast(true);
      return;
    }
    if (!submittedTask || running || providers.length === 0 || attachedFiles.some((file) => file.status === "FAILED" || file.status === "QUARANTINED" || file.status === "UNSUPPORTED")) return;
    const projectId = current.project.id;
    try {
      await window.orchestrator.composerDraft.save(composerDraftPayload(projectId));
    } catch (error) {
      setStatus(`Не удалось безопасно сохранить черновик перед отправкой: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    draftPersistenceSuspendedRef.current = true;
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
      await window.orchestrator.composerDraft.clear(projectId);
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
      draftPersistenceSuspendedRef.current = false;
      await openProject(projectId);
    } finally {
      draftPersistenceSuspendedRef.current = false;
      setRunning(false);
      setStreaming({});
      setOptimisticUserTask(null);
    }
  }

  async function login(provider: string): Promise<void> {
    setStatus(`Войдите в ${getProviderDisplayName(provider)} в открывшемся окне…`);
    setProviderStatuses((previous) => ({
      ...previous,
      [provider]: { ...previous[provider], session: "BUSY", ready: false },
    }));
    try {
      const session = await window.orchestrator.provider.login(provider);
      setProviderStatuses((previous) => ({
        ...previous,
        [provider]: { session, ready: session === "AUTHENTICATED", checkedAt: new Date().toISOString() },
      }));
      setStatus(`Сессия ${getProviderDisplayName(provider)} активна: ${session}`);
    } catch (error: any) {
      const errorText = String(error?.message ?? error);
      const failedSession = /challenge|captcha|капч|traffic_blocked/i.test(errorText)
        ? "CHALLENGE_REQUIRED"
        : "UNKNOWN";
      setProviderStatuses((previous) => ({
        ...previous,
        [provider]: { session: failedSession, ready: false, checkedAt: new Date().toISOString(), lastError: errorText },
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

  async function openProviderWebChat(provider: string, conversationId?: string): Promise<void> {
    try {
      await window.orchestrator.provider.openWebChat(provider, conversationId);
      setStatus(`Веб-чат ${getProviderDisplayName(provider)} открыт`);
    } catch (error) {
      setStatus(`Не удалось открыть веб-чат: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function rebindProviderConversation(provider: string, conversationId: string): Promise<void> {
    if (!window.confirm(`Перепривязать диалог ${getProviderDisplayName(provider)}? Текущая локальная ссылка будет очищена, а новый веб-диалог определится при следующей отправке. Transcript проекта сохранится.`)) return;
    try {
      await window.orchestrator.provider.rebindConversation(provider, conversationId);
      if (current) await openProject(current.project.id);
      setStatus(`Диалог ${getProviderDisplayName(provider)} будет перепривязан при следующей отправке`);
    } catch (error) {
      setStatus(`Не удалось перепривязать диалог: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function copyMessage(id: string, content: string): Promise<void> {
    try {
      const copyText = messageTextForClipboard(content);
      if (!copyText) throw new Error("В сообщении нет пользовательского текста для копирования");
      await window.orchestrator.system.copyText(copyText);
      setCopiedMessageId(id);
      window.setTimeout(() => setCopiedMessageId((currentId) => currentId === id ? null : currentId), 1_800);
    } catch (error) {
      setStatus(`Не удалось скопировать сообщение: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function toggleProjectSelection(projectId: string): void {
    setSelectedProjectIds((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });
  }

  async function moveProjectsToTrash(projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) return;
    try {
      await window.orchestrator.projects.trash(projectIds);
      if (current && projectIds.includes(current.project.id)) setCurrent(null);
      setSelectedProjectIds(new Set());
      setProjectSelectionMode(false);
      await refresh();
      setStatus(`${projectIds.length} проект(а) перемещено в корзину. Веб-чаты не удалялись.`);
    } catch (error) {
      setStatus(`Не удалось переместить проекты в корзину: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function restoreProjects(projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) return;
    try {
      await window.orchestrator.projects.restore(projectIds);
      setSelectedProjectIds(new Set());
      await refresh();
      setStatus(`${projectIds.length} проект(а) восстановлено`);
    } catch (error) {
      setStatus(`Не удалось восстановить проекты: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function permanentlyDeleteProjects(projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) return;
    const localFileCount = trashSummaries.filter((item) => projectIds.includes(item.projectId)).reduce((sum, item) => sum + item.localFileCount, 0);
    if (!window.confirm(`Окончательно удалить ${projectIds.length} проект(а) и ${localFileCount} связанных локальных файл(а)? Это действие нельзя отменить. Внешние веб-чаты затронуты не будут.`)) return;
    try {
      await window.orchestrator.projects.deletePermanent(projectIds);
      setSelectedProjectIds(new Set());
      await refresh();
      setStatus(`${projectIds.length} проект(а) окончательно удалено`);
    } catch (error) {
      setStatus(`Не удалось окончательно удалить проекты: ${error instanceof Error ? error.message : String(error)}`);
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
  const visibleProjects = projects
    .filter((project) => (showProjectTrash ? project.status === "ARCHIVED" : project.status !== "ARCHIVED"))
    .filter((project) => project.name.toLocaleLowerCase("ru-RU").includes(projectSearch.trim().toLocaleLowerCase("ru-RU")))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const headerLogoSrc = effectiveAppearanceTheme === "light" ? logoLight : logoDark;
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
          <img className="header-logo" src={headerLogoSrc} alt="" aria-hidden="true" />
          <h1 className="header-title">G+G</h1>
        </div>
        <div className="header-actions">
          <span className={`status-summary ${running ? "busy" : ""}`} title={status}>
            <span className="status-summary-dot" />
            {running ? "Выполняется" : "Готово"}
          </span>
          <button
            ref={specificationButtonRef}
            className={`icon-header-btn specification-btn ${inspectorOpen ? "active" : ""}`}
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
      {statusNotificationVisible ? (
        <div className="app-notification" role="status" aria-live="polite">
          <span className="app-notification-text" title={status}>{status}</span>
          <button
            className="app-notification-close"
            type="button"
            aria-label="Закрыть уведомление"
            title="Закрыть уведомление"
            onClick={() => setStatusNotificationVisible(false)}
          >
            ×
          </button>
        </div>
      ) : null}
      <div className={`layout ${!sidebarOpen ? "collapsed-sidebar" : ""} ${inspectorOpen ? "has-inspector" : ""}`}>
        {sidebarOpen ? (
          <aside className="sidebar-pane">
            <div className="sidebar-header">
              <h2>{showProjectTrash ? "Корзина" : "Проекты"}</h2>
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
            <div className="projects-toolbar">
              <label className="project-search">
                <span className="sr-only">Поиск проектов</span>
                <input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Поиск проектов" />
                {projectSearch ? <button type="button" onClick={() => setProjectSearch("")} aria-label="Очистить поиск">×</button> : null}
              </label>
              <div className="project-list-actions">
                <button type="button" onClick={() => { setShowProjectTrash((value) => !value); setSelectedProjectIds(new Set()); }}>
                  {showProjectTrash ? "К проектам" : `Корзина${trashSummaries.length ? ` · ${trashSummaries.length}` : ""}`}
                </button>
                <button type="button" onClick={() => { setProjectSelectionMode((value) => !value); setSelectedProjectIds(new Set()); }}>
                  {projectSelectionMode ? "Отмена" : "Выбрать"}
                </button>
              </div>
              {projectSelectionMode ? <div className="project-batch-bar">
                <span>Выбрано: {selectedProjectIds.size}</span>
                <button type="button" onClick={() => setSelectedProjectIds(new Set(visibleProjects.map((project) => project.id)))}>Все видимые</button>
                <button type="button" onClick={() => setSelectedProjectIds(new Set())}>Снять</button>
                {showProjectTrash ? <>
                  <button type="button" disabled={!selectedProjectIds.size} onClick={() => void restoreProjects([...selectedProjectIds])}>Восстановить</button>
                  <button type="button" className="danger" disabled={!selectedProjectIds.size} onClick={() => void permanentlyDeleteProjects([...selectedProjectIds])}>Удалить</button>
                </> : <button type="button" disabled={!selectedProjectIds.size} onClick={() => void moveProjectsToTrash([...selectedProjectIds])}>В корзину</button>}
              </div> : null}
            </div>
            <nav className="projects-list-nav">
              {visibleProjects.map((project) => (
                <div
                  className={`project-row ${current?.project.id === project.id ? "selected" : ""}`}
                  key={project.id}
                  ref={current?.project.id === project.id ? selectedProjectRowRef : undefined}
                >
                  {projectSelectionMode ? <input className="project-select-checkbox" type="checkbox" checked={selectedProjectIds.has(project.id)} onChange={() => toggleProjectSelection(project.id)} aria-label={`Выбрать проект ${project.name}`} /> : null}
                  <button
                    className="project-btn"
                    aria-current={current?.project.id === project.id ? "page" : undefined}
                    onClick={() => projectSelectionMode ? toggleProjectSelection(project.id) : void openProject(project.id)}
                  >
                    <span className="project-name" title={project.name}>{project.name}</span>
                    <time className="project-updated" dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })}</time>
                  </button>
                  {!projectSelectionMode ? <button
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
                  </button> : null}
                  {projectMenuOpenId === project.id ? (
                    <div className="project-context-menu">
                      <button
                        onClick={() => {
                          setProjectMenuOpenId(null);
                          void (showProjectTrash ? restoreProjects([project.id]) : moveProjectsToTrash([project.id]));
                        }}
                      >
                        {showProjectTrash ? "Восстановить" : "В корзину"}
                      </button>
                      {showProjectTrash ? <button className="danger" onClick={() => { setProjectMenuOpenId(null); void permanentlyDeleteProjects([project.id]); }}>Удалить навсегда</button> : null}
                    </div>
                  ) : null}
                </div>
              ))}
              {visibleProjects.length === 0 ? <p className="projects-empty">{projectSearch ? "Ничего не найдено" : showProjectTrash ? "Корзина пуста" : "Нет проектов"}</p> : null}
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
                      onClick={() => { setSettingsTab("models"); setSelectedModelId(pId); setSettingsOpen(true); }}
                    />
                  );
                })}
              </div>
              <button type="button" className="add-model-btn" onClick={() => { setSettingsTab("models"); setSelectedModelId(null); setSettingsOpen(true); }}>+ Добавить модель</button>
            </div>

            <footer className="sidebar-footer">
              <div
                className="profile-chip interactive"
                onClick={() => { setSettingsTab("profile"); setSelectedModelId(null); setSettingsOpen(true); }}
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
                    {assistantTranscript.some((entry) => entry.id !== explicitFinalEntry?.id) ? (
                      <button type="button" className="open-discussion-btn" onClick={() => setDiscussionOpen(true)}>
                        Показать ход обсуждения · {assistantTranscript.filter((entry) => entry.id !== explicitFinalEntry?.id).length} ходов
                      </button>
                    ) : null}
                    {readyAnswerEntries.map((entry) => (
                      <section className={`message ${entry.role.toLowerCase()} ${entry.providerId ?? ""} ${entry.id === explicitFinalEntry?.id ? "final" : ""} ${entry.id.startsWith("entry_stopped_") ? "cancelled" : ""}`} key={entry.id}>
                        <header>
                          <strong>{entry.role === "USER" ? "Вы" : entry.providerId === "system" ? "Системный отчёт" : `Итоговый ответ (${entry.providerId})`}</strong>
                          {entry.round ? <small>ход {entry.round}</small> : null}
                        </header>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.content}</ReactMarkdown>
                        {entry.attachments?.length ? <MessageAttachments files={entry.attachments} onPreview={setPreviewImageModalUrl} /> : null}
                        <MessageCopyAction content={entry.content} copied={copiedMessageId === entry.id} onCopy={(content) => void copyMessage(entry.id, content)} />
                      </section>
                    ))}
                  </>
                ) : (
                  (current?.transcript || []).map((entry) => (
                    <section className={`message ${entry.role.toLowerCase()} ${entry.providerId ?? ""} ${entry.id.startsWith("entry_stopped_") ? "cancelled" : ""}`} key={entry.id}>
                      <header>
                        <strong>{entry.role === "USER" ? "Вы" : entry.providerId ?? entry.role}</strong>
                        {entry.round ? <small>ход {entry.round}</small> : null}
                      </header>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.content}</ReactMarkdown>
                      {entry.attachments?.length ? <MessageAttachments files={entry.attachments} onPreview={setPreviewImageModalUrl} /> : null}
                      <MessageCopyAction content={entry.content} copied={copiedMessageId === entry.id} onCopy={(content) => void copyMessage(entry.id, content)} />
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
                    <MessageCopyAction content={optimisticUserTask} copied={copiedMessageId === "optimistic-user-task"} onCopy={(content) => void copyMessage("optimistic-user-task", content)} />
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
                    <section className={`message assistant partial ${providerId}`} key={`streaming-${providerId}`}>
                      <header>
                        <strong>{providerId}</strong>
                        <small>печатает...</small>
                      </header>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>
                      <MessageCopyAction content={text} copied={copiedMessageId === `streaming-${providerId}`} onCopy={(content) => void copyMessage(`streaming-${providerId}`, content)} />
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
                    disabled={!current || (!task.trim() && attachedFiles.length === 0) || providers.length === 0 || attachedFiles.some((file) => file.status === "FAILED" || file.status === "QUARANTINED" || file.status === "UNSUPPORTED")}
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
                  f.previewUrl ? (
                    <span key={f.id} className="attachment-card attachment-image-card attachment-thumbnail" title={`${f.fileName} · ${f.mimeType} · ${formatAttachmentSize(f.sizeBytes)} · ${f.status}`}>
                      <button type="button" className="attachment-thumbnail-open" aria-label={`Открыть изображение ${f.fileName}`} onClick={() => setPreviewImageModalUrl(f.previewUrl!)}>
                        <img src={f.previewUrl} alt="" />
                      </button>
                      <button type="button" className="attachment-remove attachment-thumbnail-remove" aria-label={`Удалить вложение ${f.fileName}`} onClick={() => void removeFile(f.id)}>×</button>
                    </span>
                  ) : (
                    <span key={f.id} className="attachment-card attachment-document-card attached-file-tag document-attachment-card">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                        <polyline points="13 2 13 9 20 9" />
                      </svg>
                      <span className="attached-file-details">
                        <span className="attached-file-name">{f.fileName}</span>
                        <small>{f.fileName.includes(".") ? f.fileName.split(".").pop()?.toUpperCase() : f.mimeType} · {formatAttachmentSize(f.sizeBytes)} · {f.status}</small>
                        {f.error ? <small className="attachment-error">{f.error}</small> : null}
                      </span>
                      {f.status === "FAILED" ? <button aria-label={`Повторить вложение ${f.fileName}`} onClick={() => void retryFile(f.id)}>↻</button> : null}
                      <button type="button" className="attachment-remove" aria-label={`Удалить вложение ${f.fileName}`} onClick={() => void removeFile(f.id)}>×</button>
                    </span>
                  )
                ))}
              </div>
            ) : null}
          </div>
        </section>
        {inspectorOpen ? (
          <aside className="inspector">
          <header className="state-heading inspector-header">
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
          </header>
          <div className="inspector-content">
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
                    <SpecIcon id={section.key} />
                    <strong>{section.title}</strong>
                    <span className="spec-chip-badge">{count}</span>
                    <svg className="spec-chip-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
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
          <section className="events-section">
            <div className="events-heading">
              <h2>События</h2>
              <select aria-label="Фильтр событий" value={eventFilter} onChange={(event) => { setEventFilter(event.target.value); setEventLimit(20); }}>
                <option value="ALL">Все события</option>
                {[...new Set((current?.events ?? []).map((event) => event.eventType))].sort().map((type) => <option value={type} key={type}>{eventTitle(type)}</option>)}
              </select>
            </div>
            <ol className="timeline">
              {(current?.events ?? []).slice().reverse().filter((event) => eventFilter === "ALL" || event.eventType === eventFilter).slice(0, eventLimit).map((event) => (
                <li key={event.sequence}>
                  <details>
                    <summary><strong>{eventTitle(event.eventType)}</strong><time>{new Date(event.occurredAt).toLocaleString("ru-RU")}</time></summary>
                    <div className="event-details"><code>{event.eventType}</code><button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(event, null, 2)).then(() => setStatus("Технические данные события скопированы")).catch((error) => setStatus(`Не удалось скопировать событие: ${String(error)}`))}>Копировать данные</button><pre>{JSON.stringify(event, null, 2)}</pre></div>
                  </details>
                </li>
              ))}
            </ol>
            {(current?.events ?? []).filter((event) => eventFilter === "ALL" || event.eventType === eventFilter).length > eventLimit ? <button type="button" className="show-more-events" onClick={() => setEventLimit((value) => value + 20)}>Показать ещё</button> : null}
          </section>
          </div>
          <footer className="controls state-actions inspector-footer">
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
          </footer>
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
        refreshQuality={loadQualityDashboard}
        preflight={preflight}
        runPreflight={refreshDiagnostics}
        maintenanceBusy={maintenanceBusy}
        createBackup={createBackup}
        providerStatuses={providerStatuses}
        initialTab={settingsTab}
        initialModelId={selectedModelId}
        conversations={current?.conversations ?? []}
        openWebChat={openProviderWebChat}
        rebindConversation={rebindProviderConversation}
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
        <div className="modal-backdrop" role="presentation" onMouseDown={closeSpecSection}>
          <section ref={specModalRef} className="settings-modal spec-modal" role="dialog" aria-modal="true" aria-labelledby="spec-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2 id="spec-modal-title"><SpecIcon id={activeSpecSection as StateSection} />{stateSections.find((section) => section.key === activeSpecSection)?.title}</h2>
              <button aria-label="Закрыть раздел спецификации" onClick={closeSpecSection}>×</button>
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
              <button className="primary" onClick={closeSpecSection}>Готово</button>
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

      {assistantTranscript.some((entry) => entry.id !== explicitFinalEntry?.id) ? (
        <aside
          className={`discussion-view ${settings.appearance.discussionView === "FULLSCREEN" ? "fullscreen" : "right-drawer"} ${discussionOpen ? "open" : "closed"}`}
          aria-hidden={!discussionOpen}
          aria-label="Ход обсуждения моделей"
        >
          <header className="discussion-view-header">
            <div>
              <strong>Ход обсуждения моделей</strong>
              <small>{assistantTranscript.filter((entry) => entry.id !== explicitFinalEntry?.id).length} ходов</small>
            </div>
            <button type="button" className="close-modal-btn" aria-label="Вернуться к итоговому ответу" onClick={() => setDiscussionOpen(false)}>×</button>
          </header>
          <div className="discussion-view-scroll">
            {assistantTranscript.filter((entry) => entry.id !== explicitFinalEntry?.id).map((entry) => (
              <section className={`discussion-turn ${entry.providerId ?? ""}`} key={`discussion-${entry.id}`}>
                <header>
                  <strong>{entry.providerId ?? "ASSISTANT"}</strong>
                  <span>{entry.round ? `Ход ${entry.round}` : "Промежуточный ответ"}</span>
                  {entry.createdAt ? <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}
                </header>
                <div className="discussion-turn-content"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{entry.content}</ReactMarkdown></div>
              </section>
            ))}
          </div>
        </aside>
      ) : null}

      {previewImageModalUrl ? createPortal(
        <div className="modal-backdrop image-preview-backdrop" role="presentation" onClick={() => setPreviewImageModalUrl(null)}>
          <div className="image-preview-modal-card" role="dialog" aria-modal="true" aria-label="Просмотр изображения" onClick={(e) => e.stopPropagation()}>
            <button className="close-modal-btn" aria-label="Закрыть просмотр" onClick={() => setPreviewImageModalUrl(null)}>×</button>
            <img src={previewImageModalUrl} alt="Полноэкранный просмотр" className="full-preview-image" />
          </div>
        </div>,
        document.body,
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

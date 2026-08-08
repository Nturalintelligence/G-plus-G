import React, { useEffect, useRef, useState } from "react";
import { getProviderDisplayName, PROVIDER_METADATA_MAP } from "../provider-metadata.js";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, ProfileIcon, ProviderLogoIcon, RefreshIcon, SettingsIcon, TrashIcon } from "./Icon.js";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: any;
  onSave: (settings: any) => Promise<boolean>;
  onReset: () => Promise<any>;
  initialTab?: "profile" | "models" | "behavior" | "appearance" | "quality" | "diagnostics";
  login: (provider: string) => Promise<void>;
  resetSession: (provider: string) => Promise<void>;
  qualityDashboard: any;
  preflight: any[];
  runPreflight: () => void;
  maintenanceBusy: boolean;
  createBackup: () => Promise<void>;
  releaseInfo?: {
    appVersion: string;
    commit: string;
    nodeVersion: string;
    platform: string;
    dataPath: string;
  } | null;
  openDataFolder: () => Promise<void>;
  providerStatuses?: Record<string, { session: string; ready: boolean }>;
}

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  onReset,
  initialTab = "profile",
  login,
  resetSession,
  qualityDashboard,
  preflight,
  runPreflight,
  maintenanceBusy,
  createBackup,
  releaseInfo,
  openDataFolder,
  providerStatuses,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<
    "profile" | "models" | "behavior" | "appearance" | "quality" | "diagnostics"
  >("profile");
  const [modelFilter, setModelFilter] = useState<"all" | "supported" | "experimental">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(() => structuredClone(settings));
  const [saveBusy, setSaveBusy] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDraft(structuredClone(settings));
    setActiveTab(initialTab);
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, initialTab, settings]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="settings-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        {/* Row 1: Header */}
        <header className="settings-dialog-header">
          <div>
            <h1 id="settings-dialog-title">Профиль и настройки workspace</h1>
            <p className="settings-dialog-subtitle">
              Конфигурация хранится локально в оркстраторе. Пароли и токены сессий не передаются на внешние сервера.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-header-btn close-btn"
            aria-label="Закрыть настройки"
            onClick={onClose}
          >
            <CloseIcon size={18} />
          </button>
        </header>

        {/* Row 2: Body Grid */}
        <div className="settings-dialog-body">
          <aside className="settings-nav">
            {[
              { id: "profile", label: "Профиль" },
              { id: "models", label: "Модели и авторизация" },
              { id: "behavior", label: "Обсуждение и лимиты" },
              { id: "appearance", label: "Внешний вид" },
              { id: "quality", label: "Центр качества" },
              { id: "diagnostics", label: "Диагностика и данные" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav-btn ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id as any)}
              >
                <span>{tab.label}</span>
              </button>
            ))}
          </aside>

          <main className="settings-content">
            {/* Tab 1: Profile */}
            {activeTab === "profile" && (
              <section className="settings-section">
                <h2>Персональный профиль</h2>
                <p className="section-description">Укажите имя для обращения в чатах и на сплеш-экране.</p>
                <div className="form-grid">
                  <label className="form-field">
                    <span className="field-label">Отображаемый никнейм</span>
                    <input
                      type="text"
                      maxLength={80}
                      value={draft.profile.displayName}
                      onChange={(e) =>
                        setDraft((prev: any) => ({
                          ...prev,
                          profile: { ...prev.profile, displayName: e.target.value },
                        }))
                      }
                      placeholder="Например: Алекс"
                    />
                  </label>
                  <label className="form-field">
                    <span className="field-label">Настоящее имя (необязательно)</span>
                    <input
                      type="text"
                      maxLength={80}
                      value={draft.profile.realName ?? ""}
                      onChange={(e) =>
                        setDraft((prev: any) => ({
                          ...prev,
                          profile: { ...prev.profile, realName: e.target.value },
                        }))
                      }
                      placeholder="Имя и Фамилия"
                    />
                  </label>
                </div>
              </section>
            )}

            {/* Tab 2: Models & Auth */}
            {activeTab === "models" && (
              <section className="settings-section">
                <h2>Модели ИИ и управление сессиями</h2>
                <p className="section-description">
                  Авторизуйтесь в браузерных сессиях ИИ-провайдеров и настройте персональные роли.
                </p>

                {/* Filter Toolbar */}
                <div className="models-filter-toolbar">
                  <input
                    type="search"
                    className="models-search-input"
                    placeholder="Поиск моделей..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <div className="filter-chips-group">
                    <button
                      type="button"
                      className={`filter-chip ${modelFilter === "all" ? "active" : ""}`}
                      onClick={() => setModelFilter("all")}
                    >Все</button>
                    <button
                      type="button"
                      className={`filter-chip ${modelFilter === "supported" ? "active" : ""}`}
                      onClick={() => setModelFilter("supported")}
                    >Поддерживаемые</button>
                    <button
                      type="button"
                      className={`filter-chip ${modelFilter === "experimental" ? "active" : ""}`}
                      onClick={() => setModelFilter("experimental")}
                    >Экспериментальные</button>
                  </div>
                </div>

                <div className="models-settings-list">
                  {Object.keys(PROVIDER_METADATA_MAP)
                    .filter((pId) => {
                      const meta = PROVIDER_METADATA_MAP[pId];
                      if (modelFilter === "supported" && !meta.isSupported) return false;
                      if (modelFilter === "experimental" && meta.isSupported) return false;
                      if (searchQuery.trim()) {
                        const q = searchQuery.toLowerCase();
                        return meta.displayName.toLowerCase().includes(q) || pId.includes(q);
                      }
                      return true;
                    })
                    .map((pId) => {
                      const meta = PROVIDER_METADATA_MAP[pId];
                      const currentCustom = draft.models?.[pId] || { role: "Автоматически", customPrompt: "" };
                      const isExpanded = expandedModelId === pId;

                      return (
                        <div key={pId} className={`model-setting-card accordion-card ${isExpanded ? "expanded" : ""}`}>
                          <header
                            className="model-card-header accordion-header"
                            onClick={() => setExpandedModelId(isExpanded ? null : pId)}
                          >
                            <div className="model-identity">
                              <ProviderLogoIcon providerId={pId} size={22} />
                              <strong className="model-name-text">{meta.displayName}</strong>
                              <span
                                className={`status-badge ${
                                  providerStatuses?.[pId]?.session === "AUTHENTICATED"
                                    ? "supported"
                                    : providerStatuses?.[pId]?.session === "CHALLENGE_REQUIRED"
                                    ? "warning"
                                    : "experimental"
                                }`}
                              >
                                {providerStatuses?.[pId]?.session === "AUTHENTICATED"
                                  ? "Авторизован"
                                  : providerStatuses?.[pId]?.session === "CHALLENGE_REQUIRED"
                                  ? "Проверка капчи"
                                  : meta.isSupported
                                  ? "Требуется вход"
                                  : "Эксперимент"}
                              </span>
                            </div>
                            <div className="model-actions" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm login-btn"
                                disabled={!meta.isSupported}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void login(pId);
                                }}
                              >
                                <span>{meta.isSupported ? "Войти в аккаунт" : "Адаптер не настроен"}</span>
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger-subtle btn-sm"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void resetSession(pId);
                                }}
                                title="Очистить профиль браузера"
                              >
                                <span>Сбросить</span>
                              </button>
                              <button
                                type="button"
                                className="accordion-toggle-btn"
                                onClick={() => setExpandedModelId(isExpanded ? null : pId)}
                                aria-label={isExpanded ? "Свернуть" : "Развернуть"}
                              >
                                {isExpanded ? <ChevronUpIcon size={18} /> : <ChevronDownIcon size={18} />}
                              </button>
                            </div>
                          </header>

                          {isExpanded && (
                            <div className="model-card-body accordion-body">
                              <label className="form-field">
                                <span className="field-label">Назначенная роль</span>
                                <select
                                  value={currentCustom.role}
                                  onChange={(e) => {
                                    const role = e.target.value;
                                    setDraft((val: any) => ({
                                      ...val,
                                      models: {
                                        ...val.models,
                                        [pId]: { ...(val.models?.[pId] || { customPrompt: "" }), role },
                                      },
                                    }));
                                  }}
                                >
                                  <option value="Автоматически">Автоматическая (по умолчанию)</option>
                                  <option value="Архитектор / Планнер">Архитектор / Планнер</option>
                                  <option value="Исполнитель / Кодер">Исполнитель / Кодер</option>
                                  <option value="Критик / Валидатор">Критик / Валидатор</option>
                                </select>
                              </label>
                              <label className="form-field">
                                <span className="field-label">Персональная инструкция (системный промпт)</span>
                                <textarea
                                  placeholder="Дополнительные указания для этой модели..."
                                  value={currentCustom.customPrompt}
                                  onChange={(e) => {
                                    const customPrompt = e.target.value;
                                    setDraft((val: any) => ({
                                      ...val,
                                      models: {
                                        ...val.models,
                                        [pId]: { ...(val.models?.[pId] || { role: "Автоматически" }), customPrompt },
                                      },
                                    }));
                                  }}
                                />
                              </label>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </section>
            )}


            {/* Tab 3: Behavior & Limits */}
            {activeTab === "behavior" && (
              <section className="settings-section">
                <h2>Параметры оркестрации и лимиты</h2>
                <div className="form-grid">
                  <label className="form-field">
                    <span className="field-label">Максимум ходов на раунд</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={draft.defaults.limits.maxTurns}
                      onChange={(e) =>
                        setDraft((val: any) => ({
                          ...val,
                          defaults: {
                            ...val.defaults,
                            limits: { ...val.defaults.limits, maxTurns: parseInt(e.target.value, 10) || 1 },
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span className="field-label">Максимум повторов (Retry)</span>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={draft.defaults.limits.maxRetries}
                      onChange={(e) =>
                        setDraft((val: any) => ({
                          ...val,
                          defaults: {
                            ...val.defaults,
                            limits: { ...val.defaults.limits, maxRetries: parseInt(e.target.value, 10) || 0 },
                          },
                        }))
                      }
                    />
                  </label>
                </div>
              </section>
            )}

            {/* Tab 4: Appearance */}
            {activeTab === "appearance" && (
              <section className="settings-section">
                <h2>Внешний вид и тема оформления</h2>
                <label className="form-field">
                  <span className="field-label">Цветовая тема</span>
                  <select
                    value={draft.appearance.theme}
                    onChange={(e) =>
                      setDraft((val: any) => ({
                        ...val,
                        appearance: { ...val.appearance, theme: e.target.value },
                      }))
                    }
                  >
                    <option value="dark">Тёмная тема (Big-Tech Dark)</option>
                    <option value="light">Светлая тема (Big-Tech Light)</option>
                  </select>
                </label>
              </section>
            )}

            {/* Tab 5: Quality */}
            {activeTab === "quality" && (
              <section className="settings-section">
                <h2>Центр качества ИИ-провайдеров</h2>
                <p className="section-description">Статистика выполнения ходов и успешности браузерных сессий.</p>
                {qualityDashboard ? (
                  <div className="quality-summary-grid">
                    <div className="kpi-card">
                      <span className="kpi-label">Всего запусков</span>
                      <strong className="kpi-value">{
                        qualityDashboard.overall?.find((metric: any) => metric.name === "orchestration.run.success")?.count
                          ?? qualityDashboard.totalSamples
                          ?? 0
                      }</strong>
                    </div>
                    <div className="kpi-card">
                      <span className="kpi-label">Успешные раунды</span>
                      <strong className="kpi-value text-success">{(() => {
                        const metric = qualityDashboard.overall?.find((item: any) => item.name === "orchestration.run.success");
                        return metric ? Math.round(metric.count * metric.average) : 0;
                      })()}</strong>
                    </div>
                    <div className="kpi-card">
                      <span className="kpi-label">Средняя длительность</span>
                      <strong className="kpi-value">{(() => {
                        const metric = qualityDashboard.overall?.find((item: any) => item.name === "orchestration.run.elapsed_ms");
                        return metric ? `${(metric.average / 1000).toFixed(1)} сек` : "—";
                      })()}</strong>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted">Данные центров качества загружаются…</p>
                )}
              </section>
            )}

            {/* Tab 6: Diagnostics */}
            {activeTab === "diagnostics" && (
              <section className="settings-section">
                <h2>Диагностика и резервное копирование</h2>
                <div className="actions-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={maintenanceBusy}
                    onClick={() => runPreflight()}
                  >
                    <RefreshIcon size={16} />
                    <span>Запустить Preflight-проверку</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={maintenanceBusy}
                    onClick={() => void createBackup()}
                  >
                    <span>Создать резервную копию (Backup)</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void openDataFolder()}
                  >
                    <span>Открыть папку данных</span>
                  </button>
                </div>

                {releaseInfo ? (
                  <dl className="release-info-list">
                    <div><dt>Версия</dt><dd>{releaseInfo.appVersion}</dd></div>
                    <div><dt>Commit</dt><dd><code>{releaseInfo.commit}</code></dd></div>
                    <div><dt>Node</dt><dd>{releaseInfo.nodeVersion}</dd></div>
                    <div><dt>Платформа</dt><dd>{releaseInfo.platform}</dd></div>
                    <div><dt>Папка данных</dt><dd><code>{releaseInfo.dataPath}</code></dd></div>
                  </dl>
                ) : null}

                {preflight.length > 0 && (
                  <div className="preflight-results">
                    <h3>Результаты диагностики:</h3>
                    <ul>
                      {preflight.map((item, index) => (
                        <li key={index} className={`preflight-item ${item.status}`}>
                          <strong>{item.name}:</strong> <span>{item.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}
          </main>
        </div>

        {/* Row 3: Footer */}
        <footer className="settings-dialog-footer">
          <button
            type="button"
            className="btn btn-danger-subtle"
            disabled={saveBusy}
            onClick={() => {
              if (window.confirm("Сбросить все настройки до заводских значений по умолчанию?")) {
                setSaveBusy(true);
                void onReset()
                  .then((value) => setDraft(structuredClone(value)))
                  .finally(() => setSaveBusy(false));
              }
            }}
          >
            <span>Сбросить настройки</span>
          </button>

          <div className="footer-actions">
            <button type="button" className="btn btn-secondary" disabled={saveBusy} onClick={onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saveBusy}
              onClick={() => {
                setSaveBusy(true);
                void onSave(draft)
                  .then((saved) => {
                    if (saved) onClose();
                  })
                  .finally(() => setSaveBusy(false));
              }}
            >
              Сохранить изменения
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

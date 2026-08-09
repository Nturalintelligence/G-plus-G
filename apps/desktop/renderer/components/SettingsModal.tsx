import React, { useState } from "react";
import { getProviderDisplayName, PROVIDER_METADATA_MAP } from "../provider-metadata.js";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, ProfileIcon, ProviderLogoIcon, RefreshIcon, SettingsIcon, TrashIcon } from "./Icon.js";
import { QualityCenterView } from "./QualityCenterView.js";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: any;
  setSettings: React.Dispatch<React.SetStateAction<any>>;
  onSave: () => void;
  login: (provider: string) => Promise<void>;
  resetSession: (provider: string) => Promise<void>;
  qualityDashboard: any;
  refreshQuality: () => Promise<void>;
  preflight: any[];
  runPreflight: () => void;
  maintenanceBusy: boolean;
  createBackup: () => Promise<void>;
  providerStatuses?: Record<string, { session: string; ready: boolean }>;
}

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  setSettings,
  onSave,
  login,
  resetSession,
  qualityDashboard,
  refreshQuality,
  preflight,
  runPreflight,
  maintenanceBusy,
  createBackup,
  providerStatuses,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<
    "profile" | "models" | "behavior" | "appearance" | "quality" | "diagnostics"
  >("profile");
  const [modelFilter, setModelFilter] = useState<"all" | "supported" | "experimental">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="settings-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
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
                      value={settings.profile.displayName}
                      onChange={(e) =>
                        setSettings((prev: any) => ({
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
                      value={settings.profile.realName ?? ""}
                      onChange={(e) =>
                        setSettings((prev: any) => ({
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
                      const currentCustom = settings.models?.[pId] || { role: "Автоматически", customPrompt: "" };
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
                                    setSettings((val: any) => ({
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
                                    setSettings((val: any) => ({
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
                      value={settings.defaults.limits.maxTurns}
                      onChange={(e) =>
                        setSettings((val: any) => ({
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
                      value={settings.defaults.limits.maxRetriesPerTurn}
                      onChange={(e) =>
                        setSettings((val: any) => ({
                          ...val,
                          defaults: {
                            ...val.defaults,
                            limits: { ...val.defaults.limits, maxRetriesPerTurn: parseInt(e.target.value, 10) || 0 },
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
                <label className="form-field appearance-theme-field">
                  <span className="field-label">Цветовая тема</span>
                  <select
                    value={settings.appearance.theme}
                    onChange={(e) =>
                      setSettings((val: any) => ({
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
                <QualityCenterView
                  dashboardData={qualityDashboard}
                  onRefresh={() => void refreshQuality()}
                />
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
                </div>

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
            onClick={() => {
              if (window.confirm("Сбросить все настройки до заводских значений по умолчанию?")) {
                // Reset settings action
              }
            }}
          >
            <span>Сбросить настройки</span>
          </button>

          <div className="footer-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onSave();
                onClose();
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

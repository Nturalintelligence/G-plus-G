import React from "react";
import { formatProviderList, getProviderDisplayName, getProviderMetadata } from "../provider-metadata.js";
import { ChevronDownIcon, ChevronUpIcon, LayersIcon, ProviderLogoIcon, TargetIcon } from "./Icon.js";

export interface RunSummaryBarProps {
  viewMode: "SYNTHESIZED" | "LIVE";
  setViewMode: (mode: "SYNTHESIZED" | "LIVE") => void;
  mode: string;
  setMode: (mode: string) => void;
  finalizerMode: "MANUAL" | "LEAD_SELECTS" | "PEER_AGREEMENT";
  setFinalizerMode: (mode: "MANUAL" | "LEAD_SELECTS" | "PEER_AGREEMENT") => void;
  finalResponder: string;
  setFinalResponder: (responder: string) => void;
  providers: string[];
  setProviders: React.Dispatch<React.SetStateAction<string[]>>;
  availableProviders?: string[];
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}

export function RunSummaryBar({
  viewMode,
  setViewMode,
  mode,
  setMode,
  finalizerMode,
  setFinalizerMode,
  finalResponder,
  setFinalResponder,
  providers,
  setProviders,
  availableProviders = ["chatgpt", "gemini", "deepseek"],
  expanded,
  setExpanded,
}: RunSummaryBarProps) {
  // Human-readable labels for collapsed state
  const viewModeLabel = viewMode === "SYNTHESIZED" ? "Готовый ответ" : "Живой диалог";

  const modeLabelMap: Record<string, string> = {
    MANUAL: "Один ответ",
    SEQUENTIAL: "По очереди",
    PARALLEL: "Параллельно",
    DEBATE: "До согласия",
  };
  const modeLabel = modeLabelMap[mode] || mode;

  let finalizerLabel = "";
  if (finalizerMode === "LEAD_SELECTS") {
    finalizerLabel = "Итог: выберет главный ИИ";
  } else if (finalizerMode === "PEER_AGREEMENT") {
    finalizerLabel = "Итог: модели договорятся";
  } else {
    const responderName = finalResponder === "auto" ? "Автоматически" : getProviderDisplayName(finalResponder);
    finalizerLabel = `Итог: ${responderName}`;
  }

  const participantsLabel = `Участники: ${formatProviderList(providers)}`;

  return (
    <div className={`run-summary-container ${expanded ? "expanded" : "collapsed"}`}>
      <button
        type="button"
        className="run-summary-bar-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label="Параметры запуска оркестратора"
      >
        <div className="run-summary-chips">
          <span className="summary-chip highlight-chip">
            <TargetIcon size={14} />
            <span>{viewModeLabel}</span>
          </span>
          <span className="summary-chip">
            <LayersIcon size={14} />
            <span>{modeLabel}</span>
          </span>
          <span className="summary-chip">
            <span>{finalizerLabel}</span>
          </span>
          <span className="summary-chip provider-highlight-chip">
            <span>{participantsLabel}</span>
          </span>
        </div>

        <div className="summary-chevron-wrapper">
          <span className="summary-action-hint">{expanded ? "Свернуть" : "Настроить"}</span>
          {expanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
        </div>
      </button>

      {expanded && (
        <div className="run-config-panel">
          {/* Group 1: Результат */}
          <div className="config-group">
            <label className="config-group-title">Результат</label>
            <div className="segmented-control">
              <button
                type="button"
                className={`segment-btn ${viewMode === "SYNTHESIZED" ? "active" : ""}`}
                onClick={() => setViewMode("SYNTHESIZED")}
              >
                <TargetIcon size={14} />
                <span>Готовый ответ</span>
              </button>
              <button
                type="button"
                className={`segment-btn ${viewMode === "LIVE" ? "active" : ""}`}
                onClick={() => setViewMode("LIVE")}
              >
                <span>Живой диалог</span>
              </button>
            </div>
          </div>

          {/* Group 2: Как обсуждать */}
          <div className="config-group">
            <label className="config-group-title">Как обсуждать</label>
            <div className="pills-row">
              {[
                { id: "MANUAL", label: "Один ответ" },
                { id: "SEQUENTIAL", label: "По очереди" },
                { id: "DEBATE", label: "До согласия" },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`pill-btn ${mode === m.id ? "active" : ""}`}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Group 3: Кто подготовит итог */}
          <div className="config-group">
            <label className="config-group-title">Кто подготовит итог</label>
            <div className="pills-row">
              {[
                { id: "MANUAL", label: "Выбрать вручную" },
                { id: "LEAD_SELECTS", label: "Выберет главный ИИ" },
                { id: "PEER_AGREEMENT", label: "Модели договорятся" },
              ].map((fm) => (
                <button
                  key={fm.id}
                  type="button"
                  className={`pill-btn ${finalizerMode === fm.id ? "active" : ""}`}
                  onClick={() => setFinalizerMode(fm.id as any)}
                >
                  {fm.label}
                </button>
              ))}
            </div>

            {finalizerMode === "MANUAL" && (
              <div className="manual-model-picker">
                <label className="sub-label">Выберите конкретную модель-финализатора:</label>
                <div className="pills-row">
                  <button
                    type="button"
                    className={`pill-btn model-pill ${finalResponder === "auto" ? "active" : ""}`}
                    onClick={() => setFinalResponder("auto")}
                  >
                    <span>Автоматически</span>
                  </button>
                  {providers.map((pId) => {
                    const meta = getProviderMetadata(pId);
                    return (
                      <button
                        key={pId}
                        type="button"
                        className={`pill-btn model-pill ${finalResponder === pId ? "active" : ""}`}
                        onClick={() => setFinalResponder(pId)}
                      >
                        <ProviderLogoIcon providerId={pId} size={14} />
                        <span>{meta.displayName}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Group 4: Участники */}
          <div className="config-group">
            <label className="config-group-title">Участники</label>
            <div className="participants-grid">
              {availableProviders.map((pId) => {
                const meta = getProviderMetadata(pId);
                const isSelected = providers.includes(pId);
                return (
                  <label
                    key={pId}
                    className={`participant-card ${isSelected ? "selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() =>
                        setProviders((current) => {
                          const next = current.includes(pId)
                            ? current.filter((id) => id !== pId)
                            : [...current, pId];
                          if (next.length < 2 && (mode === "DEBATE" || mode === "SEQUENTIAL")) {
                            setMode("MANUAL");
                          }
                          return next;
                        })
                      }
                    />
                    <ProviderLogoIcon providerId={pId} size={16} />
                    <span className="participant-name">{meta.displayName}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useState } from "react";
import { getProviderDisplayName } from "../provider-metadata.js";
import { formatDuration } from "../utils/formatters.js";
import { ActivityIcon, ChevronDownIcon, ChevronUpIcon, ProviderLogoIcon, RefreshIcon } from "./Icon.js";

export interface QualityCenterViewProps {
  dashboardData: any;
  onRefresh?: () => void;
  isLoading?: boolean;
}

export function QualityCenterView({
  dashboardData,
  onRefresh,
  isLoading = false,
}: QualityCenterViewProps) {
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});

  const toggleExpand = (providerId: string) => {
    setExpandedModels((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  };

  if (isLoading) {
    return (
      <div className="quality-center-empty">
        <ActivityIcon size={24} className="pulse-icon" />
        <p>Загрузка статистики качества провайдеров…</p>
      </div>
    );
  }

  if (!dashboardData || !dashboardData.providers || Object.keys(dashboardData.providers).length === 0) {
    return (
      <div className="quality-center-empty">
        <ActivityIcon size={24} />
        <p>Нет зарегистрированных измерений качества.</p>
        {onRefresh && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>
            <RefreshIcon size={14} />
            <span>Обновить данные</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="quality-center-container">
      <header className="quality-center-header">
        <div className="title-block">
          <h3>Метрики качества провайдеров</h3>
          <p className="subtitle">Агрегированные данные скорости ответа, ошибок и повторов.</p>
        </div>
        {onRefresh && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>
            <RefreshIcon size={14} />
            <span>Обновить</span>
          </button>
        )}
      </header>

      <div className="quality-models-grid">
        {Object.entries(dashboardData.providers).map(([pId, stats]: [string, any]) => {
          const displayName = getProviderDisplayName(pId);
          const isExpanded = !!expandedModels[pId];
          const successRate = stats.successRate != null ? `${Math.round(stats.successRate * 100)}%` : "100%";

          return (
            <div key={pId} className="quality-model-card">
              <header className="card-top">
                <div className="provider-name-row">
                  <ProviderLogoIcon providerId={pId} size={20} />
                  <strong>{displayName}</strong>
                </div>
                <div className="success-badge">
                  <span>Успешность: </span>
                  <strong>{successRate}</strong>
                </div>
              </header>

              <div className="kpi-three-grid">
                <div className="kpi-cell">
                  <span className="kpi-label">Ходов</span>
                  <span className="kpi-value">{stats.totalTurns || 0}</span>
                </div>
                <div className="kpi-cell">
                  <span className="kpi-label">Средний ответ</span>
                  <span className="kpi-value">{formatDuration(stats.avgDurationMs || 0)}</span>
                </div>
                <div className="kpi-cell">
                  <span className="kpi-label">Повторы</span>
                  <span className="kpi-value">{stats.retryCount || 0}</span>
                </div>
              </div>

              <button
                type="button"
                className="details-toggle-btn"
                onClick={() => toggleExpand(pId)}
                aria-expanded={isExpanded}
              >
                <span>Подробная статистика</span>
                {isExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
              </button>

              {isExpanded && (
                <div className="details-panel">
                  <div className="detail-row">
                    <span>Измерений:</span>
                    <strong>{stats.sampleCount || stats.totalTurns || 0}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Медиана (P50):</span>
                    <strong>{formatDuration(stats.p50Ms || stats.avgDurationMs || 0)}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Перцентиль (P95):</span>
                    <strong>{formatDuration(stats.p95Ms || (stats.avgDurationMs || 0) * 1.5)}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Минимум / Максимум:</span>
                    <strong>
                      {formatDuration(stats.minMs || 0)} / {formatDuration(stats.maxMs || 0)}
                    </strong>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

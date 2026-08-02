import React, { useState } from "react";
import { AlertCircleIcon, CloseIcon, InfoIcon } from "./Icon.js";
import { UserFacingError } from "../user-errors.js";

export interface ErrorModalProps {
  error: UserFacingError | null;
  onClose: () => void;
}

export function ErrorModal({ error, onClose }: ErrorModalProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!error) return null;

  const handleCopy = () => {
    const details = `[${error.code}] ${error.title}\n${error.message}\n${error.rawStack ?? ""}`;
    void navigator.clipboard.writeText(details);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenLogs = () => {
    void window.orchestrator?.system?.openDataFolder?.();
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-modal error-dialog-card"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        aria-labelledby="error-modal-title"
      >
        <header className="delete-dialog-header">
          <div className="title-row">
            <AlertCircleIcon size={22} className="danger-icon" />
            <h2 id="error-modal-title">{error.title}</h2>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Закрыть">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="delete-dialog-body">
          <p className="error-message-text">{error.message}</p>

          {error.actions && error.actions.length > 0 && (
            <div className="error-actions-row">
              {error.actions.map((act, index) => (
                <button
                  key={index}
                  type="button"
                  className={`btn btn-${act.variant ?? "secondary"}`}
                  onClick={act.onClick}
                >
                  {act.label}
                </button>
              ))}
            </div>
          )}

          <div className="error-details-toggle">
            <button
              type="button"
              className="btn-link"
              onClick={() => setDetailsOpen((prev) => !prev)}
            >
              <InfoIcon size={16} />
              <span>{detailsOpen ? "Скрыть подробности" : "Подробнее"}</span>
            </button>
          </div>

          {detailsOpen && (
            <div className="error-details-pane">
              <div className="details-meta-row">
                <span>Код: <code>{error.code}</code></span>
              </div>
              {error.rawStack && (
                <pre className="error-stack-trace">{error.rawStack}</pre>
              )}
              <div className="details-btn-row">
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopy}>
                  {copied ? "Скопировано!" : "Скопировать сведения"}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleOpenLogs}>
                  Открыть папку с логами
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="settings-dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Закрыть
          </button>
        </footer>
      </section>
    </div>
  );
}

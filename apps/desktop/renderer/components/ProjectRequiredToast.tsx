import React from "react";
import { AlertCircleIcon, CloseIcon } from "./Icon.js";

export interface ProjectRequiredToastProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectProject: () => void;
}

export function ProjectRequiredToast({ isOpen, onClose, onSelectProject }: ProjectRequiredToastProps) {
  if (!isOpen) return null;

  return (
    <div
      aria-live="polite"
      className="project-required-toast"
      role="alert"
    >
      <div className="toast-icon-wrap">
        <AlertCircleIcon size={20} className="toast-warning-icon" />
      </div>
      <div className="toast-body">
        <strong>Сначала выберите проект</strong>
        <p>Запросы и история сохраняются внутри проекта. Выберите существующий проект в боковой панели или создайте новый.</p>
      </div>
      <div className="toast-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            onSelectProject();
            onClose();
          }}
        >
          Выбрать проект
        </button>
        <button
          type="button"
          className="toast-close-btn"
          onClick={onClose}
          aria-label="Закрыть уведомление"
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </div>
  );
}

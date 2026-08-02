import React, { useState } from "react";
import { AlertCircleIcon, CloseIcon, TrashIcon } from "./Icon.js";

export interface DeleteProjectDialogProps {
  isOpen: boolean;
  project: { id: string; name: string } | null;
  onClose: () => void;
  onConfirmDelete: (deleteRemote: boolean) => Promise<void>;
  isDeleting: boolean;
}

export function DeleteProjectDialog({
  isOpen,
  project,
  onClose,
  onConfirmDelete,
  isDeleting,
}: DeleteProjectDialogProps) {
  const [deleteOption, setDeleteOption] = useState<"local_only" | "local_and_remote">("local_only");
  const [confirmationInput, setConfirmationInput] = useState("");

  if (!isOpen || !project) return null;

  const requiresNameConfirmation = deleteOption === "local_and_remote";
  const isNameConfirmed = !requiresNameConfirmation || confirmationInput.trim() === project.name;
  const canDelete = !isDeleting && isNameConfirmed;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="delete-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="delete-dialog-header">
          <div className="title-row">
            <TrashIcon size={20} className="danger-icon" />
            <h2 id="delete-dialog-title">Удалить проект «{project.name}»?</h2>
          </div>
          <button
            type="button"
            className="icon-header-btn close-btn"
            aria-label="Отмена"
            onClick={onClose}
            disabled={isDeleting}
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="delete-dialog-body">
          <p className="delete-description">
            Выберите уровень удаления. Локальные записи и история проекта удаляются безвозвратно.
          </p>

          <div className="radio-cards-group">
            {/* Option 1: Local only (Recommended) */}
            <label className={`radio-card ${deleteOption === "local_only" ? "selected" : ""}`}>
              <input
                type="radio"
                name="delete_mode"
                value="local_only"
                checked={deleteOption === "local_only"}
                onChange={() => setDeleteOption("local_only")}
                disabled={isDeleting}
              />
              <div className="radio-card-content">
                <div className="card-title-row">
                  <strong>Удалить только из G+G</strong>
                  <span className="badge recommended-badge">Рекомендуется</span>
                </div>
                <p className="card-subtitle">
                  Локальный проект и история удалятся. Привязанные веб-чаты в аккаунтах ИИ сохранятся.
                </p>
              </div>
            </label>

            {/* Option 2: Local and Remote */}
            <label className={`radio-card danger-card ${deleteOption === "local_and_remote" ? "selected" : ""}`}>
              <input
                type="radio"
                name="delete_mode"
                value="local_and_remote"
                checked={deleteOption === "local_and_remote"}
                onChange={() => setDeleteOption("local_and_remote")}
                disabled={isDeleting}
              />
              <div className="radio-card-content">
                <div className="card-title-row">
                  <strong>Удалить из G+G и попытаться удалить веб-чаты</strong>
                  <span className="badge danger-badge">Опасное действие</span>
                </div>
                <p className="card-subtitle">
                  Действие выполняется отдельно для каждого провайдера. Возможны частичные ошибки или необходимость ручного подтверждения на сайте.
                </p>
              </div>
            </label>
          </div>

          {requiresNameConfirmation && (
            <div className="confirmation-field-wrapper">
              <label className="form-label danger-label">
                Для подтверждения введите точное название проекта <strong>«{project.name}»</strong>:
                <input
                  type="text"
                  value={confirmationInput}
                  onChange={(e) => setConfirmationInput(e.target.value)}
                  placeholder={project.name}
                  disabled={isDeleting}
                  autoFocus
                />
              </label>
              {!isNameConfirmed && confirmationInput.length > 0 && (
                <div className="inline-warning">
                  <AlertCircleIcon size={14} />
                  <span>Название не совпадает</span>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="delete-dialog-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isDeleting}
          >
            Отмена
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!canDelete}
            onClick={() => void onConfirmDelete(deleteOption === "local_and_remote")}
          >
            {isDeleting ? "Удаление…" : "Удалить проект"}
          </button>
        </footer>
      </div>
    </div>
  );
}

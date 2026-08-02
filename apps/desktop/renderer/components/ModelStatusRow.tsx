import React from "react";
import { getProviderDisplayName, getProviderMetadata } from "../provider-metadata.js";
import { ProviderLogoIcon } from "./Icon.js";

export interface ModelStatusRowProps {
  providerId: string;
  statusText?: string;
  statusType?: "online" | "warning" | "busy" | "error" | "offline";
  onClick?: () => void;
  className?: string;
}

export function ModelStatusRow({
  providerId,
  statusText = "Готова",
  statusType = "online",
  onClick,
  className = "",
}: ModelStatusRowProps) {
  const meta = getProviderMetadata(providerId);
  const displayName = getProviderDisplayName(providerId);

  const dotClass =
    statusType === "online"
      ? "status-online"
      : statusType === "warning"
      ? "status-warning"
      : statusType === "busy"
      ? "status-busy"
      : statusType === "error"
      ? "status-error"
      : "status-offline";

  return (
    <div
      className={`model-status-row ${onClick ? "interactive" : ""} ${className}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="model-status-icon-wrapper">
        <ProviderLogoIcon providerId={meta.id} size={20} />
      </div>
      <span className="model-status-name">{displayName}</span>
      <div className="model-status-indicator">
        <span className={`status-dot ${dotClass}`} aria-hidden="true" />
        <span className="model-status-text">{statusText}</span>
      </div>
    </div>
  );
}

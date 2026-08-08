export type AttachmentKind =
  | "image"
  | "document"
  | "text"
  | "archive"
  | "audio"
  | "video"
  | "binary";

export type AttachmentSource = "user" | "chatgpt" | "gemini" | "cli";

export type AttachmentStatus =
  | "STAGED"
  | "UPLOADING"
  | "READY"
  | "FAILED"
  | "QUARANTINED";

export type QuarantineReason =
  | "EXECUTABLE_BLOCKED"
  | "MIME_MISMATCH"
  | "SIZE_LIMIT"
  | "UNSAFE_FILENAME"
  | "MANUAL_REVIEW_REQUIRED";

export interface ProviderArtifactMetadata {
  providerId: string;
  providerMessageId?: string;
  providerFileId?: string;
  originalUrlHash?: string;
  expiresAt?: string;
}

export interface AttachmentRefV1 {
  id: string;
  messageId: string;
  projectId: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  localRelativePath: string;
  source: AttachmentSource;
  status: AttachmentStatus;
  previewRelativePath?: string;
  providerMetadata?: ProviderArtifactMetadata;
  quarantineReason?: QuarantineReason;
  /** True when the content-addressed blob already existed in managed storage. */
  deduplicated?: boolean;
}

export interface MessageInputV1 {
  content: string;
  attachments: AttachmentRefV1[];
}

export interface TurnResultV1 {
  response: string;
  responseFingerprint: string;
  elapsedMs: number;
  artifacts: AttachmentRefV1[];
  links: Array<{ label: string; url: string; downloadable: boolean }>;
}

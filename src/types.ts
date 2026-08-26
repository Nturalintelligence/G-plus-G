import type { AttachmentRefV1 } from "./attachments/attachments.js";
import type { DownloadedArtifactRecord } from "./attachments/artifact-downloader.js";

export type SessionState =
  | "AUTHENTICATED"
  | "LOGIN_REQUIRED"
  | "CHALLENGE_REQUIRED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export interface ResponseSnapshot {
  ordinal: number;
  domId: string | null;
  text: string;
  fingerprint: string;
}

export interface TurnResult {
  response: string;
  responseFingerprint: string;
  elapsedMs: number;
  artifacts?: DownloadedArtifactRecord[];
  links?: Array<{ label: string; url: string; downloadable: boolean }>;
}

export interface DiagnosticReport {
  timestamp: string;
  url: string;
  title: string;
  sessionState: SessionState;
  composerCandidates: number;
  assistantResponseCount: number;
  mutationCount?: number;
  submissionEvidence?: {
    level: "STRONG_CONFIRMED" | "PROBABLE_SUBMITTED" | "UNKNOWN" | "FAILED_BEFORE_SUBMIT";
    signals: string[];
  };
}

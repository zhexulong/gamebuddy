import type { P3Draft, P3Snapshot } from "./p3-browser-api";

export type ViewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; snapshot: P3Snapshot; draft: P3Draft }>
  | Readonly<{
      kind: "problem";
      disposition: "bootstrap_unavailable" | "temporarily_unavailable" | "reconciliation_failed";
    }>;

export type ActivePanel = "none" | "chats" | "characters" | "worldInfo" | "persona" | "memory" | "settings";

export interface CompanionSummary {
  id: string;
  name: string;
  role?: string;
  persona?: string;
  avatarUrl?: string;
}

export interface ChatSummary {
  chatHandle: string;
  title: string;
  /** Absent in metadata-only profiles (for example the management list). */
  updatedAtMs?: number;
  /** Absent in metadata-only profiles (for example the management list). */
  messageCount?: number;
}

export interface WorldInfoEntry {
  id: string;
  key: string;
  title: string;
  content: string;
  enabled: boolean;
}

export interface UserPersona {
  name: string;
  description: string;
}

export interface SemanticMemoryItem {
  id: string;
  fact: string;
  status: "active" | "permanent";
  recordedAtMs: number;
}

export interface ImportCandidateField {
  reviewKey: string;
  label: string;
  eligible: boolean;
  value: string;
}

export interface ImportResult {
  report: {
    reviewId: string;
    dispositions: Array<{ status: "available" | "excluded" | "unsupported"; label: string }>;
  };
  candidate: {
    fields: ImportCandidateField[];
  };
}

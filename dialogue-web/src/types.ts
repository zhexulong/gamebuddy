export interface ChatSummary {
  chatHandle: string;
  title: string;
  /** Absent in metadata-only profiles (for example the management list). */
  updatedAtMs?: number;
  /** Absent in metadata-only profiles (for example the management list). */
  messageCount?: number;
  managementRevision?: number;
}

import type { P3Draft } from "../p3-browser-api";

export function DraftSection({
  draft,
  labels,
}: {
  draft: P3Draft;
  labels: {
    savedDraft: string;
    noSavedDraft: string;
  };
}) {
  return (
    <section className="draft-section" aria-label={labels.savedDraft}>
      <div className="draft-header">
        <h2>{labels.savedDraft}</h2>
      </div>
      {draft.text === null ? (
        <p className="draft-content draft-empty">{labels.noSavedDraft}</p>
      ) : (
        <p className="draft-content">{draft.text}</p>
      )}
    </section>
  );
}

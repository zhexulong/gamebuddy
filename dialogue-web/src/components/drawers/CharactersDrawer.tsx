import { Plus, Upload, User, UserCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Messages } from "../../i18n";
import type { CompanionSummary } from "../../types";

export function CharactersDrawer({
  isOpen,
  onClose,
  labels,
  activeCompanion,
  companions,
  onSelectCompanion,
  onCreateCompanion,
  onImportCard,
}: {
  isOpen: boolean;
  onClose: () => void;
  labels: Messages;
  activeCompanion: CompanionSummary;
  companions: CompanionSummary[];
  onSelectCompanion: (id: string) => void;
  onCreateCompanion: (name: string, persona?: string) => void;
  onImportCard: (cardJson: string) => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<"view" | "create" | "import">("view");
  const [newName, setNewName] = useState("");
  const [newPersona, setNewPersona] = useState("");
  const [cardJson, setCardJson] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      <div className="backdrop-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={drawerRef} className="context-panel" role="dialog" aria-modal="true" aria-label={labels.characters}>
        <div className="drawer-header">
          <div className="drawer-title-group">
            <User size={20} aria-hidden="true" />
            <h2>{labels.characters}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={labels.close}
            aria-label={labels.close}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="tab-navigation">
          <button
            type="button"
            className={`tab-button ${tab === "view" ? "active" : ""}`}
            onClick={() => setTab("view")}
          >
            {labels.allCharacters}
          </button>
          <button
            type="button"
            className={`tab-button ${tab === "create" ? "active" : ""}`}
            onClick={() => setTab("create")}
          >
            <Plus size={14} aria-hidden="true" />
            {labels.newCharacter}
          </button>
          <button
            type="button"
            className={`tab-button ${tab === "import" ? "active" : ""}`}
            onClick={() => setTab("import")}
          >
            <Upload size={14} aria-hidden="true" />
            {labels.import}
          </button>
        </div>

        <div className="drawer-content">
          {tab === "view" && (
            <div className="character-view-section">
              <div className="active-companion-card">
                <div className="card-header">
                  <div className="companion-avatar-large">{activeCompanion.name.slice(0, 1).toUpperCase()}</div>
                  <div>
                    <h3>{activeCompanion.name}</h3>
                    <span className="badge-active">
                      <UserCheck size={12} aria-hidden="true" />
                      {labels.activeCharacter}
                    </span>
                  </div>
                </div>
                {activeCompanion.persona && <p className="companion-persona-text">{activeCompanion.persona}</p>}
              </div>

              <h4 className="section-subtitle">{labels.allCharacters}</h4>
              <div className="companion-list">
                {companions.map((c) => (
                  <div
                    key={c.id}
                    className={`companion-list-item ${c.id === activeCompanion.id ? "active" : ""}`}
                    onClick={() => onSelectCompanion(c.id)}
                  >
                    <div className="monogram-small">{c.name.slice(0, 1).toUpperCase()}</div>
                    <span className="name">{c.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "create" && (
            <div className="form-stack">
              <label className="form-field">
                <span className="form-label">{labels.characterName}</span>
                <input
                  type="text"
                  className="form-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. 凛 / Mira"
                />
              </label>
              <label className="form-field">
                <span className="form-label">{labels.persona}</span>
                <textarea
                  className="form-textarea"
                  rows={4}
                  value={newPersona}
                  onChange={(e) => setNewPersona(e.target.value)}
                  placeholder="Describe personality, tone, background..."
                />
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={!newName.trim()}
                onClick={() => {
                  onCreateCompanion(newName.trim(), newPersona.trim());
                  setNewName("");
                  setNewPersona("");
                  setTab("view");
                }}
              >
                {labels.create}
              </button>
            </div>
          )}

          {tab === "import" && (
            <div className="form-stack">
              <label className="form-field">
                <span className="form-label">{labels.pasteCardJson} (SillyTavern Card V2/V3)</span>
                <textarea
                  className="form-textarea"
                  rows={8}
                  value={cardJson}
                  onChange={(e) => setCardJson(e.target.value)}
                  placeholder='{"name": "...", "description": "...", "personality": "..."}'
                />
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={!cardJson.trim()}
                onClick={() => {
                  onImportCard(cardJson.trim());
                  setCardJson("");
                  setTab("view");
                }}
              >
                {labels.importCharacterCard}
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

import { UserCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Messages } from "../../i18n";
import type { UserPersona } from "../../types";

export function PersonaDrawer({
  isOpen,
  onClose,
  labels,
  persona,
  onSavePersona,
}: {
  isOpen: boolean;
  onClose: () => void;
  labels: Messages;
  persona: UserPersona;
  onSavePersona: (persona: UserPersona) => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const [name, setName] = useState(persona.name);
  const [description, setDescription] = useState(persona.description);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setName(persona.name);
    setDescription(persona.description);
  }, [persona]);

  useEffect(() => {
    if (!isOpen) {
      setSavedNotice(false);
      return;
    }
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
      <aside ref={drawerRef} className="context-panel" role="dialog" aria-modal="true" aria-label={labels.userPersona}>
        <div className="drawer-header">
          <div className="drawer-title-group">
            <UserCircle size={20} aria-hidden="true" />
            <h2>{labels.userPersona}</h2>
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

        <div className="drawer-content">
          <div className="form-stack">
            <label className="form-field">
              <span className="form-label">{labels.personaName}</span>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Farmer / 农场主"
              />
            </label>
            <label className="form-field">
              <span className="form-label">{labels.personaDescription}</span>
              <textarea
                className="form-textarea"
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe your appearance, background, communication habits..."
              />
            </label>

            {savedNotice && <p className="success-text">{labels.success}</p>}

            <button
              type="button"
              className="primary-button"
              onClick={() => {
                onSavePersona({ name: name.trim(), description: description.trim() });
                setSavedNotice(true);
                setTimeout(() => setSavedNotice(false), 3000);
              }}
            >
              {labels.save}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

import { Cpu, Globe, Settings, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Locale, Messages } from "../i18n";

export function SettingsDrawer({
  isOpen,
  onClose,
  currentLocale,
  onSelectLocale,
  labels,
  invokerRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentLocale: Locale;
  onSelectLocale: (locale: Locale) => void;
  labels: Messages;
  invokerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const drawer = drawerRef.current;
    if (!drawer) return;

    const focusables = drawer.querySelectorAll<HTMLElement>(
      'button, select, input, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    first?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "Tab") {
        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      invokerRef?.current?.focus();
    };
  }, [isOpen, onClose, invokerRef]);

  if (!isOpen) return null;

  return (
    <>
      <div className="backdrop-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={drawerRef} className="context-panel" role="dialog" aria-modal="true" aria-label={labels.settings}>
        <div className="drawer-header">
          <div className="drawer-title-group">
            <Settings size={20} aria-hidden="true" />
            <h2>{labels.settings}</h2>
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
          <div className="settings-section">
            <div className="settings-section-title">
              <Globe size={16} aria-hidden="true" />
              <h3>{labels.language}</h3>
            </div>
            <div className="form-field">
              <label htmlFor="language-select" className="form-label">
                {labels.language}
              </label>
              <select
                id="language-select"
                className="form-select"
                value={currentLocale}
                onChange={(e) => onSelectLocale(e.target.value as Locale)}
              >
                <option value="en">{labels.english}</option>
                <option value="zh-CN">{labels.chinese}</option>
              </select>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <Cpu size={16} aria-hidden="true" />
              <h3>{labels.chatModelProfile}</h3>
            </div>
            <div className="model-info-card">
              <div className="model-info-row">
                <span className="label">{labels.surface}</span>
                <span className="value">Chat</span>
              </div>
              <div className="model-info-row">
                <span className="label">{labels.model}</span>
                <span className="value">deepseek-v4-flash</span>
              </div>
              <div className="model-info-row">
                <span className="label">{labels.thinkingLevel}</span>
                <span className="value badge-highlight">{labels.high}</span>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <Cpu size={16} aria-hidden="true" />
              <h3>{labels.gameModelProfile}</h3>
            </div>
            <div className="model-info-card">
              <div className="model-info-row">
                <span className="label">{labels.surface}</span>
                <span className="value">Game companion</span>
              </div>
              <div className="model-info-row">
                <span className="label">{labels.model}</span>
                <span className="value">deepseek-v4-flash</span>
              </div>
              <div className="model-info-row">
                <span className="label">{labels.thinkingLevel}</span>
                <span className="value badge-highlight">{labels.high}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="drawer-footer">
          <button type="button" className="small-button" onClick={onClose}>
            {labels.close}
          </button>
        </div>
      </aside>
    </>
  );
}

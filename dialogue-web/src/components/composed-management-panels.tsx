/**
 * Management panels for the composed reference-game shell.
 *
 * Each panel is a thin, honest surface over the delegated management routes the composed
 * root now serves under /api/tavern/v1/ (chat.list, memory.read/mutate, world-info.read,
 * settings.language.read, settings.voice.read). Data is fetched through the composed
 * session cookie (same-origin, credentials: same-origin), so no second bootstrap or
 * second CSRF chain exists; a route the Host has not mounted stays absent, never a
 * disabled lookalike (design/26 §1, design/104 §2).
 */
import { useEffect, useState, type ReactElement } from "react";
import { messages, type Locale } from "../i18n";
import type {
  ManageChatsPanel,
  ManageMemoryPanel,
  ManageSettingsPanel,
  ManageWorldInfoPanel,
  ManagementPanelsApi,
} from "../composed-management-panels-api";

type Ready<T> = Readonly<{ kind: "ready"; value: T }>;
type Load<T> = Readonly<{ kind: "loading" }> | Ready<T> | Readonly<{ kind: "error" }>;

export function ChatsPanelView({
  api,
  labels,
  load,
}: Readonly<{
  api: ManagementPanelsApi;
  labels: ReturnType<typeof messages>;
  load: () => Promise<ManageChatsPanel>;
}>): ReactElement {
  const [view, setView] = useState<Load<ManageChatsPanel>>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    void load()
      .then((value) => active && setView({ kind: "ready", value }))
      .catch(() => active && setView({ kind: "error" }));
    return () => {
      active = false;
    };
  }, [api, load]);
  if (view.kind === "loading") return <p className="state-placeholder">{labels.loading}</p>;
  if (view.kind === "error") return <p className="state-placeholder">{labels.failure}</p>;
  const chats = view.value.chats;
  if (chats.length === 0) return <p className="state-placeholder">{labels.chatsEmpty}</p>;
  return (
    <ul className="composed-chat-list" aria-label={labels.chatsPanel}>
      {chats.map((chat) => (
        <li key={chat.handle} className="composed-chat-row">
          <span className="composed-chat-title">{chat.title ?? labels.untitled}</span>
          <span className="composed-chat-status">{chat.status}</span>
        </li>
      ))}
    </ul>
  );
}

export function MemoryPanelView({
  api,
  labels,
  load,
}: Readonly<{
  api: ManagementPanelsApi;
  labels: ReturnType<typeof messages>;
  load: () => Promise<ManageMemoryPanel>;
}>): ReactElement {
  const [view, setView] = useState<Load<ManageMemoryPanel>>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    void load()
      .then((value) => active && setView({ kind: "ready", value }))
      .catch(() => active && setView({ kind: "error" }));
    return () => {
      active = false;
    };
  }, [api, load]);
  if (view.kind === "loading") return <p className="state-placeholder">{labels.loading}</p>;
  if (view.kind === "error") return <p className="state-placeholder">{labels.failure}</p>;
  const memories = view.value.memories;
  if (memories.length === 0) return <p className="state-placeholder">{labels.memoryEmpty}</p>;
  return (
    <ul className="composed-memory-list" aria-label={labels.memoryPanel}>
      {memories.map((memory) => (
        <li key={memory.handle} className="composed-memory-row">
          <span className="composed-memory-text">{memory.text}</span>
          <span className="composed-memory-origin">{memory.origin}</span>
        </li>
      ))}
    </ul>
  );
}

export function WorldInfoPanelView({
  api,
  labels,
  load,
}: Readonly<{
  api: ManagementPanelsApi;
  labels: ReturnType<typeof messages>;
  load: () => Promise<ManageWorldInfoPanel>;
}>): ReactElement {
  const [view, setView] = useState<Load<ManageWorldInfoPanel>>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    void load()
      .then((value) => active && setView({ kind: "ready", value }))
      .catch(() => active && setView({ kind: "error" }));
    return () => {
      active = false;
    };
  }, [api, load]);
  if (view.kind === "loading") return <p className="state-placeholder">{labels.loading}</p>;
  if (view.kind === "error") return <p className="state-placeholder">{labels.failure}</p>;
  const items = view.value.items;
  if (items.length === 0) return <p className="state-placeholder">{labels.worldInfoEmpty}</p>;
  return (
    <ul className="composed-world-info-list" aria-label={labels.worldInfoPanel}>
      {items.map((item) => (
        <li key={item.handle} className="composed-world-info-row">
          <span className="composed-world-info-title">{item.title}</span>
          {item.selected ? <span className="composed-world-info-mark">{labels.selected}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function SettingsPanelView({
  api,
  labels,
  load,
}: Readonly<{
  api: ManagementPanelsApi;
  labels: ReturnType<typeof messages>;
  load: () => Promise<ManageSettingsPanel>;
}>): ReactElement {
  const [view, setView] = useState<Load<ManageSettingsPanel>>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    void load()
      .then((value) => active && setView({ kind: "ready", value }))
      .catch(() => active && setView({ kind: "error" }));
    return () => {
      active = false;
    };
  }, [api, load]);
  if (view.kind === "loading") return <p className="state-placeholder">{labels.loading}</p>;
  if (view.kind === "error") return <p className="state-placeholder">{labels.failure}</p>;
  const { language, voice } = view.value;
  return (
    <dl className="composed-settings-list" aria-label={labels.settingsPanel}>
      <dt>{labels.language}</dt>
      <dd>{language}</dd>
      <dt>{labels.voiceConsent}</dt>
      <dd>{voice === "accepted" ? labels.voiceAccepted : voice === "revoked" ? labels.voiceRevoked : labels.voiceUndecided}</dd>
    </dl>
  );
}

export type { Locale };
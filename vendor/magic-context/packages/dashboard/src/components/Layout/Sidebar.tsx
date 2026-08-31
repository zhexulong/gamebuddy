import type { NavSection } from "../../lib/types";

const NAV_ITEMS: { id: NavSection; icon: string; label: string }[] = [
  { id: "projects", icon: "📁", label: "Projects" },
  { id: "workspaces", icon: "🗂️", label: "Workspaces" },
  { id: "cache", icon: "📊", label: "Cache" },
  { id: "user-memories", icon: "👤", label: "User Directives" },
  { id: "config", icon: "⚙️", label: "Config" },
  { id: "logs", icon: "📋", label: "Logs" },
];

interface Props {
  active: NavSection;
  onNavigate: (section: NavSection) => void;
}

export default function Sidebar(props: Props) {
  return (
    <nav class="nav">
      {NAV_ITEMS.map((item) => (
        <button
          type="button"
          class={`nav-item ${props.active === item.id ? "active" : ""}`}
          onClick={() => props.onNavigate(item.id)}
          title={item.label}
        >
          <span class="nav-icon">{item.icon}</span>
          <span class="nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

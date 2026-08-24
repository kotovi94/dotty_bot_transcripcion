import {
  Activity,
  BookOpen,
  FolderOpen,
  HardDrive,
  Home,
  Settings,
  Terminal,
  Wrench,
} from "lucide-react";

import dottyBotImage from "../assets/dotty-bot.png";
import type { DottyState } from "../../shared/contracts";

export type SidebarPage = "dashboard" | "sessions" | "processing" | "tools" | "settings";

interface SidebarProps {
  page: SidebarPage;
  onPageChange: (page: SidebarPage) => void;
  transcriptCount: number;
  issueCount: number;
  state: DottyState;
  fullyReady: boolean;
  partiallyReady: boolean;
  onOpenData: () => void;
}

function StatusDot({ active, warning = false }: { active: boolean; warning?: boolean }) {
  return <span className={`status-dot ${active ? "online" : warning ? "warning" : "offline"}`} />;
}

export function Sidebar({
  page,
  onPageChange,
  transcriptCount,
  issueCount,
  state,
  fullyReady,
  partiallyReady,
  onOpenData,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img src={dottyBotImage} alt="Dotty" />
        </div>
        <div>
          <strong>Dotty</strong>
          <span>Control Center</span>
        </div>
      </div>

      <nav>
        <button className={page === "dashboard" ? "active" : ""} onClick={() => onPageChange("dashboard")}>
          <Home size={19} /> Dashboard
        </button>
        <button className={page === "sessions" ? "active" : ""} onClick={() => onPageChange("sessions")}>
          <BookOpen size={19} /> Sesiones
          <span className="nav-count">{transcriptCount}</span>
        </button>
        <button className={page === "processing" ? "active" : ""} onClick={() => onPageChange("processing")}>
          <Activity size={19} /> Procesamiento
        </button>
        <button className={page === "tools" ? "active" : ""} onClick={() => onPageChange("tools")}>
          <Wrench size={19} /> Herramientas
          {issueCount > 0 && <span className="nav-count warning-count">{issueCount}</span>}
        </button>
        <button className={page === "settings" ? "active" : ""} onClick={() => onPageChange("settings")}>
          <Settings size={19} /> Configuración
        </button>
      </nav>

      <div className="sidebar-status">
        <div className="sidebar-status-row">
          <StatusDot active={fullyReady} warning={partiallyReady && !fullyReady} />
          <div>
            <strong>{fullyReady ? "Dotty operativo" : partiallyReady ? "Inicio parcial" : "Dotty apagado"}</strong>
            <span>{state.transcriber.activeDevice === "cuda" ? "GPU CUDA" : state.transcriber.available ? "CPU" : "Sin transcriptor"}</span>
          </div>
        </div>
        <button onClick={onOpenData}>
          <FolderOpen size={17} /> Abrir datos
        </button>
      </div>
    </aside>
  );
}

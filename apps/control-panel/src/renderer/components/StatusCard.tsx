import type { ReactNode } from "react";

export type StatusCardTone = "good" | "warn" | "muted" | "danger";

interface StatusCardProps {
  icon: ReactNode;
  title: string;
  value: string;
  detail: string;
  tone: StatusCardTone;
}

export function StatusCard({ icon, title, value, detail, tone }: StatusCardProps) {
  return (
    <article className="service-card">
      <div className={`service-icon ${tone}`}>{icon}</div>
      <div className="service-copy">
        <span>{title}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
      <span className={`status-dot ${tone === "good" ? "online" : tone === "warn" || tone === "danger" ? "warning" : "offline"}`} />
    </article>
  );
}

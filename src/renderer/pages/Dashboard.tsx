import React, { useEffect, useState } from "react";
import type { SyncStatus, DiskInfo } from "../types";
import logo from "../assets/logo-orange.png";

const ACCENT = "#F97316"; // brand orange (Team palette)

// Functional sync-state colors — must match the tray status dots in the main process.
type DisplayState = "idle" | "synced" | "syncing" | "paused" | "error";
const DOT: Record<DisplayState, string> = {
  idle: "#9aa0a6",
  synced: "#22c55e",
  syncing: "#3b82f6",
  paused: "#f59e0b",
  error: "#ef4444",
};
const LABEL: Record<DisplayState, string> = {
  idle: "Idle",
  synced: "Up to date",
  syncing: "Syncing…",
  paused: "Paused",
  error: "Sync error",
};

// Derive the same branded state the tray shows (adds a clear "up to date" state).
function displayState(status: SyncStatus | null): DisplayState {
  if (!status) return "idle";
  if (status.state === "error") return "error";
  if (status.paused || status.state === "paused") return "paused";
  if (status.state === "syncing") return "syncing";
  return status.filesSynced > 0 && status.filesPending === 0 ? "synced" : "idle";
}

function fmt(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function Dashboard({
  user,
  onOpenSettings,
  onLogout,
}: {
  user: any;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [progress, setProgress] = useState<{ file: string; pct: number } | null>(null);

  useEffect(() => {
    window.emSync.getStatus().then(setStatus);
    window.emSync.getDiskInfo().then(setDisk);
    window.emSync.onStatusUpdate(setStatus);
    window.emSync.onProgress((p) => setProgress(p));
    const t = setInterval(() => window.emSync.getDiskInfo().then(setDisk), 30000);
    return () => clearInterval(t);
  }, []);

  const state = displayState(status);
  const diskPct =
    disk && disk.totalBytes && disk.usedBytes
      ? Math.round((disk.usedBytes / disk.totalBytes) * 100)
      : 0;

  return (
    <div style={{ padding: 24, height: "100%", display: "flex", flexDirection: "column", gap: 18 }}>
      <img src={logo} alt="Editing Machine" style={{ height: 26, width: "auto", objectFit: "contain", alignSelf: "flex-start" }} />

      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: DOT[state] }} />
        <strong>{LABEL[state]}</strong>
        <span style={{ marginLeft: "auto", textAlign: "right", fontSize: 12, opacity: 0.6, lineHeight: 1.3 }}>
          {user?.name && <div>{user.name}</div>}
          {(user?.email || status?.user?.email) && (
            <div style={{ opacity: user?.name ? 0.8 : 1 }}>
              {user?.email || status?.user?.email}
            </div>
          )}
        </span>
      </header>

      {progress && state === "syncing" && (
        <div style={card}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>↓ {progress.file}</div>
          <div style={{ background: "#23272e", borderRadius: 6, overflow: "hidden", height: 8 }}>
            <div style={{ width: `${progress.pct}%`, height: "100%", background: DOT.syncing }} />
          </div>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>{progress.pct}%</div>
        </div>
      )}

      <div style={card}>
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>Storage</div>
        <div style={{ background: "#23272e", borderRadius: 6, overflow: "hidden", height: 8 }}>
          <div style={{ width: `${diskPct}%`, height: "100%", background: DOT.synced }} />
        </div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
          {fmt(disk?.usedBytes)} / {fmt(disk?.totalBytes)} used
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
        <div style={{ ...card, flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{status?.filesSynced ?? 0}</div>
          <div style={{ opacity: 0.6 }}>Synced</div>
        </div>
        <div style={{ ...card, flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{status?.filesPending ?? 0}</div>
          <div style={{ opacity: 0.6 }}>Pending</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
        {status?.paused ? (
          <button style={btn} onClick={() => window.emSync.resumeSync()}>Resume</button>
        ) : (
          <button style={btn} onClick={() => window.emSync.pauseSync()}>Pause</button>
        )}
        <button style={btn} onClick={() => window.emSync.syncNow()}>Sync Now</button>
        <button style={primaryBtn} onClick={() => window.emSync.openPortal()}>Open Portal</button>
        <button style={btn} onClick={() => window.emSync.openSyncFolder()}>Sync Folder</button>
        <button style={btn} onClick={onOpenSettings}>Settings</button>
        <button style={{ ...btn, color: ACCENT, borderColor: "#3a2a1c" }} onClick={onLogout}>Log Out</button>
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "#1a1d23",
  border: "1px solid #23272e",
  borderRadius: 10,
  padding: 14,
};

const btn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #2a2f37",
  background: "#1a1d23",
  color: "#e6e8eb",
  cursor: "pointer",
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  ...btn,
  background: ACCENT,
  border: "none",
  color: "white",
  fontWeight: 600,
};

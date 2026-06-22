import React, { useEffect, useState } from "react";
import type { SyncStatus, DiskInfo } from "../types";
import { deriveSyncState, SYNC_LABELS } from "../../shared/sync-state";
import logo from "../assets/logo-orange.png";

const ACCENT = "#F97316"; // brand orange (Team palette)

// Functional sync-state colors — must match the tray status dots in the main process.
type DisplayState = "offline" | "idle" | "synced" | "syncing" | "paused" | "error";
const DOT: Record<DisplayState, string> = {
  offline: "#9aa0a6",
  idle: "#9aa0a6",
  synced: "#22c55e",
  syncing: "#3b82f6",
  paused: "#f59e0b",
  error: "#ef4444",
};
// Human labels come from the shared sync-state module so this window header and
// the tray tooltip/menu (main process) always read identically.
const LABEL: Record<DisplayState, string> = SYNC_LABELS;

// Derive the branded logical state. The rule itself lives in the shared
// sync-state module so this window and the tray dot (main process trayState)
// can never drift apart. No status snapshot yet ⇒ we're not connected to the
// engine, i.e. offline.
function displayState(status: SyncStatus | null): DisplayState {
  return deriveSyncState({
    signedIn: !!status,
    state: status?.state,
    paused: status?.paused,
    filesPending: status?.filesPending,
  });
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

      {/* Task #1938 — controls moved to the top, directly above the Storage bar. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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

      <div style={card}>
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>Storage</div>
        <div style={{ background: "#23272e", borderRadius: 6, overflow: "hidden", height: 8 }}>
          <div style={{ width: `${diskPct}%`, height: "100%", background: DOT.synced }} />
        </div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
          {fmt(disk?.usedBytes)} / {fmt(disk?.totalBytes)} used
        </div>
      </div>

      <ProjectBreakdown status={status} />
    </div>
  );
}

// Task #1938 — per-project sync breakdown. Replaces the two global Synced /
// Pending tiles with one row per project that still has files queued or
// downloading, each showing local-vs-pending counts and an active indicator,
// plus a compact overall summary line so the global picture isn't lost. Empty
// and all-synced states are honest — no placeholder numbers.
function ProjectBreakdown({ status }: { status: SyncStatus | null }) {
  const projects = status?.projects ?? [];
  const totalLocal = projects.reduce((s, p) => s + p.localFiles, 0);
  const totalFiles = projects.reduce((s, p) => s + p.totalFiles, 0);
  // Only show projects with work left (queued or in progress); fully-synced
  // projects collapse into the summary + the all-synced empty state.
  const pending = projects.filter((p) => p.pendingFiles > 0);

  return (
    <div style={{ ...card, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 12, opacity: 0.6 }}>Projects</div>
        {totalFiles > 0 && (
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            {totalLocal} of {totalFiles} files on this device
          </div>
        )}
      </div>

      {totalFiles === 0 ? (
        <div style={emptyText}>Nothing to sync yet</div>
      ) : pending.length === 0 ? (
        <div style={emptyText}>All projects synced</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
          {pending.map((p) => (
            <div
              key={p.projectName}
              style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}
            >
              <span
                title={p.active ? "Downloading now" : "Queued"}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: p.active ? DOT.syncing : DOT.idle,
                }}
              />
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.projectName}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, textAlign: "right", flexShrink: 0 }}>
                <span style={{ color: p.active ? DOT.syncing : undefined }}>
                  {p.localFiles}/{p.totalFiles} local
                </span>
                <span style={{ opacity: 0.6 }}> · {p.pendingFiles} pending</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const emptyText: React.CSSProperties = {
  fontSize: 13,
  opacity: 0.5,
  padding: "8px 0",
};

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

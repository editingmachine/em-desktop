import React, { useEffect, useRef, useState } from "react";
import type { SyncStatus, DiskInfo, ProjectSyncIssue } from "../types";
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
  const [proxyFirst, setProxyFirst] = useState<{ enabled: boolean; reason: string } | null>(null);

  useEffect(() => {
    window.emSync.getStatus().then(setStatus);
    window.emSync.getProxyFirstConfig().then(setProxyFirst).catch(() => setProxyFirst({ enabled: false, reason: "contract_unavailable" }));
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
    <div style={{ padding: 24, height: "100%", overflowY: "auto", display: "flex", flexDirection: "column", gap: 18 }}>
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

      <ProjectBreakdown status={status} progress={progress} />
      <div style={{ ...card, borderColor: proxyFirst?.enabled ? "#2563eb" : "#3a2a1c" }} aria-label="Proxy-first upload status">
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 5 }}>Editing preparation</div>
        <strong style={{ fontSize: 13 }}>{proxyFirst?.enabled ? "Proxy-first pilot enabled" : "Original-first upload mode"}</strong>
        <div style={{ fontSize: 11, opacity: 0.62, marginTop: 5 }}>
          {proxyFirst?.enabled
            ? "Proxies can be prepared first; verified originals are still required for final renders."
            : "Proxy-first preparation is not enabled for this account. Originals remain the source of truth."}
        </div>
      </div>
      <ProjectLifecycleActivity status={status} />
    </div>
  );
}

// Task #4306 — uploads and cleanup are intentionally shown separately from
// download progress. A project may be fully downloaded while a manual file is
// still waiting for verified cloud coverage and therefore blocks retirement.
function ProjectLifecycleActivity({ status }: { status: SyncStatus | null }) {
  const activity = status?.projectSync;
  if (!activity) return null;
  const deleted = activity.deletedDownloads;
  const uploads = activity.uploads ?? {
    pending: 0, active: 0, completed: 0, failed: 0, issues: [],
  };
  const migration = activity.migration ?? {
    pending: 0, completed: 0, conflicts: 0, issues: [],
  };
  const cleanup = activity.cleanup ?? {
    pendingProjects: 0, completedProjects: 0, reclaimedBytes: 0, issues: [],
  };
  const projectIssues: ProjectSyncIssue[] = (activity.projects || [])
    .filter((project) => project.state === "blocked")
    .map((project) => ({
      projectId: project.projectId,
      projectCode: project.projectCode,
      projectName: project.projectName,
      reason: project.message || "This project's local folder cannot be retired safely yet.",
      remedy: project.remedy,
    }));
  const issues = [
    ...(deleted?.issues || []),
    ...projectIssues,
    ...(uploads.issues || []),
    ...(migration.issues || []),
    ...(cleanup.issues || []),
  ];
  const uploadWorking = uploads.pending + uploads.active;
  const hasActivity =
    !!(deleted && (deleted.pending + deleted.completed + deleted.blocked)) ||
    uploadWorking > 0 ||
    uploads.completed > 0 ||
    cleanup.pendingProjects > 0 ||
    cleanup.completedProjects > 0 ||
    migration.pending > 0 ||
    migration.completed > 0 ||
    (activity.projects || []).some((project) => project.state === "retired") ||
    issues.length > 0;
  if (!hasActivity) return null;

  return (
    <section style={card} aria-label="Project backup and cleanup activity">
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10 }}>Backup &amp; retirement</div>
      {deleted && (deleted.pending + deleted.completed + deleted.blocked > 0) && (
        <div role="status" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
          Deleted cloud downloads: {deleted.completed} removed, {deleted.pending} pending,
          {" "}{deleted.blocked} retained. Cleanup runs while signed in, online and syncing.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <ActivityMetric
          label="Uploads"
          value={uploads.active > 0 ? `${uploads.active} uploading` : `${uploads.pending} queued`}
          detail={
            uploads.bytesPending
              ? `${fmt(uploads.bytesPending)} remaining`
              : `${uploads.completed} verified`
          }
          color={uploads.failed > 0 ? DOT.error : uploadWorking > 0 ? DOT.syncing : DOT.synced}
        />
        <ActivityMetric
          label="Folder migration"
          value={migration.pending > 0 ? `${migration.pending} pending` : `${migration.completed} moved`}
          detail={`${migration.conflicts} conflicts`}
          color={migration.conflicts > 0 ? DOT.paused : migration.pending > 0 ? DOT.syncing : DOT.synced}
        />
        <ActivityMetric
          label="Cleanup"
          value={
            cleanup.activeProject
              ? `Removing ${cleanup.activeProject}`
              : `${cleanup.pendingProjects} waiting`
          }
          detail={`${fmt(cleanup.reclaimedBytes)} reclaimed`}
          color={issues.length > 0 ? DOT.paused : cleanup.pendingProjects > 0 ? DOT.syncing : DOT.synced}
        />
      </div>
      {issues.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <strong style={{ color: "#f59e0b", fontSize: 12 }}>
            {issues.length} item{issues.length === 1 ? "" : "s"} need attention — local files are retained
          </strong>
          {issues.slice(0, 8).map((issue, index) => (
            <IssueRow issue={issue} key={`${issue.projectId || issue.projectCode || "project"}-${issue.relativePath || issue.reason}-${index}`} />
          ))}
          {issues.length > 8 && (
            <div style={{ fontSize: 11, opacity: 0.55 }}>
              {issues.length - 8} more. Resolve the items above and sync again to refresh the list.
            </div>
          )}
        </div>
      )}
      {(uploads.failed > 0 || uploads.active > 0) && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            style={btn}
            onClick={() => window.emSync.syncNow()}
            aria-label="Retry failed uploads"
          >
            Retry failed uploads
          </button>
          {uploads.active > 0 && (
            <button
              style={{ ...btn, color: "#f59e0b", borderColor: "#4a351c" }}
              onClick={() => window.emSync.pauseSync()}
              aria-label="Cancel active upload"
            >
              Cancel active upload
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ActivityMetric({
  label, value, detail, color,
}: {
  label: string; value: string; detail: string; color: string;
}) {
  return (
    <div style={{ background: "#15181d", borderRadius: 8, padding: 9, minWidth: 0 }}>
      <div style={{ color, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 12, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>{detail}</div>
    </div>
  );
}

function IssueRow({ issue }: { issue: ProjectSyncIssue }) {
  const project = issue.projectCode || issue.projectName || "Unidentified project";
  return (
    <div style={{ borderLeft: "2px solid #f59e0b", paddingLeft: 9, minWidth: 0 }}>
      <div style={{ fontSize: 12 }}>
        <strong>{project}</strong>
        {issue.relativePath && (
          <span title={issue.relativePath} style={{ opacity: 0.7 }}> · {issue.relativePath}</span>
        )}
      </div>
      <div style={{ fontSize: 11, opacity: 0.66, lineHeight: 1.4 }}>{issue.reason}</div>
      <div style={{ fontSize: 11, color: "#f59e0b", lineHeight: 1.4 }}>
        {issue.remedy || defaultRemedy(issue)}
      </div>
    </div>
  );
}

function defaultRemedy(issue: ProjectSyncIssue): string {
  switch (issue.kind) {
    case "unsupported":
      return "Move this file outside the project folder, or convert it to a supported format.";
    case "unauthorized":
      return "Restore project access or ask an administrator to choose an authorized recovery destination.";
    case "quarantined":
      return "Review the Smart Cloud security result; cleanup stays blocked.";
    case "migration_conflict":
      return "Resolve the numbered-folder conflict without overwriting either copy, then sync again.";
    case "ambiguous_identity":
      return "Ask an administrator to identify the correct project; this folder will not be migrated or deleted.";
    case "cleanup_locked":
      return "Close apps using this project folder, then choose Sync Now.";
    case "late_write":
      return "Wait for the new file to finish copying and upload, then sync again.";
    default:
      return "Keep the file in place and choose Sync Now. If it still fails, contact an administrator.";
  }
}

// Completion percentage for one project. Count-based (local of total), with the
// in-flight file's byte progress blended into the ACTIVE project so its bar
// advances smoothly mid-file instead of jumping a whole file at a time.
function projectPct(
  p: { localFiles: number; totalFiles: number; active: boolean },
  progress: { pct: number } | null,
): number {
  if (!p.totalFiles) return 0;
  let done = p.localFiles;
  if (p.active && progress && progress.pct > 0 && progress.pct < 100) {
    done += progress.pct / 100;
  }
  return Math.min(100, Math.round((done / p.totalFiles) * 100));
}

// Task #1938 — per-project sync breakdown. Replaces the two global Synced /
// Pending tiles with one row per project that still has files queued or
// downloading, each showing local-vs-pending counts and an active indicator,
// plus a compact overall summary line so the global picture isn't lost. Empty
// and all-synced states are honest — no placeholder numbers.
function ProjectBreakdown({
  status,
  progress,
}: {
  status: SyncStatus | null;
  progress: { file: string; pct: number } | null;
}) {
  const projects = status?.projects ?? [];
  const totalLocal = projects.reduce((s, p) => s + p.localFiles, 0);
  const totalFiles = projects.reduce((s, p) => s + p.totalFiles, 0);
  // Only show projects with work left (queued or in progress); fully-synced
  // projects collapse into the summary + the all-synced empty state.
  const pending = projects.filter((p) => p.pendingFiles > 0);

  // Persist each project's highest shown percentage so a bar NEVER flicks
  // backwards. The per-file progress event resets to 0% at the start of every
  // file, and that 0% can briefly arrive before the status update that bumps
  // localFiles — without this clamp the bar would dip to 0 between files. We
  // only re-baseline (allow a drop) when the project's totalFiles changes, i.e.
  // genuinely more work was added.
  const maxPctRef = useRef<Map<string, { pct: number; total: number }>>(new Map());

  function stablePct(p: { projectName: string; localFiles: number; totalFiles: number; active: boolean }): number {
    const raw = projectPct(p, progress);
    const prev = maxPctRef.current.get(p.projectName);
    const shown = prev && prev.total === p.totalFiles ? Math.max(prev.pct, raw) : raw;
    maxPctRef.current.set(p.projectName, { pct: shown, total: p.totalFiles });
    return shown;
  }

  // Drop remembered percentages for projects that no longer exist so the map
  // can't grow unbounded and a recreated project starts fresh.
  const liveNames = new Set(projects.map((p) => p.projectName));
  for (const name of maxPctRef.current.keys()) {
    if (!liveNames.has(name)) maxPctRef.current.delete(name);
  }

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
        <div style={{ display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          {pending.map((p) => {
            const pct = stablePct(p);
            const activeFile = p.active && progress ? progress.file : null;
            return (
              <div key={p.projectName} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
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

                <div style={{ background: "#23272e", borderRadius: 6, overflow: "hidden", height: 6 }}>
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: p.active ? DOT.syncing : "#3a4250",
                      transition: "width .3s ease",
                    }}
                  />
                </div>

                {activeFile && (
                  <div style={{ fontSize: 11, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    ↓ {activeFile}
                    {progress && progress.pct > 0 ? ` · ${progress.pct}%` : ""}
                  </div>
                )}
              </div>
            );
          })}
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

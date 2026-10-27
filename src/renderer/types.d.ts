// Task #1742 — typings for the preload bridge exposed on window.emSync.

// Vite asset imports (png logos) resolve to a URL string.
declare module "*.png" {
  const src: string;
  export default src;
}

// Task #1938 — per-project breakdown of the current manifest. One row per
// project that has files in the manifest, with how many of its files are on the
// local drive vs still pending; `active` is true only for the project whose
// file is downloading right now.
export interface ProjectSyncBreakdown {
  projectId?: number;
  projectCode?: string;
  projectName: string;
  localFiles: number;
  pendingFiles: number;
  totalFiles: number;
  active: boolean;
}

// Task #4306 — durable two-way project-sync activity exposed by the daemon.
// Counts are restart-safe queue counts, not just activity observed since this
// renderer mounted. Issues remain present until the underlying file is
// uploaded, migrated, or safely retired.
export interface ProjectSyncIssue {
  projectId?: number;
  projectCode?: string;
  projectName?: string;
  relativePath?: string;
  reason: string;
  remedy?: string;
  kind?:
    | "unsupported"
    | "unauthorized"
    | "quarantined"
    | "unverified"
    | "upload_failed"
    | "migration_conflict"
    | "ambiguous_identity"
    | "cleanup_locked"
    | "late_write";
}

export interface ProjectSyncActivity {
  deletedDownloads?: { pending: number; completed: number; blocked: number; issues: ProjectSyncIssue[] };
  // Baseline daemon contract. `message` is required for blocked projects so
  // older renderer builds can still explain why retirement is held.
  projects: Array<{
    projectId: number;
    projectCode?: string;
    projectName?: string;
    state: "ready" | "retired" | "blocked";
    message?: string;
    remedy?: string;
  }>;
  // Optional aggregate telemetry. The UI feature-detects these fields so the
  // safety-critical blocked state works during a staggered desktop rollout.
  uploads?: {
    pending: number;
    active: number;
    completed: number;
    failed: number;
    bytesPending?: number;
    issues: ProjectSyncIssue[];
  };
  cleanup?: {
    pendingProjects: number;
    activeProject?: string | null;
    completedProjects: number;
    reclaimedBytes: number;
    issues: ProjectSyncIssue[];
  };
  migration?: {
    pending: number;
    completed: number;
    conflicts: number;
    issues: ProjectSyncIssue[];
  };
}

export interface SyncStatus {
  state: "idle" | "syncing" | "paused" | "error";
  paused: boolean;
  currentFile: string | null;
  currentProject: string | null;
  filesSynced: number;
  filesPending: number;
  projects: ProjectSyncBreakdown[];
  projectSync?: ProjectSyncActivity;
  user: { email: string; name?: string } | null;
}

export interface DiskInfo {
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
}

export interface Settings {
  syncFolder: string;
  syncInterval: number;
  autoStart: boolean;
  selectedClients: number[];
  // Task #4306 — retirement is mandatory and safety-gated; there is no
  // user-controlled blanket "delete unlisted files" switch.
  projectStorageNoticeAcknowledged?: boolean;
  apiBase: string;
  usingKeychain: boolean;
}

export interface ProxyFirstConfig {
  enabled: boolean;
  version: number;
  reason: string;
  formats: string[];
  codecs: string[];
  requiresPackagedConverter: boolean;
  originalsRequiredForRender: boolean;
}

export interface LegacyMigrationProject {
  projectId: number;
  projectCode: string;
  projectName: string;
}

declare global {
  interface Window {
    emSync: {
      login(email: string, password: string): Promise<{ success: boolean; user: any }>;
      logout(): Promise<{ success: boolean }>;
      getSession(): Promise<{ loggedIn: boolean; user: any }>;
      startSync(): Promise<boolean>;
      pauseSync(): Promise<boolean>;
      resumeSync(): Promise<boolean>;
      syncNow(): Promise<boolean>;
      getStatus(): Promise<SyncStatus>;
      getProxyFirstConfig(): Promise<ProxyFirstConfig>;
      getDiskInfo(): Promise<DiskInfo>;
      getSettings(): Promise<Settings>;
      updateSettings(s: Partial<Settings>): Promise<boolean>;
      chooseSyncFolder(): Promise<string>;
      openSyncFolder(): Promise<void>;
      openPortal(): Promise<boolean>;
      getVersion(): Promise<string>;
      // Task #4306 — deliberate legacy-folder binding. The main process owns
      // the native picker and derives the relative directory; the renderer
      // supplies only authenticated project identity + exact code confirmation.
      getLegacyMigrationProjects(): Promise<LegacyMigrationProject[]>;
      mapLegacyDirectory(
        projectId: number,
        confirmedProjectCode: string,
      ): Promise<{ cancelled?: boolean; success?: boolean }>;
      installUpdate(): Promise<void>;
      onStatusUpdate(cb: (s: SyncStatus) => void): void;
      onProgress(cb: (p: { file: string; pct: number; bytes: number }) => void): void;
      onError(cb: (e: { message: string }) => void): void;
      onUpdateEvent(cb: (e: { type: string; version?: string; message?: string }) => void): void;
    };
  }
}

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
  projectName: string;
  localFiles: number;
  pendingFiles: number;
  totalFiles: number;
  active: boolean;
}

export interface SyncStatus {
  state: "idle" | "syncing" | "paused" | "error";
  paused: boolean;
  currentFile: string | null;
  currentProject: string | null;
  filesSynced: number;
  filesPending: number;
  projects: ProjectSyncBreakdown[];
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
  cleanupRemoved: boolean;
  apiBase: string;
  usingKeychain: boolean;
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
      getDiskInfo(): Promise<DiskInfo>;
      getSettings(): Promise<Settings>;
      updateSettings(s: Partial<Settings>): Promise<boolean>;
      chooseSyncFolder(): Promise<string>;
      openSyncFolder(): Promise<void>;
      openPortal(): Promise<boolean>;
      getVersion(): Promise<string>;
      installUpdate(): Promise<void>;
      onStatusUpdate(cb: (s: SyncStatus) => void): void;
      onProgress(cb: (p: { file: string; pct: number; bytes: number }) => void): void;
      onError(cb: (e: { message: string }) => void): void;
      onUpdateEvent(cb: (e: { type: string; version?: string; message?: string }) => void): void;
    };
  }
}

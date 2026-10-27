import React, { useEffect, useState } from "react";
import type { LegacyMigrationProject, Settings as SettingsType } from "../types";

const ACCENT = "#F97316"; // brand orange (Team palette)

export function Settings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [version, setVersion] = useState("");
  const [migrationProjects, setMigrationProjects] = useState<LegacyMigrationProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [confirmedCode, setConfirmedCode] = useState("");
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);

  useEffect(() => {
    window.emSync.getSettings().then(setSettings);
    window.emSync.getVersion().then(setVersion);
    window.emSync
      .getLegacyMigrationProjects()
      .then((projects) => setMigrationProjects(projects))
      .catch((error) => {
        setMigrationMessage({
          kind: "error",
          text: error instanceof Error
            ? error.message
            : "Could not load the projects available for migration.",
        });
      });
  }, []);

  if (!settings) return <div style={{ padding: 24, opacity: 0.6 }}>Loading…</div>;

  const update = async (patch: Partial<SettingsType>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await window.emSync.updateSettings(patch);
  };

  return (
    <div style={{ padding: 24, height: "100%", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button style={linkBtn} onClick={onBack}>← Back</button>
        <strong>Settings</strong>
      </header>

      <label style={label}>
        Sync folder
        <div style={{ display: "flex", gap: 8 }}>
          <input readOnly value={settings.syncFolder} style={{ ...input, flex: 1 }} />
          <button
            style={linkBtn}
            onClick={async () => {
              const folder = await window.emSync.chooseSyncFolder();
              setSettings({ ...settings, syncFolder: folder });
            }}
          >
            Change
          </button>
        </div>
      </label>

      <label style={label}>
        Sync interval (minutes)
        <input
          type="number"
          min={1}
          value={settings.syncInterval}
          onChange={(e) => update({ syncInterval: Number(e.target.value) })}
          style={input}
        />
      </label>

      <label style={checkRow}>
        <input
          type="checkbox"
          checked={settings.autoStart}
          onChange={(e) => update({ autoStart: e.target.checked })}
          style={{ accentColor: ACCENT }}
        />
        Start automatically on login
      </label>

      <section style={warning}>
        <strong>Deleted Smart Cloud downloads</strong>
        <div style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.75 }}>
          While online and syncing, this build removes only unchanged app-downloaded originals
          and proxies with an explicit cloud deletion receipt. Offline, paused or closed
          desktops catch up on their next sync. Operator recovery copies, modified, manual, legacy and client-original
          files are retained. See the dashboard for pending cleanup and remedies.
          Close playback or other apps and sync again for locked files. Preserve modified
          or unidentified copies outside the sync folder before removing them manually.
        </div>
        <strong style={{ color: "#f59e0b" }}>Project folders are disposable working storage</strong>
        <div style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.75 }}>
          Projects use their existing number as the folder name (for example,
          {" "}<strong>001-0001</strong>). Supported files you add are backed up to
          production-only Smart Cloud automatically.
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.75 }}>
          After final approval or archive, the app automatically removes the
          <strong> entire project folder</strong>, including modified, manual, and hidden
          files. Cleanup only proceeds after the latest contents have verified cloud
          coverage. Blocked files are retained and shown on the dashboard with a remedy.
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.75 }}>
          Store permanent local-only material outside the sync folder. Cloud originals
          are never deleted by local retirement.
        </div>
      </section>

      <LegacyMigration
        projects={migrationProjects}
        selectedProjectId={selectedProjectId}
        confirmedCode={confirmedCode}
        busy={migrationBusy}
        message={migrationMessage}
        onSelect={(projectId) => {
          setSelectedProjectId(projectId);
          setConfirmedCode("");
          setMigrationMessage(null);
        }}
        onConfirmCode={setConfirmedCode}
        onMigrate={async () => {
          const project = migrationProjects.find((p) => p.projectId === selectedProjectId);
          if (!project || confirmedCode !== project.projectCode) {
            setMigrationMessage({
              kind: "error",
              text: "Type the exact project code before choosing a legacy folder.",
            });
            return;
          }
          setMigrationBusy(true);
          setMigrationMessage(null);
          try {
            const result = await window.emSync.mapLegacyDirectory(
              project.projectId,
              confirmedCode,
            );
            if (result.cancelled) return;
            if (!result.success) {
              throw new Error(
                "The folder could not be mapped safely. No files were moved. Check the dashboard for conflicts.",
              );
            }
            setMigrationMessage({
              kind: "success",
              text: `${project.projectName} is mapped. Migration will resume safely during sync.`,
            });
            setConfirmedCode("");
          } catch (error) {
            setMigrationMessage({
              kind: "error",
              text: error instanceof Error ? error.message : "The legacy folder could not be migrated.",
            });
          } finally {
            setMigrationBusy(false);
          }
        }}
      />

      <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>
        Server: {settings.apiBase}
        <br />
        Credentials: {settings.usingKeychain ? "OS keychain" : "in-memory (keychain unavailable)"}
        <br />
        Version: {version}
      </div>
    </div>
  );
}

function LegacyMigration({
  projects,
  selectedProjectId,
  confirmedCode,
  busy,
  message,
  onSelect,
  onConfirmCode,
  onMigrate,
}: {
  projects: LegacyMigrationProject[];
  selectedProjectId: number | null;
  confirmedCode: string;
  busy: boolean;
  message: { kind: "error" | "success"; text: string } | null;
  onSelect: (projectId: number | null) => void;
  onConfirmCode: (code: string) => void;
  onMigrate: () => Promise<void>;
}) {
  const selected = projects.find((project) => project.projectId === selectedProjectId);
  const confirmed = !!selected && confirmedCode === selected.projectCode;

  return (
    <section style={migrationCard}>
      <div>
        <strong>Migrate an old title-named folder</strong>
        <div style={{ fontSize: 12, opacity: 0.68, lineHeight: 1.45, marginTop: 4 }}>
          Use this only for a legacy project folder that predates numbered folders.
          Choose the authenticated project first, then deliberately select its old folder.
          Editing Machine never guesses ownership from a title or folder name.
        </div>
      </div>

      <label style={label}>
        Project
        <select
          value={selectedProjectId ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onSelect(value ? Number(value) : null);
          }}
          disabled={busy}
          style={input}
        >
          <option value="">Select an authenticated project…</option>
          {projects.map((project) => (
            <option value={project.projectId} key={project.projectId}>
              {project.projectName} — {project.projectCode}
            </option>
          ))}
        </select>
      </label>

      {selected && (
        <>
          <div style={migrationWarning}>
            Every file and subfolder in the folder you choose — including hidden,
            modified, and manually added content — will move into the numbered
            <strong> {selected.projectCode}</strong> project folder without overwriting
            conflicts. After this project is finally approved or archived, that entire
            numbered folder retires automatically once all latest contents have verified
            cloud backup.
          </div>
          <label style={label}>
            Type <strong>{selected.projectCode}</strong> to confirm this binding
            <input
              value={confirmedCode}
              onChange={(event) => onConfirmCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              placeholder={selected.projectCode}
              style={input}
            />
          </label>
          <button
            type="button"
            disabled={!confirmed || busy}
            onClick={() => void onMigrate()}
            style={{
              ...linkBtn,
              opacity: confirmed && !busy ? 1 : 0.45,
              cursor: confirmed && !busy ? "pointer" : "not-allowed",
              alignSelf: "flex-start",
            }}
          >
            {busy ? "Checking folder…" : "Choose old folder & migrate"}
          </button>
        </>
      )}

      {projects.length === 0 && !message && (
        <div style={{ fontSize: 12, opacity: 0.55 }}>
          No authenticated projects are currently available for legacy migration.
        </div>
      )}
      {message && (
        <div
          role={message.kind === "error" ? "alert" : "status"}
          style={{ fontSize: 12, color: message.kind === "error" ? "#ef4444" : "#22c55e" }}
        >
          {message.text}
        </div>
      )}
    </section>
  );
}

const input: React.CSSProperties = {
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid #2a2f37",
  background: "#1a1d23",
  color: "#e6e8eb",
  fontSize: 13,
  accentColor: ACCENT,
};
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 13 };
const checkRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13 };
const warning: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: "1px solid #4a3518",
  background: "#211b13",
  borderRadius: 10,
  padding: 14,
};
const migrationCard: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  border: "1px solid #2a2f37",
  background: "#171a20",
  borderRadius: 10,
  padding: 14,
};
const migrationWarning: React.CSSProperties = {
  padding: 10,
  borderRadius: 8,
  border: "1px solid #4a3518",
  background: "#211b13",
  color: "#d8c5a8",
  fontSize: 12,
  lineHeight: 1.5,
};
const linkBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #3a2a1c",
  background: "#1a1d23",
  color: ACCENT,
  cursor: "pointer",
  fontSize: 13,
};

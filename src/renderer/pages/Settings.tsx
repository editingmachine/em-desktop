import React, { useEffect, useState } from "react";
import type { Settings as SettingsType } from "../types";

const ACCENT = "#F97316"; // brand orange (Team palette)

export function Settings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    window.emSync.getSettings().then(setSettings);
    window.emSync.getVersion().then(setVersion);
  }, []);

  if (!settings) return <div style={{ padding: 24, opacity: 0.6 }}>Loading…</div>;

  const update = async (patch: Partial<SettingsType>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await window.emSync.updateSettings(patch);
  };

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
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

      <label style={checkRow}>
        <input
          type="checkbox"
          checked={settings.cleanupRemoved}
          onChange={(e) => update({ cleanupRemoved: e.target.checked })}
          style={{ accentColor: ACCENT }}
        />
        Delete local files removed from the cloud
      </label>

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
const linkBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #3a2a1c",
  background: "#1a1d23",
  color: ACCENT,
  cursor: "pointer",
  fontSize: 13,
};

import React, { useEffect, useState } from "react";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";

type View = "loading" | "login" | "onboarding" | "dashboard" | "settings";

export function App() {
  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<any>(null);
  const [checkingNotice, setCheckingNotice] = useState(false);

  useEffect(() => {
    window.emSync.getSession().then((s) => {
      if (s.loggedIn) {
        setUser(s.user);
        setCheckingNotice(true);
        window.emSync.getSettings()
          .then((settings) => {
            setView(settings.projectStorageNoticeAcknowledged ? "dashboard" : "onboarding");
          })
          .catch(() => setView("onboarding"))
          .finally(() => setCheckingNotice(false));
      } else {
        setView("login");
      }
    });
  }, []);

  const onLoggedIn = (u: any) => {
    setUser(u);
    setCheckingNotice(true);
    window.emSync.getSettings()
      .then((settings) => {
        setView(settings.projectStorageNoticeAcknowledged ? "dashboard" : "onboarding");
      })
      .catch(() => setView("onboarding"))
      .finally(() => setCheckingNotice(false));
  };

  const onLogout = async () => {
    await window.emSync.logout();
    setUser(null);
    setView("login");
  };

  if (view === "loading" || checkingNotice) {
    return <div style={{ padding: 24, opacity: 0.6 }}>Loading…</div>;
  }
  if (view === "login") {
    return <Login onLoggedIn={onLoggedIn} />;
  }
  if (view === "settings") {
    return <Settings onBack={() => setView("dashboard")} />;
  }
  if (view === "onboarding") {
    return (
      <ProjectStorageNotice
        onContinue={async () => {
          const saved = await window.emSync.updateSettings({ projectStorageNoticeAcknowledged: true });
          if (!saved) throw new Error("The desktop app could not save this acknowledgement.");
          setView("dashboard");
        }}
      />
    );
  }
  return (
    <Dashboard
      user={user}
      onOpenSettings={() => setView("settings")}
      onLogout={onLogout}
    />
  );
}

function ProjectStorageNotice({ onContinue }: { onContinue: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  return (
    <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div style={{ color: "#F97316", fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>
          BEFORE YOU SYNC
        </div>
        <h2 style={{ margin: "6px 0 8px", fontSize: 22 }}>Project folders are working storage</h2>
        <div style={{ opacity: 0.72, fontSize: 13, lineHeight: 1.55 }}>
          Editing Machine keeps each project in its numbered folder (for example,
          <strong> 001-0001</strong>). These folders are not permanent local archives.
        </div>
      </div>
      <div style={{ ...noticeCard, display: "grid", gap: 12 }}>
        <NoticePoint title="Local additions are backed up">
          Supported files you add are uploaded automatically as production-only Smart Cloud assets.
        </NoticePoint>
        <NoticePoint title="Retired projects are removed automatically">
          After final approval or archive, the entire project folder is deleted, including hidden,
          modified, and manually added files. Routine retirement does not ask for confirmation.
        </NoticePoint>
        <NoticePoint title="Unprotected files stop cleanup">
          Unsupported, failed, quarantined, or unverified files are retained and shown with a remedy.
          Resolve every warning before that project can be removed.
        </NoticePoint>
      </div>
      <div style={{ fontSize: 12, opacity: 0.62, lineHeight: 1.45 }}>
        Keep anything that must remain outside Editing Machine in a separate folder. Local deletion
        never deletes the verified cloud original.
      </div>
      {error && <div style={{ color: "#ef4444", fontSize: 12 }}>{error}</div>}
      <button
        disabled={saving}
        style={{
          padding: "10px 14px", border: 0, borderRadius: 8, background: "#F97316",
          color: "white", fontWeight: 700, cursor: saving ? "default" : "pointer",
        }}
        onClick={async () => {
          setSaving(true);
          setError("");
          try {
            await onContinue();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save this acknowledgement.");
            setSaving(false);
          }
        }}
      >
        {saving ? "Saving…" : "I understand — start syncing"}
      </button>
    </div>
  );
}

function NoticePoint({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 8 }}>
      <span style={{ color: "#F97316" }}>●</span>
      <div>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <div style={{ fontSize: 12, opacity: 0.68, lineHeight: 1.45, marginTop: 2 }}>{children}</div>
      </div>
    </div>
  );
}

const noticeCard: React.CSSProperties = {
  padding: 16,
  borderRadius: 10,
  border: "1px solid #3a2a1c",
  background: "#1a1d23",
};

import React, { useEffect, useState } from "react";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";

type View = "loading" | "login" | "dashboard" | "settings";

export function App() {
  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    window.emSync.getSession().then((s) => {
      if (s.loggedIn) {
        setUser(s.user);
        setView("dashboard");
      } else {
        setView("login");
      }
    });
  }, []);

  const onLoggedIn = (u: any) => {
    setUser(u);
    setView("dashboard");
  };

  const onLogout = async () => {
    await window.emSync.logout();
    setUser(null);
    setView("login");
  };

  if (view === "loading") {
    return <div style={{ padding: 24, opacity: 0.6 }}>Loading…</div>;
  }
  if (view === "login") {
    return <Login onLoggedIn={onLoggedIn} />;
  }
  if (view === "settings") {
    return <Settings onBack={() => setView("dashboard")} />;
  }
  return (
    <Dashboard
      user={user}
      onOpenSettings={() => setView("settings")}
      onLogout={onLogout}
    />
  );
}

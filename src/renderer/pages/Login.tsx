import React, { useState } from "react";
import logo from "../assets/logo-orange.png";

const ACCENT = "#F97316"; // brand orange (Team palette)
const ERROR = "#ef4444"; // functional error red (not a brand accent)

export function Login({ onLoggedIn }: { onLoggedIn: (user: any) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await window.emSync.login(email, password);
      if (res.success) onLoggedIn(res.user);
      else setError("Login failed");
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 32, justifyContent: "center" }}>
      <img src={logo} alt="Editing Machine" style={{ height: 40, width: "auto", objectFit: "contain", alignSelf: "flex-start", marginBottom: 6 }} />
      <p style={{ opacity: 0.6, marginTop: 0, marginBottom: 28 }}>Sign in with your portal credentials</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={inputStyle}
        />
        {error && <div style={{ color: ERROR, fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...buttonStyle, background: ACCENT, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "11px 12px",
  borderRadius: 8,
  border: "1px solid #2a2f37",
  background: "#1a1d23",
  color: "#e6e8eb",
  fontSize: 14,
  accentColor: "#F97316",
};

const buttonStyle: React.CSSProperties = {
  padding: "11px 12px",
  borderRadius: 8,
  border: "none",
  color: "white",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  marginTop: 6,
};

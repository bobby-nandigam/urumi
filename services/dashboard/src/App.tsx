import { useEffect, useState } from "react";
import { api, getKey, setKey, ApiError } from "./api";
import { OverviewView, KeysView, ToolsView, AuditView } from "./views";

type Tab = "overview" | "keys" | "tools" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "keys", label: "API Keys" },
  { id: "tools", label: "Tools" },
  { id: "audit", label: "Audit Log" },
];

export function App() {
  // Authenticated = we hold a key that /api/overview accepted as admin.
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  // On load, if a key is already in sessionStorage, validate it silently.
  useEffect(() => {
    if (!getKey()) { setChecking(false); return; }
    api.overview().then(() => setAuthed(true)).catch(() => setKey("")).finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="center muted">Loading…</div>;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">urumi<span className="brand-dim"> · gateway</span></div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <button className="btn ghost" onClick={() => { setKey(""); setAuthed(false); }}>Sign out</button>
      </header>
      <main className="content">
        {tab === "overview" && <OverviewView />}
        {tab === "keys" && <KeysView />}
        {tab === "tools" && <ToolsView />}
        {tab === "audit" && <AuditView />}
      </main>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    setKey(value.trim());
    try {
      await api.overview(); // succeeds only for a valid admin key
      onLogin();
    } catch (e) {
      setKey("");
      setErr(e instanceof ApiError && e.status === 403
        ? "That key is valid but not an admin key."
        : "Invalid or revoked API key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="brand big">urumi<span className="brand-dim"> · gateway</span></div>
        <p className="muted">Sign in with an <strong>admin</strong> API key.</p>
        <input
          className="input" type="password" placeholder="urumi_…" autoFocus
          value={value} onChange={(e) => setValue(e.target.value)}
        />
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

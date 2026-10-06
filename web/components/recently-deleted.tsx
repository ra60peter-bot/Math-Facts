"use client";

import { useCallback, useEffect, useState } from "react";
import { accessRequest } from "../lib/access-client";

type DeletedProfile = { id: string; kind: "user" | "student"; name: string; ownerEmail?: string; deletedAt: string; restoreUntil: string };

export function RecentlyDeleted({ refreshKey, onRestored }: { refreshKey: unknown; onRestored: () => Promise<void> }) {
  const [entries, setEntries] = useState<DeletedProfile[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const result = await accessRequest("/api/recently-deleted");
    setEntries(result.entries);
  }, []);
  useEffect(() => {
    let current = true;
    accessRequest("/api/recently-deleted").then(result => { if (current) setEntries(result.entries); })
      .catch(error => { if (current) setMessage(error instanceof Error ? error.message : "Could not load deleted profiles."); });
    return () => { current = false; };
  }, [refreshKey]);

  async function restore(entry: DeletedProfile) {
    if (busy) return;
    setBusy(entry.id); setMessage("");
    try {
      await accessRequest(`/api/${entry.kind === "user" ? "users" : "students"}/${entry.id}`, { method: "PATCH" });
      await load(); await onRestored();
      setMessage(`${entry.name} was restored with their saved history and progress.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not restore this profile."); }
    finally { setBusy(""); }
  }

  return <section className="recently-deleted" aria-labelledby="recently-deleted-title">
    <h2 id="recently-deleted-title">Recently deleted</h2>
    <p className="muted">Profiles and their history are kept for 30 days, then permanently removed. Restoring an account also restores its students, except those deleted separately.</p>
    {message && <p className="notice" role="status">{message}</p>}
    {entries.length === 0 ? <p className="muted">No profiles to restore.</p> : <ul className="recovery-list">{entries.map(entry => <li key={`${entry.kind}-${entry.id}`}>
      <div><strong>{entry.name}</strong><span className="role-label">{entry.kind === "user" ? "Account owner" : "Student"}</span>
        {entry.ownerEmail && <p className="fine-print">Account: {entry.ownerEmail}</p>}
        <p className="fine-print">Restore before {new Date(entry.restoreUntil).toLocaleString()}</p></div>
      <button className="button secondary" disabled={!!busy} onClick={() => void restore(entry)}>{busy === entry.id ? "Restoring…" : `Restore ${entry.kind}`}</button>
    </li>)}</ul>}
  </section>;
}

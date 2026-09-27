"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";

export function DeleteStudentButton({ student, onDelete }: {
  student: { id: string; name: string };
  onDelete: (password: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return <><button className="button danger" onClick={() => setOpen(true)}>Delete student</button>{open && <DeleteStudentDialog student={student} onDelete={onDelete} onClose={() => setOpen(false)} />}</>;
}

function DeleteStudentDialog({ student, onDelete, onClose }: {
  student: { id: string; name: string };
  onDelete: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !password.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    const entered = password;
    setPassword("");
    try {
      await onDelete(entered);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Deletion failed. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function sendPasswordLink() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPassword("");
    try {
      const client = supabaseBrowser();
      if (!client) throw new Error("Sign in again to continue.");
      const { data, error: identityError } = await client.auth.getUser();
      if (identityError || !data.user?.email) throw new Error("Sign in again to continue.");
      const { error } = await client.auth.resetPasswordForEmail(data.user.email, {
        redirectTo: `${window.location.origin}/auth/callback`,
      });
      if (error) throw error;
      setMessage("Check your email for a password setup/reset link. After setting your password, return here to delete the student.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The password email could not be sent.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="delete-student-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={titleId}>Delete {student.name}?</h2>
    <p id={descriptionId}>This permanently deletes this student and all their practice history and progress. Enter <strong>your own Math Facts account password</strong> to confirm.</p>
    <form onSubmit={submit} autoComplete="off">
      <label>Your Math Facts password<input type="password" name="delete-student-password" autoComplete="off" required maxLength={1024} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
      <p className="muted">Use your Math Facts password. If you use Google sign-in and haven’t set one, request the email link below.</p>
      {message && <p className="notice" role="status">{message}</p>}
      <div className="table-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button danger" disabled={busy || !password.trim()}>{busy ? "Please wait…" : "Permanently delete student"}</button></div>
      <button type="button" className="button secondary password-link" disabled={busy} onClick={() => void sendPasswordLink()}>Email me a password setup/reset link</button>
    </form>
  </dialog>;
}

"use client";
import { useEffect, useState } from "react";
import { GUMDROP_AVATARS, GumdropAvatar, avatarId } from "./gumdrop-avatar";
import { PracticeDialog } from "./practice-dialog";

export function StudentAvatar({ studentId, name, editable = false }: { studentId: string; name: string; editable?: boolean }) {
  const [selected, setSelected] = useState("party");
  const [open, setOpen] = useState(false);
  const key = `math-facts-avatar:${studentId}`;
  useEffect(() => {
    const read = () => { try { setSelected(avatarId(localStorage.getItem(key))); } catch { /* Default face works without storage. */ } };
    read(); window.addEventListener("math-facts-avatar", read);
    return () => window.removeEventListener("math-facts-avatar", read);
  }, [key]);
  return <>
    {editable ? <button className="avatar-edit" onClick={() => setOpen(true)} aria-label={`Change ${name}'s avatar`}><GumdropAvatar id={selected} className="gumdrop-small"/><span>Change avatar</span></button> : <GumdropAvatar id={selected} className="profile-gumdrop"/>}
    {open && <PracticeDialog title={`${name}’s gumdrop`} onClose={() => setOpen(false)}>
      <p>Pick your favorite. You can change it whenever you like.</p>
      <div className="avatar-picker" role="group" aria-label="Choose a gumdrop avatar">{GUMDROP_AVATARS.map(avatar => <button className="avatar-option" key={avatar.id} aria-pressed={selected === avatar.id} onClick={() => {
        setSelected(avatar.id); try { localStorage.setItem(key, avatar.id); window.dispatchEvent(new Event("math-facts-avatar")); } catch { /* Keep the choice for this visit. */ }
      }}><GumdropAvatar id={avatar.id}/><strong>{avatar.name}</strong><small>{selected === avatar.id ? "✓ Selected" : "Choose"}</small></button>)}</div>
      <button className="button primary" onClick={() => setOpen(false)}>Done</button>
    </PracticeDialog>}
  </>;
}

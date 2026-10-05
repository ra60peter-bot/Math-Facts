"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function PracticeDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return <dialog className="practice-dialog" ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>×</button>
    <h2 id={titleId}>{title}</h2>{children}
  </dialog>;
}

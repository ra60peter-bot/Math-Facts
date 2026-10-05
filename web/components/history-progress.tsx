"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import type { FactCard } from "../lib/cards";
import { getProgressSummary, type AutomaticProgress } from "../lib/automaticity";
import { makeCards } from "../lib/cards";
import { MasteryProgress } from "./mastery-progress";
import type { Operation } from "../lib/learning";
import { buildProgressReport, factLabel, progressNarrative, reportLabels, reportOperations, type ReportSession, type ReportStatus, type ReportProgress } from "../lib/progress-report";

export function HistoryProgress({ name, sessions, progress, children, initialTab = "sessions", onPractice }: {
  name: string; sessions: ReportSession[]; progress?: ReportProgress | null; children: ReactNode; initialTab?: "sessions" | "report"; onPractice?: (card: FactCard) => void;
}) {
  const [tab, setTab] = useState<"sessions" | "report">(initialTab);
  const [operation, setOperation] = useState<Operation>([...sessions].sort((a,b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0]?.operation ?? "add");
  const [filter, setFilter] = useState<ReportStatus | "all">("all");
  const id = useId();
  const report = useMemo(() => buildProgressReport(operation, sessions, progress), [operation, sessions, progress]);
  const wholeProgress = progress && "events" in progress ? getProgressSummary(progress as AutomaticProgress, makeCards(operation)) : null;
  const narrative = progressNarrative(report, name);
  const rows = report.facts.filter(f => filter === "all" || f.status === filter);
  return <section className="history-progress" aria-label={`${name} history and progress`}>
    <div className="history-tabs" role="tablist" aria-label="History views">
      {(["sessions", "report"] as const).map(value => <button key={value} id={`${id}-${value}-tab`} role="tab" aria-selected={tab === value} aria-controls={`${id}-${value}`} tabIndex={tab === value ? 0 : -1}
        onClick={() => setTab(value)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "sessions" : event.key === "End" ? "report" : tab === "sessions" ? "report" : "sessions";
          setTab(next); document.getElementById(`${id}-${next}-tab`)?.focus();
        }}>{value === "sessions" ? "Sessions" : "Progress report"}</button>)}
    </div>
    <div id={`${id}-sessions`} role="tabpanel" aria-labelledby={`${id}-sessions-tab`} hidden={tab !== "sessions"}>{children}</div>
    <div id={`${id}-report`} role="tabpanel" aria-labelledby={`${id}-report-tab`} hidden={tab !== "report"}>
      <div className="report-heading"><div><p className="report-eyebrow">A little practice, every day</p><h2>{name}’s progress report</h2></div>
        <label>Operation<select value={operation} onChange={e => { setOperation(e.target.value as Operation); setFilter("all"); }}>{(Object.keys(reportOperations) as Operation[]).map(op => <option key={op} value={op}>{reportOperations[op]}</option>)}</select></label></div>
      {wholeProgress && <MasteryProgress score={wholeProgress.score} subject={reportOperations[operation]} studentName={name} factCount={report.total} assessedCount={wholeProgress.assessed}/>}
      <section className="report-story" aria-label="Your progress summary"><h3>How you’re doing</h3>{narrative.map((text,i) => <p key={i}>{text}</p>)}</section>
      <dl className="report-stats">
        <div><dt>Facts practiced</dt><dd>{report.practiced}<small> / {report.total}</small></dd></div>
        <div><dt>Mastered</dt><dd>{report.counts.mastered}<small> / {report.total}</small></dd></div>
        <div><dt>History accuracy</dt><dd>{report.accuracy === null ? "—" : `${report.accuracy.toFixed(0)}%`}</dd></div>
        <div><dt>Correct-answer average</dt><dd>{report.averageMs === null ? "—" : `${(report.averageMs / 1000).toFixed(2)}s`}</dd></div>
      </dl>
      <section aria-labelledby={`${id}-facts`}>
        <div className="report-heading"><div><h3 id={`${id}-facts`}>Every fact, one step at a time</h3><p className="muted">All {report.total} {reportOperations[operation].toLowerCase()} facts, including those you haven’t tried.</p></div>
          <label>Show facts<select value={filter} onChange={e => setFilter(e.target.value as ReportStatus | "all")}><option value="all">All facts ({report.total})</option>{(Object.keys(reportLabels) as ReportStatus[]).map(status => <option key={status} value={status}>{reportLabels[status]} ({report.counts[status]})</option>)}</select></label></div>
        <p className="report-note">Mastered means verified on later spaced checks. Fast answers are within 1.5 seconds; slower correct answers still show learning. Recorded tries, accuracy, and averages use the sessions currently in History. Saved mastery and latest performance remain when history is deleted.</p>
        <div className="table-scroll"><table className="history-table report-table"><caption className="sr-only">{reportOperations[operation]} fact progress for {name}</caption><thead><tr><th scope="col">Fact</th><th scope="col">Status</th><th scope="col">Latest result</th><th scope="col">Recorded tries</th><th scope="col">Accuracy</th><th scope="col">Correct-answer average</th>{onPractice && <th scope="col"><span className="sr-only">Practice</span></th>}</tr></thead>
          <tbody>{rows.map(f => <tr key={f.card.id}><th scope="row">{factLabel(f.card)}</th><td><span className="fact-report-status" data-status={f.status}>{reportLabels[f.status]}</span></td><td>{f.latestMs === null ? "—" : `${f.latestCorrect ? "Correct" : "Wrong / assisted"} · ${(f.latestMs / 1000).toFixed(2)}s`}</td><td>{f.count}</td><td>{f.accuracy === null ? "—" : `${f.accuracy.toFixed(0)}%`}</td><td>{f.averageMs === null ? "—" : `${(f.averageMs / 1000).toFixed(2)}s`}</td>{onPractice && <td><button className="text-button" onClick={() => onPractice(f.card)}>Practice →</button></td>}</tr>)}</tbody></table></div>
        {rows.length === 0 && <p className="empty">No facts in this category yet.</p>}
      </section>
    </div>
  </section>;
}

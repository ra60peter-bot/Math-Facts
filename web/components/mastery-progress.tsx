import { useId } from "react";

export function MasteryProgress({ score, subject, studentName, factCount, assessedCount }: {
  score: number;
  subject: string;
  studentName: string;
  factCount: number;
  assessedCount: number;
}) {
  const titleId = useId();
  const value = Math.max(0, Math.min(1000, Math.round(score)));
  return <section className="mastery-progress" aria-labelledby={titleId}>
    <div className="mastery-progress-heading">
      <div><h3 id={titleId}>{subject} progress</h3><p>{studentName} · {assessedCount}/{factCount} subject facts assessed</p></div>
      <div className="mastery-progress-score"><strong>{value.toLocaleString("en-US")}</strong><span>/ 1,000</span></div>
    </div>
    <div className="mastery-progress-track" role="progressbar" aria-labelledby={titleId} aria-valuemin={0} aria-valuemax={1000} aria-valuenow={value} aria-valuetext={`${studentName}: ${value} out of 1000 in ${subject.toLowerCase()}`}>
      <div className="mastery-progress-fill" style={{ width: `${value / 10}%` }} />
      <span className="mastery-progress-marker" style={{ left: `${value / 10}%` }} />
    </div>
    <div className="mastery-progress-scale" aria-hidden="true"><span>0</span><span>500</span><span>1,000</span></div>
    <p className="mastery-progress-caption">{assessedCount === 0 ? "Not assessed yet. Progress covers the whole subject." : "1,000 = every fact in this subject correct within 1.5s, regardless of practice selection."}</p>
  </section>;
}

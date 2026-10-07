export type PracticeResultValue = {
  text: string;
  tone: "good" | "slow" | "wrong";
  detail?: string;
  detailTone?: "good" | "slow";
  correctAnswer?: number;
};

export function PracticeResult({ result, placeholder }: { result: PracticeResultValue | null; placeholder: string }) {
  return <div className="practice-result">
    <div className={`result ${result?.tone ?? ""}`}>{result?.text ?? placeholder}</div>
    {result?.detail && <div className={`result-timing ${result.detailTone ?? "good"}`}>{result.detail}</div>}
  </div>;
}

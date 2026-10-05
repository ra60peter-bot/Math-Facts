import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MathFactsApp } from '../web/components/math-facts-app';
import { ThemeToggle } from '../web/components/theme-toggle';
import { seedFixture } from './baseline-fixture';
import { NumberSpeechRecognition, replay, type ReplayOutcome } from './baseline-speech';

// This origin is separate from production. No account credentials or remote data.
seedFixture();
window.SpeechRecognition = NumberSpeechRecognition;
window.webkitSpeechRecognition = NumberSpeechRecognition;
window.addEventListener('error', event => replay.log(`Error: ${event.message}`));
window.addEventListener('unhandledrejection', event => replay.log(`Rejected: ${String(event.reason)}`));
document.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest('button');
  if(!button || !['Start practice','Resume session','Repeat'].includes(button.textContent?.trim() ?? ''))return;
  replay.log(`Clicked ${button.textContent?.trim()}. Enabled: ${!button.disabled}.`);
  window.setTimeout(() => {
    const id = localStorage.getItem('math-facts-web-active-user');
    const saved = JSON.parse(localStorage.getItem(`math-facts-web-local-progress:${id}`) ?? '{}');
    replay.log(`Fixture session: ${saved.automaticity?.session?.status ?? 'none'}; question visible: ${Boolean(document.querySelector('.fact'))}.`);
  }, 400);
}, true);

function ReplayPanel() {
  useSyncExternalStore(replay.subscribe, replay.snapshot);
  return <details className="audit-panel"><summary>Current UI · simulated speech / sample data</summary><div className="audit-content">
    <p className="audit-note">Actual application component and CSS. This local developer mode includes owner controls; hosted student access differs. No real microphone, account, or production data.</p>
    <label>Automatically replay each answer<select value={replay.outcome()} onChange={event => replay.setOutcome(event.target.value as ReplayOutcome)}>
      <option value="manual">Manual (four-second window)</option><option value="correct">Correct · 0.85 seconds</option><option value="slow">Correct but slow · 2.10 seconds</option><option value="wrong">Wrong number · 0.85 seconds</option><option value="unrecognized">Speech not understood</option><option value="microphone">Microphone failure</option>
    </select></label>
    <p>Set an outcome before Start, Next, or Mic. The app’s own four-second deadline and result screens are unchanged.</p>
    <div className="audit-buttons">{(['correct','slow','wrong','unrecognized','microphone'] as const).map(outcome => <button key={outcome} disabled={!replay.ready()} onClick={() => replay.answer(outcome)}>{outcome}</button>)}</div>
    <div className="audit-buttons"><button onClick={() => { seedFixture(true); window.location.reload(); }}>Reset fictional data</button><a href="/">Proposed design</a><a href="/report.html">Review</a></div>
    <details><summary>Replay diagnostics</summary><ul>{replay.trace().map((message,index)=><li key={index}>{message}</li>)}</ul></details>
  </div></details>;
}
createRoot(document.getElementById('root')!).render(<><ThemeToggle /><MathFactsApp /></>);
createRoot(document.getElementById('audit-controls')!).render(<ReplayPanel />);

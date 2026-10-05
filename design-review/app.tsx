import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { prepareVoice, startVoiceAttempt, unlockVoice, releaseVoiceAudio } from './live-voice';
import { GUMDROP_AVATARS, GumdropAvatar, avatarId } from './avatars';
import { buildRoundQueue } from './round-order';
import { RoundCelebration, chooseCelebration, prepareCelebrationAudio, shouldCelebrateRound, type CelebrationChoice } from './round-celebration';
import { makeCards, answerFor, names, symbols, label, operations, summary, withRounds, factStatus, statusLabels, roundMetrics, type FactCard, type Operation, type Result, type Round } from './data';

const KEY='auto-math-facts-design-preview-v2';
function readSaved(){try{return JSON.parse(localStorage.getItem(KEY)||'{}');}catch{return {};}}
const saved=readSaved();
const MIC_KEY='auto-math-facts-preview-microphone-confirmed';
function readMicConfirmed(){try{return localStorage.getItem(MIC_KEY)==='true';}catch{return false;}}
const Icon=({name}:{name:string})=><span aria-hidden="true" className={`icon icon-${name}`}>{({practice:'✦',progress:'▥',history:'◷',arrow:'→',check:'✓',close:'×',pause:'Ⅱ',mic:'◉',settings:'⚙',back:'←'} as Record<string,string>)[name]||name}</span>;
function App(){
  const [student,setStudent]=useState<string|null>(null);
  const [people,setPeople]=useState<string[]>(saved.people||['Maya','Alex']);
  const [avatars,setAvatars]=useState<Record<string,string>>(saved.avatars||{});
  const [avatarStudent,setAvatarStudent]=useState<string|null>(null);
  const [screen,setScreen]=useState('pick');
  const [operation,setOperation]=useState<Operation>(saved.operation||'mul');
  const [count,setCount]=useState(saved.count||10);
  const [selected,setSelected]=useState<Record<string,string[]>>(saved.selected||{});
  const [rounds,setRounds]=useState<Round[]>(saved.rounds||[]);
  const [simulated,setSimulated]=useState(false);
  const [engine,setEngine]=useState('loading');
  const [voiceMessage,setVoiceMessage]=useState('');
  const [micHeard,setMicHeard]=useState('');
  const [micConfirmed,setMicConfirmed]=useState(readMicConfirmed);
  const [mic,setMic]=useState(readMicConfirmed()?'ready':'unchecked');
  const [theme,setTheme]=useState(saved.theme||'dark');
  const [showTimes,setShowTimes]=useState(saved.showTimes??true);
  const [sound,setSound]=useState(false);
  const [motion,setMotion]=useState(saved.motion??true);
  const [celebrationSound,setCelebrationSound]=useState(saved.celebrationSound??true);
  const [dialog,setDialog]=useState<string|null>(null);
  const [ownerPassword,setOwnerPassword]=useState('');
  const [newName,setNewName]=useState('');
  const [notice,setNotice]=useState('');
  const [queue,setQueue]=useState<FactCard[]>([]);
  const [index,setIndex]=useState(0);
  const [results,setResults]=useState<Result[]>([]);
  const [step,setStep]=useState('opening');
  const [questionVisible,setQuestionVisible]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const [last,setLast]=useState<Result|null>(null);
  const [retry,setRetry]=useState(false);
  const [issues,setIssues]=useState(0);
  const [heard,setHeard]=useState('');
  const [filter,setFilter]=useState('all');
  const [expanded,setExpanded]=useState<string|null>(null);
  const [endRound,setEndRound]=useState<Round|null>(null);
  const [celebration,setCelebration]=useState<CelebrationChoice|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const voice=useRef<{cancel:()=>void}|null>(null);
  const calibrationVersion=useRef(0);
  const roundActive=useRef(false);
  const heading=useRef<HTMLHeadingElement|null>(null);
  const modal=useRef<HTMLDialogElement|null>(null);
  const returnFocus=useRef<HTMLElement|null>(null);
  const card=queue[index];
  const deck=makeCards(operation);
  const chosen=selected[operation]??deck.map(c=>c.id);
  const progress=summary(student||'Maya',operation,rounds);
  const p=withRounds(student||'Maya',rounds);

  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
  useEffect(()=>{try{localStorage.setItem(KEY,JSON.stringify({people,avatars,operation,count,selected,rounds,theme,showTimes,motion,celebrationSound}));}catch{setNotice('Preview storage is unavailable. This visit still works.');}},[people,avatars,operation,count,selected,rounds,theme,showTimes,motion,celebrationSound]);
  useEffect(()=>{heading.current?.focus();window.scrollTo(0,0);},[screen]);
  useEffect(()=>{
    if(dialog){returnFocus.current=document.activeElement as HTMLElement;modal.current?.showModal();}
    else {modal.current?.close();returnFocus.current?.focus();}
  },[dialog]);
  useEffect(()=>{let active=true;prepareVoice().then(()=>{if(active)setEngine('ready');}).catch(error=>{if(active){setEngine('failed');setVoiceMessage(error instanceof Error?error.message:'Number recognition could not load.');}});return()=>{active=false;stopVoice();releaseVoiceAudio();if(timer.current)clearTimeout(timer.current);};},[]);
  useEffect(()=>{
    if(screen!=='practice'||dialog||!card||['feedback','disputed','recovery'].includes(step))return;
    if(simulated){setQuestionVisible(true);setStep('listening');return;}
    let active=true, frame=0;
    setQuestionVisible(false);setStep('opening');setHeard('');setVoiceMessage('');
    const session=startVoiceAttempt({
      onReady:markShown=>{frame=requestAnimationFrame(()=>{if(!active)return;flushSync(()=>{setQuestionVisible(true);setStep('listening');});markShown(performance.now());});},
      onTranscript:text=>{if(active)setHeard(text);},
      onProcessing:()=>{if(active)setStep('checking');},
      onAnswer:(value,text,ms)=>{if(active)grade(value!==answerFor(card)?'wrong':ms===null?'untimed':ms<=1500?'fast':'slow',ms,text);},
      onFailure:message=>{if(active){setIssues(n=>n+1);setVoiceMessage(message);setStep('recovery');}},
    });
    voice.current=session;
    return()=>{active=false;cancelAnimationFrame(frame);session.cancel();if(voice.current===session)voice.current=null;};
  },[screen,index,attempt,dialog,simulated]);
  useEffect(()=>{
    if(screen!=='practice'||dialog||!['feedback','disputed'].includes(step))return;
    const delay=step==='disputed'?1400:last?.outcome==='wrong'?4000:last?.outcome==='slow'?1800:1200;
    const advance=setTimeout(nextQuestion,delay);
    return()=>clearTimeout(advance);
  },[screen,step,last,dialog]);

  function stopVoice(){calibrationVersion.current++;voice.current?.cancel();voice.current=null;}
  function avatarFor(name:string){return avatarId(avatars[name],people.indexOf(name));}
  function chooseAvatarFor(name:string){setAvatarStudent(name);openDialog('avatar');}
  function choosePerson(name:string){stopVoice();releaseVoiceAudio();setStudent(name);setScreen('home');setNotice('');setMic(micConfirmed?'ready':'unchecked');}
  function chooseOperation(op:Operation){setOperation(op);setFilter('all');}
  function pickFacts(ids:string[]){setSelected(s=>({...s,[operation]:ids}));}
  function toggleFact(id:string){pickFacts(chosen.includes(id)?chosen.filter(v=>v!==id):[...chosen,id]);}
  function toggleGroup(ids:string[]){pickFacts(ids.every(id=>chosen.includes(id))?chosen.filter(id=>!ids.includes(id)):[...new Set([...chosen,...ids])]);}
  function go(where:string){setCelebration(null);stopVoice();releaseVoiceAudio();if(mic!=='ready')setMic('unchecked');if(!student&&['home','progress','history','preflight'].includes(where)){setScreen('pick');setNotice('Choose a student first.');return;}setScreen(where);setNotice('');}
  async function start(){
    if(!chosen.length)return;
    setCelebration(null);setNotice('');
    if(!micConfirmed&&!simulated){setScreen('preflight');return;}
    stopVoice();unlockVoice();const version=calibrationVersion.current;
    setNotice('Preparing microphone…');
    try{if(!simulated)await prepareVoice();if(version!==calibrationVersion.current)return;setEngine('ready');setNotice('');beginRound();}
    catch{if(version!==calibrationVersion.current)return;setNotice('Number recognition could not load. Try Start practice again, or use Microphone troubleshooting in Family controls.');releaseVoiceAudio();}
  }
  async function checkMic(){
    stopVoice();setVoiceMessage('');setMicHeard('');
    if(simulated&&screen!=='miccheck'){setMic('ready');return;}
    unlockVoice();const version=calibrationVersion.current;
    setMic('loading');
    try{await prepareVoice();if(version!==calibrationVersion.current)return;setEngine('ready');setMic('checking');
      voice.current=startVoiceAttempt({calibration:true,
        onReady:mark=>{mark(performance.now());setMic('listening');},
        onTranscript:setMicHeard,
        onProcessing:()=>setMic('processing'),
        onAnswer:(_value,text)=>{setMicHeard(text);setMic('ready');setMicConfirmed(true);try{localStorage.setItem(MIC_KEY,'true');}catch{setNotice('Microphone confirmed for this visit. Browser storage is unavailable, so it cannot be remembered after closing the page.');}releaseVoiceAudio();},
        onFailure:message=>{setVoiceMessage(message);setMic('failed');releaseVoiceAudio();},
      });
    }catch(error){if(version!==calibrationVersion.current)return;setEngine('failed');setMic('failed');setVoiceMessage(error instanceof Error?error.message:'The microphone could not start.');releaseVoiceAudio();}
  }
  function beginRound(){
    stopVoice();if(!simulated)unlockVoice();
    const enabled=deck.filter(c=>chosen.includes(c.id));if(!enabled.length)return;
    if(celebrationSound)prepareCelebrationAudio();
    setCelebration(null);
    roundActive.current=true;
    setQueue(buildRoundQueue(enabled,count));setIndex(0);setResults([]);setIssues(0);setLast(null);setRetry(false);setStep('opening');setQuestionVisible(false);setHeard('');setScreen('practice');setAttempt(n=>n+1);
  }
  function beep(){if(!sound)return;try{const ctx=new AudioContext();const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=660;g.gain.setValueAtTime(.035,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.17);o.connect(g).connect(ctx.destination);o.start();o.stop(ctx.currentTime+.18);o.onended=()=>void ctx.close();}catch{/* Sound never blocks the round. */}}
  function grade(outcome:'fast'|'slow'|'wrong'|'untimed',ms:number|null,text:string){
    if(!roundActive.current)return;
    const r:Result={card,outcome,ms:retry?null:ms,heard:text,mode:'speech',retry};setLast(r);setResults(old=>[...old,r]);setStep('feedback');if(outcome!=='wrong')beep();
  }
  function simulate(which:string){
    if(step!=='listening'||!simulated)return;
    if(which==='failure'){setIssues(n=>n+1);setStep('recovery');return;}
    const heard=String(answerFor(card)+(which==='wrong'?1:0));
    setHeard(heard);setStep('checking');
    timer.current=setTimeout(()=>grade(which==='slow'?'slow':which==='wrong'?'wrong':which==='uncertain'?'untimed':'fast',which==='uncertain'?null:which==='slow'?2240:1080,heard),which==='delay'?1800:280);
  }
  function nextQuestion(){if(!roundActive.current)return;stopVoice();if(timer.current)clearTimeout(timer.current);if(index+1>=queue.length){finish();return;}setIndex(i=>i+1);setLast(null);setRetry(false);setHeard('');setQuestionVisible(false);setStep('opening');}
  function tryAgain(){stopVoice();if(!simulated)unlockVoice();setRetry(true);setHeard('');setQuestionVisible(false);setStep('opening');setNotice('');setAttempt(n=>n+1);}
  function dispute(){setResults(old=>old.map((r,i)=>i===old.length-1?{...r,outcome:'disputed',ms:null}:r));setLast(r=>r?{...r,outcome:'disputed',ms:null}:null);setStep('disputed');}
  function finish(){
    if(!roundActive.current)return;roundActive.current=false;
    stopVoice();releaseVoiceAudio();
    if(timer.current)clearTimeout(timer.current);
    const r:Round={id:crypto.randomUUID(),student:student||'Maya',operation,results,total:queue.length,at:new Date().toISOString(),problems:issues};
    setRounds(old=>[...old,r]);setEndRound(r);setDialog(null);setScreen('results');
    setCelebration(shouldCelebrateRound(r)?chooseCelebration():null);
  }
  function openDialog(name:string){stopVoice();releaseVoiceAudio();if(timer.current)clearTimeout(timer.current);if(screen==='preflight'&&mic!=='ready')setMic('unchecked');if(screen==='practice'&&['opening','listening','checking'].includes(step)){setStep('opening');setQuestionVisible(false);setRetry(true);}setDialog(name);}
  function pause(){openDialog('pause');}
  function resume(){if(screen==='practice'&&!simulated)unlockVoice();setDialog(null);}
  function savePrefs(e:React.FormEvent){e.preventDefault();setDialog(null);setNotice('Preferences saved for this preview.');}
  const opTabs=<div className="operation-tabs" role="group" aria-label="Operation">{operations.map(op=><button key={op} aria-pressed={operation===op} onClick={()=>chooseOperation(op)}><span aria-hidden="true">{symbols[op]}</span>{names[op]}</button>)}</div>;
  const controls=<div className="preview-bar"><span><b>Design preview</b> · Sample profiles · {simulated?'Simulated speech':'Real microphone · local number recognition'}</span><div><a href="/report.html">Review &amp; research</a><a href="/current.html" target="_blank" rel="noreferrer">Current UI comparison ↗</a><button onClick={()=>openDialog('guide')}>How to try it</button></div></div>;
  const headingText=screen==='home'?`Ready for a quick round, ${student}?`:screen==='progress'?'See your progress':screen==='history'?'Your practice history':screen==='miccheck'?'Microphone troubleshooting':screen==='preflight'?'One-time sound check':screen==='owner'?'Family workspace':'Your round, in focus';

  return <>
    <a className="skip-link" href="#main">Skip to content</a>{controls}
    {screen==='pick'?<main className="welcome" id="main">
      <div className="brand"><span className="brand-mark" aria-hidden="true">÷</span><span>Auto Math Facts</span></div>
      <span className="eyebrow">A little practice. Stronger recall.</span><h1 ref={heading} tabIndex={-1}>Who's practicing?</h1><p className="lead">Choose your name. Your facts and progress are ready.</p>
      <div className="profile-grid">{people.map(name=><div className="profile-tile" key={name}><button className="profile-card" onClick={()=>choosePerson(name)}><GumdropAvatar id={avatarFor(name)} className="profile-gumdrop"/><strong>{name}</strong><span>Let's practice <Icon name="arrow"/></span></button><button className="profile-avatar-edit" onClick={()=>chooseAvatarFor(name)} aria-label={`Choose avatar for ${name}`}>Choose avatar</button></div>)}</div>
      <div className="adult-entry"><span>This preview represents a connected family computer.</span><button className="text-button" onClick={()=>{setOwnerPassword('');setDialog('owner');}}>Parent / account owner <span aria-hidden="true">↗</span></button></div>
      <button className="text-button subtle" onClick={()=>{setOwnerPassword('');setDialog('firstvisit');}}>Preview first-device setup</button>
    </main>:screen==='practice'?<main className="practice-stage" id="main">
      <header className="round-header"><div><GumdropAvatar id={avatarFor(student||'Maya')} className="gumdrop-small"/><div><b>{student}</b><span>{names[operation]}</span></div></div><div className="round-count"><b>{Math.min(index+1,queue.length)} <span>/ {queue.length}</span></b><span>questions</span></div><div className="round-header-actions"><button className="button secondary" onClick={pause}><Icon name="pause"/> Pause</button><button className="button end-round" onClick={finish}><Icon name="close"/> End round early</button></div></header>
      <div className="round-track" role="progressbar" aria-label="Round completed" aria-valuenow={results.length} aria-valuemin={0} aria-valuemax={queue.length}><span style={{width:`${results.length/queue.length*100}%`}}/></div>
      <section className={`question-area ${dialog==='avatar'&&avatarStudent?<><span className="eyebrow">Make it yours</span><h2 id="dialog-title">{avatarStudent}’s gumdrop</h2><p>Pick your favorite. You can change it whenever you like.</p><div className="avatar-picker" role="group" aria-label="Choose a gumdrop avatar">{GUMDROP_AVATARS.map(avatar=><button key={avatar.id} className="avatar-option" aria-pressed={avatarFor(avatarStudent)===avatar.id} onClick={()=>setAvatars(old=>({...old,[avatarStudent]:avatar.id}))}><GumdropAvatar id={avatar.id}/><strong>{avatar.name}</strong><span className="avatar-selection">{avatarFor(avatarStudent)===avatar.id?'✓ Selected':'Choose'}</span></button>)}</div><p className="fine-print">Saved for {avatarStudent} on this preview.</p><button className="button primary avatar-done" onClick={()=>setDialog(null)}>Done</button></>:dialog==='pause'?'concealed':''}`} aria-hidden={dialog==='pause'}>
        <span className="eyebrow">{questionVisible?'Say just the answer':'Wait for the microphone'}</span>
        <h1 className={questionVisible?'equation':'preparing-question'} aria-label={questionVisible&&card?`${card.a} ${operation==='mul'?'times':operation==='add'?'plus':'minus'} ${card.b}`:undefined} aria-live="polite">{questionVisible&&card?label(card):step==='recovery'?'Microphone needs attention':'Getting ready…'}</h1>
        <div className="answer-zone" aria-live="polite" aria-atomic="true">
          {step==='opening'&&<><div className="status-title blue">Opening the microphone…</div><p>The question appears when listening begins.</p></>}
          {step==='listening'&&<><div className="listening-pill"><span className="listen-dot"/><b>Listening</b></div><p>{retry?'Retry practice · this question will not earn a speed or mastery result.':'Your response time stops when you start speaking.'}</p></>}
          {step==='checking'&&<><div className="status-title"><span className="checking-dot"/>Checking your answer…</div><p>You can stop speaking. Recognition delay does not add to your response time.</p></>}
          {step==='recovery'&&<><div className="status-title blue">I couldn't catch that.</div><p>{voiceMessage||'No number was recognized.'}<br/>No answer was scored. Try again when you're ready.</p><div className="actions centered"><button className="button primary" onClick={tryAgain}><Icon name="mic"/> Try microphone again</button></div></>}
          {step==='disputed'&&<><div className="status-title blue">Thanks for letting us know.</div><p>Marked “recognition disputed,” not a math mistake.<br/>Moving on automatically.</p></>}
          {step==='feedback'&&last&&<>
            <div className={`status-title ${last.outcome==='wrong'?'red':last.outcome==='slow'?'gold':'green'}`}><Icon name={last.outcome==='wrong'?'close':'check'}/>{last.outcome==='wrong'?'Not quite.':last.outcome==='slow'&&last.ms!==null?'Correct. Building speed.':'Correct!'}{showTimes&&last.ms!==null&&<span className="response-time">{(last.ms/1000).toFixed(2)}s</span>}</div>
            <p>{last.outcome==='wrong'?<>We heard <b>{last.heard}</b>. <strong>{label(card)} = {answerFor(card)}</strong></>:last.ms===null?(last.retry?'Retry practice · no speed or mastery result':'Correct answer · timing unavailable'):last.outcome==='slow'?'You knew it. The speed goal is 1.50 seconds.':'Within your 1.50-second goal.'}</p>
            <p className="auto-next-note">{index+1===queue.length?'Opening your results automatically…':'Next question starts automatically…'}</p>
            {last.outcome==='wrong'&&<button className="button secondary" onClick={dispute}>That's not what I said</button>}
          </>}
        </div>
      </section>
      <footer className="round-footer"><span><Icon name="mic"/> {simulated?'Simulation for design testing':'On-device voice recognition'} <span className="separator">·</span> {retry?'A fresh check will come later':'Questions advance automatically'}</span><span className="heard-transcript">{heard?`Heard: ${heard}`:'Say the answer when Listening appears.'}</span></footer>
      {simulated&&<details className="demo-controls" open><summary>Design test controls · simulated answers</summary><p>The microphone is off in this test mode. Results and times here are simulated.</p><div>{[['fast','Correct · 1.08s'],['slow','Correct · 2.24s'],['wrong','Wrong answer'],['failure','Speech not understood'],['delay','Delayed recognition'],['uncertain','Timing unavailable']].map(([key,text])=><button key={key} disabled={step!=='listening'||Boolean(dialog)} onClick={()=>simulate(key)}>{text}</button>)}</div></details>}
    </main>:<div className="shell">
      <aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true">÷</span><span>Auto<br/>Math Facts</span></div><div className="identity">{student?<button className="avatar-change" onClick={()=>chooseAvatarFor(student)} aria-label={"Change avatar for "+student}><GumdropAvatar id={avatarFor(student)} className="gumdrop-small"/></button>:<span className="avatar small">P</span>}<div><strong>{student||'Parent'}</strong><span>{screen==='owner'?'Account owner':'My workspace'}</span>{student&&<button className="avatar-change-label" onClick={()=>chooseAvatarFor(student)}>Change avatar</button>}</div></div><nav aria-label="Main navigation">{student?[['home','practice','Practice'],['progress','progress','My progress'],['history','history','History']].map(([where,icon,title])=><button key={where} aria-current={screen===where?'page':undefined} onClick={()=>go(where)}><Icon name={icon}/>{title}</button>):<button aria-current="page" onClick={()=>go('owner')}>Family controls</button>}</nav><button className="text-button switch" onClick={()=>{setStudent(null);go('pick');}}>Switch person <Icon name="arrow"/></button><div className="sidebar-bottom"><button className="text-button" onClick={()=>openDialog('settings')}><Icon name="settings"/> Preferences</button><button className="text-button" onClick={()=>openDialog('help')}>Help with the microphone</button></div></aside>
      <main id="main" className="workspace"><header className="page-header"><div><p className="eyebrow">{screen==='progress'?'Small steps add up':screen==='history'?'A record of your effort':screen==='results'?'Practice counts':screen==='owner'?'Setup, kept separate':'Make the facts feel familiar'}</p><h1 ref={heading} tabIndex={-1}>{screen==='results'?'Nice work showing up.':headingText}</h1></div><button className="theme-button" aria-label={`Use ${theme==='dark'?'light':'dark'} theme`} onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?'☼':'☾'}</button></header>
      {notice&&<p className="notice" role="status">{notice}</p>}
      {screen==='home'&&<>
        {opTabs}
        <section className="practice-builder"><div className="round-plan"><span className="step-label">YOUR NEXT ROUND</span><h2>{names[operation]}</h2><p>Build quick recall.<br/>Choose any facts, any time.</p><label className="field-label">Round length<select value={count} onChange={e=>setCount(Number(e.target.value))}><option value="10">10 questions · quick round</option><option value="20">20 questions</option><option value="30">30 questions</option><option value="40">40 questions</option><option value="50">50 questions</option><option value="100">100 questions</option></select></label><div className="voice-plan"><b><Icon name="mic"/> Speak your answers</b><small>Questions move on automatically.<br/>Goal: start your answer within 1.50s.</small></div><button className="button primary start-round" disabled={!chosen.length} onClick={()=>void start()}>{micConfirmed?'Start practice':'Get ready'} <Icon name="arrow"/></button><small>{chosen.length?`${chosen.length} ${chosen.length===1?'fact':'facts'} selected · repeat as much as you like`:'Choose at least one fact to begin.'}</small></div>
        <div className="fact-picker"><div className="section-heading"><div><h2>Choose your facts</h2><p>{operation==='mul'?'Factors 2–12':operation==='add'?'Numbers 1–9':'Positive differences · numbers 1–10'}</p></div><div className="small-actions"><button onClick={()=>pickFacts(deck.map(c=>c.id))}>All</button><button onClick={()=>pickFacts([])}>Clear</button></div></div><FactGrid operation={operation} chosen={chosen} onToggle={toggleFact} onGroup={toggleGroup}/><p className="grid-help"><b>Top = first number.</b> Left = second. Select a heading for a whole group.</p></div></section>
        <section className="progress-strip"><div><span className="mini-label">{names[operation]} · all {deck.length} facts</span><b>{progress.score} <small>/ 1,000</small></b></div><div className="strip-meter"><Meter value={progress.score}/><span>Latest accuracy + speed · {progress.verified} facts mastered over time</span></div><button className="text-button" onClick={()=>go('progress')}>See my progress <Icon name="arrow"/></button></section>
      </>}
      {(screen==='preflight'||screen==='miccheck')&&<section className="preflight panel">
        <button className="text-button" onClick={()=>go(screen==='miccheck'?'owner':'home')}><Icon name="back"/> {screen==='miccheck'?'Back to family controls':'Back to my choices'}</button>
        <div className={`mic-orb ${mic==='ready'?'ready':''}`} aria-hidden="true"><Icon name={mic==='ready'?'check':'mic'}/></div>
        <h2>{mic==='ready'?'Ready when you are.':mic==='listening'?'Say a number, such as eight.':mic==='processing'?'Checking what we heard…':mic==='failed'?'Let’s get your microphone working.':mic==='loading'?'Preparing number recognition…':mic==='checking'?'Opening the microphone…':'Let’s make sure we can hear you.'}</h2>
        <p className="lead" role="status">{mic==='ready'?'When a question appears, say just the answer. Each result leads to the next question automatically.':mic==='failed'?voiceMessage:mic==='listening'?'Speak one number in your usual voice. This is a sound check, not a scored question.':mic==='processing'?'You can stop speaking while we check your number.':mic==='loading'?'The local speech engine may take a moment to load the first time.':mic==='checking'?'Allow microphone access if your browser asks.':simulated?'Design testing mode is on. The microphone is off and answers will be simulated.':'Try one number before your round. Allow microphone access when your browser asks. Your voice is processed on this device.'}</p>
        {micHeard&&<p className="mic-transcript">Heard: <strong>{micHeard}</strong></p>}
        <p className="fine-print">One successful check is remembered for all students in this browser on this computer. You can run it again from Family controls.</p>{screen!=='miccheck'&&<div className="round-preview">{count} questions <span>·</span> {names[operation]} <span>·</span> {chosen.length} selected facts</div>}
        <div className="actions centered">{mic==='ready'&&screen!=='miccheck'?<button className="button primary" onClick={beginRound}>Start my round <Icon name="arrow"/></button>:<button className="button primary" disabled={['loading','checking','listening','processing'].includes(mic)} onClick={()=>void checkMic()}>{screen==='miccheck'?'Run microphone check':mic==='failed'?'Try microphone again':'Try the microphone'}</button>}</div>
        <p className="fine-print">{simulated?'Simulated speech for interface testing.':engine==='loading'?'Preparing the on-device number recognition engine…':engine==='failed'?'The speech engine needs another try. Use the microphone button above to retry.':'On-device number recognition · your audio is not uploaded.'}</p>
        {mic==='failed'&&<p className="fine-print">If the embedded preview cannot open your microphone, open <b>http://localhost:4173/</b> directly in Chrome or Edge and allow microphone access there.</p>}
        <details className="demo-note"><summary>Design testing options</summary><label className="check-row"><input type="checkbox" checked={simulated} onChange={e=>{stopVoice();releaseVoiceAudio();setSimulated(e.target.checked);setMic('unchecked');setMicHeard('');setVoiceMessage('');}}/>Use simulated answers for interface testing</label><p>Real voice is the default. This optional test mode lets you inspect result states without speaking.</p></details>
      </section>}
      {screen==='results'&&endRound&&<Results round={endRound} score={progress.score} onRepeat={()=>void start()} onProgress={()=>go('progress')} onHome={()=>go('home')}/>}
      {screen==='progress'&&<>{opTabs}<section className="progress-overview"><div className="panel progress-main"><span className="mini-label">LATEST PERFORMANCE · ALL {deck.length} FACTS</span><div className="large-score">{progress.score}<span>/ 1,000</span></div><Meter value={progress.score}/><p>Correct answers earn progress. Quick answers earn more.<br/>1,000 means the latest valid first spoken answer to every fact was correct within 1.50s.</p></div><div className="panel mastery-note"><span className="mini-label">REMEMBERED OVER TIME</span><strong>{progress.verified}<span> / {deck.length}</span></strong><h2>facts mastered</h2><p>Mastery comes from quick, correct answers on later days. A fast answer today is a good step.</p><button className="text-button" onClick={()=>setDialog('mastery')}>How mastery works <Icon name="arrow"/></button></div></section><div className="progress-story"><Icon name="practice"/><p><b>There's more than one kind of progress.</b> You've tried {progress.assessed} facts in {names[operation].toLowerCase()}. {progress.verifying} are fast and waiting for later checks. Choose any fact below to give it another go.</p></div><section className="panel"><div className="section-heading"><div><h2>Every fact has its own story</h2><p>{student} · {names[operation]} · reversed facts count separately</p></div><label>Show<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All facts</option>{Object.entries(statusLabels).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label></div><div className="report-table-wrap"><table><thead><tr><th>Fact</th><th>Where I am</th><th>Latest spoken time</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{deck.filter(c=>filter==='all'||factStatus(p,c)===filter).map(c=>{const status=factStatus(p,c);return <tr key={c.id}><th scope="row">{label(c)}</th><td><span className={`badge ${status}`}>{statusLabels[status]}</span></td><td>{p.facts[c.id].latest?`${(p.facts[c.id].latest!.responseMs/1000).toFixed(2)}s`:'—'}</td><td><button className="text-button" onClick={()=>{pickFacts([c.id]);go('home');setNotice(`${label(c)} selected. You can practice it as often as you like.`);}}>Practice <Icon name="arrow"/></button></td></tr>;})}</tbody></table></div><p className="fine-print">Starting progress is fictional sample data. New preview rounds update this local demonstration; no real student records change.</p></section></>}
      {screen==='history'&&<><p className="lead">Open a round to see what you answered and what the app heard.</p>{rounds.filter(r=>r.student===student).length===0?<section className="empty panel"><Icon name="history"/><h2>Your next round starts the story.</h2><p>There are no saved preview sessions yet. Your sample fact progress is shown separately.</p><button className="button primary" onClick={()=>go('home')}>Choose practice</button></section>:<div className="history-list">{[...rounds].reverse().filter(r=>r.student===student).map(r=>{const m=roundMetrics(r);return <section className="panel" key={r.id}><button className="history-heading" aria-expanded={expanded===r.id} onClick={()=>setExpanded(expanded===r.id?null:r.id)}><span><b>{names[r.operation]}</b><small>{new Date(r.at).toLocaleDateString()} · {r.results.length}/{r.total} answered</small></span><span>{m.correct}/{m.scored.length} correct <span aria-hidden="true">⌄</span></span></button>{expanded===r.id&&<><p>{m.average===null?'No comparable spoken timing.':`Spoken response average: ${(m.average/1000).toFixed(2)}s (${m.timed.length} valid first attempts).`}<br/>{r.problems} recognition problems were left unscored.</p><ResultTable results={r.results}/></>}</section>;})}</div>}</>}
      {screen==='owner'&&<section className="panel owner-panel"><p className="demo-note">Demo account controls. No accounts are created and no passwords are stored.</p><h2>Microphone troubleshooting</h2><p>{micConfirmed?'This browser has passed its microphone check. Students can start rounds directly.':'This browser has not completed its one-time microphone check.'}</p><button className="button secondary" onClick={()=>{stopVoice();releaseVoiceAudio();setMic('unchecked');setMicHeard('');setVoiceMessage('');setScreen('miccheck');}}>Check microphone</button><h2>Students on this computer</h2>{people.map(name=><div className="owner-row" key={name}><GumdropAvatar id={avatarFor(name)} className="gumdrop-small"/><b>{name}</b><button className="text-button" onClick={()=>choosePerson(name)}>Preview student</button><button className="text-button red" onClick={()=>{setNewName(name);setDialog('remove');}}>Remove</button></div>)}<form className="actions" onSubmit={e=>{e.preventDefault();const name=newName.trim();if(!name||people.includes(name)){setNotice('Choose a new student name.');return;}setPeople(p=>[...p,name]);setNewName('');setNotice('Student added to this local preview.');}}><label>Add a student<input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="First name" required maxLength={30}/></label><button className="button primary">Add student</button></form><p>Only the account owner can add or remove students. Students can practice and view their own results.</p></section>}
      </main>
    </div>}
    {screen==='results'&&celebration&&<RoundCelebration choice={celebration} onFinished={()=>setCelebration(null)} sound={celebrationSound} motion={motion}/>}
    <dialog ref={modal} onCancel={e=>{e.preventDefault();resume();}} onClose={()=>{if(dialog)setDialog(null);}} aria-labelledby="dialog-title">
      <button className="dialog-close" aria-label="Close dialog" onClick={()=>resume()}>×</button>
      {dialog==='avatar'&&avatarStudent?<><span className="eyebrow">Make it yours</span><h2 id="dialog-title">{avatarStudent}’s gumdrop</h2><p>Pick your favorite. You can change it whenever you like.</p><div className="avatar-picker" role="group" aria-label="Choose a gumdrop avatar">{GUMDROP_AVATARS.map(avatar=><button key={avatar.id} className="avatar-option" aria-pressed={avatarFor(avatarStudent)===avatar.id} onClick={()=>setAvatars(old=>({...old,[avatarStudent]:avatar.id}))}><GumdropAvatar id={avatar.id}/><strong>{avatar.name}</strong><span className="avatar-selection">{avatarFor(avatarStudent)===avatar.id?'✓ Selected':'Choose'}</span></button>)}</div><p className="fine-print">Saved for {avatarStudent} on this preview.</p><button className="button primary avatar-done" onClick={()=>setDialog(null)}>Done</button></>:dialog==='pause'?<><span className="eyebrow">Take your time</span><h2 id="dialog-title">Your round is paused.</h2><p>{results.length} answers recorded. Nothing is timed while you take a break.</p><p className="muted">If you pause before answering, that question becomes retry practice and won't earn speed or mastery credit.</p><div className="actions"><button className="button primary" onClick={resume}>Resume practice</button><button className="button secondary" onClick={finish}>End &amp; save round</button></div></>:dialog==='owner'||dialog==='firstvisit'?<form onSubmit={e=>{e.preventDefault();if(ownerPassword.length<8)return;setOwnerPassword('');setDialog(null);setScreen('owner');setStudent(null);}}><span className="eyebrow">For a parent or account owner</span><h2 id="dialog-title">{dialog==='firstvisit'?'Connect your family computer':'Open family controls'}</h2><p>{dialog==='firstvisit'?'In the real app, your invitation connects your account. Create a password, add students, and hand the computer back.':'Students never need this password. Owner controls stay locked each time you switch.'}</p><label>Demo password<input type="password" value={ownerPassword} onChange={e=>setOwnerPassword(e.target.value)} minLength={8} autoComplete="off" required/></label><p className="demo-note">Use any 8+ characters. Do not enter a real password. This is a simulation; it does not authenticate or store the password.</p><button className="button primary">{dialog==='firstvisit'?'Continue to add students':'Open demo family controls'}</button></form>:dialog==='remove'?<><h2 id="dialog-title">Remove {newName} from this preview?</h2><p>This affects only fictional profiles in this browser. Real student data is untouched.</p><div className="actions"><button className="button secondary" onClick={()=>setDialog(null)}>Keep student</button><button className="button danger" onClick={()=>{setPeople(p=>p.filter(n=>n!==newName));setRounds(r=>r.filter(v=>v.student!==newName));setNewName('');setDialog(null);}}>Remove preview student</button></div></>:dialog==='settings'?<form onSubmit={savePrefs}><h2 id="dialog-title">Make practice comfortable</h2><label className="check-row"><input type="checkbox" checked={showTimes} onChange={e=>setShowTimes(e.target.checked)}/>Show response times during practice</label><p>Times stay available in results. No running countdown is shown.</p><p>Questions always advance automatically after feedback. Use Pause whenever you need a break.</p><label className="check-row"><input type="checkbox" checked={sound} onChange={e=>setSound(e.target.checked)}/>Short success sound</label><label className="check-row"><input type="checkbox" checked={motion} onChange={e=>setMotion(e.target.checked)}/>Animated gumdrop celebrations</label><label className="check-row"><input type="checkbox" checked={celebrationSound} onChange={e=>setCelebrationSound(e.target.checked)}/>Celebration music</label><p>Finish a round with more than 80% correct for eight seconds of gumdrop fun. Five tunes and five scenes mix independently. Reduced motion keeps a still celebration, and you can always mute or dismiss it.</p><button className="button primary">Done</button></form>:dialog==='mastery'?<><h2 id="dialog-title">Fast today. Remembered later.</h2><p>The 0–1,000 score describes your latest accuracy and speed across every fact in this operation. It is separate from the number mastered.</p><p><b>Mastered</b> means four quick, unassisted checks on different days, spanning at least seven days. The speed goal is 1.50 seconds.</p><p>You can always keep practicing. Extra tries, disputed recognition, and retries don't count as a new spaced check.</p><button className="button primary" onClick={()=>setDialog(null)}>Got it</button></>:dialog==='guide'?<><h2 id="dialog-title">Try the whole experience</h2><ol><li>Choose Maya, pick some facts, and select Get ready.</li><li>On a browser’s first visit, allow microphone access and say one number. Successful checks are remembered across students and visits.</li><li>Start a round and speak your answers. The next question appears automatically.</li><li>Try Pause and the prominent End round early button. If speech is unclear, try the microphone again.</li><li>Inspect results, Repeat, My progress, and History.</li></ol><p>The microphone is real, using the local number-recognition engine. Profiles and saved rounds are fictional preview data. For silent UI testing, enable simulated answers under Design testing options on the sound-check screen.</p><a className="button primary" href="/report.html">Read the design review</a></>:<><h2 id="dialog-title">Let's get you practicing.</h2><p>If the microphone misses an answer, try once more in your usual voice. Wait for Listening before speaking.</p><ol><li>Check that your browser allows this site's microphone.</li><li>Try a quiet spot and keep the microphone near you.</li><li>If it keeps happening, pause and ask an adult to check which microphone the browser is using.</li></ol><p>Recognition problems are not math mistakes. A disputed answer can be flagged without awarding mastery.</p><button className="button primary" onClick={resume}>Got it</button></>}
    </dialog>
  </>;
}

function Meter({value}:{value:number}){return <div className="meter" role="progressbar" aria-label="Operation performance" aria-valuemin={0} aria-valuemax={1000} aria-valuenow={value}><span style={{width:`${value/10}%`}}/></div>;}
function FactGrid({operation,chosen,onToggle,onGroup}:{operation:Operation;chosen:string[];onToggle:(id:string)=>void;onGroup:(ids:string[])=>void}){
  const cards=makeCards(operation), nums=operation==='mul'?Array.from({length:11},(_,i)=>i+2):operation==='sub'?Array.from({length:10},(_,i)=>i+1):Array.from({length:9},(_,i)=>i+1);
  return <div className="fact-grid-scroll"><table className="fact-grid"><caption className="sr-only">Choose individual {names[operation].toLowerCase()} facts. Columns are the first number.</caption><thead><tr><th aria-label="Second number, first number">{symbols[operation]}</th>{nums.map(n=><th scope="col" key={n}><button aria-label={`All facts with first number ${n}`} aria-pressed={cards.filter(c=>c.a===n).every(c=>chosen.includes(c.id))} onClick={()=>onGroup(cards.filter(c=>c.a===n).map(c=>c.id))}>{n}</button></th>)}</tr></thead><tbody>{nums.map(b=><tr key={b}><th scope="row"><button aria-label={`All facts with second number ${b}`} aria-pressed={cards.filter(c=>c.b===b).every(c=>chosen.includes(c.id))} onClick={()=>onGroup(cards.filter(c=>c.b===b).map(c=>c.id))}>{b}</button></th>{nums.map(a=>{const card=cards.find(c=>c.a===a&&c.b===b);return <td key={a}>{card?<button aria-label={label(card)} aria-pressed={chosen.includes(card.id)} onClick={()=>onToggle(card.id)}>{chosen.includes(card.id)?'✓':'·'}</button>:<span aria-hidden="true">—</span>}</td>;})}</tr>)}</tbody></table></div>;
}
function ResultTable({results}:{results:Result[]}){return <div className="report-table-wrap"><table><thead><tr><th>Fact</th><th>Answer heard</th><th>Result</th><th>Response time</th></tr></thead><tbody>{results.map((r,i)=><tr key={i}><th scope="row">{label(r.card)} = {answerFor(r.card)}</th><td>{r.heard}{r.mode==='keyboard'?' (typed)':''}</td><td>{r.outcome==='disputed'?'Recognition disputed · unscored':r.outcome==='wrong'?'Not correct':r.outcome==='slow'?'Correct · building speed':'Correct'}</td><td>{r.ms===null?(r.mode==='keyboard'?'Untimed':r.retry?'Retry · not timed':'Unavailable'):`${(r.ms/1000).toFixed(2)}s`}</td></tr>)}</tbody></table></div>;}
function Results({round,score,onRepeat,onProgress,onHome}:{round:Round;score:number;onRepeat:()=>void;onProgress:()=>void;onHome:()=>void}){
  const m=roundMetrics(round), complete=round.results.length===round.total;
  return <><p className="lead">{complete?'Round complete.':'Your progress is saved, even when you stop early.'} {round.results.length} of {round.total} questions answered.</p><div className="result-cards"><div className="panel"><span className="mini-label">ACCURACY</span><strong>{m.correct}<span> / {m.scored.length}</span></strong><p>correct answers</p></div><div className="panel"><span className="mini-label">SPOKEN RESPONSE</span><strong>{m.average===null?'—':(m.average/1000).toFixed(2)}<span>{m.average===null?'':' s'}</span></strong><p>{m.timed.length} comparable first attempts</p></div><div className="panel"><span className="mini-label">{names[round.operation].toUpperCase()} PERFORMANCE</span><strong>{score}<span> / 1,000</span></strong><p>across every fact in this operation</p></div></div><p className="result-note">{round.problems?`${round.problems} recognition ${round.problems===1?'problem was':'problems were'} not scored. `:''}Retries and uncertain timing are kept separate from spoken speed.</p><div className="actions"><button className="button primary" onClick={onRepeat}>Repeat this round <Icon name="arrow"/></button><button className="button secondary" onClick={onHome}>Choose other facts</button><button className="text-button" onClick={onProgress}>My progress</button></div><details className="panel results-details"><summary>See every answer</summary>{round.results.length?<ResultTable results={round.results}/>:<p>No answers were scored in this round.</p>}</details><p className="fine-print">Saved on this computer for the design preview. Production syncing is not connected.</p></>;
}
createRoot(document.getElementById('root')!).render(<App/>);

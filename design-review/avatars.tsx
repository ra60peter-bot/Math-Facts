import React from 'react';

export const GUMDROP_AVATARS = [
  {id:'party',name:'Party',image:'party-blob'},
  {id:'giggles',name:'Giggles',image:'laughing-blob'},
  {id:'cool',name:'Cool',image:'cool-blob'},
  {id:'star',name:'Star',image:null},
  {id:'hearts',name:'Hearts',image:null},
  {id:'wink',name:'Wink',image:null},
] as const;

export function avatarId(value:unknown, fallbackIndex=0):string {
  return GUMDROP_AVATARS.some(a=>a.id===value)?String(value):GUMDROP_AVATARS[Math.max(0,fallbackIndex)%GUMDROP_AVATARS.length].id;
}

// Vector faces match the original celebration's gumdrop silhouette, on every OS.
export function GumdropAvatar({id,className=''}:{id:string;className?:string}){
  const avatar=GUMDROP_AVATARS.find(a=>a.id===id)??GUMDROP_AVATARS[0];
  return <span className={`gumdrop-avatar ${className}`} aria-hidden="true">{avatar.image?<img src={`/celebration/${avatar.image}.svg`} alt="" draggable={false}/>:<svg viewBox="0 0 128 128" focusable="false">
    <path d="M64 9C2 9 1 79 1 93c0 14 28 25 63 25s63-11 63-25C127 79 126 9 64 9Z" fill="#fcc21b"/>
    <path d="M22 46c6-16 18-24 29-26" fill="none" stroke="#ffe68c" strokeWidth="7" strokeLinecap="round" opacity=".75"/>
    {avatar.id==='star'?<g fill="#503516"><path d="m39 39 5 11 13 1-10 9 3 13-11-7-11 7 3-13-10-9 13-1Z"/><path d="m90 39 5 11 13 1-10 9 3 13-11-7-11 7 3-13-10-9 13-1Z"/></g>:avatar.id==='hearts'?<g fill="#ed5266"><path d="M22 51c0-13 16-17 21-6 5-11 21-7 21 6 0 10-13 19-21 26-8-7-21-16-21-26Z" transform="translate(-5 0)"/><path d="M22 51c0-13 16-17 21-6 5-11 21-7 21 6 0 10-13 19-21 26-8-7-21-16-21-26Z" transform="translate(44 0)"/></g>:<g fill="#352b25"><ellipse cx="39" cy="56" rx="6" ry="9"/><path d="M79 58q10-13 20 0" fill="none" stroke="#352b25" strokeWidth="6" strokeLinecap="round"/></g>}
    <ellipse cx="23" cy="79" rx="9" ry="5" fill="#f19250" opacity=".8"/><ellipse cx="105" cy="79" rx="9" ry="5" fill="#f19250" opacity=".8"/>
    {avatar.id==='wink'?<path d="M43 84q22 21 45-3" fill="none" stroke="#352b25" strokeWidth="6" strokeLinecap="round"/>:<><path d="M39 82q25 8 50 0c-1 28-48 30-50 0Z" fill="#492c21"/><path d="M42 83q22 6 44 0l-3 8H46Z" fill="#fff8e8"/><path d="M50 103q14-12 28 0-14 10-28 0" fill="#e97968"/></>}
  </svg>}</span>;
}

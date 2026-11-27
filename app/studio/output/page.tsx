'use client';
import { OutputVideo, useStudio } from '../media';
export default function OBSOutput(){const {state,error}=useStudio();return <div style={{position:'fixed',inset:0,background:'#000',color:'#fff',overflow:'hidden'}}><style>{`nextjs-portal{display:none}.studio-picture{width:100%;height:100%;object-fit:contain;display:block}.studio-placeholder{height:100%;display:grid;place-items:center;font:24px sans-serif}`}</style>{error&&!state?<div className="studio-placeholder">{error}</div>:<OutputVideo source={state?.source||null}/>}</div>;}

import { setTimeout as sleep } from 'node:timers/promises';
import { FRAME_INTERVAL, streamedTool, type Canvas, type Emit } from './canvas';

const guide = `半小时不是硬标准，留一段慢下来的时间就好。`;
const steps = [
  { id: 'light', label: '调暗灯光', cx: 54, color: '#C86D2D', note: '先把环境灯光调暗一点，让眼睛慢慢适应。', icon: '<path d="M54 49a15 15 0 1 0 14 21 15 15 0 0 1-14-21Z" fill="#C86D2D"/>' },
  { id: 'phone', label: '放下手机', cx: 160, color: '#6F8F82', note: '第二步是让手机离手。换成读几页书，让注意力慢慢放松。', icon: '<rect x="151" y="47" width="18" height="30" rx="4" fill="none" stroke="#6F8F82" stroke-width="2"/><circle cx="160" cy="71" r="1.5" fill="#6F8F82"/>' },
  { id: 'breath', label: '放慢呼吸', cx: 266, color: '#6F8F82', note: '最后试着自然地放慢呼吸：舒服就好，不用数拍子或憋气。', icon: '<path d="M253 66q7-13 14 0t13 0M253 56q7-8 14 0t13 0" fill="none" stroke="#6F8F82" stroke-width="2" stroke-linecap="round"/>' },
];
type Step = typeof steps[number];
function group(step: Step, selected = false) {
  return `<g id="${step.id}" ${step.id === 'phone' ? '' : `data-prompt="${step.label}" `}aria-label="${step.label}">
<title>${step.label}</title>
<circle cx="${step.cx}" cy="62" r="${selected ? 38 : 30}" fill="${selected ? '#FFE3C7' : step.color}" ${selected ? 'stroke="#C86D2D" stroke-width="2"' : 'fill-opacity="0.16"'}/>
${step.icon}
<text x="${step.cx}" y="127" text-anchor="middle" font-size="15" fill="${selected ? '#9A491A' : '#2C2416'}">${step.label}</text>
</g>`;
}
const note = (value: string) => `<p id="tip" style="min-height:3.5em;line-height:1.65;color:#6B5D4D">${value}</p>`;
const opening = `<div style="min-height:100%;padding:24px 18px;display:flex;flex-direction:column;justify-content:space-between;gap:20px">
<header><p style="color:#975021;font-size:13px;letter-spacing:.14em">晚间节律</p><h1 style="font-size:28px;margin:0">给睡前留个缓冲</h1><p style="color:#6B5D4D">把最后半小时，留给三个小动作。</p></header>
<svg viewBox="0 0 320 165" style="width:100%;height:auto" role="img" aria-label="三个睡前小动作">
<path d="M54 62Q105 24 160 62T266 62" fill="none" stroke="#BDA58C" stroke-width="2" stroke-dasharray="4 5"/>
${steps.map(step => group(step)).join('\n')}
</svg>
${note(guide)}
</div>`;

async function simulate(state: Canvas, emit: Emit, signal: AbortSignal, name: string, commentary: string, args: Record<string, string>) {
  const tool = streamedTool(state, emit);
  const first = JSON.stringify({ commentary }).slice(0, -1);
  const cut = first.lastIndexOf('"');
  tool.push(name, first.slice(0, cut));
  await sleep(55, undefined, { signal });
  tool.push(name, first.slice(cut)); // commentary closes before any markup arrives
  let comma = ',';
  for (const [key, value] of Object.entries(args)) {
    tool.push(name, comma + JSON.stringify(key) + ':"');
    const escaped = JSON.stringify(value).slice(1, -1);
    const chunks = key === 'html' || key === 'new_string' ? escaped.match(/[\s\S]{1,110}/gu) ?? [] : [escaped];
    for (const chunk of chunks) {
      if (key === 'html' || key === 'new_string') await sleep(FRAME_INTERVAL, undefined, { signal });
      tool.push(name, chunk);
    }
    tool.push(name, '"');
    comma = ',';
  }
  tool.push(name, '}');
  const result = tool.finish(name);
  if (!('shown' in result) || !result.shown) throw new Error('模拟画板未能完成。');
}

async function highlight(state: Canvas, emit: Emit, signal: AbortSignal, step: Step, explain = true) {
  const old = state.current?.rawHtml;
  if (!old) return;
  const svgStart = old.indexOf('<g id="');
  const svgEnd = old.indexOf('</svg>');
  const noteEnd = old.indexOf('</p>', old.indexOf('<p id="tip"')) + 4;
  const previous = old.slice(svgStart, noteEnd);
  if (svgStart < 0 || svgEnd < 0 || noteEnd < svgEnd) return;
  const next = steps.map(item => group(item, item.id === step.id)).join('\n') + `\n</svg>\n${note(step.note)}`;
  await simulate(state, emit, signal, 'canvas_edit', explain ? step.note : '', { old_string: previous, new_string: next, title: `聚焦 · ${step.label}` });
}

export async function runDemo(state: Canvas, tap: string, emit: Emit, signal: AbortSignal) {
  if (tap) {
    const step = steps.find(item => tap.includes(item.label)) ?? steps[1];
    await highlight(state, emit, signal, step);
    return;
  }
  await simulate(state, emit, signal, 'render_canvas_card', '晚上想慢慢静下来，可以先调暗灯光、放下手机，再试着放慢呼吸。我把三个动作画出来。', { html: opening, title: '睡前缓冲 · 总览' });
  await sleep(550, undefined, { signal });
  await highlight(state, emit, signal, steps[1]);
}

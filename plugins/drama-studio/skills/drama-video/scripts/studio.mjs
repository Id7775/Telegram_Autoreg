#!/usr/bin/env node
// Drama Studio — пайплайн «ИИ-драмы»: refs → frames → voices → clips → (lipsync) → assemble.
// Нужны только Node 18+, curl, ffmpeg/ffprobe. Генерация идёт через fal.ai (ключ FAL_KEY),
// модели переопределяются в project.json → "models". Всё, что пользователь положил сам
// в input/refs, input/frames, input/clips, input/voice, input/music.*, имеет приоритет над генерацией.
//
// Команды:
//   node studio.mjs init [--project DIR]        — создать папки и пример project.json
//   node studio.mjs check                       — проверить ffmpeg/curl/ключ и project.json
//   node studio.mjs prompts                     — выгрузить все промпты в out/prompts.md (ручной режим)
//   node studio.mjs refs    [--only id,id] [--force]   — листы персонажей и пустые локации
//   node studio.mjs frames  [--only s01,s02] [--force] — ключевые кадры сцен
//   node studio.mjs voices  [--only l001]   [--force]  — реплики (TTS)
//   node studio.mjs clips   [--only s01]    [--force]  — оживление кадров (image-to-video)
//   node studio.mjs lipsync [--only s01]    [--force]  — липсинк (только для сцен с "lipsync": true)
//   node studio.mjs music   [--force]                  — музыкальная подложка
//   node studio.mjs sheet   [refs|frames]              — контактный лист для проверки
//   node studio.mjs assemble [--draft]                 — финальный MP4 (out/final.mp4)
//   node studio.mjs status                             — что уже готово
// Общие флаги: --mock (заглушки вместо платной генерации), --dry (показать запросы, не отправлять).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- аргументы ----------
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--') && ['project', 'only'].includes(k)) { flags[k] = next; i++; }
    else flags[k] = true;
  } else positional.push(a);
}
const ROOT = path.resolve(flags.project || '.');
const P = (...p) => path.join(ROOT, ...p);
const ONLY = flags.only ? new Set(String(flags.only).split(',').map(s => s.trim())) : null;
const pick = id => !ONLY || ONLY.has(id);

const DEFAULT_MODELS = {
  t2i: 'fal-ai/nano-banana',
  edit: 'fal-ai/nano-banana/edit',
  i2v: 'fal-ai/kling-video/v2.1/standard/image-to-video',
  lipsync: 'fal-ai/kling-video/lipsync/audio-to-video',
  tts: 'fal-ai/elevenlabs/tts/multilingual-v2',
  music: 'fal-ai/stable-audio',
};

// ---------- утилиты ----------
const log = (...a) => console.log(...a);
const die = m => { console.error('✖ ' + m); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ensureDir = d => fs.mkdirSync(d, { recursive: true });
const exists = f => { try { return fs.statSync(f).size > 0; } catch { return false; } };

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: opts.encoding ?? 'utf8', input: opts.input, maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`${bin}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${bin} ${args.slice(0, 6).join(' ')} … → ${String(r.stderr).slice(-1500)}`);
  return r;
}
const ff = args => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
function duration(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(r.stdout.trim()) || 0;
}
function firstFile(dir, id, exts) {
  for (const e of exts) { const f = path.join(dir, `${id}.${e}`); if (exists(f)) return f; }
  return null;
}
const IMG = ['png', 'jpg', 'jpeg', 'webp'];
const AUD = ['mp3', 'wav', 'm4a', 'ogg', 'flac'];
const VID = ['mp4', 'mov', 'webm', 'mkv'];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const dataUri = f => `data:${MIME[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream'};base64,${fs.readFileSync(f).toString('base64')}`;

// ---------- проект и состояние ----------
function loadProject() {
  const f = P('project.json');
  if (!exists(f)) die(`Нет ${f}. Запусти: node studio.mjs init`);
  let pr;
  try { pr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`project.json не читается: ${e.message}`); }
  pr.models = { ...DEFAULT_MODELS, ...(pr.models || {}) };
  pr.characters ||= []; pr.locations ||= []; pr.shots ||= [];
  pr.format ||= '16:9';
  return pr;
}
const STATE_F = () => P('assets', 'state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_F(), 'utf8')); } catch { return { remote: {}, durations: {} }; } }
function saveState(s) { ensureDir(P('assets')); fs.writeFileSync(STATE_F(), JSON.stringify(s, null, 2)); }
const STATE = fs.existsSync(ROOT) ? loadState() : { remote: {}, durations: {} };
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
// Для передачи локального файла в API: если он сам пришёл с fal — отдаём его URL, иначе data URI.
const asInput = f => STATE.remote[rel(f)] || dataUri(f);

function size(pr) {
  return pr.format === '9:16' ? { w: 1080, h: 1920, ar: '9:16' } : { w: 1920, h: 1080, ar: '16:9' };
}
const charById = (pr, id) => pr.characters.find(c => c.id === id) || die(`Персонаж "${id}" не описан в characters`);
const locById = (pr, id) => pr.locations.find(l => l.id === id) || die(`Локация "${id}" не описана в locations`);
const allLines = pr => pr.shots.flatMap(s => (s.lines || []).map(l => ({ ...l, shot: s.id })));

// ---------- HTTP через curl (работает через прокси и на Windows/Mac) ----------
function http(method, url, body) {
  const key = process.env.FAL_KEY || 'injected-by-proxy';
  const args = ['-sS', '-L', '-X', method, url, '-H', `Authorization: Key ${key}`, '-w', '\n%{http_code}'];
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  const r = run('curl', args, { input: body === undefined ? undefined : JSON.stringify(body), allowFail: true });
  const out = String(r.stdout);
  const i = out.lastIndexOf('\n');
  const code = parseInt(out.slice(i + 1), 10);
  const text = out.slice(0, i);
  if (r.status !== 0) throw new Error(`curl: ${String(r.stderr).trim()}`);
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { code, text, json };
}
function download(url, file) {
  ensureDir(path.dirname(file));
  if (url.startsWith('data:')) { fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64')); return; }
  run('curl', ['-sS', '-L', '--fail', '-o', file, url]);
}

async function fal(model, input, label) {
  const short = JSON.stringify(input, (k, v) => (typeof v === 'string' && v.startsWith('data:') ? `<data ${Math.round(v.length / 1024)}KB>` : v));
  if (flags.dry) { log(`  [dry] ${model} ← ${short.slice(0, 600)}`); return null; }
  log(`  → ${model} (${label})`);
  const sub = http('POST', `https://queue.fal.run/${model}`, input);
  if (sub.code >= 400 || !sub.json) throw new Error(`fal ${model}: HTTP ${sub.code} ${sub.text.slice(0, 800)}`);
  const { status_url, response_url } = sub.json;
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    await sleep(i < 5 ? 2000 : 5000);
    const st = http('GET', status_url);
    const s = st.json?.status;
    if (s === 'COMPLETED') break;
    if (st.code >= 400 || (s && !['IN_QUEUE', 'IN_PROGRESS'].includes(s))) throw new Error(`fal ${model}: статус ${st.code} ${st.text.slice(0, 500)}`);
    if (Date.now() - t0 > 30 * 60 * 1000) throw new Error(`fal ${model}: таймаут 30 мин`);
    if (i % 6 === 5) log(`    …${Math.round((Date.now() - t0) / 1000)} с, ${s}`);
  }
  const res = http('GET', response_url);
  if (res.code >= 400 || !res.json) throw new Error(`fal ${model}: ответ ${res.code} ${res.text.slice(0, 800)}`);
  return res.json;
}
// Ищем URL результата в ответе любой модели (images[0].url, video.url, audio.url, audio_file.url …)
function resultUrl(obj, prefer) {
  const found = [];
  const walk = (o, keyPath) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.url === 'string') found.push({ keyPath, url: o.url });
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, `${keyPath}.${k}`);
  };
  walk(obj, '');
  const hit = found.find(f => prefer.some(p => f.keyPath.includes(p))) || found[0];
  if (!hit) throw new Error(`В ответе нет URL: ${JSON.stringify(obj).slice(0, 500)}`);
  return hit.url;
}
async function falToFile(model, input, file, prefer, label) {
  const out = await fal(model, input, label);
  if (!out) return false;
  const url = resultUrl(out, prefer);
  download(url, file);
  STATE.remote[rel(file)] = url;
  saveState(STATE);
  log(`  ✓ ${rel(file)}`);
  return true;
}

// ---------- промпты ----------
const FRAMING = {
  wide: 'wide establishing shot, both characters full body, whole room visible',
  medium: 'medium shot, characters from the knees or waist up',
  two_shot: 'tight two-shot, both characters from the chest up, faces large in frame',
  close: 'close-up on one character face and shoulders, background softly blurred',
  over_shoulder: 'over-the-shoulder shot, foreground character seen from behind, the other character facing camera',
  insert: 'insert close-up of an object or document, large and readable',
};
function charDesc(c) { return `${c.name}: ${c.look}`; }
function refPrompt(pr, c) {
  return `${pr.style}\n\nCharacter reference sheet of ONE character: ${c.look}. ` +
    `Left: full body standing, front view. Right: head-and-shoulders close-up, neutral expression. ` +
    `Plain light-grey studio background, even lighting, no text, no other people.`;
}
function locPrompt(pr, l) {
  return `${pr.style}\n\nEmpty location, no people: ${l.desc}. Wide establishing view of the whole space, ` +
    `eye-level camera, cinematic ${size(pr).ar} composition, no text.`;
}
function framePrompt(pr, s) {
  const chars = (s.chars || []).map(id => charById(pr, id));
  const parts = [
    pr.style,
    `Shot: ${FRAMING[s.framing] || s.framing || FRAMING.medium}.`,
    s.image_prompt || '',
    chars.length ? `Characters (match the reference images exactly — same face, skin tone, hair, outfit, proportions): ${chars.map(charDesc).join('; ')}.` : 'No people in frame.',
    s.location ? `Setting: exactly the same room as the location reference image (${locById(pr, s.location).desc}).` : '',
    s.insert_text ? `Readable text in the image: ${s.insert_text}` : 'No captions, no subtitles, no watermark, no on-screen text.',
    `Single frame, ${size(pr).ar}, high detail, consistent illustration style.`,
  ];
  return parts.filter(Boolean).join('\n');
}
function framRefs(pr, s) {
  const refs = [];
  if (s.location) {
    const f = firstFile(P('assets', 'refs'), `loc_${s.location}`, IMG) || firstFile(P('input', 'refs'), `loc_${s.location}`, IMG);
    if (f) refs.push(f);
  }
  for (const id of s.chars || []) {
    const f = firstFile(P('input', 'refs'), id, IMG) || firstFile(P('assets', 'refs'), `char_${id}`, IMG);
    if (!f) die(`Нет референса персонажа "${id}". Сначала: node studio.mjs refs`);
    refs.push(f);
  }
  if (s.from_frame) { // продолжение предыдущего кадра (тот же ракурс, другая поза)
    const f = shotFrame(s.from_frame); if (f) refs.unshift(f);
  }
  return refs;
}
function motionPrompt(pr, s) {
  const talkers = [...new Set((s.lines || []).map(l => l.who))].map(id => charById(pr, id));
  const emo = (s.lines || []).map(l => `${charById(pr, l.who).name} says a line${l.emotion ? ` (${l.emotion})` : ''}`).join(', then ');
  return [
    s.motion_prompt || 'Characters stay in place with small natural movements: breathing, blinking, slight head turns, subtle hand gestures.',
    talkers.length ? `${emo}. Mouth moves naturally while talking; the listener reacts with facial expression.` : '',
    s.camera || 'Static camera with a very slow push-in.',
    'Keep faces, outfits and the room identical to the first frame. No morphing, no new people, no text.',
  ].filter(Boolean).join(' ');
}
const NEG = 'blur, distortion, extra limbs, deformed hands, morphing face, flicker, text, subtitles, watermark, low quality';

// ---------- пути ассетов ----------
const shotFrame = sid => firstFile(P('input', 'frames'), sid, IMG) || firstFile(P('assets', 'frames'), sid, IMG);
const lineVoice = lid => firstFile(P('input', 'voice'), lid, AUD) || firstFile(P('assets', 'voice'), lid, AUD);
function shotClips(sid) {
  const user = firstFile(P('input', 'clips'), sid, VID);
  if (user) return [user];
  const dir = P('assets', 'clips');
  if (!fs.existsSync(dir)) return [];
  const ls = firstFile(dir, `${sid}_ls`, ['mp4']);
  if (ls) return [ls];
  return fs.readdirSync(dir).filter(f => new RegExp(`^${sid}_\\d+\\.mp4$`).test(f)).sort().map(f => path.join(dir, f));
}

// ---------- mock-заглушки (бесплатный прогон пайплайна) ----------
function mockImage(file, w, h, seed) {
  ensureDir(path.dirname(file));
  const hue = (seed * 47) % 360;
  ff(['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:d=1`, '-vf', `hue=h=${hue}:s=0.4`, '-frames:v', '1', file]);
}
function mockVoice(file, text, seed) {
  ensureDir(path.dirname(file));
  const d = Math.max(1.2, text.split(/\s+/).length * 0.38 + 0.3);
  ff(['-f', 'lavfi', '-i', `sine=f=${180 + (seed % 5) * 60}:d=${d.toFixed(2)}`, '-af', 'volume=0.25', '-ar', '44100', '-c:a', 'libmp3lame', file]);
}
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---------- команды ----------
async function cmdInit() {
  for (const d of ['input/refs', 'input/frames', 'input/clips', 'input/voice', 'assets', 'out']) ensureDir(P(d));
  const f = P('project.json');
  if (exists(f)) { log(`project.json уже есть — не трогаю.`); return; }
  const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'project.example.json');
  fs.copyFileSync(tpl, f);
  log(`✓ Создан ${f} (пример). Заполни его по сценарию.`);
}

function cmdCheck() {
  const ok = (c, m) => log(`${c ? '✓' : '✖'} ${m}`);
  ok(!run('ffmpeg', ['-version'], { allowFail: true }).status, 'ffmpeg');
  ok(!run('ffprobe', ['-version'], { allowFail: true }).status, 'ffprobe');
  ok(!run('curl', ['--version'], { allowFail: true }).status, 'curl');
  ok(!!process.env.FAL_KEY, `FAL_KEY ${process.env.FAL_KEY ? 'задан' : 'не задан (в облачной сессии ключ может подставлять прокси)'}`);
  const pr = loadProject();
  const lines = allLines(pr);
  log(`Проект «${pr.title || '—'}»: ${pr.characters.length} перс., ${pr.locations.length} лок., ${pr.shots.length} сцен, ${lines.length} реплик, формат ${pr.format}.`);
  const ids = new Set();
  for (const s of pr.shots) {
    if (ids.has(s.id)) die(`Повтор id сцены ${s.id}`); ids.add(s.id);
    (s.chars || []).forEach(id => charById(pr, id));
    if (s.location) locById(pr, s.location);
    for (const l of s.lines || []) { if (ids.has(l.id)) die(`Повтор id ${l.id}`); ids.add(l.id); charById(pr, l.who); }
  }
  for (const c of pr.characters) if (!c.voice) log(`! У персонажа ${c.id} нет "voice" — TTS возьмёт голос по умолчанию.`);
  log('✓ project.json корректен');
}

function cmdPrompts() {
  const pr = loadProject();
  let md = `# Промпты — ${pr.title || ''}\n\nРучной режим: генерируй в любом сервисе и клади результаты:\n` +
    `- персонажи → input/refs/<id>.png, локации → input/refs/loc_<id>.png\n- кадры → input/frames/<sceneId>.png\n` +
    `- оживлённые клипы → input/clips/<sceneId>.mp4\n- реплики → input/voice/<lineId>.mp3\n- музыка → input/music.mp3\n\n## Персонажи\n`;
  for (const c of pr.characters) md += `\n### ${c.id} — ${c.name}\n\`\`\`\n${refPrompt(pr, c)}\n\`\`\`\nГолос: ${c.voice || '—'}\n`;
  md += `\n## Локации\n`;
  for (const l of pr.locations) md += `\n### loc_${l.id}\n\`\`\`\n${locPrompt(pr, l)}\n\`\`\`\n`;
  md += `\n## Сцены\n`;
  for (const s of pr.shots) {
    md += `\n### ${s.id} (${s.framing || 'medium'})\nРеференсы: ${[s.location && 'loc_' + s.location, ...(s.chars || [])].filter(Boolean).join(', ')}\n\n**Кадр:**\n\`\`\`\n${framePrompt(pr, s)}\n\`\`\`\n**Оживление:**\n\`\`\`\n${motionPrompt(pr, s)}\n\`\`\`\n`;
    for (const l of s.lines || []) md += `- \`${l.id}\` **${charById(pr, l.who).name}**${l.emotion ? ` _(${l.emotion})_` : ''}: ${l.text}\n`;
  }
  ensureDir(P('out'));
  fs.writeFileSync(P('out', 'prompts.md'), md);
  log(`✓ out/prompts.md`);
}

async function cmdRefs() {
  const pr = loadProject();
  for (const c of pr.characters) {
    if (!pick(c.id)) continue;
    if (firstFile(P('input', 'refs'), c.id, IMG)) { log(`• ${c.id}: свой референс из input/refs`); continue; }
    const out = P('assets', 'refs', `char_${c.id}.png`);
    if (exists(out) && !flags.force) { log(`• ${c.id}: уже есть`); continue; }
    log(`• персонаж ${c.id}`);
    if (flags.mock) { mockImage(out, 1920, 1080, hash(c.id)); continue; }
    await falToFile(pr.models.t2i, { prompt: refPrompt(pr, c), aspect_ratio: '16:9', num_images: 1, output_format: 'png' }, out, ['images'], c.id);
  }
  for (const l of pr.locations) {
    if (!pick(l.id)) continue;
    if (firstFile(P('input', 'refs'), `loc_${l.id}`, IMG)) { log(`• loc_${l.id}: своя из input/refs`); continue; }
    const out = P('assets', 'refs', `loc_${l.id}.png`);
    if (exists(out) && !flags.force) { log(`• loc_${l.id}: уже есть`); continue; }
    log(`• локация ${l.id}`);
    const { w, h, ar } = size(pr);
    if (flags.mock) { mockImage(out, w, h, hash(l.id)); continue; }
    await falToFile(pr.models.t2i, { prompt: locPrompt(pr, l), aspect_ratio: ar, num_images: 1, output_format: 'png' }, out, ['images'], l.id);
  }
}

async function cmdFrames() {
  const pr = loadProject();
  const { w, h, ar } = size(pr);
  for (const s of pr.shots) {
    if (!pick(s.id)) continue;
    if (firstFile(P('input', 'frames'), s.id, IMG)) { log(`• ${s.id}: свой кадр из input/frames`); continue; }
    const out = P('assets', 'frames', `${s.id}.png`);
    if (exists(out) && !flags.force) { log(`• ${s.id}: уже есть`); continue; }
    log(`• кадр ${s.id}`);
    if (flags.mock) { mockImage(out, w, h, hash(s.id)); continue; }
    const refs = framRefs(pr, s);
    const input = { prompt: framePrompt(pr, s), image_urls: refs.map(asInput), num_images: 1, output_format: 'png', aspect_ratio: ar };
    await falToFile(refs.length ? pr.models.edit : pr.models.t2i, input, out, ['images'], s.id);
  }
}

async function cmdVoices() {
  const pr = loadProject();
  for (const l of allLines(pr)) {
    if (!pick(l.id) && !pick(l.shot)) continue;
    if (firstFile(P('input', 'voice'), l.id, AUD)) { log(`• ${l.id}: своя запись`); continue; }
    const out = P('assets', 'voice', `${l.id}.mp3`);
    if (exists(out) && !flags.force) continue;
    const c = charById(pr, l.who);
    log(`• ${l.id} ${c.name}: ${l.text.slice(0, 60)}`);
    if (flags.mock) { mockVoice(out, l.text, hash(c.id)); continue; }
    const input = { text: l.text, voice: c.voice || 'Rachel', ...(pr.tts_options || {}), ...(c.tts_options || {}), ...(l.tts_options || {}) };
    await falToFile(pr.models.tts, input, out, ['audio'], l.id);
  }
}

function shotDuration(pr, s) {
  const lines = s.lines || [];
  let d = s.lead ?? 0.3;
  for (const l of lines) {
    const v = lineVoice(l.id);
    d += (v ? duration(v) : l.text.split(/\s+/).length * 0.4) + (l.pause ?? 0.35);
  }
  d += s.hold ?? 0.6;
  return Math.max(d, s.min_duration ?? 3);
}

async function cmdClips() {
  const pr = loadProject();
  for (const s of pr.shots) {
    if (!pick(s.id)) continue;
    if (s.animate === false) { log(`• ${s.id}: без оживления (Ken Burns)`); continue; }
    if (firstFile(P('input', 'clips'), s.id, VID)) { log(`• ${s.id}: свой клип`); continue; }
    const frame = shotFrame(s.id);
    if (!frame) { log(`! ${s.id}: нет кадра — сначала frames`); continue; }
    const need = shotDuration(pr, s);
    const max = pr.clip_seconds || 10;
    const n = Math.max(1, Math.ceil(need / max - 0.15));
    const have = shotClips(s.id).filter(f => !f.endsWith('_ls.mp4'));
    if (have.length >= n && !flags.force) { log(`• ${s.id}: ${have.length} клип(ов) уже есть`); continue; }
    log(`• ${s.id}: нужно ~${need.toFixed(1)} с → ${n} клип(а)`);
    let src = frame;
    for (let k = 1; k <= n; k++) {
      const out = P('assets', 'clips', `${s.id}_${k}.mp4`);
      if (exists(out) && !flags.force) { src = lastFrame(out, s.id, k); continue; }
      const left = need - (k - 1) * max;
      const input = { prompt: motionPrompt(pr, s), image_url: asInput(src), duration: left > 5.5 ? String(max) : '5', negative_prompt: NEG, cfg_scale: 0.5, ...(pr.i2v_options || {}) };
      if (flags.mock) { log('  (mock: клипы не генерирую — при сборке будет Ken Burns)'); break; }
      if (!(await falToFile(pr.models.i2v, input, out, ['video'], `${s.id}_${k}`))) break;
      if (k < n) src = lastFrame(out, s.id, k);
    }
  }
}
function lastFrame(clip, sid, k) {
  const f = P('assets', 'clips', `${sid}_${k}_last.png`);
  if (!exists(f)) ff(['-sseof', '-0.15', '-i', clip, '-frames:v', '1', '-update', '1', f]);
  return f;
}

async function cmdLipsync() {
  const pr = loadProject();
  for (const s of pr.shots) {
    if (!pick(s.id) || !s.lipsync) continue;
    const clips = shotClips(s.id).filter(f => !f.endsWith('_ls.mp4'));
    if (clips.length !== 1) { log(`! ${s.id}: липсинк поддерживается для сцены из одного клипа (сейчас ${clips.length})`); continue; }
    const out = P('assets', 'clips', `${s.id}_ls.mp4`);
    if (exists(out) && !flags.force) { log(`• ${s.id}: липсинк уже есть`); continue; }
    const audio = buildShotAudio(pr, s).file;
    const mp3 = audio.replace(/\.wav$/, '.mp3');
    ff(['-i', audio, '-c:a', 'libmp3lame', '-b:a', '128k', mp3]);
    log(`• липсинк ${s.id}`);
    await falToFile(pr.models.lipsync, { video_url: asInput(clips[0]), audio_url: dataUri(mp3) }, out, ['video'], s.id);
  }
}

async function cmdMusic() {
  const pr = loadProject();
  if (firstFile(P('input'), 'music', AUD)) { log('• музыка: input/music.*'); return; }
  if (!pr.music?.prompt) { log('• музыка не задана (project.music.prompt) — пропускаю'); return; }
  const out = P('assets', 'music.wav');
  if (exists(out) && !flags.force) { log('• музыка уже есть'); return; }
  if (flags.mock) { ff(['-f', 'lavfi', '-i', 'sine=f=110:d=30', '-af', 'volume=0.2', out]); return; }
  await falToFile(pr.models.music, { prompt: pr.music.prompt, seconds_total: pr.music.seconds || 45, ...(pr.music.options || {}) }, out, ['audio'], 'music');
}

function cmdSheet() {
  const what = positional[0] || 'frames';
  const dir = P('assets', what);
  const pr = loadProject();
  let files;
  if (what === 'frames') files = pr.shots.map(s => shotFrame(s.id)).filter(Boolean);
  else files = [...(fs.existsSync(P('input', 'refs')) ? fs.readdirSync(P('input', 'refs')).map(f => P('input', 'refs', f)) : []),
    ...(fs.existsSync(dir) ? fs.readdirSync(dir).map(f => path.join(dir, f)) : [])].filter(f => IMG.includes(path.extname(f).slice(1).toLowerCase()));
  if (!files.length) die(`Нет картинок для листа "${what}"`);
  const tmp = P('assets', '.sheet'); fs.rmSync(tmp, { recursive: true, force: true }); ensureDir(tmp);
  files.forEach((f, i) => ff(['-i', f, '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x202020', '-frames:v', '1', path.join(tmp, `${String(i).padStart(3, '0')}.png`)]));
  const cols = Math.min(4, files.length), rows = Math.ceil(files.length / cols);
  const out = P('out', `sheet_${what}.jpg`); ensureDir(P('out'));
  ff(['-i', path.join(tmp, '%03d.png'), '-vf', `tile=${cols}x${rows}:padding=6:color=0x101010`, '-frames:v', '1', '-q:v', '3', out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`✓ ${rel(out)}  (${files.map(f => path.basename(f, path.extname(f))).join(', ')})`);
}

// --- сборка ---
function buildShotAudio(pr, s) {
  const dir = P('assets', 'build'); ensureDir(dir);
  const parts = []; const cues = [];
  const sil = d => { const f = path.join(dir, `sil_${d.toFixed(2)}.wav`); if (!exists(f)) ff(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', d.toFixed(3), '-c:a', 'pcm_s16le', f]); return f; };
  let t = s.lead ?? 0.3; parts.push(sil(t));
  for (const l of s.lines || []) {
    const v = lineVoice(l.id);
    if (!v) die(`Нет озвучки реплики ${l.id} — запусти voices (или --mock)`);
    const wav = path.join(dir, `v_${l.id}.wav`);
    ff(['-i', v, '-ac', '1', '-ar', '48000', '-af', `volume=${l.gain ?? 1}`, '-c:a', 'pcm_s16le', wav]);
    const d = duration(wav);
    cues.push({ start: t, end: t + d, who: charById(pr, l.who).name, text: l.text });
    parts.push(wav); t += d;
    const p = l.pause ?? 0.35; parts.push(sil(p)); t += p;
  }
  const hold = s.hold ?? 0.6; parts.push(sil(hold)); t += hold;
  if (t < (s.min_duration ?? 3)) { const extra = (s.min_duration ?? 3) - t; parts.push(sil(extra)); t += extra; }
  const list = path.join(dir, `a_${s.id}.txt`);
  fs.writeFileSync(list, parts.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const file = path.join(dir, `a_${s.id}.wav`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', file]);
  return { file, dur: duration(file), cues };
}

function buildShotVideo(pr, s, dur, isFirst, isLast, draft) {
  const { w, h } = size(pr);
  const fps = pr.fps || 30;
  const dir = P('assets', 'build');
  const out = path.join(dir, `seg_${s.id}.mp4`);
  const audio = path.join(dir, `a_${s.id}.wav`);
  const clips = s.animate === false ? [] : shotClips(s.id);
  const norm = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},setsar=1,format=yuv420p`;
  const fades = [isFirst ? `fade=t=in:st=0:d=0.6` : '', isLast ? `fade=t=out:st=${Math.max(0, dur - 0.9).toFixed(2)}:d=0.9` : ''].filter(Boolean);
  const enc = ['-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'medium', '-crf', draft ? '26' : '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest'];
  if (clips.length) {
    const ins = clips.flatMap(c => ['-i', c]);
    const chains = clips.map((c, i) => `[${i}:v]${norm}[v${i}]`).join(';');
    const speed = s.speed ? `,setpts=PTS/${s.speed}` : '';
    const fc = `${chains};${clips.map((c, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0${speed},tpad=stop_mode=clone:stop_duration=${Math.ceil(dur + 1)},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS${fades.length ? ',' + fades.join(',') : ''}[v]`;
    ff([...ins, '-i', audio, '-filter_complex', fc, '-map', '[v]', '-map', `${clips.length}:a`, ...enc, out]);
  } else {
    const frame = shotFrame(s.id);
    if (!frame) die(`Сцена ${s.id}: нет ни клипа, ни кадра`);
    const frames = Math.ceil(dur * fps);
    const zMax = s.zoom ?? 1.08;
    const zf = `min(1+${((zMax - 1) / frames).toFixed(6)}*on,${zMax})`;
    const vf = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=z='${zf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps},trim=duration=${dur.toFixed(3)},setsar=1,format=yuv420p${fades.length ? ',' + fades.join(',') : ''}`;
    ff(['-loop', '1', '-framerate', String(fps), '-t', (dur + 0.2).toFixed(3), '-i', frame, '-i', audio, '-vf', vf, '-map', '0:v', '-map', '1:a', ...enc, out]);
  }
  return out;
}

const srtTime = t => { const ms = Math.round(t * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };

function cmdAssemble() {
  const pr = loadProject();
  const draft = !!flags.draft;
  const shots = pr.shots.filter(s => pick(s.id));
  if (!shots.length) die('Нет сцен для сборки');
  const segs = []; const cues = []; let T = 0;
  shots.forEach((s, i) => {
    const a = buildShotAudio(pr, s);
    const seg = buildShotVideo(pr, s, a.dur, i === 0, i === shots.length - 1, draft);
    const real = duration(seg);
    a.cues.forEach(c => cues.push({ ...c, start: c.start + T, end: c.end + T }));
    log(`• ${s.id}: ${real.toFixed(1)} с ${shotClips(s.id).length && s.animate !== false ? '(клипы)' : '(кадр + наезд)'}`);
    segs.push(seg); T += real;
  });
  ensureDir(P('out'));
  const list = P('assets', 'build', 'segments.txt');
  fs.writeFileSync(list, segs.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const joined = P('assets', 'build', 'joined.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

  // субтитры
  const srt = P('out', 'final.srt');
  const showName = pr.subtitles?.names ?? false;
  fs.writeFileSync(srt, cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${showName ? c.who + ': ' : ''}${c.text}\n`).join('\n'));

  // музыка + громкость
  const music = firstFile(P('input'), 'music', AUD) || (exists(P('assets', 'music.wav')) ? P('assets', 'music.wav') : null);
  const mVol = pr.music?.volume ?? 0.16;
  const total = duration(joined);
  const out = P('out', draft ? 'draft.mp4' : 'final.mp4');
  const burn = pr.subtitles?.burn;
  const subStyle = pr.subtitles?.style || 'FontName=Arial,FontSize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=40,Bold=1';
  const vMap = burn ? ['-vf', `subtitles='${srt.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}':force_style='${subStyle}'`, '-c:v', 'libx264', '-crf', draft ? '26' : '18', '-preset', draft ? 'veryfast' : 'medium'] : ['-c:v', 'copy'];
  const loud = `loudnorm=I=${pr.loudness ?? -14}:TP=-1.5:LRA=11`;
  if (music) {
    const fc = `[0:a]asplit=2[vo][sc];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${mVol},atrim=0:${total.toFixed(3)},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(2)}:d=2.5[m];` +
      `[m][sc]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=500[md];[vo][md]amix=inputs=2:duration=first:normalize=0,${loud}[a]`;
    ff(['-i', joined, '-stream_loop', '-1', '-i', music, '-filter_complex', fc, '-map', '0:v', '-map', '[a]', ...vMap, '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', out]);
  } else {
    ff(['-i', joined, '-af', loud, ...vMap, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  }
  log(`✓ ${rel(out)} — ${duration(out).toFixed(1)} с, ${segs.length} сцен; субтитры: ${rel(srt)}${burn ? ' (вшиты)' : ''}`);
}

function cmdStatus() {
  const pr = loadProject();
  const lines = allLines(pr);
  const refsOk = pr.characters.filter(c => firstFile(P('input', 'refs'), c.id, IMG) || firstFile(P('assets', 'refs'), `char_${c.id}`, IMG)).length;
  log(`Персонажи: ${refsOk}/${pr.characters.length}`);
  log(`Кадры:     ${pr.shots.filter(s => shotFrame(s.id)).length}/${pr.shots.length}`);
  log(`Реплики:   ${lines.filter(l => lineVoice(l.id)).length}/${lines.length}`);
  log(`Клипы:     ${pr.shots.filter(s => shotClips(s.id).length).length}/${pr.shots.length}`);
  const tot = pr.shots.reduce((a, s) => a + shotDuration(pr, s), 0);
  log(`Оценка длины: ${Math.floor(tot / 60)}:${String(Math.round(tot % 60)).padStart(2, '0')}`);
  log(`Финал: ${exists(P('out', 'final.mp4')) ? 'out/final.mp4' : '—'}`);
}

const COMMANDS = { init: cmdInit, check: cmdCheck, prompts: cmdPrompts, refs: cmdRefs, frames: cmdFrames, voices: cmdVoices, clips: cmdClips, lipsync: cmdLipsync, music: cmdMusic, sheet: cmdSheet, assemble: cmdAssemble, status: cmdStatus };
if (!COMMANDS[cmd]) {
  log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(cmd === 'help' ? 0 : 1);
}
try { await COMMANDS[cmd](); } catch (e) { die(e.message); }

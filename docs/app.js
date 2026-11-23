// Startbildschirm: Kassetten (Projekte) verwalten.

import { listTapes, putTape, deleteTape, getClip } from './db.js';
import { newTape, tapeLength, timecode } from './tape.js';
import { Deck } from './deck.js';
import { startExport } from './exporter.js';

const $ = (sel) => document.querySelector(sel);
const home = $('#home');
const list = $('#tapeList');
const deck = new Deck($('#deck'), { onEject: () => showHome() });

// ---------- Dialog ----------

function dialog({ title, text = '', input = null, buttons }) {
  return new Promise((resolve) => {
    const el = $('#dialog');
    $('#dialogTitle').textContent = title;
    $('#dialogText').textContent = text;
    const field = $('#dialogInput');
    field.classList.toggle('hidden', input === null);
    field.value = input ?? '';
    const box = $('#dialogButtons');
    box.innerHTML = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.className) btn.className = b.className;
      btn.addEventListener('click', () => {
        el.classList.add('hidden');
        if (b.action) b.action(); // synchron im Klick (iPhone-Freigabe für Video/Ton)
        resolve(b.value === 'input' ? field.value : b.value);
      });
      box.appendChild(btn);
    }
    el.classList.remove('hidden');
    if (input !== null) setTimeout(() => { field.focus(); field.select(); }, 50);
  });
}

// ---------- Liste ----------

async function render() {
  const tapes = await listTapes();
  list.innerHTML = '';
  $('#empty').classList.toggle('hidden', tapes.length > 0);
  for (const tape of tapes) {
    const li = document.createElement('li');
    li.className = 'tape';
    const n = tape.segments.length;
    li.innerHTML = `
      <button class="tape-open">
        <span class="cassette"><span class="label"></span><span class="reels"><i></i><i></i></span></span>
        <span class="info">
          <span class="name"></span>
          <span class="meta">${timecode(tapeLength(tape))} · ${n} ${n === 1 ? 'Aufnahme' : 'Aufnahmen'}</span>
          <span class="date">${new Date(tape.updatedAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        </span>
      </button>
      <button class="tape-more" aria-label="Optionen">•••</button>`;
    li.querySelector('.name').textContent = tape.name;
    li.querySelector('.tape-open').addEventListener('click', () => openTape(tape));
    li.querySelector('.tape-more').addEventListener('click', () => tapeMenu(tape));
    list.appendChild(li);
  }
  updateStorage();
}

async function updateStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const mb = (b) => (b / 1024 / 1024).toFixed(0);
    $('#storage').textContent = `Speicher: ${mb(usage)} MB belegt${quota ? ` von ca. ${mb(quota)} MB` : ''}`;
  } catch (e) { /* egal */ }
}

function openTape(tape) {
  home.classList.add('hidden');
  deck.open(tape);
}

function showHome() {
  home.classList.remove('hidden');
  render();
}

async function newTapeFlow() {
  const tapes = await listTapes();
  const name = await dialog({
    title: 'Neue Kassette',
    input: `Kassette ${tapes.length + 1}`,
    buttons: [{ label: 'Abbrechen', value: null }, { label: 'Einlegen', value: 'input', className: 'primary' }],
  });
  if (name === null) return;
  const tape = newTape(name.trim() || `Kassette ${tapes.length + 1}`);
  await putTape(tape);
  openTape(tape);
}

async function tapeMenu(tape) {
  const choice = await dialog({
    title: tape.name,
    buttons: [
      { label: 'Als Video speichern', value: 'export', className: 'primary' },
      { label: 'Umbenennen', value: 'rename' },
      { label: 'Löschen', value: 'delete', className: 'danger' },
      { label: 'Abbrechen', value: null },
    ],
  });
  if (choice === 'rename') {
    const name = await dialog({
      title: 'Umbenennen', input: tape.name,
      buttons: [{ label: 'Abbrechen', value: null }, { label: 'Sichern', value: 'input', className: 'primary' }],
    });
    if (name && name.trim()) {
      tape.name = name.trim();
      await putTape(tape);
      render();
    }
  } else if (choice === 'delete') {
    const ok = await dialog({
      title: 'Kassette löschen?', text: `Alle Aufnahmen auf „${tape.name}“ gehen verloren.`,
      buttons: [{ label: 'Abbrechen', value: false }, { label: 'Löschen', value: true, className: 'danger' }],
    });
    if (ok) { await deleteTape(tape); render(); }
  } else if (choice === 'export') {
    if (tapeLength(tape) < 0.1) {
      await dialog({ title: 'Die Kassette ist noch leer.', buttons: [{ label: 'OK', value: true }] });
      return;
    }
    const firstBlob = await getClip(tape.segments[0].clip);
    const firstUrl = firstBlob ? URL.createObjectURL(firstBlob) : null;
    const ok = await dialog({
      title: 'Als Video speichern',
      text: `Die Kassette wird in Echtzeit überspielt (${timecode(tapeLength(tape))}). Lass die App so lange offen.`,
      buttons: [
        { label: 'Abbrechen', value: false },
        { label: 'Los', value: true, className: 'primary', action: () => runExport(tape, firstUrl) },
      ],
    });
    if (!ok && firstUrl) URL.revokeObjectURL(firstUrl);
  }
}

// Wird direkt aus dem "Los"-Klick aufgerufen (wichtig fürs iPhone)
function runExport(tape, firstUrl) {
  const overlay = $('#exportOverlay');
  const status = $('#exportStatus');
  const actions = $('#exportActions');
  overlay.classList.remove('hidden');
  actions.innerHTML = '';
  status.textContent = 'Überspiele…';
  const job = startExport(tape, (t, total) => {
    status.textContent = `Überspiele… ${timecode(t)} / ${timecode(total)}`;
  }, firstUrl);
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Abbrechen';
  cancelBtn.addEventListener('click', () => job.cancel());
  actions.appendChild(cancelBtn);

  job.promise.then((file) => {
    actions.innerHTML = '';
    if (!file) { overlay.classList.add('hidden'); return; }
    status.textContent = 'Fertig! Tippe auf „Teilen“ und dann „Video sichern“, um es in Fotos zu speichern.';
    const share = document.createElement('button');
    share.className = 'primary';
    share.textContent = 'Teilen / In Fotos sichern';
    share.addEventListener('click', async () => {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: tape.name }); } catch (e) { /* abgebrochen */ }
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }
    });
    const close = document.createElement('button');
    close.textContent = 'Schließen';
    close.addEventListener('click', () => overlay.classList.add('hidden'));
    actions.append(share, close);
  }).catch((e) => {
    console.error(e);
    status.textContent = 'Export fehlgeschlagen: ' + (e && e.message ? e.message : e);
    actions.innerHTML = '';
    const close = document.createElement('button');
    close.textContent = 'Schließen';
    close.addEventListener('click', () => overlay.classList.add('hidden'));
    actions.appendChild(close);
  });
}

// ---------- Start ----------

$('#newTape').addEventListener('click', newTapeFlow);

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
$('#installHint').classList.toggle('hidden', !isIOS || standalone);

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (document.fonts && document.fonts.load) document.fonts.load('44px VT323').catch(() => {});

render();

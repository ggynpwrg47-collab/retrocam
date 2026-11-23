// Der Camcorder: Kamera/Sucher, Aufnahme, Wiedergabe, Spulen, Überschreiben.

import { VHSRenderer } from './vhs.js';
import { uid, tapeLength, recordSegment, segmentAt, timecode } from './tape.js';
import { putTape, putClip, getClip, cleanupClips } from './db.js';

const SHUTTLE_SPEED = 6; // Spulgeschwindigkeit (x-fach)

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
};

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function probeDuration(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      resolve(d);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => finish(v.duration);
    v.onerror = () => finish(NaN);
    setTimeout(() => finish(NaN), 4000);
    v.src = url;
  });
}

export class Deck {
  constructor(root, { onEject }) {
    this.root = root;
    this.onEject = onEject;
    this.$ = (sel) => root.querySelector(sel);

    this.live = this.$('#live');
    this.vcr = this.$('#vcr');
    this.camVideo = this.$('#camVideo');
    this.fx = this.$('#fx');
    this.fxCtx = this.fx.getContext('2d');
    this.bar = this.$('#tapebar');
    this.barCtx = this.bar.getContext('2d');
    this.osdMode = this.$('#osdMode');
    this.osdCounter = this.$('#osdCounter');
    this.osdHint = this.$('#osdHint');
    this.osdName = this.$('#osdName');
    this.message = this.$('#screenMessage');

    try {
      this.vhs = new VHSRenderer(this.live);
    } catch (e) {
      this.vhs = null;
      console.error(e);
    }

    this.mode = 'standby';
    this.tape = null;
    this.head = 0;
    this.busy = false;
    this.stream = null;
    this.cameraStarting = null;
    this.rec = null;
    this.urls = new Map();
    this.segIndex = -1;
    this.loadedClip = null;
    this.seekPending = false;
    this.glitchStart = -1e9;
    this.flashUntil = 0;
    this.snowUntil = 0;
    this.lastFrame = 0;
    this.showDate = localStorage.getItem('showDate') !== '0';
    this.osdZoom = this.$('#osdZoom');
    this.zoom = 1;
    this.zoomMin = 1;
    this.zoomMax = 4;
    this.hwZoom = false;   // echter Kamera-Zoom verfügbar?
    this.zoomDir = 0;      // -1 = W, +1 = T (Taste gehalten)
    this.zoomShownUntil = 0;
    this.mimeType = pickMimeType();

    this.bindButtons();
    this.bindTapeBar();
    this.bindZoom();

    this.vcr.addEventListener('seeked', () => { this.seekPending = false; });
    this.vcr.addEventListener('error', () => { this.seekPending = false; });

    document.addEventListener('visibilitychange', () => {
      if (!this.tape) return;
      if (document.hidden) {
        if (this.mode === 'recording') this.stopRecording();
        else if (this.mode === 'playing' || this.isShuttling()) this.pause();
      } else {
        this.requestWakeLock();
        if (this.mode === 'standby') this.startCamera();
      }
    });

    this.loop = this.loop.bind(this);
  }

  // ---------- Öffnen / Schließen ----------

  async open(tape) {
    this.tape = tape;
    this.tape.segments.sort((a, b) => a.tapeStart - b.tapeStart);
    this.head = Math.min(Math.max(0, tape.head || 0), tapeLength(tape));
    this.mode = 'standby';
    this.busy = false;
    this.zoom = this.zoomMin;
    this.segIndex = -1;
    this.loadedClip = null;
    this.vcr.removeAttribute('src');
    this.osdName.textContent = tape.name.toUpperCase();
    this.root.classList.remove('hidden');
    this.updateButtons();
    this.requestWakeLock();
    this.raf = requestAnimationFrame(this.loop);

    // Alle Clips der Kassette als Objekt-URLs bereitlegen (für sofortiges Abspielen)
    for (const seg of tape.segments) await this.ensureUrl(seg.clip);
    if (!this.vhs) this.showMessage('Dein Browser unterstützt kein WebGL – der VHS-Effekt kann nicht angezeigt werden.');
    else this.startCamera();
  }

  async close() {
    if (this.mode === 'recording') await this.stopRecording();
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    this.vcr.pause();
    this.stopCamera();
    cancelAnimationFrame(this.raf);
    if (this.tape) {
      this.tape.head = this.head;
      await putTape(this.tape);
    }
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.vcr.removeAttribute('src');
    this.vcr.load();
    this.tape = null;
    this.releaseWakeLock();
    this.root.classList.add('hidden');
  }

  async ensureUrl(clipId) {
    if (this.urls.has(clipId)) return this.urls.get(clipId);
    const blob = await getClip(clipId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(clipId, url);
    return url;
  }

  // ---------- Kamera ----------

  startCamera() {
    if (this.stream) return Promise.resolve(true);
    if (this.cameraStarting) return this.cameraStarting;
    this.cameraStarting = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
        // Falls inzwischen auf Wiedergabe umgeschaltet wurde: gleich wieder freigeben
        if (!this.tape || !this.showsCamera()) {
          stream.getTracks().forEach((t) => t.stop());
          return false;
        }
        this.stream = stream;
        this.camVideo.srcObject = stream;
        await this.camVideo.play().catch(() => {});
        this.hideMessage();
        this.setupZoom();
        return true;
      } catch (e) {
        console.error(e);
        this.showMessage('Kein Kamerazugriff. Bitte Kamera und Mikrofon für diese Seite erlauben und neu laden.');
        return false;
      } finally {
        this.cameraStarting = null;
      }
    })();
    return this.cameraStarting;
  }

  /** Kamera + Mikrofon freigeben (bei Wiedergabe – sonst ist auf dem iPhone der Ton sehr leise). */
  stopCamera() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.camVideo.srcObject = null;
  }

  // ---------- Hauptschleife ----------

  loop(now) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;

    if (this.showsCamera() && this.vhs && this.stream) {
      const glitch = Math.max(0, 1 - (now - this.glitchStart) / 600);
      this.vhs.render(this.camVideo, { glitch, showStamp: this.showDate, time: now / 1000, zoom: this.hwZoom ? 1 : this.zoom });
    }
    if (this.zoomDir && this.showsCamera()) this.setZoom(this.zoom * Math.exp(this.zoomDir * (Math.log(this.zoomMax / this.zoomMin) / 2.5) * dt)); // ganzer Bereich in ca. 2,5 s

    if (this.mode === 'recording' && this.rec) {
      this.head = this.rec.startHead + (performance.now() - this.rec.t0) / 1000;
    } else if (this.mode === 'playing') {
      this.updatePlayback();
    } else if (this.isShuttling()) {
      this.shuttleStep(dt);
    }

    this.drawFx(now);
    this.updateOSD(now);
    this.drawTapeBar();
  }

  showsCamera() { return this.mode === 'standby' || this.mode === 'recording'; }
  isShuttling() { return this.mode === 'rewinding' || this.mode === 'forwarding'; }
  length() { return this.tape ? tapeLength(this.tape) : 0; }

  setMode(mode) {
    this.mode = mode;
    this.root.classList.toggle('vcr-mode', !this.showsCamera());
    if (this.showsCamera()) {
      this.startCamera();
    } else {
      this.stopCamera();
    }
    this.updateButtons();
  }

  // ---------- Tasten ----------

  bindButtons() {
    const on = (id, fn) => this.$(id).addEventListener('click', (e) => {
      e.preventDefault();
      if (navigator.vibrate) navigator.vibrate(8);
      fn();
    });
    on('#btnRec', () => this.recButton());
    on('#btnPlay', () => this.playButton());
    on('#btnStop', () => this.stopButton());
    on('#btnRew', () => this.shuttle(-1));
    on('#btnFf', () => this.shuttle(1));
    on('#btnDate', () => {
      this.showDate = !this.showDate;
      localStorage.setItem('showDate', this.showDate ? '1' : '0');
      this.updateButtons();
    });
    on('#btnEject', async () => {
      await this.close();
      this.onEject();
    });
  }

  updateButtons() {
    const set = (id, on) => this.$(id).classList.toggle('active', on);
    set('#btnRec', this.mode === 'recording');
    set('#btnPlay', this.mode === 'playing' || this.mode === 'paused');
    set('#btnRew', this.mode === 'rewinding');
    set('#btnFf', this.mode === 'forwarding');
    set('#btnDate', this.showDate);
    this.$('#btnRec .label').textContent = this.mode === 'recording' ? 'STOP' : 'REC';
    this.$('#btnPlay').innerHTML = this.mode === 'playing' ? ICONS.pause : ICONS.play;
    this.root.classList.toggle('busy', this.busy);
  }

  recButton() {
    if (this.busy) return;
    if (this.mode === 'recording') this.stopRecording();
    else this.startRecording();
  }

  playButton() {
    if (this.busy || this.mode === 'recording') return;
    if (this.mode === 'playing') { this.pause(); return; }
    const len = this.length();
    if (len < 0.1 || this.head >= len - 0.1) {
      this.snow(1200); // leeres Band / Bandende
      return;
    }
    const wasCamera = this.showsCamera();
    this.setMode('playing');
    // Wichtig fürs iPhone: play() muss direkt im Tasten-Klick aufgerufen werden.
    this.seekTo(this.head, wasCamera);
    this.vcr.play().catch(() => {});
  }

  pause() {
    this.vcr.pause();
    this.setMode('paused');
    this.saveHead();
  }

  stopButton() {
    if (this.busy) return;
    if (this.mode === 'recording') { this.stopRecording(); return; }
    this.vcr.pause();
    this.setMode('standby');
    this.saveHead();
  }

  shuttle(direction) {
    if (this.busy || this.mode === 'recording') return;
    const target = direction < 0 ? 'rewinding' : 'forwarding';
    if (this.mode === target) { this.pause(); this.seekTo(this.head, false); return; }
    if (this.length() < 0.1) { this.snow(1200); return; }
    this.vcr.pause();
    this.shuttleDir = direction;
    this.setMode(target);
    this.seekTo(this.head, false);
  }

  shuttleStep(dt) {
    const len = this.length();
    const next = this.head + this.shuttleDir * SHUTTLE_SPEED * dt;
    if (next <= 0) {
      this.head = 0;
      this.setMode('paused');
      this.seekTo(0, false);
      this.saveHead();
      return;
    }
    if (next >= len) {
      // Bandende: zurück zur Kamera – die nächste Aufnahme hängt hinten an
      this.head = len;
      this.vcr.pause();
      this.setMode('standby');
      this.snow(900);
      this.saveHead();
      return;
    }
    this.head = next;
    if (!this.seekPending) this.seekTo(next, false);
  }

  /** Bandanzeige antippen/ziehen = direkt an die Stelle spulen. */
  bindTapeBar() {
    let dragging = false;
    const timeAt = (e) => {
      const r = this.bar.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - r.left), r.width);
      return Math.min(this.length(), (x / r.width) * this.barTotal());
    };
    this.bar.addEventListener('pointerdown', (e) => {
      if (this.busy || this.mode === 'recording' || this.length() < 0.1) return;
      dragging = true;
      this.bar.setPointerCapture(e.pointerId);
      this.vcr.pause();
      if (this.mode !== 'paused') this.setMode('paused');
      this.head = timeAt(e);
      this.seekTo(this.head, false);
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.head = timeAt(e);
      if (!this.seekPending) this.seekTo(this.head, false);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      this.head = timeAt(e);
      this.seekTo(this.head, false);
      this.saveHead();
    };
    this.bar.addEventListener('pointerup', end);
    this.bar.addEventListener('pointercancel', end);
  }

  // ---------- Wiedergabe ----------

  /** Lädt das Segment an Bandstelle t in den Player und springt dorthin. */
  seekTo(t, flash) {
    const hit = segmentAt(this.tape, t);
    if (!hit) return;
    const { seg, index } = hit;
    const offset = Math.max(0, t - seg.tapeStart);
    this.loadSegment(index, offset, flash);
  }

  loadSegment(index, offset, flash) {
    const seg = this.tape.segments[index];
    const url = this.urls.get(seg.clip);
    if (!url) return;
    this.segIndex = index;
    const target = seg.clipOffset + offset;
    const v = this.vcr;
    if (flash) this.flashUntil = performance.now() + 220;
    this.seekPending = true;
    if (this.loadedClip !== seg.clip) {
      this.loadedClip = seg.clip;
      v.src = url;
      const onMeta = () => { v.currentTime = target; };
      v.addEventListener('loadedmetadata', onMeta, { once: true });
    } else if (v.readyState >= 1) {
      v.currentTime = target;
    } else {
      v.addEventListener('loadedmetadata', () => { v.currentTime = target; }, { once: true });
    }
  }

  updatePlayback() {
    const seg = this.tape.segments[this.segIndex];
    if (!seg || this.seekPending) return;
    const v = this.vcr;
    const local = v.currentTime - seg.clipOffset;
    if (local >= seg.duration - 0.02 || v.ended) {
      const next = this.segIndex + 1;
      if (next >= this.tape.segments.length) {
        this.reachedEnd();
        return;
      }
      // Übergang zur nächsten Aufnahme – mit kurzer Störung wie beim echten Band
      this.head = this.tape.segments[next].tapeStart;
      this.loadSegment(next, 0, true);
      v.play().catch(() => {});
      return;
    }
    this.head = seg.tapeStart + Math.max(0, local);
  }

  reachedEnd() {
    this.head = this.length();
    this.vcr.pause();
    this.setMode('standby');
    this.snow(1200);
    this.saveHead();
  }

  // ---------- Aufnahme ----------

  async startRecording() {
    if (!this.vhs) return;
    if (typeof MediaRecorder === 'undefined' || this.mimeType === null) {
      this.showMessage('Dein Browser kann keine Videos aufnehmen (MediaRecorder fehlt). Bitte iOS aktualisieren.');
      return;
    }
    this.vcr.pause();
    const startHead = this.head;
    if (!this.showsCamera()) this.setMode('standby');
    this.busy = true;
    this.updateButtons();
    const ok = await this.startCamera();
    this.busy = false;
    if (!ok || !this.stream) { this.updateButtons(); return; }

    const canvasStream = this.live.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks(), ...this.stream.getAudioTracks()];
    const options = { videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 };
    if (this.mimeType) options.mimeType = this.mimeType;
    let recorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), options);
    } catch (e) {
      recorder = new MediaRecorder(new MediaStream(tracks));
    }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    this.rec = {
      recorder, chunks, canvasStream, startHead,
      clip: `${this.tape.id}/${uid()}`,
      t0: performance.now(),
    };
    this.head = startHead;
    this.glitchStart = performance.now();
    recorder.start();
    this.setMode('recording');
  }

  async stopRecording() {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    this.busy = true;
    const measured = (performance.now() - r.t0) / 1000;
    this.head = r.startHead + measured;
    this.setMode('standby');
    try {
      await new Promise((resolve) => {
        r.recorder.onstop = resolve;
        try { r.recorder.stop(); } catch (e) { resolve(); }
      });
      r.canvasStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(r.chunks, { type: r.recorder.mimeType || this.mimeType || 'video/mp4' });
      const meta = await probeDuration(blob);
      const duration = Number.isFinite(meta) && meta > 0.1 ? meta : measured;
      if (blob.size === 0 || duration < 0.2) {
        this.head = r.startHead;
        return;
      }
      await putClip(r.clip, blob);
      this.urls.set(r.clip, URL.createObjectURL(blob));
      recordSegment(this.tape, { id: uid(), clip: r.clip, tapeStart: r.startHead, clipOffset: 0, duration });
      this.head = this.tape.head;
      this.tape.updatedAt = Date.now();
      await putTape(this.tape);
      await cleanupClips(this.tape);
      this.loadedClip = null;
    } catch (e) {
      console.error(e);
      this.head = r.startHead;
      this.showMessage('Die Aufnahme konnte nicht gespeichert werden (Speicher voll?).', 4000);
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  saveHead() {
    if (!this.tape || this.busy) return;
    this.tape.head = this.head;
    putTape(this.tape).catch(() => {});
  }

  // ---------- Anzeige ----------

  snow(ms) { this.snowUntil = performance.now() + ms; }

  drawFx(now) {
    const ctx = this.fxCtx;
    const w = this.fx.width, h = this.fx.height;
    const snow = now < this.snowUntil || (this.mode === 'playing' && now < this.flashUntil);
    const bars = this.isShuttling() || (this.mode === 'paused' && this.seekPending);
    if (!snow && !bars) {
      if (this.fxVisible) { ctx.clearRect(0, 0, w, h); this.fxVisible = false; }
      return;
    }
    this.fxVisible = true;
    if (!this.noise || this.noise.width !== w) this.noise = ctx.createImageData(w, h);
    const d = this.noise.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
    if (snow) {
      ctx.putImageData(this.noise, 0, 0);
      return;
    }
    ctx.clearRect(0, 0, w, h);
    const t = now / 1000;
    for (let k = 0; k < 3; k++) {
      const speed = 0.45 + k * 0.21;
      const phase = ((t * speed * (this.shuttleDir || 1) + k * 0.37) % 1 + 1) % 1;
      const bh = 4 + k * 3;
      const y = Math.round(phase * (h + 20) - 10);
      ctx.putImageData(this.noise, 0, 0, 0, y, w, bh);
    }
  }

  updateOSD(now) {
    const blink = Math.floor(now / 500) % 2 === 0;
    let label;
    switch (this.mode) {
      case 'recording': label = `<span class="rec-dot${blink ? '' : ' off'}"></span><span class="red">REC</span>`; break;
      case 'playing': label = 'PLAY &#x25B6;&#xFE0E;'; break;
      case 'paused': label = 'PAUSE &#x275A;&#x275A;'; break;
      case 'rewinding': label = '&#x25C0;&#xFE0E;&#x25C0;&#xFE0E; REW'; break;
      case 'forwarding': label = '&#x25B6;&#xFE0E;&#x25B6;&#xFE0E; FF'; break;
      default: label = this.busy ? 'SAVE' : 'STBY';
    }
    if (label !== this.lastLabel) { this.osdMode.innerHTML = label; this.lastLabel = label; }
    const counter = timecode(this.head);
    if (counter !== this.lastCounter) { this.osdCounter.textContent = counter; this.lastCounter = counter; }

    let hint = '';
    const len = this.length();
    if (this.mode === 'recording' && this.head < len - 0.05) hint = 'ÜBERSPIELEN';
    else if (this.mode === 'standby' && !this.busy && this.head < len - 0.05) hint = 'REC = ÜBERSPIELEN';
    if (hint !== this.lastHint) { this.osdHint.textContent = hint; this.lastHint = hint; }

    const showZoom = this.showsCamera() && (now < this.zoomShownUntil || this.zoomDir !== 0);
    this.osdZoom.classList.toggle('hidden', !showZoom);
    if (showZoom) {
      const range = Math.log(this.zoomMax / this.zoomMin) || 1;
      const pos = Math.log(this.zoom / this.zoomMin) / range;
      this.osdZoomFill.style.width = `${Math.round(Math.min(1, Math.max(0, pos)) * 100)}%`;
      const label = `${this.hwZoom ? '' : 'D.'}ZOOM ${this.zoom.toFixed(1)}x`;
      if (label !== this.lastZoomLabel) { this.osdZoomLabel.textContent = label; this.lastZoomLabel = label; }
    }
  }

  // ---------- Zoom ----------

  /** Nach dem Kamerastart: echten Kamera-Zoom nutzen, wenn der Browser ihn anbietet. */
  setupZoom() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const prevFactor = this.zoom / this.zoomMin;
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      this.hwZoom = true;
      this.zoomMin = caps.zoom.min;
      this.zoomMax = Math.min(caps.zoom.max, caps.zoom.min * 10);
    } else {
      this.hwZoom = false;
      this.zoomMin = 1;
      this.zoomMax = 4;
    }
    this.zoom = -1; // erzwingt Anwenden
    this.setZoom(this.zoomMin * prevFactor, true);
  }

  setZoom(value, silent) {
    const z = Math.min(this.zoomMax, Math.max(this.zoomMin, value));
    if (Math.abs(z - this.zoom) < 1e-4) return;
    this.zoom = z;
    if (!silent) this.zoomShownUntil = performance.now() + 1500;
    if (this.hwZoom) this.applyHardwareZoom();
  }

  applyHardwareZoom() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (!track) return;
    if (this.zoomApplying) { this.zoomPending = true; return; }
    this.zoomApplying = true;
    track.applyConstraints({ advanced: [{ zoom: this.zoom }] })
      .catch(() => { this.hwZoom = false; this.zoomMin = 1; this.zoomMax = 4; this.zoom = 1; })
      .finally(() => {
        this.zoomApplying = false;
        if (this.zoomPending) { this.zoomPending = false; this.applyHardwareZoom(); }
      });
  }

  bindZoom() {
    this.osdZoomFill = this.$('#osdZoom .fill');
    this.osdZoomLabel = this.$('#osdZoom .zlabel');
    // W/T-Wippe: gedrückt halten
    for (const [id, dir] of [['#btnZoomW', -1], ['#btnZoomT', 1]]) {
      const btn = this.$(id);
      const stop = () => { if (this.zoomDir === dir) this.zoomDir = 0; btn.classList.remove('active'); };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!this.showsCamera()) return;
        btn.setPointerCapture(e.pointerId);
        btn.classList.add('active');
        this.zoomDir = dir;
        this.zoomShownUntil = performance.now() + 1500;
      });
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    // Zwei-Finger-Zoom auf dem Bild
    const screen = this.$('#screen');
    const touches = new Map();
    let startDist = 0, startZoom = 1;
    const dist = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    screen.addEventListener('pointerdown', (e) => {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { startDist = dist(); startZoom = this.zoom; }
    });
    screen.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && startDist > 10 && this.showsCamera()) this.setZoom(startZoom * dist() / startDist);
    });
    const end = (e) => { touches.delete(e.pointerId); startDist = 0; };
    screen.addEventListener('pointerup', end);
    screen.addEventListener('pointercancel', end);
  }

  barTotal() { return Math.max(this.length(), this.head, 10) * 1.08; }

  drawTapeBar() {
    const c = this.bar;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = this.barCtx;
    const total = this.barTotal();
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, w, h);
    this.tape.segments.forEach((s, i) => {
      ctx.fillStyle = i % 2 === 0 ? '#d1732e' : '#f5a145';
      ctx.fillRect(Math.floor((s.tapeStart / total) * w), 0, Math.max(1, Math.ceil((s.duration / total) * w)), h);
    });
    if (this.mode === 'recording' && this.rec) {
      ctx.fillStyle = '#e02020';
      const x = (this.rec.startHead / total) * w;
      ctx.fillRect(x, 0, Math.max(1, ((this.head - this.rec.startHead) / total) * w), h);
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.min(w - 3 * dpr, (this.head / total) * w), 0, 3 * dpr, h);
  }

  showMessage(text, ms) {
    this.message.textContent = text;
    this.message.classList.remove('hidden');
    clearTimeout(this.messageTimer);
    if (ms) this.messageTimer = setTimeout(() => this.hideMessage(), ms);
  }

  hideMessage() { this.message.classList.add('hidden'); }

  // ---------- Bildschirm anlassen ----------

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch (e) { /* egal */ }
  }

  releaseWakeLock() {
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
  }
}


// Export der ganzen Kassette als eine Videodatei.
// 1. Versuch: Schnell-Export (Aufnahmen werden ohne Neukodierung zusammengesetzt, siehe remux.js).
// 2. Notfalls: Echtzeit-Überspielen (wie früher vom Camcorder auf den Videorekorder).

import { getClip } from './db.js';
import { tapeLength } from './tape.js';
import { remuxTape, FallbackError } from './remux.js';

const WIDTH = 640;
const HEIGHT = 480;

function pickMimeType() {
  const candidates = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

const wait = (target, event, ms = 4000) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); target.removeEventListener(event, done); resolve(); };
  const timer = setTimeout(done, ms);
  target.addEventListener(event, done, { once: true });
});

/**
 * Muss direkt aus einem Klick heraus aufgerufen werden (iPhone: Ton/Video-Freigabe).
 * onProgress(sekunden, gesamt). Gibt { promise, cancel } zurück.
 */
export function startExport(tape, onProgress, firstUrl) {
  const video = document.createElement('video');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
  document.body.appendChild(video);
  // Im Klick mit dem ersten Clip anstoßen, damit das iPhone späteres play() erlaubt
  // (stumm anstoßen und gleich wieder anhalten – der Ton wird nur im Notfall-Modus gebraucht)
  if (firstUrl) video.src = firstUrl;
  video.muted = true;
  const unlocked = video.play().then(() => video.pause()).catch(() => {});

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audio = AudioCtx ? new AudioCtx() : null;
  if (audio && audio.state === 'suspended') audio.resume().catch(() => {});

  let cancelled = false;
  const cancel = () => { cancelled = true; };

  const realtime = async () => {
    const total = tapeLength(tape);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const tracks = [...canvas.captureStream(30).getVideoTracks()];
    if (audio) {
      const source = audio.createMediaElementSource(video);
      const dest = audio.createMediaStreamDestination();
      source.connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType, videoBitsPerSecond: 3_000_000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    let drawing = true;
    const draw = () => {
      if (!drawing) return;
      if (video.readyState >= 2) ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
      requestAnimationFrame(draw);
    };

    const urls = [];
    try {
      recorder.start(1000);
      requestAnimationFrame(draw);
      for (const seg of tape.segments) {
        if (cancelled) break;
        let url = seg === tape.segments[0] && firstUrl ? firstUrl : null;
        if (!url) {
          const blob = await getClip(seg.clip);
          if (!blob) continue;
          url = URL.createObjectURL(blob);
          urls.push(url);
        }
        if (video.src !== url) video.src = url;
        if (video.readyState < 1) await wait(video, 'loadedmetadata');
        video.pause();
        const seeked = wait(video, 'seeked');
        video.currentTime = seg.clipOffset;
        await seeked;
        await video.play().catch(() => {});
        const end = seg.clipOffset + seg.duration;
        await new Promise((resolve) => {
          let lastTime = -1, stalledSince = performance.now();
          const check = () => {
            if (video.currentTime !== lastTime) { lastTime = video.currentTime; stalledSince = performance.now(); }
            const stalled = performance.now() - stalledSince > 5000;
            if (video.paused && !video.ended) video.play().catch(() => {});
            if (cancelled || stalled || video.ended || video.currentTime >= end - 0.03) { resolve(); return; }
            onProgress(Math.min(total, seg.tapeStart + video.currentTime - seg.clipOffset), total, 'realtime');
            requestAnimationFrame(check);
          };
          check();
        });
        video.pause();
      }
      drawing = false;
      await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
    } finally {
      drawing = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (firstUrl) URL.revokeObjectURL(firstUrl);
      video.remove();
      if (audio) audio.close().catch(() => {});
    }
    if (cancelled) return null;
    const type = recorder.mimeType || mimeType || 'video/mp4';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    const safeName = tape.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'RetroCam';
    return new File([blob], `${safeName}.${ext}`, { type });
  };

  const cleanup = () => {
    video.remove();
    if (audio) audio.close().catch(() => {});
    if (firstUrl) URL.revokeObjectURL(firstUrl);
  };

  const promise = (async () => {
    try {
      onProgress(0, tapeLength(tape), 'copy');
      const file = await remuxTape(tape, {
        onProgress,
        isCancelled: () => cancelled,
      });
      cleanup();
      return file;
    } catch (e) {
      if (cancelled) { cleanup(); return null; }
      if (!(e instanceof FallbackError)) { cleanup(); throw e; }
      console.warn('Schnell-Export nicht möglich, nehme Echtzeit:', e.message);
      await unlocked;
      video.muted = false;
      return realtime();
    }
  })();

  return { promise, cancel };
}

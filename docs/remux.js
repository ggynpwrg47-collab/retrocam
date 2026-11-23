// Schneller Export der ganzen Kassette in EINE MP4-Datei – ohne Echtzeit-Abspielen.
//
// Weg 1 "Kopieren": Wenn jedes Stück am Anfang einer Aufnahme (bzw. an einem Schlüsselbild)
//   beginnt, werden die Videodaten unverändert zusammengesetzt. Dauert nur Sekunden.
// Weg 2 "Umrechnen": Beginnt ein Stück mitten in einer alten Aufnahme (nach einer
//   Überspielstelle), wird das Video mit dem Video-Chip des Geräts (WebCodecs) neu kodiert.
//   Bildgenau und deutlich schneller als Echtzeit.
// Der Ton wird in beiden Fällen unverändert übernommen.
// Klappt beides nicht, wirft das Modul FallbackError -> Echtzeit-Überspielen (exporter.js).

import { Muxer, StreamTarget } from './vendor/mp4-muxer.mjs';
import { getClip, putClip, deleteClip, clipKeys } from './db.js';
import { tapeLength } from './tape.js';

const KEY_TOLERANCE = 0.1;            // Kopieren nur, wenn ein Schlüsselbild so nah am Schnitt liegt
const READ_CHUNK = 4 * 1024 * 1024;   // Lese-Häppchen
const WRITE_CHUNK = 32 * 1024 * 1024; // Ausgabe wird in diesen Stücken zwischengespeichert
const MAX_QUEUE = 24;                 // Rückstau für Decoder/Encoder

export class FallbackError extends Error {}

let mp4boxPromise;
function loadMP4Box() {
  if (window.MP4Box) return Promise.resolve();
  if (!mp4boxPromise) {
    mp4boxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mp4box.all.min.js';
      s.onload = resolve;
      s.onerror = () => { mp4boxPromise = null; reject(new FallbackError('MP4-Bibliothek konnte nicht geladen werden')); };
      document.head.appendChild(s);
    });
  }
  return mp4boxPromise;
}

const us = (sec) => Math.round(sec * 1e6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function videoCodecName(codec) {
  if (/^avc[13]/.test(codec)) return 'avc';
  if (/^(hvc1|hev1)/.test(codec)) return 'hevc';
  if (/^vp09/.test(codec)) return 'vp9';
  if (/^av01/.test(codec)) return 'av1';
  return null;
}

function audioCodecName(codec) {
  if (/^mp4a/i.test(codec)) return 'aac';
  if (/^opus/i.test(codec)) return 'opus';
  return null;
}

function trackDescription(file, trackId) {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new window.DataStream(undefined, 0, window.DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // ohne Box-Header
    }
    if (entry.esds) {
      try { return new Uint8Array(entry.esds.esd.descs[0].descs[0].data); } catch (e) { return undefined; }
    }
  }
  return undefined;
}

function sameBytes(a, b) {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function clipInfo(info, file) {
  const v = info.videoTracks[0];
  const a = info.audioTracks[0] || null;
  if (!v) throw new FallbackError('keine Videospur');
  const c = {
    vId: v.id,
    vCodec: v.codec,
    vName: videoCodecName(v.codec),
    width: v.video.width,
    height: v.video.height,
    vDesc: trackDescription(file, v.id),
    aId: a ? a.id : null,
    aCodec: a ? a.codec : null,
    aName: a ? audioCodecName(a.codec) : null,
    channels: a ? a.audio.channel_count : 0,
    rate: a ? a.audio.sample_rate : 0,
    aDesc: a ? trackDescription(file, a.id) : undefined,
  };
  if (a && !c.aName) throw new FallbackError('Tonformat nicht unterstützt: ' + a.codec);
  return c;
}

/**
 * Liest eine MP4-Datei häppchenweise. onSamples sammelt nur; nach jedem Häppchen
 * wird `process` abgewartet (dort darf asynchron gearbeitet werden).
 */
async function demux(blob, { onReady, onSamples, process, shouldStop }) {
  const file = window.MP4Box.createFile();
  let error = null;
  let cbError = null;
  let ready = false;
  file.onError = (e) => { error = e; };
  file.onReady = (info) => {
    ready = true;
    try { onReady(info, file); } catch (e) { cbError = e; return; }
    for (const t of info.tracks) file.setExtractionOptions(t.id, null, { nbSamples: 60 });
    file.start();
  };
  file.onSamples = (id, user, samples) => {
    if (cbError) return;
    try { onSamples(id, samples); } catch (e) { cbError = e; return; }
    if (samples.length) file.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
  };
  let offset = 0;
  while (offset < blob.size && !error && !cbError && !shouldStop()) {
    const buf = await blob.slice(offset, offset + READ_CHUNK).arrayBuffer();
    buf.fileStart = offset;
    file.appendBuffer(buf);
    offset += buf.byteLength;
    if (offset >= blob.size && !cbError) file.flush();
    if (!cbError && ready) {
      try { await process(); } catch (e) { cbError = e; }
    }
  }
  if (cbError) throw cbError;
  if (error) throw new FallbackError('MP4 konnte nicht gelesen werden: ' + error);
  if (!ready) throw new FallbackError('Aufnahme ist kein MP4');
}

/** Entfernt Reste abgebrochener Exporte. */
export async function cleanupExports() {
  const keys = (await clipKeys()) || [];
  for (const k of keys) if (String(k).startsWith('export/')) await deleteClip(k);
}

export function canTranscode() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

async function pickEncoderConfig(width, height) {
  for (const codec of ['avc1.4d401f', 'avc1.42001f', 'avc1.640028']) {
    const config = {
      codec, width, height,
      bitrate: 3_000_000,
      framerate: 30,
      latencyMode: 'realtime', // keine B-Frames
      avc: { format: 'avc' },
    };
    try {
      const res = await VideoEncoder.isConfigSupported(config);
      if (res.supported) return config;
    } catch (e) { /* nächsten probieren */ }
  }
  return null;
}

/**
 * Setzt die ganze Kassette zu einer MP4-Datei zusammen.
 * onProgress(sekunden, gesamt, weg) mit weg = 'copy' | 'transcode'.
 * @returns {Promise<File|null>} null bei Abbruch. Wirft FallbackError, wenn das nicht geht.
 */
export async function remuxTape(tape, { onProgress, isCancelled }) {
  await loadMP4Box();
  const midClipStart = tape.segments.some((s) => s.clipOffset > 0.05);
  if (!midClipStart) {
    try {
      return await build(tape, 'copy', onProgress, isCancelled);
    } catch (e) {
      if (!(e instanceof FallbackError) || !canTranscode()) throw e;
      console.warn('Kopieren nicht möglich, rechne um:', e.message);
    }
  }
  if (!canTranscode()) throw new FallbackError('WebCodecs nicht verfügbar');
  return build(tape, 'transcode', onProgress, isCancelled);
}

async function build(tape, mode, onProgress, isCancelled) {
  const total = tapeLength(tape);
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const partKeys = [];

  // ---- Ausgabe: stückweise in der Datenbank zwischenspeichern (spart Arbeitsspeicher)
  let pending = [];
  let pendingBytes = 0;
  let written = 0;
  let writeError = null;
  const flush = async (force) => {
    if (writeError) throw writeError;
    if (!pendingBytes || (!force && pendingBytes < WRITE_CHUNK)) return;
    const key = `export/${jobId}/${String(partKeys.length).padStart(5, '0')}`;
    const blob = new Blob(pending, { type: 'video/mp4' });
    pending = [];
    pendingBytes = 0;
    await putClip(key, blob);
    partKeys.push(key);
  };
  const target = new StreamTarget({
    onData: (data, position) => {
      if (position !== written) { writeError = new FallbackError('Unerwartete Schreibposition'); return; }
      pending.push(data.slice());
      pendingBytes += data.byteLength;
      written += data.byteLength;
    },
  });

  let muxer = null;
  let first = null;        // Format der ersten Aufnahme
  let encoder = null;
  let encoderError = null;
  let encodedFrames = 0;
  let cursor = 0;          // Ausgabezeit in Sekunden
  let lastAudioOut = -1;
  let videoMetaSent = false;
  let audioMetaSent = false;
  let audioDecoderConfig = null;

  const createMuxer = async (c) => {
    first = c;
    audioDecoderConfig = c.aId ? {
      codec: c.aCodec, numberOfChannels: c.channels, sampleRate: c.rate,
      ...(c.aDesc && c.aName === 'aac' ? { description: c.aDesc } : {}),
    } : null;
    let videoOpt;
    if (mode === 'copy') {
      if (!c.vName) throw new FallbackError('Videoformat nicht unterstützt: ' + c.vCodec);
      videoOpt = { codec: c.vName, width: c.width, height: c.height };
    } else {
      const encConfig = await pickEncoderConfig(c.width, c.height);
      if (!encConfig) throw new FallbackError('Kein passender Video-Encoder');
      encoder = new VideoEncoder({
        output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encoderError = e; } },
        error: (e) => { encoderError = e; },
      });
      encoder.configure(encConfig);
      videoOpt = { codec: 'avc', width: c.width, height: c.height };
    }
    muxer = new Muxer({
      target,
      fastStart: 'fragmented',
      firstTimestampBehavior: 'cross-track-offset',
      video: videoOpt,
      ...(audioDecoderConfig ? { audio: { codec: c.aName, numberOfChannels: c.channels, sampleRate: c.rate } } : {}),
    });
  };

  const checkSameAudio = (c) => {
    if (c.aCodec !== first.aCodec || c.channels !== first.channels || c.rate !== first.rate || !sameBytes(c.aDesc, first.aDesc)) {
      throw new FallbackError('Aufnahmen haben unterschiedliche Tonformate');
    }
  };

  const discardParts = async () => { for (const k of partKeys) await deleteClip(k).catch(() => {}); };

  try {
    for (const seg of tape.segments) {
      if (isCancelled()) { await discardParts(); return null; }
      const blob = await getClip(seg.clip);
      if (!blob) continue;

      const start = seg.clipOffset;
      const end = seg.clipOffset + seg.duration;
      let clip = null;
      let vBase = null;
      let segStart = mode === 'transcode' ? start : null; // ab hier wird ausgegeben (Aufnahme-Zeit)
      let lastVideoEnd = null;
      let videoDone = false;
      let audioDone = false;
      let decoder = null;
      let decoderError = null;
      let fedKey = false;
      const queue = [];     // [trackId, sample]
      const pendingAudio = [];

      const writeAudio = (s) => {
        if (audioDone) return;
        const t = s.cts / s.timescale - vBase;
        const dur = s.duration / s.timescale;
        if (t < segStart - 0.001) return;
        if (t + dur > end + 0.001) { audioDone = true; return; }
        const out = cursor + (t - segStart);
        if (out <= lastAudioOut) return; // keine Überlappung an den Schnitten
        lastAudioOut = out;
        const meta = audioMetaSent ? undefined : { decoderConfig: audioDecoderConfig };
        audioMetaSent = true;
        muxer.addAudioChunkRaw(s.data, 'key', us(out), us(dur), meta);
      };

      const flushPendingAudio = () => {
        if (!pendingAudio.length || segStart === null || vBase === null) return;
        for (const a of pendingAudio) writeAudio(a);
        pendingAudio.length = 0;
      };

      const onFrame = (frame) => {
        const t = frame.timestamp / 1e6;
        const dur = (frame.duration || 33333) / 1e6;
        if (t < start - 0.001 || t >= end - 0.001 || encoderError) { frame.close(); return; }
        const out = new VideoFrame(frame, { timestamp: us(cursor + (t - start)), duration: frame.duration || undefined });
        frame.close();
        try {
          encoder.encode(out, { keyFrame: encodedFrames % 30 === 0 });
          encodedFrames++;
        } catch (e) { encoderError = e; }
        out.close();
        lastVideoEnd = Math.max(lastVideoEnd ?? 0, t + dur);
        onProgress(Math.min(total, seg.tapeStart + (t - start)), total, mode);
      };

      const handleVideo = async (s) => {
        if (vBase === null) vBase = s.cts / s.timescale;
        if (videoDone) return;
        const tc = s.cts / s.timescale - vBase;
        const td = s.dts / s.timescale - vBase;
        const dur = s.duration / s.timescale;
        if (tc >= end - 0.001) { videoDone = true; return; }

        if (mode === 'copy') {
          if (segStart === null) {
            if (!(s.is_sync && tc >= start - 0.04)) return;
            if (tc - start > KEY_TOLERANCE) throw new FallbackError('kein Schlüsselbild am Schnitt');
            segStart = tc;
          }
          const meta = videoMetaSent ? undefined : { decoderConfig: { codec: first.vCodec, codedWidth: first.width, codedHeight: first.height, ...(first.vDesc ? { description: first.vDesc } : {}) } };
          videoMetaSent = true;
          muxer.addVideoChunkRaw(s.data, s.is_sync ? 'key' : 'delta', us(cursor + (tc - segStart)), us(dur), meta, us(tc - td));
          lastVideoEnd = tc + dur;
          onProgress(Math.min(total, seg.tapeStart + (tc - start)), total, mode);
          return;
        }

        // Umrechnen: ab dem letzten Schlüsselbild dekodieren, Bilder vor dem Schnitt verwerfen
        if (!fedKey) {
          if (!s.is_sync) return;
          fedKey = true;
        }
        while ((decoder.decodeQueueSize > MAX_QUEUE || encoder.encodeQueueSize > MAX_QUEUE) && !decoderError && !encoderError) {
          await sleep(2);
        }
        if (decoderError) throw new FallbackError('Dekodieren fehlgeschlagen: ' + decoderError.message);
        if (encoderError) throw new FallbackError('Kodieren fehlgeschlagen: ' + encoderError.message);
        decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: us(tc), duration: us(dur), data: s.data }));
      };

      await demux(blob, {
        shouldStop: () => isCancelled() || (videoDone && (audioDone || !clip || !clip.aId)),
        onReady: (info, file) => {
          clip = clipInfo(info, file);
          if (first) {
            if (mode === 'copy' && (clip.vCodec !== first.vCodec || clip.width !== first.width ||
                clip.height !== first.height || !sameBytes(clip.vDesc, first.vDesc))) {
              throw new FallbackError('Aufnahmen haben unterschiedliche Videoformate');
            }
            if (audioDecoderConfig) checkSameAudio(clip);
          }
        },
        // Felder kopieren: MP4Box gibt die Original-Samples nach dem Callback frei
        onSamples: (id, samples) => {
          for (const s of samples) {
            queue.push([id, { data: s.data, cts: s.cts, dts: s.dts, duration: s.duration, timescale: s.timescale, is_sync: s.is_sync }]);
          }
        },
        process: async () => {
          if (!muxer) await createMuxer(clip);
          if (mode === 'transcode' && !decoder) {
            decoder = new VideoDecoder({ output: onFrame, error: (e) => { decoderError = e; } });
            decoder.configure({
              codec: clip.vCodec, codedWidth: clip.width, codedHeight: clip.height,
              ...(clip.vDesc ? { description: clip.vDesc } : {}),
            });
          }
          while (queue.length) {
            const [id, s] = queue.shift();
            if (id === clip.vId) {
              await handleVideo(s);
            } else if (id === clip.aId && audioDecoderConfig) {
              if (segStart === null || vBase === null) pendingAudio.push(s);
              else writeAudio(s);
            }
            flushPendingAudio();
          }
          await flush(false);
        },
      });

      if (decoder) {
        if (decoder.state === 'configured') await decoder.flush().catch((e) => { decoderError = e; });
        if (decoder.state !== 'closed') decoder.close();
        if (decoderError) throw new FallbackError('Dekodieren fehlgeschlagen: ' + decoderError.message);
      }
      if (segStart !== null && lastVideoEnd !== null) cursor += lastVideoEnd - segStart;
      await flush(false);
    }

    if (isCancelled()) { await discardParts(); return null; }
    if (!muxer) throw new FallbackError('Keine Daten');
    if (encoder) {
      await encoder.flush();
      encoder.close();
      if (encoderError) throw new FallbackError('Kodieren fehlgeschlagen: ' + encoderError.message);
    }
    muxer.finalize();
    await flush(true);

    const parts = [];
    for (const key of partKeys) parts.push(await getClip(key));
    const safeName = tape.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'RetroCam';
    const file = new File(parts, `${safeName}.mp4`, { type: 'video/mp4' });
    file.cleanup = discardParts;
    return file;
  } catch (e) {
    if (encoder && encoder.state !== 'closed') encoder.close();
    await discardParts();
    throw e instanceof FallbackError ? e : new FallbackError(e && e.message ? e.message : String(e));
  }
}

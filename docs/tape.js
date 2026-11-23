// Datenmodell einer Kassette – funktioniert wie ein echtes Band.
// Eine Kassette hat eine Kopfposition (head). Eine neue Aufnahme beginnt dort und
// überschreibt alles im Bereich [Start, Start + Aufnahmedauer). Alles danach bleibt erhalten.

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export function newTape(name) {
  const now = Date.now();
  return { id: uid(), name, createdAt: now, updatedAt: now, segments: [], head: 0 };
}

export const segEnd = (s) => s.tapeStart + s.duration;

export const tapeLength = (tape) => tape.segments.reduce((m, s) => Math.max(m, segEnd(s)), 0);

/** Fügt eine neue Aufnahme ein und schneidet überlappende ältere Aufnahmen zurecht. */
export function recordSegment(tape, seg) {
  const start = seg.tapeStart;
  const end = segEnd(seg);
  const minPiece = 1 / 30;
  const result = [];
  for (const s of tape.segments) {
    const sEnd = segEnd(s);
    if (sEnd <= start || s.tapeStart >= end) { result.push(s); continue; }
    if (s.tapeStart < start) {
      const left = { ...s, id: uid(), duration: start - s.tapeStart };
      if (left.duration >= minPiece) result.push(left);
    }
    if (sEnd > end) {
      const cut = end - s.tapeStart;
      const right = { ...s, id: uid(), tapeStart: end, clipOffset: s.clipOffset + cut, duration: sEnd - end };
      if (right.duration >= minPiece) result.push(right);
    }
  }
  result.push(seg);
  result.sort((a, b) => a.tapeStart - b.tapeStart);
  tape.segments = result;
  tape.head = end;
}

/** Welches Segment liegt an Bandstelle t? */
export function segmentAt(tape, t) {
  const segs = tape.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (t >= s.tapeStart - 1e-4 && t < segEnd(s) - 1e-3) return { seg: s, index: i };
  }
  // In einer (seltenen) Lücke: nächstes Segment dahinter
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].tapeStart > t) return { seg: segs[i], index: i };
  }
  return null;
}

export function timecode(seconds) {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

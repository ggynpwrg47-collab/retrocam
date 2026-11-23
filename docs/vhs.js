// VHS-Look in Echtzeit per WebGL. Zeichnet das Kamerabild 4:3 (640x480) mit
// Rauschen, Farbbluten, Überschärfung, Zeilenstruktur, Tracking-Band, Kopfumschalt-Störung,
// Dropouts, Vignette und eingebranntem Datums-/Zeitstempel.

export const WIDTH = 640;
export const HEIGHT = 480;

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uStamp;
uniform vec2 uCropScale;
uniform vec2 uCropOffset;
uniform vec2 uRes;
uniform float uTime;
uniform float uSeed;
uniform float uGlitch;
uniform float uBandY;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 src(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  vec3 c = texture2D(uVideo, uCropOffset + uv * uCropScale).rgb;
  vec4 s = texture2D(uStamp, uv);
  return mix(c, s.rgb, s.a);
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec2 chroma(vec3 c) {
  return vec2(dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 yiq2rgb(vec3 y) {
  return vec3(y.x + 0.956 * y.y + 0.621 * y.z,
              y.x - 0.272 * y.y - 0.647 * y.z,
              y.x - 1.106 * y.y + 1.703 * y.z);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);          // y nach unten
  // Bildrollen beim Aufnahmestart
  uv.y = fract(uv.y + uGlitch * uGlitch * 0.12 * sin(uTime * 9.0));
  float line = floor(uv.y * uRes.y);
  float px = 1.0 / uRes.x;

  // Zeilenzittern
  float jitter = (rand(vec2(line, uSeed)) - 0.5) * 0.7 * px;
  jitter += uGlitch * (rand(vec2(floor(line / 6.0), uSeed + 1.0)) - 0.5) * 0.07;

  // Langsam durchlaufendes Tracking-Band
  float band = smoothstep(0.03 + uGlitch * 0.12, 0.0, abs(uv.y - uBandY));
  jitter += band * (3.0 + 6.0 * rand(vec2(line, uSeed + 2.0))) * px;

  // Kopfumschalt-Störung an der Unterkante
  float hs = step(1.0 - 8.0 / uRes.y, uv.y);
  jitter += hs * (10.0 + 14.0 * rand(vec2(line, uSeed + 3.0))) * px;

  vec2 p = vec2(uv.x + jitter, uv.y);

  // Helligkeit: leicht weich + VHS-Überschärfung (helle Säume)
  float y = luma(src(p - vec2(px, 0.0))) * 0.25 + luma(src(p)) * 0.5 + luma(src(p + vec2(px, 0.0))) * 0.25;
  float yWide = 0.0;
  for (int i = -3; i <= 3; i++) yWide += luma(src(p + vec2(float(i) * 1.5 * px, 0.0)));
  yWide /= 7.0;
  y = y + 0.55 * (y - yWide);

  // Farbe: stark horizontal verschmiert und leicht nach rechts versetzt
  vec2 iq = vec2(0.0);
  for (int i = -4; i <= 4; i++) iq += chroma(src(p + vec2((float(i) * 2.0 - 2.5) * px, 0.0)));
  iq /= 9.0;
  iq *= 1.35;

  vec3 col = yiq2rgb(vec3(y, iq));
  col *= vec3(1.06, 1.0, 0.9);                      // leicht warm
  col = mix(vec3(0.05, 0.045, 0.065), vec3(1.0), col); // milchige Schwarzwerte
  col = (col - 0.5) * 0.92 + 0.5;

  // Rauschen (horizontal gestreckt)
  float n = rand(vec2(floor(uv.x * uRes.x * 0.5), line) + uSeed);
  col += (n - 0.5) * (0.085 + uGlitch * 0.5 + band * 0.22 + hs * 0.5);

  // Seltene Dropouts (weiße Striche)
  if (rand(vec2(line, uSeed + 4.0)) > 0.99975 - uGlitch * 0.004) {
    float xs = rand(vec2(line, uSeed + 5.0));
    if (abs(uv.x - xs) < 0.09) col = mix(col, vec3(1.0), 0.7);
  }

  col *= 0.87 + 0.13 * mod(line, 2.0);              // Zeilenstruktur
  vec2 q = uv - 0.5;
  col *= 1.0 - dot(q, q) * 0.75;                    // Vignette
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const pad = (n) => String(n).padStart(2, '0');

export class VHSRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL wird nicht unterstützt');
    this.gl = gl;

    const program = gl.createProgram();
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    this.program = program;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const name of ['uVideo', 'uStamp', 'uCropScale', 'uCropOffset', 'uRes', 'uTime', 'uSeed', 'uGlitch', 'uBandY']) {
      this.u[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(this.u.uVideo, 0);
    gl.uniform1i(this.u.uStamp, 1);
    gl.uniform2f(this.u.uRes, WIDTH, HEIGHT);

    this.videoTex = this.makeTexture(0);
    this.stampTex = this.makeTexture(1);
    this.stampCanvas = document.createElement('canvas');
    this.stampCanvas.width = WIDTH;
    this.stampCanvas.height = HEIGHT;
    this.stampKey = null;
    this.uploadStamp('');
    gl.viewport(0, 0, WIDTH, HEIGHT);
  }

  compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  makeTexture(unit) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    return tex;
  }

  uploadStamp(key, date) {
    if (key === this.stampKey) return;
    this.stampKey = key;
    const ctx = this.stampCanvas.getContext('2d');
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (date) {
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      const day = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
      ctx.font = '44px VT323, "Courier New", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      const x = WIDTH - 34;
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillText(time, x + 3, 412 + 3);
      ctx.fillText(day, x + 3, 452 + 3);
      ctx.fillStyle = '#fff7e2';
      ctx.fillText(time, x, 412);
      ctx.fillText(day, x, 452);
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.stampCanvas);
  }

  /** Zeichnet einen Frame. Gibt false zurück, wenn noch kein Kamerabild da ist. */
  render(video, { glitch = 0, showStamp = true, time = 0, zoom = 1 } = {}) {
    if (!video || video.readyState < 2 || !video.videoWidth) return false;
    const gl = this.gl;

    if (showStamp) {
      const now = new Date();
      this.uploadStamp(String(Math.floor(now.getTime() / 1000)), now);
    } else {
      this.uploadStamp('');
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    // Auf 4:3 zuschneiden (mittig), egal ob das Handy hoch oder quer gehalten wird
    const va = video.videoWidth / video.videoHeight;
    const target = WIDTH / HEIGHT;
    let sx = 1, sy = 1;
    if (va > target) sx = target / va; else sy = va / target;
    sx /= zoom; // digitaler Zoom: kleineren Ausschnitt aus der Mitte nehmen
    sy /= zoom;
    gl.uniform2f(this.u.uCropScale, sx, sy);
    gl.uniform2f(this.u.uCropOffset, (1 - sx) / 2, (1 - sy) / 2);

    gl.uniform1f(this.u.uTime, time);
    gl.uniform1f(this.u.uSeed, Math.random() * 100);
    gl.uniform1f(this.u.uGlitch, glitch);
    gl.uniform1f(this.u.uBandY, ((time * 0.045) % 1.5) - 0.25);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}

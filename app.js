// Travel at home - bản thử trên trình duyệt.
// Chuỗi xử lý mỗi khung hình: camera -> mặt nạ người (MediaPipe) -> ghép lên ảnh 360° xoay theo cảm biến.

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const VERSION = 'v4', ZOOM_MIN = 0.6;
const qs = new URLSearchParams(location.search);
const DEMO = qs.has('demo');          // không dùng camera: nguồn hình và mặt nạ giả lập
const $ = (id) => document.getElementById(id);

const state = {
  fovV: 70, delayMs: 60, sens: 5, tintAmt: 0.3, zoom: 1,
  invert: false, listen: true, mirror: true,
  reveal: 0, revealTarget: 0,          // 0 = ở nhà, 1 = ở điểm đến
  heading0: 0,                          // hướng la bàn được canh làm tâm ảnh 360°
  fps: 0, segMs: 0, segBackend: '-', orient: DEMO ? 'chuột' : 'chưa có',
};

// ---------- Toán ma trận 3x3 (mảng 9 phần tử, theo hàng) ----------
const mul = (a, b) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};
const rotZ = (t) => { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
const rotX = (t) => { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotY = (t) => { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const D2R = Math.PI / 180;
// Chuẩn W3C: R = Rz(alpha) Rx(beta) Ry(gamma), đổi toạ độ máy -> toạ độ mặt đất (X đông, Y bắc, Z lên).
const deviceMatrix = (alpha, beta, gamma) => mul(mul(rotZ(alpha * D2R), rotX(beta * D2R)), rotY(gamma * D2R));
// Camera trước nhìn theo trục +Z của máy. Hướng la bàn của nó, đo từ bắc sang đông.
const headingOf = (m) => Math.atan2(m[2], m[5]);

// ---------- Cảm biến xoay ----------
const orientBuf = [];                   // {t, m}
let mouseYaw = 0, mousePitch = 0;
function pushOrient(m) {
  orientBuf.push({ t: performance.now(), m });
  if (orientBuf.length > 120) orientBuf.shift();
}
function orientAt(t) {                  // mẫu gần nhất không muộn hơn t (bù trễ camera)
  if (!orientBuf.length) return deviceMatrix(0, 90, 0);
  for (let i = orientBuf.length - 1; i >= 0; i--) if (orientBuf[i].t <= t) return orientBuf[i].m;
  return orientBuf[0].m;
}
async function startOrientation() {
  if (DEMO || !('DeviceOrientationEvent' in window)) return startMouseOrientation();
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { state.orient = 'bị từ chối'; return startMouseOrientation(); }
    }
  } catch (e) { state.orient = 'lỗi quyền'; return startMouseOrientation(); }
  let got = false;
  window.addEventListener('deviceorientation', (e) => {
    if (e.alpha == null) return;
    if (!got) { got = true; state.orient = 'cảm biến'; }
    pushOrient(deviceMatrix(e.alpha, e.beta, e.gamma));
  });
  setTimeout(() => { if (!got) startMouseOrientation(); }, 1500);
}
function startMouseOrientation() {
  if (state.orient !== 'bị từ chối') state.orient = 'chuột';
  const upd = () => pushOrient(deviceMatrix(mouseYaw, 90 + mousePitch, 0));
  upd();
  let drag = null;
  const view = $('view');
  view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    mouseYaw += (e.clientX - drag.x) * 0.3; mousePitch += (e.clientY - drag.y) * 0.3;
    mousePitch = Math.max(-80, Math.min(80, mousePitch));
    drag = { x: e.clientX, y: e.clientY }; upd();
  });
  setInterval(upd, 50);
}

// ---------- WebGL ----------
const VS = `#version 300 es
in vec2 aPos; out vec2 vUv; out vec2 vP;
void main(){ vP=aPos; vUv=vec2(aPos.x*.5+.5, .5-aPos.y*.5); gl_Position=vec4(aPos,0.,1.); }`;
const FS = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vP; out vec4 o;
uniform sampler2D uVideo, uMask, uPano;
uniform mat3 uRot; uniform vec2 uTan; uniform float uReveal, uAspect, uTintAmt, uInvert, uZoom;
uniform vec3 uTint; uniform vec2 uVidScale; uniform float uSoft;
const float PI=3.14159265359;
vec3 pano(vec3 d){
  float lon=atan(d.x,d.y), lat=asin(clamp(d.z,-1.,1.));
  return texture(uPano, vec2(lon/(2.*PI)+.5, .5-lat/PI)).rgb;
}
void main(){
  // Vị trí trong ảnh camera. uVidScale cắt ảnh 3:4 cho vừa khung 9:16; zoom < 1 thì lộ phần ngoài ảnh.
  vec2 zuv=(vUv-.5)*uVidScale/uZoom+.5;
  float s=uSoft+1e-4;                                     // viền mờ dần khi ảnh camera không phủ kín khung
  float inside=smoothstep(0.,s,zuv.x)*(1.-smoothstep(1.-s,1.,zuv.x))
              *smoothstep(0.,s,zuv.y)*(1.-smoothstep(1.-4.*s,1.,zuv.y));
  vec3 cam=texture(uVideo,zuv).rgb*inside;
  float m=texture(uMask,zuv).r; m=mix(m,1.-m,uInvert);
  float a=smoothstep(.35,.7,m)*inside;
  // Ảnh thật của camera trước: bên phải ảnh là trục -X của máy.
  vec3 bg=pano(normalize(uRot*vec3(-vP.x*uTan.x, vP.y*uTan.y, 1.)));
  vec3 person=mix(cam, cam*uTint, uTintAmt);
  person=mix(person, bg, a*(1.-a)*1.0);                 // làm mềm viền bằng màu nền
  vec3 comp=mix(bg, person, a);
  float r=length(vec2(vP.x*uAspect, vP.y));
  float edge=uReveal*(length(vec2(uAspect,1.))+.35);
  float k=1.-smoothstep(edge-.25, edge, r);
  float glow=(1.-smoothstep(0.,.14,abs(r-edge)))*step(.001,uReveal)*(1.-step(.999,uReveal));
  o=vec4(mix(cam,comp,k)+glow*vec3(1.,.93,.75)*.9, 1.);
}`;

const canvas = $('view');
const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
let prog, U = {}, texVideo, texMask, texPano;

function initGL() {
  if (!gl) throw new Error('Trình duyệt không hỗ trợ WebGL2');
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  for (const n of ['uVideo', 'uMask', 'uPano', 'uRot', 'uTan', 'uReveal', 'uAspect', 'uTintAmt', 'uInvert', 'uTint', 'uZoom', 'uVidScale', 'uSoft'])
    U[n] = gl.getUniformLocation(prog, n);
  const tex = (unit, wrapS) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  texVideo = tex(0, gl.CLAMP_TO_EDGE); texMask = tex(1, gl.CLAMP_TO_EDGE); texPano = tex(2, gl.REPEAT);
  gl.uniform1i(U.uVideo, 0); gl.uniform1i(U.uMask, 1); gl.uniform1i(U.uPano, 2);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.activeTexture(gl.TEXTURE1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
}

// ---------- Ảnh 360° ----------
let panoTint = [1, 1, 1];
function setPano(source) {                // ảnh hoặc canvas dạng equirectangular 2:1
  const maxW = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const sw = source.naturalWidth || source.width, shh = source.naturalHeight || source.height;
  const w = Math.min(maxW, sw), h = Math.round(w * shh / sw);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(source, 0, 0, w, h);
  gl.activeTexture(gl.TEXTURE2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  // Màu trung bình của dải ngang giữa ảnh, dùng để nhuộm nhẹ người cho hợp nền.
  const s = document.createElement('canvas'); s.width = 32; s.height = 16;
  const sx = s.getContext('2d', { willReadFrequently: true }); sx.drawImage(c, 0, 0, 32, 16);
  const d = sx.getImageData(0, 4, 32, 8).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const lum = (r + g + b) / 3 || 1;
  panoTint = [r / lum, g / lum, b / lum].map((v) => Math.max(0.75, Math.min(1.25, v)));
}
function makeTestPano() {                 // ảnh thử có lưới và nhãn để kiểm tra hướng xoay
  const W = 2048, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, H / 2); sky.addColorStop(0, '#2b6cd4'); sky.addColorStop(1, '#bfe3ff');
  x.fillStyle = sky; x.fillRect(0, 0, W, H / 2);
  const gr = x.createLinearGradient(0, H / 2, 0, H); gr.addColorStop(0, '#7fae6a'); gr.addColorStop(1, '#3d5f33');
  x.fillStyle = gr; x.fillRect(0, H / 2, W, H / 2);
  x.textAlign = 'center'; x.lineWidth = 3;
  const names = { 0: 'HÀ NỘI', 90: 'PHẢI', 180: 'SAU LƯNG', 270: 'TRÁI' };
  for (let deg = 0; deg < 360; deg += 30) {
    const px = ((deg / 360 + 0.5) % 1) * W;
    x.strokeStyle = 'rgba(255,255,255,.55)'; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H); x.stroke();
    x.fillStyle = '#fff'; x.font = 'bold 34px sans-serif'; x.fillText(deg + '°', px, H / 2 + 60);
    if (names[deg]) {
      x.fillStyle = deg === 0 ? '#c0392b' : '#34495e';
      x.fillRect(px - 100, H / 2 - 170, 200, 110);
      x.fillStyle = '#fff'; x.font = 'bold 30px sans-serif'; x.fillText(names[deg], px, H / 2 - 105);
    }
  }
  x.strokeStyle = 'rgba(255,255,255,.8)'; x.beginPath(); x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke();
  x.fillStyle = '#fff3b0'; x.beginPath(); x.arc(W * 0.62, H * 0.2, 46, 0, 7); x.fill();
  return c;
}

// ---------- Nguồn hình ----------
const video = $('cam');
let frameSrc = video, demoCanvas = null, micStream = null;
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Xin ảnh 3:4 (trọn cảm biến) để có góc nhìn ngang rộng nhất; khung xuất ra vẫn là 9:16.
    video: { facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  micStream = new MediaStream(stream.getAudioTracks());
  camTrack = stream.getVideoTracks()[0];
  video.srcObject = new MediaStream([camTrack]);
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  canvas.width = 720; canvas.height = 1280;
  describeCamera();
}
// Các kiểu xin hình từ camera, để so trên máy thật xem kiểu nào cho góc nhìn rộng nhất.
const CAM_MODES = [
  { name: '3:4 dọc 1080x1440', w: 1080, h: 1440 },
  { name: '9:16 dọc 720x1280', w: 720, h: 1280 },
  { name: '9:16 dọc 1080x1920', w: 1080, h: 1920 },
  { name: '4:3 ngang 1440x1080', w: 1440, h: 1080 },
  { name: '16:9 ngang 1280x720', w: 1280, h: 720 },
  { name: '4:3 lớn nhất', w: 4032, h: 3024 },
];
let camTrack = null, camMode = 0;
function describeCamera() {
  if (!camTrack) return;
  const s = camTrack.getSettings ? camTrack.getSettings() : {};
  const c = camTrack.getCapabilities ? camTrack.getCapabilities() : {};
  const z = c.zoom ? `${c.zoom.min}–${c.zoom.max} (đang ${s.zoom ?? '?'})` : 'không có';
  const max = c.width && c.height ? `${c.width.max}x${c.height.max}` : '?';
  state.camInfo = `chế độ: ${CAM_MODES[camMode].name}\nmáy cấp: ${s.width}x${s.height} @${Math.round(s.frameRate || 0)}  tối đa ${max}\nzoom ống kính: ${z}`;
}
async function nextCamMode() {
  if (!camTrack) return;
  camMode = (camMode + 1) % CAM_MODES.length;
  const m = CAM_MODES[camMode];
  try { await camTrack.applyConstraints({ width: { ideal: m.w }, height: { ideal: m.h }, frameRate: { ideal: 30 } }); }
  catch (e) { state.camInfo = 'lỗi đổi chế độ: ' + e.message; return; }
  await new Promise((r) => setTimeout(r, 400));
  describeCamera();
}
function startDemoSource() {              // "căn phòng" giả có vật chuyển động, mặt nạ là hình người đơn giản
  demoCanvas = document.createElement('canvas'); demoCanvas.width = 540; demoCanvas.height = 960;
  frameSrc = demoCanvas; canvas.width = 540; canvas.height = 960;
}
const demoMask = new Uint8Array(128 * 128);
function drawDemo(t) {
  const x = demoCanvas.getContext('2d'), W = 540, H = 960;
  x.fillStyle = '#6b5a4a'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#8a7765'; for (let i = 0; i < 6; i++) x.fillRect(i * 100 - 20, 0, 50, H);
  const cx = W / 2 + Math.sin(t / 900) * 40;
  x.fillStyle = '#e8b796'; x.beginPath(); x.arc(cx, 380, 95, 0, 7); x.fill();
  x.fillStyle = '#2d6cdf'; x.beginPath(); x.ellipse(cx, 800, 210, 330, 0, 0, 7); x.fill();
  x.fillStyle = '#111'; x.font = 'bold 28px sans-serif'; x.textAlign = 'center'; x.fillText('GIẢ LẬP', cx, 390);
  for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) {
    const px = (i + 0.5) / 128 * W, py = (j + 0.5) / 128 * H;
    const head = Math.hypot(px - cx, py - 380) < 95;
    const body = ((px - cx) / 210) ** 2 + ((py - 800) / 330) ** 2 < 1;
    demoMask[j * 128 + i] = head || body ? 255 : 0;
  }
  return { data: demoMask, w: 128, h: 128 };
}

// ---------- Tách người ----------
let segmenter = null, maskU8 = null;
async function initSegmenter() {
  const { ImageSegmenter, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const make = (delegate) => ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
  });
  const want = qs.get('delegate') || 'GPU';
  try { segmenter = await make(want); state.segBackend = want; }
  catch (e) { console.warn('GPU delegate lỗi, chuyển CPU', e); segmenter = await make('CPU'); state.segBackend = 'CPU'; }
}
function segment(src, t) {
  let out = null;
  const t0 = performance.now();
  segmenter.segmentForVideo(src, t, (res) => {
    const masks = res.confidenceMasks; if (!masks || !masks.length) return;
    const m = masks[masks.length - 1];
    const f = m.getAsFloat32Array(), n = m.width * m.height;
    if (!maskU8 || maskU8.length !== n) maskU8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) maskU8[i] = f[i] * 255;
    out = { data: maskU8, w: m.width, h: m.height };
  });
  state.segMs = state.segMs * 0.9 + (performance.now() - t0) * 0.1;
  return out;
}

// ---------- Bắt tiếng búng tay ----------
let analyser = null, tdBuf = null, bgLevel = 0.01, cand = null, lastSnap = 0, audioCtx = null;
function initAudio() {
  if (!micStream || !micStream.getAudioTracks().length) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const srcNode = audioCtx.createMediaStreamSource(micStream);
  const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200;
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
  srcNode.connect(hp); hp.connect(analyser);
  tdBuf = new Float32Array(analyser.fftSize);
  audioCtx.resume();
}
function pollSnap(now) {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(tdBuf);
  let peak = 0; for (let i = 0; i < tdBuf.length; i++) { const v = Math.abs(tdBuf[i]); if (v > peak) peak = v; }
  $('meter').firstElementChild.style.width = Math.min(100, peak * 300) + '%';
  const thresh = Math.max(0.5 / (state.sens * state.sens), bgLevel * 6);   // sens 5 -> 0.02
  if (cand) {
    // Tiếng búng tắt rất nhanh; tiếng nói thì kéo dài. Chờ 90 ms rồi kiểm tra đã lặng lại chưa.
    if (now - cand.t > 90) {
      if (peak < cand.peak * 0.35 && state.listen && now - lastSnap > 1200) { lastSnap = now; onSnap(); }
      cand = null;
    } else if (peak > cand.peak) cand.peak = peak;
  } else if (peak > thresh && now - lastSnap > 1200) cand = { t: now, peak };
  bgLevel = bgLevel * 0.97 + Math.min(peak, 0.2) * 0.03;
}
function onSnap() {
  state.revealTarget = state.revealTarget > 0.5 ? 0 : 1;
  if (state.revealTarget === 1) centerPano();              // điểm đến hiện ra ngay sau lưng hai ba con
}
function centerPano() { state.heading0 = headingOf(orientAt(performance.now())); }

// ---------- Quay video ----------
let recorder = null, chunks = [], recStart = 0, lastFile = null;
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function toggleRecord() {
  if (recorder) { recorder.stop(); return; }
  if (!window.MediaRecorder || !canvas.captureStream) { alert('Trình duyệt này không quay được canvas.'); return; }
  const stream = canvas.captureStream(30);
  if (micStream) micStream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mime = pickMime();
  recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
  chunks = []; recStart = performance.now();
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const type = recorder.mimeType || mime || 'video/mp4';
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    lastFile = new File([blob], `travel-at-home-${Date.now()}.${ext}`, { type: type.split(';')[0] });
    $('savedVideo').src = URL.createObjectURL(blob);
    $('savedInfo').textContent = `${((performance.now() - recStart) / 1000).toFixed(1)} giây, ${(blob.size / 1e6).toFixed(1)} MB, ${ext}`;
    $('saved').classList.add('open'); $('rec').classList.remove('on'); recorder = null;
  };
  recorder.start(1000); $('rec').classList.add('on');
}
async function shareLast() {
  if (!lastFile) return;
  if (navigator.canShare && navigator.canShare({ files: [lastFile] })) {
    try { await navigator.share({ files: [lastFile] }); } catch (e) { /* người dùng huỷ */ }
  } else {
    const a = document.createElement('a'); a.href = $('savedVideo').src; a.download = lastFile.name; a.click();
  }
}

// ---------- Vòng lặp ----------
let lastT = 0, frames = 0, fpsT = 0, newFrame = true, lastVideoTime = -1;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - lastT) / 1000 || 0); lastT = now;
  pollSnap(now);
  // Hiệu ứng chuyển cảnh kéo dài khoảng 0,6 giây.
  const d = state.revealTarget - state.reveal;
  if (d) state.reveal += Math.sign(d) * Math.min(Math.abs(d), dt / 0.6);

  let mask = null;
  if (demoCanvas) { mask = drawDemo(now); newFrame = true; }
  else { newFrame = video.currentTime !== lastVideoTime; lastVideoTime = video.currentTime; }
  if (newFrame && (frameSrc.videoWidth || frameSrc.width)) {
    if (segmenter && !demoCanvas) mask = segment(frameSrc, now);
    else if (segmenter && qs.has('seg')) segment(frameSrc, now);      // chỉ để đo tốc độ khi giả lập
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frameSrc);
    if (mask) {
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.w, mask.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data);
    }
    frames++;
  }
  const m = mul(rotZ(state.heading0), orientAt(now - state.delayMs));
  // Zoom vào thì góc nhìn hẹp lại, nên nền 360° cũng phải phóng to đúng tỉ lệ đó.
  const aspect = canvas.width / canvas.height, tv = Math.tan(state.fovV * D2R / 2) / state.zoom;
  gl.uniform1f(U.uZoom, state.zoom);
  const av = (frameSrc.videoWidth || frameSrc.width) / (frameSrc.videoHeight || frameSrc.height) || aspect;
  if (av > aspect) gl.uniform2f(U.uVidScale, aspect / av, 1); else gl.uniform2f(U.uVidScale, 1, av / aspect);
  gl.uniform1f(U.uSoft, state.zoom < 0.999 ? 0.03 : 0);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniformMatrix3fv(U.uRot, true, m);
  gl.uniform2f(U.uTan, tv * aspect, tv);
  gl.uniform1f(U.uReveal, state.reveal); gl.uniform1f(U.uAspect, aspect);
  gl.uniform1f(U.uTintAmt, state.tintAmt); gl.uniform1f(U.uInvert, state.invert ? 1 : 0);
  gl.uniform3fv(U.uTint, panoTint);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  if (now - fpsT > 1000) {
    state.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now;
    $('hud').textContent =
      `${VERSION}  ${canvas.width}x${canvas.height}  ${state.fps.toFixed(0)} fps  cam ${frameSrc.videoWidth || frameSrc.width}x${frameSrc.videoHeight || frameSrc.height}\n` +
      `tách người: ${state.segBackend} ${state.segMs.toFixed(1)} ms\n` +
      `xoay: ${state.orient}  zoom ${state.zoom.toFixed(1)}x${state.camInfo ? '\n' + state.camInfo : ''}${recorder ? '\n● đang quay' : ''}`;
  }
}

// ---------- Giao diện ----------
function bindUI() {
  const bind = (id, key, fmt, apply) => {
    const el = $(id), out = $(id + 'V');
    const upd = () => { const v = +el.value; apply(v); out.textContent = fmt(v); };
    el.addEventListener('input', upd); upd();
  };
  bind('fov', 'fovV', (v) => v + '°', (v) => { state.fovV = v; });
  bind('delay', 'delayMs', (v) => v + ' ms', (v) => { state.delayMs = v; });
  bind('sens', 'sens', (v) => v, (v) => { state.sens = v; });
  bind('tint', 'tintAmt', (v) => v + '%', (v) => { state.tintAmt = v / 100; });
  bind('zoom', 'zoom', (v) => v.toFixed(1) + 'x', (v) => { state.zoom = v; });
  // Chụm hai ngón tay để zoom. Chặn luôn kiểu zoom cả trang của Safari.
  const setZoom = (z) => {
    state.zoom = Math.max(ZOOM_MIN, Math.min(3, z));
    $('zoom').value = state.zoom; $('zoomV').textContent = state.zoom.toFixed(1) + 'x';
  };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  let pinch = null;
  const onUI = (e) => e.target.closest && e.target.closest('#panel, #saved, button, input');
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && !onUI(e)) pinch = { d: dist(e.touches), z: state.zoom };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) { e.preventDefault(); setZoom(pinch.z * dist(e.touches) / pinch.d); }
  }, { passive: false });
  document.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  $('settings').onclick = () => $('panel').classList.toggle('open');
  $('closePanel').onclick = () => $('panel').classList.remove('open');
  $('snap').onclick = onSnap;
  $('center').onclick = centerPano;
  $('rec').onclick = toggleRecord;
  $('share').onclick = shareLast;
  $('discard').onclick = () => $('saved').classList.remove('open');
  $('mirror').onclick = (e) => { state.mirror = !state.mirror; canvas.classList.toggle('mirror', state.mirror); e.target.textContent = 'Soi gương: ' + (state.mirror ? 'bật' : 'tắt'); };
  $('invert').onclick = (e) => { state.invert = !state.invert; e.target.textContent = 'Đảo mặt nạ: ' + (state.invert ? 'bật' : 'tắt'); };
  $('listen').onclick = (e) => { state.listen = !state.listen; e.target.textContent = 'Nghe búng tay: ' + (state.listen ? 'bật' : 'tắt'); };
  $('camMode').onclick = nextCamMode;
  $('testPano').onclick = () => setPano(makeTestPano());
  $('pickPano').onclick = () => $('panoFile').click();
  $('panoFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image(); img.onload = () => { setPano(img); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(f);
  };
}

async function start() {
  const msg = $('msg'); $('go').disabled = true;
  try {
    msg.textContent = 'Đang xin quyền cảm biến…'; await startOrientation();   // phải gọi ngay trong lần chạm
    initGL(); setPano(makeTestPano());
    if (DEMO) startDemoSource();
    else { msg.textContent = 'Đang mở camera…'; await startCamera(); initAudio(); }
    if (!DEMO || qs.has('seg')) { msg.textContent = 'Đang tải model tách người…'; await initSegmenter(); }
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
    $('start').style.display = 'none';
    requestAnimationFrame(tick);
  } catch (e) {
    console.error(e); msg.textContent = 'Lỗi: ' + (e && e.message ? e.message : e); $('go').disabled = false;
  }
}

bindUI();
$('go').onclick = start;
window.__tah = { state, onSnap, centerPano };   // để kiểm thử từ console

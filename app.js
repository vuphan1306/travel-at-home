// Travel at home - bản thử trên trình duyệt.
// Chuỗi xử lý mỗi khung hình: camera -> mặt nạ người (MediaPipe) -> ghép lên ảnh 360° xoay theo cảm biến.

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MP_MODELS = 'https://storage.googleapis.com/mediapipe-models/image_segmenter';
const MODELS = {
  fast: `${MP_MODELS}/selfie_segmenter/float16/latest/selfie_segmenter.tflite`,            // 1 lớp: người
  fine: `${MP_MODELS}/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`,  // 6 lớp, lớp 0 là nền
};

import { SnapDetector } from './snap.js?v=12';

const VERSION = 'v12', ZOOM_MIN = 0.6;
const qs = new URLSearchParams(location.search);
const DEMO = qs.has('demo');          // không dùng camera: nguồn hình và mặt nạ giả lập
const $ = (id) => document.getElementById(id);

const state = {
  fovV: 70, delayMs: 60, sens: 5, tintAmt: 0.3, zoom: 1,
  invert: false, listen: true, mirror: true, snapBack: false, snapCount: 0,
  // Tinh chỉnh mặt nạ: refStep = khoảng cách giữa các điểm lấy mẫu (tính theo điểm của mặt nạ tinh chỉnh),
  // sigmaC = mức khác màu được coi là "cùng một vật", temporal = phần tin vào khung mới ở chỗ đứng yên.
  refine: true, refW: 720, refStep0: 2.2, refStep: 1.0, sigmaC: 0.10, sigmaC2: 0.07, temporal: 0.5,
  lo: 0.41, hi: 0.71, despill: 1.5, debug: false,
  model: 'fine',
  // roi: tách lại riêng từng cụm người nhỏ. Tắt mặc định: trên iPhone 12 mini nó làm tốc độ tụt còn 8 fps
  // và mép vùng cắt ngang người. matteW: bề rộng ảnh đưa vào model chuyên dụng.
  roi: false, matteW: 384, matteLo: 0.08, matteHi: 0.92,
  blobMin: 0.004, blobMax: 0.14, nRoi: 0,
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
// Ba bước vẽ mỗi khung hình:
//  1) tinh chỉnh thô: gộp các mặt nạ 256x256 (toàn khung + từng vùng người nhỏ) và kéo mép về đường biên màu.
//  2) tinh chỉnh mịn: lọc lần nữa ở bước nhỏ hơn, rồi ổn định theo thời gian.
//  3) ghép: người + nền 360° + hiệu ứng chuyển cảnh.
const VS = `#version 300 es
in vec2 aPos; out vec2 vUv; out vec2 vP;
void main(){ vP=aPos; vUv=vec2(aPos.x*.5+.5, .5-aPos.y*.5); gl_Position=vec4(aPos,0.,1.); }`;

// Toạ độ khung đích trùng toạ độ ảnh camera (gốc ở góc trên trái), nên bước ghép lấy mẫu thẳng theo zuv.
const FS_REFINE = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uVideo, uMask0, uMask1, uMask2, uTmp, uPrev;
uniform vec2 uRes, uStep;
uniform float uSigmaC, uInvert, uTemporal, uRefine;
uniform vec4 uRoi1, uRoi2;              // vùng khoanh quanh người nhỏ: x, y, rộng, cao theo toạ độ ảnh camera
uniform int uNum, uMode;                // uMode 0: bước thô đọc mặt nạ gốc; 1: bước mịn đọc kết quả bước thô
float roiM(sampler2D t, vec4 r, vec2 q){
  vec2 p=(q-r.xy)/r.zw;
  vec2 e=smoothstep(vec2(0.),vec2(.06),p)*(1.-smoothstep(vec2(.94),vec2(1.),p));   // mờ dần ở mép vùng, tránh đường cắt
  return texture(t,p).r*e.x*e.y;
}
float M(vec2 q){
  if(uMode==1) return texture(uTmp,q).r;
  float m=texture(uMask0,q).r;
  if(uNum>1) m=max(m, roiM(uMask1,uRoi1,q));
  if(uNum>2) m=max(m, roiM(uMask2,uRoi2,q));
  return mix(m,1.-m,uInvert);
}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec3 c0=texture(uVideo,uv).rgb;
  float m0=M(uv);
  // Lọc song phương có dẫn hướng: điểm lân cận nào giống màu điểm đang xét thì được tin nhiều hơn.
  // Nhờ đó mép mặt nạ trượt về đúng đường biên màu của tóc, vai, tay trong hình thật.
  float acc=0., ws=0.;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
    vec2 q=uv+vec2(float(i),float(j))*uStep;
    vec3 d=texture(uVideo,q).rgb-c0;
    float w=exp(-float(i*i+j*j)/4.5)*exp(-dot(d,d)/(2.*uSigmaC*uSigmaC));
    acc+=w*M(q); ws+=w;
  }
  float a=mix(m0, acc/ws, uRefine);
  if(uMode==0){ o=vec4(a,0.,0.,1.); return; }
  // Chống nhấp nháy: chỗ hình đứng yên thì trộn với khung trước, chỗ đang chuyển động thì theo khung mới.
  vec4 prev=texture(uPrev,uv);
  float lum=dot(c0,vec3(.299,.587,.114));
  float k=mix(uTemporal,1.,smoothstep(.02,.08,abs(lum-prev.g)));
  k=max(k,smoothstep(.25,.55,abs(a-prev.r)));
  o=vec4(mix(prev.r,a,k), lum, 0., 1.);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv; in vec2 vP; out vec4 o;
uniform sampler2D uVideo, uRef, uPano;
uniform mat3 uRot; uniform vec2 uTan; uniform float uReveal, uAspect, uTintAmt, uZoom;
uniform vec3 uTint; uniform vec2 uVidScale; uniform float uSoft;
uniform vec2 uRefTexel; uniform float uLo, uHi, uDespill, uDebug, uLinear;
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
  vec3 raw=texture(uVideo,zuv).rgb;
  vec3 cam=raw*inside;
  float ar=texture(uRef,zuv).r;
  // Model chuyên dụng đã cho độ trong suốt thật: giữ nguyên dạng đường thẳng. Model phân loại thì uốn cho mép gọn.
  float a=mix(smoothstep(uLo,uHi,ar), clamp((ar-uLo)/(uHi-uLo),0.,1.), uLinear)*inside;
  // Khử viền màu phòng: chỉ dải mép mỏng (a < 0,9) mượn màu, và chỉ lấy cách đó khoảng 2 điểm ảnh, từ phía trong thân người.
  // Phần còn lại giữ nguyên hình thật, để không tạo ra vệt nhòe trên tay, tai, tóc.
  vec3 fg=raw;
  if(uDespill>0. && a>.003 && a<.9){
    vec2 g=vec2(texture(uRef,zuv+vec2(uRefTexel.x,0.)).r-texture(uRef,zuv-vec2(uRefTexel.x,0.)).r,
                texture(uRef,zuv+vec2(0.,uRefTexel.y)).r-texture(uRef,zuv-vec2(0.,uRefTexel.y)).r);
    float gn=length(g);
    if(gn>.02) fg=mix(texture(uVideo, zuv+g/gn*uRefTexel*uDespill).rgb, raw, smoothstep(.2,.9,a));
  }
  // Ảnh thật của camera trước: bên phải ảnh là trục -X của máy.
  vec3 bg=pano(normalize(uRot*vec3(-vP.x*uTan.x, vP.y*uTan.y, 1.)));
  vec3 person=mix(fg, fg*uTint, uTintAmt);
  vec3 comp=mix(bg, person, a);
  float r=length(vec2(vP.x*uAspect, vP.y));
  float edge=uReveal*(length(vec2(uAspect,1.))+.35);
  float k=1.-smoothstep(edge-.25, edge, r);
  float glow=(1.-smoothstep(0.,.14,abs(r-edge)))*step(.001,uReveal)*(1.-step(.999,uReveal));
  vec3 col=mix(cam,comp,k)+glow*vec3(1.,.93,.75)*.9;
  if(uDebug>.5) col=mix(vec3(1.,0.,1.), fg, a);          // xem mặt nạ: nền tím, không pha gì thêm
  o=vec4(col, 1.);
}`;

const canvas = $('view');
const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: qs.has('src') });
let prog, progRefine, U = {}, UR = {}, texVideo, texPano;
const texMasks = [];                       // mặt nạ gốc: [toàn khung, vùng nhỏ 1, vùng nhỏ 2]
const MASK_UNITS = [1, 6, 7];
const ref = { w: 0, h: 0, tex: [null, null, null], fbo: [null, null, null], cur: 0 };   // phần tử thứ 3 là kết quả bước thô
let rois = [];                             // các vùng nhỏ đang dùng ở khung này

function initGL() {
  if (!gl) throw new Error('Trình duyệt không hỗ trợ WebGL2');
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const build = (fs, names) => {
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(pr, 0, 'aPos');
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    const u = {}; for (const n of names) u[n] = gl.getUniformLocation(pr, n);
    return [pr, u];
  };
  [prog, U] = build(FS, ['uVideo', 'uRef', 'uPano', 'uRot', 'uTan', 'uReveal', 'uAspect', 'uTintAmt', 'uTint', 'uZoom',
    'uVidScale', 'uSoft', 'uRefTexel', 'uLo', 'uHi', 'uDespill', 'uDebug', 'uLinear']);
  [progRefine, UR] = build(FS_REFINE, ['uVideo', 'uMask0', 'uMask1', 'uMask2', 'uTmp', 'uPrev', 'uRes', 'uStep', 'uSigmaC',
    'uInvert', 'uTemporal', 'uRefine', 'uRoi1', 'uRoi2', 'uNum', 'uMode']);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  texVideo = makeTex(0, gl.CLAMP_TO_EDGE); texPano = makeTex(2, gl.REPEAT);
  for (const u of MASK_UNITS) {
    texMasks.push(makeTex(u, gl.CLAMP_TO_EDGE));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  }
  // Đơn vị texture: 0 hình camera, 1/6/7 mặt nạ gốc, 2 ảnh 360°, 3 mặt nạ đã tinh chỉnh, 4 mặt nạ khung trước, 8 kết quả bước thô.
  gl.useProgram(prog); gl.uniform1i(U.uVideo, 0); gl.uniform1i(U.uRef, 3); gl.uniform1i(U.uPano, 2);
  gl.useProgram(progRefine); gl.uniform1i(UR.uVideo, 0); gl.uniform1i(UR.uPrev, 4); gl.uniform1i(UR.uTmp, 8);
  gl.uniform1i(UR.uMask0, 1); gl.uniform1i(UR.uMask1, 6); gl.uniform1i(UR.uMask2, 7);
}
function makeTex(unit, wrapS) {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function ensureRef(av) {                  // mặt nạ tinh chỉnh có cùng tỉ lệ với ảnh camera
  const w = state.refW, h = Math.max(16, Math.round(state.refW / av));
  if (ref.w === w && ref.h === h) return;
  for (let i = 0; i < 3; i++) {
    if (ref.tex[i]) { gl.deleteTexture(ref.tex[i]); gl.deleteFramebuffer(ref.fbo[i]); }
    ref.tex[i] = makeTex(5, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    ref.fbo[i] = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, ref.fbo[i]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ref.tex[i], 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  ref.w = w; ref.h = h; ref.cur = 0;
}
function refinePass() {
  const nxt = 1 - ref.cur;
  gl.useProgram(progRefine);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, ref.tex[ref.cur]);
  gl.viewport(0, 0, ref.w, ref.h);
  gl.uniform2f(UR.uRes, ref.w, ref.h);
  gl.uniform1f(UR.uInvert, state.invert ? 1 : 0);
  gl.uniform1f(UR.uTemporal, state.temporal);
  gl.uniform1f(UR.uRefine, state.refine && !isMatte() ? 1 : 0);
  gl.uniform1i(UR.uNum, 1 + rois.length);
  const r1 = rois[0] || FULL, r2 = rois[1] || FULL;
  gl.uniform4f(UR.uRoi1, r1.x, r1.y, r1.w, r1.h); gl.uniform4f(UR.uRoi2, r2.x, r2.y, r2.w, r2.h);
  // bước thô
  gl.bindFramebuffer(gl.FRAMEBUFFER, ref.fbo[2]);
  gl.uniform1i(UR.uMode, 0);
  gl.uniform2f(UR.uStep, state.refStep0 / ref.w, state.refStep0 / ref.h); gl.uniform1f(UR.uSigmaC, state.sigmaC);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // bước mịn + ổn định theo thời gian
  gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, ref.tex[2]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, ref.fbo[nxt]);
  gl.uniform1i(UR.uMode, 1);
  gl.uniform2f(UR.uStep, state.refStep / ref.w, state.refStep / ref.h); gl.uniform1f(UR.uSigmaC, state.sigmaC2);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  ref.cur = nxt;
}
function readAlpha() {                    // dùng cho bộ chấm điểm: đọc mặt nạ đã tinh chỉnh
  const px = new Uint8Array(ref.w * ref.h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, ref.fbo[ref.cur]);
  gl.readPixels(0, 0, ref.w, ref.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const out = new Uint8Array(ref.w * ref.h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return { w: ref.w, h: ref.h, data: out };
}
// Một khung hình trọn vẹn: tách người (kể cả các vùng người nhỏ), đưa hình và mặt nạ lên GPU, tinh chỉnh.
function processFrame(src, t, given) {
  const masks = given || (segmenter ? segmentAll(src, t) : null);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texVideo);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  if (masks && masks.length) {
    rois = masks.slice(1).map((m) => m.roi);
    masks.forEach((m, i) => {
      gl.activeTexture(gl.TEXTURE0 + MASK_UNITS[i]); gl.bindTexture(gl.TEXTURE_2D, texMasks[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, m.w, m.h, 0, gl.RED, gl.UNSIGNED_BYTE, m.data);
    });
  }
  refinePass();
}

// ---------- Ảnh 360° ----------
let panoTint = [1, 1, 1];
// Các điểm đến có sẵn. lon = kinh độ của địa danh trong ảnh (độ, 0 là giữa ảnh, dương là về bên phải),
// để khi búng tay địa danh hiện ngay sau lưng hai ba con. Giấy phép từng ảnh ghi ở assets/panos/CREDITS.md.
const DESTS = [
  { id: 'colosseum', name: 'Đấu trường La Mã', url: 'assets/panos/colosseum.jpg', lon: 132, credit: 'Greg Zaal, Rico Cilliers / Poly Haven (CC0)' },
  { id: 'eiffel', name: 'Paris, tháp Eiffel', url: 'assets/panos/eiffel.jpg', lon: -96, credit: 'Alexandre Duret-Lutz (CC BY-SA 2.0)' },
  { id: 'great-wall', name: 'Vạn Lý Trường Thành (trong vọng lâu)', url: 'assets/panos/great-wall.jpg', lon: 42, credit: 'Greg Zaal / Poly Haven (CC0)' },
];
function setPano(source, lonDeg = 0) {    // ảnh hoặc canvas dạng equirectangular 2:1
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const sw = source.naturalWidth || source.width, shh = source.naturalHeight || source.height;
  gl.activeTexture(gl.TEXTURE2);
  if (sw <= Math.min(8192, maxTex)) {
    // Đưa thẳng ảnh lên GPU. Không vẽ qua canvas vì Safari trên iPhone giới hạn canvas khoảng 16,7 triệu điểm.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  } else {
    const w = Math.min(4096, maxTex), h = Math.round(w * shh / sw);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(source, 0, 0, w, h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  }
  state.panoLon = lonDeg * D2R;
  // Màu trung bình của dải ngang giữa ảnh, dùng để nhuộm nhẹ người cho hợp nền.
  const t = document.createElement('canvas'); t.width = 32; t.height = 16;
  const sx = t.getContext('2d', { willReadFrequently: true }); sx.drawImage(source, 0, 0, 32, 16);
  const d = sx.getImageData(0, 4, 32, 8).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const lum = (r + g + b) / 3 || 1;
  panoTint = [r / lum, g / lum, b / lum].map((v) => Math.max(0.75, Math.min(1.25, v)));
}
async function loadDest(id) {
  const dst = DESTS.find((x) => x.id === id);
  const credit = $('credit');
  if (!dst) { setPano(makeTestPano()); credit.textContent = ''; return; }
  credit.textContent = 'Đang tải ảnh…';
  try {
    const img = new Image(); img.src = dst.url; await img.decode();
    setPano(img, dst.lon); credit.textContent = 'Ảnh: ' + dst.credit;
  } catch (e) { credit.textContent = 'Không tải được ảnh: ' + (e.message || e); }
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
    video: { facingMode: 'user', width: { ideal: CAM_MODES[0].w }, height: { ideal: CAM_MODES[0].h }, frameRate: { ideal: 30 } },
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
  { name: '4:3 ngang 1440x1080', w: 1440, h: 1080 },   // mặc định: user chọn trên iPhone ngày 2026-11-11
  { name: '3:4 dọc 1080x1440', w: 1080, h: 1440 },
  { name: '9:16 dọc 720x1280', w: 720, h: 1280 },
  { name: '9:16 dọc 1080x1920', w: 1080, h: 1920 },
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
let stillCanvas = null;
async function startStillSource(url) {     // ?src=ảnh&crop=x,y,w,h : dùng một ảnh thật thay cho camera
  const img = new Image(); img.src = url; await img.decode();
  const c = (qs.get('crop') || `0,0,${img.naturalWidth},${img.naturalHeight}`).split(',').map(Number);
  stillCanvas = document.createElement('canvas'); stillCanvas.width = c[2]; stillCanvas.height = c[3];
  stillCanvas.getContext('2d').drawImage(img, c[0], c[1], c[2], c[3], 0, 0, c[2], c[3]);
  frameSrc = stillCanvas; canvas.width = 720; canvas.height = 1280;
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
let mpVision = null;
async function initSegmenter() {
  if (!mpVision) {
    const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
    mpVision = { ImageSegmenter: mp.ImageSegmenter, fileset: await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`) };
  }
  const make = (delegate) => mpVision.ImageSegmenter.createFromOptions(mpVision.fileset, {
    baseOptions: { modelAssetPath: MODELS[state.model], delegate },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
  });
  const want = qs.get('delegate') || 'GPU';
  const old = segmenter; segmenter = null;
  if (old) old.close();
  try { segmenter = await make(want); state.segBackend = want; }
  catch (e) { console.warn('GPU delegate lỗi, chuyển CPU', e); segmenter = await make('CPU'); state.segBackend = 'CPU'; }
}

// Model chỉ nhìn ảnh 256x256 và được dạy trên ảnh selfie, nên người đứng xa (nhỏ trong khung) bị tách thô hoặc sai.
// Cách xử lý: sau lượt tách toàn khung, tìm các cụm người nhỏ trong mặt nạ, cắt sát quanh từng cụm rồi tách lại.
// Trong ảnh cắt, người đó to như một ảnh selfie bình thường, nên model làm tốt hơn hẳn. Kết quả các lượt được gộp lại.
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const maskBufs = [null, null, null];
let roiCanvas = null, segTs = 0;
function runSeg(input, slot) {
  let out = null;
  segTs = Math.max(segTs + 1, performance.now());           // model đòi mốc thời gian tăng dần giữa các lượt
  segmenter.segmentForVideo(input, segTs, (res) => {
    const masks = res.confidenceMasks; if (!masks || !masks.length) return;
    // Model nhiều lớp: lớp 0 là nền, người = 1 - nền. Model một lớp: mặt nạ cuối là người.
    const multi = masks.length >= 3, m = multi ? masks[0] : masks[masks.length - 1];
    const f = m.getAsFloat32Array(), n = m.width * m.height;
    if (!maskBufs[slot] || maskBufs[slot].length !== n) maskBufs[slot] = new Uint8Array(n);
    const b = maskBufs[slot];
    if (multi) for (let i = 0; i < n; i++) b[i] = (1 - f[i]) * 255;
    else for (let i = 0; i < n; i++) b[i] = f[i] * 255;
    out = { data: b, w: m.width, h: m.height };
  });
  return out;
}
const G = 64, gCell = new Uint8Array(G * G), gLab = new Int16Array(G * G), gStack = new Int32Array(G * G);
function findSmallBlobs(m) {              // tìm các cụm người nhỏ trong mặt nạ toàn khung, trả tối đa 2 vùng cắt
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++)
    gCell[y * G + x] = m.data[Math.floor((y + 0.5) / G * m.h) * m.w + Math.floor((x + 0.5) / G * m.w)] > 110 ? 1 : 0;
  gLab.fill(0);
  const comps = [];
  for (let i = 0; i < G * G; i++) {
    if (!gCell[i] || gLab[i]) continue;
    let n = 0, x0 = G, y0 = G, x1 = -1, y1 = -1, sp = 0;
    gStack[sp++] = i; gLab[i] = 1;
    while (sp) {
      const c = gStack[--sp], cx = c % G, cy = (c - cx) / G;
      n++; if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      if (cx > 0 && gCell[c - 1] && !gLab[c - 1]) { gLab[c - 1] = 1; gStack[sp++] = c - 1; }
      if (cx < G - 1 && gCell[c + 1] && !gLab[c + 1]) { gLab[c + 1] = 1; gStack[sp++] = c + 1; }
      if (cy > 0 && gCell[c - G] && !gLab[c - G]) { gLab[c - G] = 1; gStack[sp++] = c - G; }
      if (cy < G - 1 && gCell[c + G] && !gLab[c + G]) { gLab[c + G] = 1; gStack[sp++] = c + G; }
    }
    comps.push({ n, x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  const out = [];
  comps.sort((a, b) => b.n - a.n);
  for (const c of comps) {
    const frac = c.n / (G * G);
    if (frac < state.blobMin || frac > state.blobMax) continue;   // quá nhỏ là nhiễu, quá lớn là người ở gần (đã tách tốt)
    const bw = (c.x1 - c.x0) / G, bh = (c.y1 - c.y0) / G;
    const mx = Math.max(0.5 * bw, 0.07), my = Math.max(0.5 * bh, 0.07);
    // Làm tròn ra lưới 1/16 khung: vùng cắt đứng yên khi người chỉ nhích nhẹ, để mép không rung theo từng khung.
    const q = (v, up) => Math.min(1, Math.max(0, (up ? Math.ceil(v * 16) : Math.floor(v * 16)) / 16));
    const x = q(c.x0 / G - mx, false), y = q(c.y0 / G - my, false);
    const r = { x, y, w: q(c.x1 / G + mx, true) - x, h: q(c.y1 / G + my, true) - y };
    if (r.w * r.h < 0.7) out.push(r);
    if (out.length === 2) break;
  }
  return out;
}
function segmentAll(src, t) {
  const t0 = performance.now();
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  const full = runSeg(src, 0);
  if (!full) return null;
  const out = [{ ...full, roi: FULL }];
  if (state.roi) {
    if (!roiCanvas) { roiCanvas = document.createElement('canvas'); roiCanvas.width = roiCanvas.height = 256; }
    const cx = roiCanvas.getContext('2d');
    for (const R of findSmallBlobs(full)) {
      cx.drawImage(src, R.x * sw, R.y * sh, R.w * sw, R.h * sh, 0, 0, 256, 256);
      const m = runSeg(roiCanvas, out.length);
      if (m) out.push({ ...m, roi: R });
    }
  }
  state.segMs = state.segMs * 0.9 + (performance.now() - t0) * 0.1;
  state.nRoi = out.length - 1;
  return out;
}

// ---------- Model tách nền chuyên dụng ----------
// MODNet (Apache 2.0) cho ra độ trong suốt từng điểm ảnh thay vì chỉ phân loại người / nền.
// Chạy bằng onnxruntime-web: ưu tiên WebGPU, không có thì về WASM (chậm hơn nhiều).
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const MATTE_URL = 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx';
let ort = null, matte = null, matteBusy = false, holdCanvas = null;
async function initMatte() {
  if (matte) { state.segBackend = matte.ep; return; }
  if (!ort) {
    const m = await import(ORT_URL + 'ort.all.min.mjs');
    ort = m.InferenceSession ? m : m.default;
    ort.env.wasm.wasmPaths = ORT_URL;
  }
  let session = null, ep = '';
  for (const e of (qs.get('ep') ? [qs.get('ep')] : ['webgpu', 'wasm'])) {
    try { session = await ort.InferenceSession.create(MATTE_URL, { executionProviders: [e], graphOptimizationLevel: 'all' }); ep = e; break; }
    catch (err) { console.warn('onnxruntime không dùng được', e, err); }
  }
  if (!session) throw new Error('Không chạy được model tách nền chuyên dụng');
  matte = { session, ep, inName: session.inputNames[0], outName: session.outputNames[0], canvas: document.createElement('canvas'), buf: null, out: null };
  state.segBackend = ep;
}
async function runMatte(src) {
  const t0 = performance.now();
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  // Cạnh ảnh đưa vào model phải chia hết cho 32.
  const W = Math.round(state.matteW / 32) * 32, H = Math.max(32, Math.round(W * sh / sw / 32) * 32);
  const c = matte.canvas; if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(src, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data, n = W * H;
  if (!matte.buf || matte.buf.length !== 3 * n) { matte.buf = new Float32Array(3 * n); matte.out = new Uint8Array(n); }
  const b = matte.buf;
  for (let i = 0, j = 0; i < n; i++, j += 4) {              // RGB về khoảng -1..1, xếp theo kênh
    b[i] = d[j] / 127.5 - 1; b[n + i] = d[j + 1] / 127.5 - 1; b[2 * n + i] = d[j + 2] / 127.5 - 1;
  }
  const res = await matte.session.run({ [matte.inName]: new ort.Tensor('float32', b, [1, 3, H, W]) });
  const o = res[matte.outName], f = o.data || await o.getData();
  for (let i = 0; i < n; i++) matte.out[i] = Math.max(0, Math.min(255, f[i] * 255));
  state.segMs = state.segMs * 0.9 + (performance.now() - t0) * 0.1; state.nRoi = 0;
  return [{ data: matte.out, w: W, h: H, roi: FULL }];
}
const isMatte = () => state.model === 'matte';
const MODEL_NAMES = { fast: 'nhanh', fine: 'kỹ', matte: 'chuyên dụng' };

// ---------- Bắt tiếng búng tay ----------
let analyser = null, analyserRaw = null, tdBuf = null, rawBuf = null, audioCtx = null;
const snapDet = new SnapDetector();
function initAudio() {
  if (!micStream || !micStream.getAudioTracks().length) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const srcNode = audioCtx.createMediaStreamSource(micStream);
  const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200;
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
  analyserRaw = audioCtx.createAnalyser(); analyserRaw.fftSize = 1024; analyserRaw.smoothingTimeConstant = 0;
  srcNode.connect(hp); hp.connect(analyser); srcNode.connect(analyserRaw);
  tdBuf = new Float32Array(analyser.fftSize); rawBuf = new Float32Array(analyserRaw.fftSize);
  audioCtx.resume();
  // Ngón tay chạm màn hình tạo ra tiếng "tách" ngay sát micro: bỏ qua âm thanh quanh thời điểm đó.
  for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend'])
    document.addEventListener(ev, () => snapDet.noteTouch(performance.now()), { passive: true, capture: true });
}
const peakOf = (buf) => { let p = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; } return p; };
function pollSnap(now) {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(tdBuf); analyserRaw.getFloatTimeDomainData(rawBuf);
  const hp = peakOf(tdBuf), raw = peakOf(rawBuf);
  $('meter').firstElementChild.style.width = Math.min(100, hp * 300) + '%';
  snapDet.sens = state.sens;
  if (snapDet.step(hp, raw, now) && state.listen) {
    state.snapCount++;
    // Tiếng búng chỉ đưa tới điểm đến. Quay về nhà phải bấm nút, để một tiếng động lạ không kéo cảnh về giữa chừng.
    if (state.revealTarget < 0.5 || state.snapBack) onSnap();
  }
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
  if (state.paused) return;               // bộ chấm điểm tự điều khiển từng khung hình
  const dt = Math.min(0.1, (now - lastT) / 1000 || 0); lastT = now;
  pollSnap(now);
  // Hiệu ứng chuyển cảnh kéo dài khoảng 0,6 giây.
  const d = state.revealTarget - state.reveal;
  if (d) state.reveal += Math.sign(d) * Math.min(Math.abs(d), dt / 0.6);

  let mask = null;
  if (demoCanvas) { mask = drawDemo(now); newFrame = true; }
  else if (stillCanvas) newFrame = true;
  else { newFrame = video.currentTime !== lastVideoTime; lastVideoTime = video.currentTime; }
  const aspect = canvas.width / canvas.height;
  const av = (frameSrc.videoWidth || frameSrc.width) / (frameSrc.videoHeight || frameSrc.height) || aspect;
  ensureRef(av);
  if (newFrame && (frameSrc.videoWidth || frameSrc.width)) {
    if (isMatte() && matte && !demoCanvas) {
      if (!matteBusy) {
        // Model này trả kết quả sau một lúc, nên phải chụp lại khung hình lúc đưa vào để hình và mặt nạ khớp nhau.
        matteBusy = true;
        if (!holdCanvas) holdCanvas = document.createElement('canvas');
        const sw = frameSrc.videoWidth || frameSrc.width, sh = frameSrc.videoHeight || frameSrc.height;
        const hw = Math.min(sw, 1080), hh = Math.round(hw * sh / sw);
        if (holdCanvas.width !== hw || holdCanvas.height !== hh) { holdCanvas.width = hw; holdCanvas.height = hh; }
        holdCanvas.getContext('2d').drawImage(frameSrc, 0, 0, hw, hh);
        runMatte(holdCanvas).then((masks) => { processFrame(holdCanvas, now, masks); frames++; })
          .catch((e) => { console.error(e); state.camInfo = 'lỗi model: ' + (e.message || e); })
          .finally(() => { matteBusy = false; });
      }
    } else {
      if (demoCanvas && segmenter && qs.has('seg')) segmentAll(frameSrc, now);   // chỉ để đo tốc độ khi giả lập
      processFrame(frameSrc, now, demoCanvas ? [{ ...mask, roi: FULL }] : null);
      frames++;
    }
  }
  const m = mul(rotZ(state.heading0 - (state.panoLon || 0)), orientAt(now - state.delayMs));
  // Zoom vào thì góc nhìn hẹp lại, nên nền 360° cũng phải phóng to đúng tỉ lệ đó.
  const tv = Math.tan(state.fovV * D2R / 2) / state.zoom;
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, ref.tex[ref.cur]);
  gl.uniform2f(U.uRefTexel, 1 / ref.w, 1 / ref.h);
  gl.uniform1f(U.uLinear, isMatte() ? 1 : 0);
  gl.uniform1f(U.uLo, isMatte() ? state.matteLo : state.lo); gl.uniform1f(U.uHi, isMatte() ? state.matteHi : state.hi);
  gl.uniform1f(U.uDespill, state.refine ? state.despill : 0); gl.uniform1f(U.uDebug, state.debug ? 1 : 0);
  gl.uniform1f(U.uZoom, state.zoom);
  if (av > aspect) gl.uniform2f(U.uVidScale, aspect / av, 1); else gl.uniform2f(U.uVidScale, 1, av / aspect);
  gl.uniform1f(U.uSoft, state.zoom < 0.999 ? 0.03 : 0);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniformMatrix3fv(U.uRot, true, m);
  gl.uniform2f(U.uTan, tv * aspect, tv);
  gl.uniform1f(U.uReveal, state.reveal); gl.uniform1f(U.uAspect, aspect);
  gl.uniform1f(U.uTintAmt, state.tintAmt);
  gl.uniform3fv(U.uTint, panoTint);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  if (now - fpsT > 1000) {
    state.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now;
    $('hud').textContent =
      `${VERSION}  ${canvas.width}x${canvas.height}  ${state.fps.toFixed(0)} fps  cam ${frameSrc.videoWidth || frameSrc.width}x${frameSrc.videoHeight || frameSrc.height}\n` +
      `tách người: ${MODEL_NAMES[state.model]} ${state.segBackend} ${state.segMs.toFixed(1)} ms  vùng nhỏ: ${state.nRoi}\n` +
      `xoay: ${state.orient}  zoom ${state.zoom.toFixed(1)}x  búng: ${state.snapCount} (loại ${snapDet.rejected}${snapDet.lastReject ? ': ' + snapDet.lastReject : ''})${state.camInfo ? '\n' + state.camInfo : ''}${recorder ? '\n● đang quay' : ''}`;
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
  $('snapBack').onclick = (e) => { state.snapBack = !state.snapBack; e.target.textContent = 'Búng để quay về: ' + (state.snapBack ? 'bật' : 'tắt'); };
  $('listen').onclick = (e) => { state.listen = !state.listen; e.target.textContent = 'Nghe búng tay: ' + (state.listen ? 'bật' : 'tắt'); };
  $('camMode').onclick = nextCamMode;
  bind('erode', 'lo', (v) => v + '%', (v) => { state.lo = 0.2 + v / 100 * 0.5; state.hi = state.lo + 0.3; });
  $('refine').onclick = (e) => { state.refine = !state.refine; e.target.textContent = 'Làm nét viền: ' + (state.refine ? 'bật' : 'tắt'); };
  $('debug').onclick = (e) => { state.debug = !state.debug; e.target.textContent = 'Xem mặt nạ: ' + (state.debug ? 'bật' : 'tắt'); };
  $('model').onclick = async (e) => {
    const order = ['fast', 'fine', 'matte'], next = order[(order.indexOf(state.model) + 1) % order.length];
    e.target.textContent = 'Model: đang tải…';
    try { await setModel(next); }
    catch (err) { console.error(err); state.camInfo = 'không tải được model: ' + (err.message || err); await setModel('fast'); }
    e.target.textContent = 'Model: ' + MODEL_NAMES[state.model];
  };
  $('testPano').onclick = () => { $('dest').value = ''; loadDest(''); };
  for (const d of DESTS) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; $('dest').appendChild(o); }
  $('dest').onchange = (e) => loadDest(e.target.value);
  $('pickPano').onclick = () => $('panoFile').click();
  $('panoFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image(); img.onload = () => { setPano(img); URL.revokeObjectURL(img.src); $('dest').value = ''; $('credit').textContent = 'Ảnh của bạn'; };
    img.src = URL.createObjectURL(f);
  };
}

async function start() {
  const msg = $('msg'); $('go').disabled = true;
  try {
    msg.textContent = 'Đang xin quyền cảm biến…'; await startOrientation();   // phải gọi ngay trong lần chạm
    initGL(); setPano(makeTestPano());
    $('dest').value = DESTS[0].id; loadDest(DESTS[0].id);     // tải nền thật trong lúc mở camera
    if (qs.get('src')) await startStillSource(qs.get('src'));
    else if (DEMO) startDemoSource();
    else { msg.textContent = 'Đang mở camera…'; await startCamera(); initAudio(); }
    const wantModel = qs.get('model') || state.model; state.model = wantModel === 'matte' ? 'fine' : wantModel;
    if (!DEMO || qs.has('seg') || qs.get('src')) { msg.textContent = 'Đang tải model tách người…'; await initSegmenter(); }
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
    $('start').style.display = 'none';
    requestAnimationFrame(tick);
  } catch (e) {
    console.error(e); msg.textContent = 'Lỗi: ' + (e && e.message ? e.message : e); $('go').disabled = false;
  }
}

bindUI();
$('go').onclick = start;
// ---------- Móc nối cho bộ chấm điểm (tools/eval.js) ----------
async function evalFrame(src) {           // chạy đúng chuỗi tách người + tinh chỉnh trên một khung hình cho trước
  frameSrc = src; ensureRef(src.width / src.height);
  processFrame(src, performance.now(), isMatte() ? await runMatte(src) : null);
  return readAlpha();
}
function resetRef() { ref.w = 0; rois = []; }                // xoá trí nhớ khung trước giữa hai bài thử
async function setModel(kind) {
  if (kind === 'matte') { await initMatte(); state.model = kind; return; }
  if (state.model !== kind || !segmenter) { state.model = kind; await initSegmenter(); }
}
window.__tah = { state, onSnap, centerPano, readAlpha, evalFrame, resetRef, setModel };   // để kiểm thử từ console

// Bộ chấm điểm phần tách người.
//
// Ý tưởng: lấy một ảnh người thật, cắt người ra thành lớp có độ trong suốt biết trước, rồi ghép lên nhiều kiểu
// phòng khác nhau. Vì ảnh ghép do mình tạo ra nên "đáp án" (mặt nạ đúng) chính xác tới từng điểm ảnh.
// Sau đó cho chuỗi xử lý của app chạy trên ảnh ghép và so mặt nạ nó tính ra với đáp án.
//
// Cách chạy: mở index.html?src=<ảnh>, bấm Bắt đầu, rồi trong console:
//   const ev = await import('./tools/eval.js'); await ev.prepare('<ảnh>'); await ev.run({ ...cấu hình });

const FW = 810, FH = 1080;                 // khung camera mô phỏng, tỉ lệ 3:4 như máy thật
const T = () => window.__tah;
let fgCanvas = null, photo = null, skin = [200, 160, 140];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function boxBlur(src, w, h, r) {           // làm mờ hộp tách trục, trả mảng Float32
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0; for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0; for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Bước chuẩn bị: cắt người khỏi ảnh gốc bằng cấu hình tốt nhất hiện có, rồi co mép vào trong vài điểm ảnh
// để lớp người chỉ gồm phần chắc chắn là người. Mép của lớp này là đáp án chính xác cho mọi ảnh ghép.
export async function prepare(url) {
  const st = T().state; st.paused = true;
  const img = new Image(); img.src = url; await img.decode();
  photo = mk(FW, FH);
  const px = photo.getContext('2d', { willReadFrequently: true });
  const sc = Math.max(FW / img.naturalWidth, FH / img.naturalHeight);
  const dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
  px.drawImage(img, (FW - dw) / 2, (FH - dh) / 2, dw, dh);
  await T().setModel('fine');
  Object.assign(st, { refine: true, temporal: 1, invert: false, roi: false });
  T().resetRef();
  let a; for (let i = 0; i < 3; i++) a = T().evalFrame(photo);
  // phóng mặt nạ lên cỡ khung
  const small = mk(a.w, a.h), sx = small.getContext('2d'), id = sx.createImageData(a.w, a.h);
  for (let i = 0; i < a.data.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = a.data[i]; id.data[i * 4 + 3] = 255; }
  sx.putImageData(id, 0, 0);
  const big = mk(FW, FH), bx = big.getContext('2d', { willReadFrequently: true });
  bx.imageSmoothingQuality = 'high'; bx.drawImage(small, 0, 0, FW, FH);
  const bd = bx.getImageData(0, 0, FW, FH).data, bin = new Float32Array(FW * FH);
  for (let i = 0; i < bin.length; i++) bin[i] = bd[i * 4] > 140 ? 1 : 0;
  const er = boxBlur(bin, FW, FH, 5);                       // co vào khoảng 4 điểm ảnh
  for (let i = 0; i < er.length; i++) er[i] = er[i] > 0.86 ? 1 : 0;
  const soft = boxBlur(er, FW, FH, 1);                      // mép mềm 1-2 điểm ảnh như ảnh thật
  fgCanvas = mk(FW, FH);
  const fx = fgCanvas.getContext('2d'), pd = px.getImageData(0, 0, FW, FH);
  for (let i = 0; i < soft.length; i++) pd.data[i * 4 + 3] = Math.round(soft[i] * 255);
  fx.putImageData(pd, 0, 0);
  // màu da trung bình ở giữa mặt, dùng cho phông "trùng màu da"
  const cd = px.getImageData(FW * 0.4, FH * 0.45, FW * 0.2, FH * 0.1).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < cd.length; i += 4) { r += cd[i]; g += cd[i + 1]; b += cd[i + 2]; }
  skin = [r, g, b].map((v) => Math.round(v / (cd.length / 4)));
  let cover = 0; for (let i = 0; i < soft.length; i++) cover += soft[i];
  return { fgCoverage: +(cover / soft.length).toFixed(3), skin };
}

// ---------- Các kiểu phòng ----------
const BGS = {
  'tường trắng': (x) => { const g = x.createLinearGradient(0, 0, FW, FH); g.addColorStop(0, '#e2e1dc'); g.addColorStop(1, '#bdbcb6'); x.fillStyle = g; x.fillRect(0, 0, FW, FH); },
  'phòng thật': (x) => {                                   // dải tường và cửa phía trên đầu trong ảnh gốc, kéo giãn ra
    x.drawImage(photo, 0, 0, FW, FH * 0.2, 0, 0, FW, FH * 0.55);
    x.save(); x.translate(0, FH * 1.1); x.scale(1, -1); x.drawImage(photo, 0, 0, FW, FH * 0.2, 0, 0, FW, FH * 0.55); x.restore();
  },
  'trùng màu da': (x) => { const g = x.createLinearGradient(0, 0, 0, FH); g.addColorStop(0, `rgb(${skin.map((v) => Math.min(255, v + 18))})`); g.addColorStop(1, `rgb(${skin.map((v) => Math.max(0, v - 25))})`); x.fillStyle = g; x.fillRect(0, 0, FW, FH); },
  'tối như tóc': (x) => { const g = x.createLinearGradient(0, 0, FW, 0); g.addColorStop(0, '#15130f'); g.addColorStop(1, '#3a342d'); x.fillStyle = g; x.fillRect(0, 0, FW, FH); },
  'lộn xộn': (x) => {
    const r = rng(7); x.fillStyle = '#8d8f86'; x.fillRect(0, 0, FW, FH);
    for (let i = 0; i < 70; i++) { x.fillStyle = `hsl(${r() * 360},${20 + r() * 50}%,${20 + r() * 60}%)`; x.fillRect(r() * FW, r() * FH, 20 + r() * 160, 20 + r() * 200); }
    x.strokeStyle = '#222'; x.lineWidth = 3; for (let i = 0; i < 12; i++) { x.beginPath(); x.moveTo(0, r() * FH); x.lineTo(FW, r() * FH); x.stroke(); }
  },
  'cửa sổ chói': (x) => {
    x.fillStyle = '#5c5a55'; x.fillRect(0, 0, FW, FH);
    const g = x.createRadialGradient(FW * 0.3, FH * 0.3, 40, FW * 0.3, FH * 0.3, FW * 0.6); g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#f4f6ff'); g.addColorStop(1, 'rgba(244,246,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, FW, FH); x.fillStyle = '#fff'; x.fillRect(FW * 0.08, FH * 0.1, FW * 0.45, FH * 0.42);
  },
  'gỗ sọc': (x) => { for (let i = 0; i < FW; i += 18) { x.fillStyle = (i / 18) % 2 ? '#8a6a45' : '#a27c52'; x.fillRect(i, 0, 18, FH); } },
  'áo cùng màu': (x) => { x.fillStyle = '#c9c9c7'; x.fillRect(0, 0, FW, FH); x.fillStyle = '#dcdcda'; for (let i = 0; i < FH; i += 40) x.fillRect(0, i, FW, 14); },
};
// ---------- Bố cục người trong khung ----------
const LAYOUTS = {
  'gần': [{ s: 1, x: 0, flip: false }],
  'vừa': [{ s: 0.62, x: 0.19, flip: false }],
  'hai người': [{ s: 0.6, x: 0.38, flip: false }, { s: 0.42, x: 0.02, flip: true }],
};

function compose(bgName, layoutName, frame, motion, noiseSeed) {
  const c = mk(FW, FH), x = c.getContext('2d', { willReadFrequently: true });
  const g = mk(FW, FH), gx = g.getContext('2d', { willReadFrequently: true });
  x.save(); BGS[bgName](x); x.restore();
  for (const L of LAYOUTS[layoutName]) {
    const w = FW * L.s, h = FH * L.s, ox = FW * L.x + (motion ? frame * 9 : 0), oy = FH - h;   // chân người chạm đáy khung
    for (const ctx of [x, gx]) {
      ctx.save();
      if (L.flip) { ctx.translate(ox + w, oy); ctx.scale(-1, 1); ctx.drawImage(fgCanvas, 0, 0, w, h); }
      else ctx.drawImage(fgCanvas, ox, oy, w, h);
      ctx.restore();
    }
  }
  // nhiễu cảm biến: mỗi khung một kiểu nhiễu khác nhau, để lộ ra hiện tượng nhấp nháy
  const id = x.getImageData(0, 0, FW, FH), d = id.data, r = rng(noiseSeed);
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 10; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(id, 0, 0);
  return { frame: c, gt: g };
}
function gtAt(gtCanvas, w, h) {            // đáp án thu về cỡ của mặt nạ tinh chỉnh
  const s = mk(w, h), sx = s.getContext('2d', { willReadFrequently: true });
  sx.imageSmoothingQuality = 'high'; sx.drawImage(gtCanvas, 0, 0, w, h);
  const d = sx.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] / 255;
  return out;
}
const sstep = (lo, hi, v) => { const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

function score(alpha, gt, w, h, lo, hi) {
  // vùng mép: mọi điểm cách đường biên đáp án không quá ~6 điểm
  const edge = new Float32Array(w * h);
  for (let i = 0; i < edge.length; i++) edge[i] = gt[i] > 0.02 && gt[i] < 0.98 ? 1 : 0;
  const band = boxBlur(edge, w, h, 6);
  let sum = 0, es = 0, en = 0, leak = 0, bgN = 0, miss = 0, fgN = 0;
  for (let i = 0; i < gt.length; i++) {
    const a = sstep(lo, hi, alpha[i] / 255), e = Math.abs(a - gt[i]);
    sum += e;
    if (band[i] > 0) { es += e; en++; }
    if (gt[i] < 0.02) { bgN++; if (a > 0.5) leak++; }
    if (gt[i] > 0.98) { fgN++; if (a < 0.5) miss++; }
  }
  return { tong: 100 * (1 - sum / gt.length), vien: 100 * (1 - es / Math.max(1, en)), lotNen: 1000 * leak / Math.max(1, bgN), matNguoi: 1000 * miss / Math.max(1, fgN) };
}

// Chạy một cấu hình trên toàn bộ bài thử. cfg: { model, refine, sigmaC, refStep, temporal, lo, hi, frames, bgs, layouts }
export async function run(cfg = {}) {
  const st = T().state; st.paused = true;
  await T().setModel(cfg.model || 'fast');
  Object.assign(st, { refine: cfg.refine ?? true, sigmaC: cfg.sigmaC ?? 0.1, refStep: cfg.refStep ?? 1.6, temporal: cfg.temporal ?? 0.5, invert: false, roi: cfg.roi ?? false });
  const lo = cfg.lo ?? 0.41, hi = cfg.hi ?? 0.71, frames = cfg.frames ?? 6;
  const rows = [], agg = { tong: 0, vien: 0, lotNen: 0, matNguoi: 0, nhapNhay: 0, n: 0 };
  let seed = 1;
  for (const bg of cfg.bgs || Object.keys(BGS)) for (const lay of cfg.layouts || Object.keys(LAYOUTS)) for (const motion of [false, true]) {
    T().resetRef();
    let prev = null, flick = 0, last = null, lastGt = null;
    for (let f = 0; f < frames; f++) {
      const { frame, gt } = compose(bg, lay, f, motion, seed++);
      const a = T().evalFrame(frame);
      if (!motion && prev) { let dsum = 0; for (let i = 0; i < a.data.length; i++) dsum += Math.abs(sstep(lo, hi, a.data[i] / 255) - sstep(lo, hi, prev[i] / 255)); flick += dsum / a.data.length; }
      prev = a.data; last = a; lastGt = gt;
    }
    const s = score(last.data, gtAt(lastGt, last.w, last.h), last.w, last.h, lo, hi);
    s.nhapNhay = motion ? null : 1000 * flick / (frames - 1);
    rows.push({ bg, lay, motion, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v == null ? null : +v.toFixed(2)])) });
    for (const k of ['tong', 'vien', 'lotNen', 'matNguoi']) agg[k] += s[k];
    if (!motion) agg.nhapNhay += s.nhapNhay;
    agg.n++;
  }
  const mean = { tong: agg.tong / agg.n, vien: agg.vien / agg.n, lotNen: agg.lotNen / agg.n, matNguoi: agg.matNguoi / agg.n, nhapNhay: agg.nhapNhay / (agg.n / 2) };
  for (const k in mean) mean[k] = +mean[k].toFixed(2);
  const worst = [...rows].sort((a, b) => a.vien - b.vien).slice(0, 4);
  return { cfg, mean, worst, rows: cfg.rows ? rows : undefined };
}

// Xem bằng mắt một bài thử: vẽ ảnh ghép và mặt nạ tính được cạnh nhau vào một canvas trên trang.
export function show(bg, lay, cfg = {}) {
  const st = T().state; st.paused = true; T().resetRef();
  let a, fr, gt;
  for (let f = 0; f < 4; f++) { ({ frame: fr, gt } = compose(bg, lay, f, false, 100 + f)); a = T().evalFrame(fr); }
  const lo = cfg.lo ?? 0.41, hi = cfg.hi ?? 0.71, g = gtAt(gt, a.w, a.h);
  let c = document.getElementById('evalView');
  if (!c) { c = mk(a.w * 2, a.h); c.id = 'evalView'; c.style.cssText = 'position:fixed;inset:0;z-index:99;width:100%;height:100%;object-fit:contain;background:#222'; document.body.appendChild(c); }
  const x = c.getContext('2d'); x.drawImage(fr, 0, 0, a.w, a.h);
  const id = x.createImageData(a.w, a.h);
  for (let i = 0; i < g.length; i++) {       // xanh lá = đúng, đỏ = lọt nền, xanh dương = mất người
    const v = sstep(lo, hi, a.data[i] / 255), e = v - g[i];
    id.data[i * 4] = e > 0 ? 255 * e : 0; id.data[i * 4 + 2] = e < 0 ? -255 * e : 0; id.data[i * 4 + 1] = 160 * Math.min(v, g[i]); id.data[i * 4 + 3] = 255;
  }
  x.putImageData(id, a.w, 0);
  return 'ok';
}

// ---------- Chấm trên ảnh người thật có mặt nạ chuẩn (ví dụ PPM-100, đã thu về 810x1080) ----------
// dir chứa index.json, NNN.jpg và NNN_a.png. Mỗi ảnh được đưa qua nhiều khung với nhiễu khác nhau,
// giống một đoạn video đứng yên, để đo cả độ chính xác lẫn nhấp nháy.
async function loadImg(url) { const im = new Image(); im.src = url; await im.decode(); return im; }
export async function runReal(dir, cfg = {}) {
  const st = T().state; st.paused = true;
  await T().setModel(cfg.model || 'fast');
  Object.assign(st, { refine: cfg.refine ?? true, sigmaC: cfg.sigmaC ?? 0.1, refStep: cfg.refStep ?? 1.6, temporal: cfg.temporal ?? 0.5, invert: false, roi: cfg.roi ?? false });
  const lo = cfg.lo ?? 0.41, hi = cfg.hi ?? 0.71, frames = cfg.frames ?? 4;
  let index = await (await fetch(`${dir}/index.json`)).json();
  if (cfg.ids) index = index.filter((e) => cfg.ids.includes(e.id));
  if (cfg.limit) index = index.slice(0, cfg.limit);
  const rows = [], agg = { tong: 0, vien: 0, lotNen: 0, matNguoi: 0, nhapNhay: 0 };
  const c = mk(FW, FH), x = c.getContext('2d', { willReadFrequently: true });
  let seed = 1;
  for (const e of index) {
    const [im, al] = await Promise.all([loadImg(`${dir}/${e.id}.jpg`), loadImg(`${dir}/${e.id}_a.png`)]);
    T().resetRef();
    let prev = null, flick = 0, a = null;
    for (let f = 0; f < frames; f++) {
      x.drawImage(im, 0, 0, FW, FH);
      const id = x.getImageData(0, 0, FW, FH), d = id.data, r = rng(seed++);
      for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 10; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
      x.putImageData(id, 0, 0);
      a = T().evalFrame(c);
      if (prev) { let ds = 0; for (let i = 0; i < a.data.length; i++) ds += Math.abs(sstep(lo, hi, a.data[i] / 255) - sstep(lo, hi, prev[i] / 255)); flick += ds / a.data.length; }
      prev = a.data;
    }
    const g = mk(a.w, a.h), gx = g.getContext('2d', { willReadFrequently: true });
    gx.imageSmoothingQuality = 'high'; gx.drawImage(al, 0, 0, a.w, a.h);
    const gd = gx.getImageData(0, 0, a.w, a.h).data, gt = new Float32Array(a.w * a.h);
    for (let i = 0; i < gt.length; i++) gt[i] = gd[i * 4] / 255;
    const s = score(a.data, gt, a.w, a.h, lo, hi);
    s.nhapNhay = 1000 * flick / (frames - 1);
    rows.push({ id: e.id, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(2)])) });
    for (const k in agg) agg[k] += s[k];
  }
  const mean = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, +(v / rows.length).toFixed(2)]));
  const byVien = [...rows].sort((p, q) => p.vien - q.vien);
  return { n: rows.length, mean, median_vien: byVien[Math.floor(rows.length / 2)].vien, worst: byVien.slice(0, 8), rows: cfg.rows ? rows : undefined };
}
// Xem bằng mắt một ảnh thật: trái là ảnh, phải là bản đồ sai số (xanh lá đúng, đỏ lọt nền, xanh dương mất người).
export async function showReal(dir, id, cfg = {}) {
  const st = T().state; st.paused = true; T().resetRef();
  const [im, al] = await Promise.all([loadImg(`${dir}/${id}.jpg`), loadImg(`${dir}/${id}_a.png`)]);
  const c = mk(FW, FH); c.getContext('2d').drawImage(im, 0, 0, FW, FH);
  let a; for (let f = 0; f < 4; f++) a = T().evalFrame(c);
  const lo = cfg.lo ?? 0.41, hi = cfg.hi ?? 0.71;
  const g = mk(a.w, a.h), gx = g.getContext('2d', { willReadFrequently: true }); gx.drawImage(al, 0, 0, a.w, a.h);
  const gd = gx.getImageData(0, 0, a.w, a.h).data;
  let v = document.getElementById('evalView');
  if (!v) { v = mk(a.w * 2, a.h); v.id = 'evalView'; v.style.cssText = 'position:fixed;inset:0;z-index:99;width:100%;height:100%;object-fit:contain;background:#222'; document.body.appendChild(v); }
  const x = v.getContext('2d'); x.drawImage(c, 0, 0, a.w, a.h);
  const id2 = x.createImageData(a.w, a.h);
  for (let i = 0; i < a.data.length; i++) {
    const p = sstep(lo, hi, a.data[i] / 255), t = gd[i * 4] / 255, e = p - t;
    id2.data[i * 4] = e > 0 ? 255 * e : 0; id2.data[i * 4 + 2] = e < 0 ? -255 * e : 0; id2.data[i * 4 + 1] = 160 * Math.min(p, t); id2.data[i * 4 + 3] = 255;
  }
  x.putImageData(id2, a.w, 0);
  return 'ok';
}

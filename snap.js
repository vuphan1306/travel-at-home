// Bộ nhận tiếng búng tay. Tách riêng khỏi phần âm thanh của trình duyệt để thử được bằng tín hiệu giả lập.
//
// Mỗi lần gọi step() nhận một đoạn âm thanh ngắn (khoảng 10-20 ms), đã rút gọn thành hai con số:
//   hp  = đỉnh của tín hiệu sau khi lọc bỏ dải thấp (trên khoảng 2 kHz)
//   raw = đỉnh của tín hiệu gốc
// Một tiếng búng tay được công nhận khi đủ cả các điều kiện sau:
//   1. to hẳn lên so với lúc trước đó (không phải đang giữa một câu nói hay tiếng ồn kéo dài)
//   2. sáng: phần lớn năng lượng nằm ở dải cao (tiếng nói, tiếng gõ trầm thì không)
//   3. tắt rất nhanh: sau 40 ms không còn gì đáng kể, và giữ lặng tới 150 ms
//   4. không trùng lúc ngón tay vừa chạm màn hình (chạm máy cũng tạo ra tiếng "tách")
export class SnapDetector {
  constructor(opts = {}) {
    this.sens = 5;                               // 1 (khó kích) .. 10 (dễ kích)
    this.minBright = opts.minBright ?? 0.45;     // tỉ lệ hp/raw tối thiểu
    this.bg = 0.01; this.hist = []; this.cand = null;
    this.lastFire = -1e9; this.lastTouch = -1e9;
    this.rejected = 0; this.lastReject = '';
  }
  noteTouch(now) { this.lastTouch = now; }
  /** Trả về true đúng một lần cho mỗi tiếng búng tay được công nhận. now tính bằng mili giây. */
  step(hp, raw, now) {
    let fired = false;
    const c = this.cand;
    if (c) {
      const age = now - c.t;
      if (age <= 40) { if (hp > c.peak) c.peak = hp; }                       // phần bật lên và ngân rất ngắn
      else if (age <= 150) {
        if (hp > c.peak * 0.3) { this.cand = null; this.rejected++; this.lastReject = 'âm kéo dài'; }
      } else { this.cand = null; this.lastFire = now; fired = true; }
    } else {
      let recent = 0; for (const h of this.hist) if (h.hp > recent) recent = h.hp;   // 150 ms ngay trước đó
      const floor = 0.75 / (this.sens * this.sens);
      if (hp > floor && hp > this.bg * 6 && hp > recent * 4 && now - this.lastFire > 1500) {
        if (now - this.lastTouch < 400) { this.rejected++; this.lastReject = 'vừa chạm màn hình'; }
        else if (!(raw > 0) || hp / raw < this.minBright) { this.rejected++; this.lastReject = 'âm trầm'; }
        else this.cand = { t: now, peak: hp };
      }
    }
    this.hist.push({ t: now, hp });
    while (this.hist.length && now - this.hist[0].t > 150) this.hist.shift();
    this.bg = this.bg * 0.97 + Math.min(hp, 0.2) * 0.03;
    return fired;
  }
}

// Thử bộ nhận tiếng búng tay bằng tín hiệu giả lập. Chạy: node tools/test_snap.mjs
import { SnapDetector } from '../snap.js';

const STEP = 16;                                   // một lần đo mỗi 16 ms, như vòng lặp vẽ hình
function run(name, frames, { touchAt = null, expect }) {
  const d = new SnapDetector();
  let t = 1000, fires = 0;
  for (let i = 0; i < 40; i++) { d.step(0.004, 0.006, t); t += STEP; }        // phòng yên tĩnh lúc đầu
  frames.forEach(([hp, raw], i) => {
    if (touchAt === i) d.noteTouch(t - 50);
    if (d.step(hp, raw, t)) fires++;
    t += STEP;
  });
  for (let i = 0; i < 30; i++) { if (d.step(0.004, 0.006, t)) fires++; t += STEP; }
  const ok = fires === expect;
  console.log(`${ok ? 'ĐẠT ' : 'HỎNG'}  ${name}: kích ${fires} lần (mong đợi ${expect})${d.lastReject ? ', loại vì: ' + d.lastReject : ''}`);
  return ok;
}
const quiet = (n) => Array.from({ length: n }, () => [0.004, 0.006]);
const hold = (n, hp, raw) => Array.from({ length: n }, () => [hp, raw]);

const results = [
  run('búng tay rõ', [[0.30, 0.36], [0.12, 0.15], [0.02, 0.03], ...quiet(12)], { expect: 1 }),
  run('búng tay nhỏ', [[0.06, 0.08], [0.02, 0.03], ...quiet(12)], { expect: 1 }),
  run('hai lần búng cách nhau 2 giây', [[0.3, 0.36], [0.1, 0.12], ...quiet(125), [0.3, 0.36], [0.1, 0.12], ...quiet(12)], { expect: 2 }),
  run('nói một câu (âm kéo dài)', [...hold(25, 0.08, 0.4)], { expect: 0 }),
  run('âm bật "t/k" rồi tới nguyên âm', [[0.14, 0.2], [0.10, 0.3], ...hold(15, 0.07, 0.4)], { expect: 0 }),
  run('tiếng "s" kéo dài', [...hold(15, 0.2, 0.22)], { expect: 0 }),
  run('gõ trầm vào bàn', [[0.08, 0.6], [0.03, 0.3], ...quiet(12)], { expect: 0 }),
  run('chạm vào màn hình', [[0.2, 0.25], [0.05, 0.07], ...quiet(12)], { touchAt: 0, expect: 0 }),
  run('tiếng ồn nền tăng dần', [...Array.from({ length: 60 }, (_, i) => [0.004 + i * 0.002, 0.01 + i * 0.004])], { expect: 0 }),
  run('nhạc / tivi đang mở rồi có tiếng gắt', [...hold(30, 0.05, 0.2), [0.12, 0.3], ...hold(20, 0.05, 0.2)], { expect: 0 }),
  run('búng tay khi phòng hơi ồn', [...hold(30, 0.012, 0.05), [0.3, 0.36], [0.1, 0.13], ...hold(15, 0.012, 0.05)], { expect: 1 }),
];
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} ca đạt`);
process.exit(pass === results.length ? 0 : 1);

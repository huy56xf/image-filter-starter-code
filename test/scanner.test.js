/*
 * Kiểm thử lõi quét tài liệu bằng ảnh tổng hợp (không cần thư viện ngoài):
 * vẽ một "tờ giấy" có chữ giả lên nền gỗ sọc, chiếu phối cảnh qua homography,
 * thêm bóng đổ + nhiễu, rồi kiểm tra góc tìm được và kết quả tăng cường.
 *
 * Chạy: npm test
 */
'use strict';
var assert = require('assert');
var DS = require('../public/js/scanner-core.js');

function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

function makeScene(opts) {
  var W = opts.width, H = opts.height, q = opts.quad, rand = rng(opts.seed || 1);
  var img = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  var PW = 210, PH = 297; // toạ độ giấy (mm, khổ A4)
  // homography: ảnh -> giấy (để biết pixel nào thuộc giấy)
  var Hm = DS.getPerspectiveTransform(q, [{ x: 0, y: 0 }, { x: PW, y: 0 }, { x: PW, y: PH }, { x: 0, y: PH }]);
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var d = Hm[6] * x + Hm[7] * y + Hm[8];
    var u = (Hm[0] * x + Hm[1] * y + Hm[2]) / d, v = (Hm[3] * x + Hm[4] * y + Hm[5]) / d;
    var c;
    if (u >= 0 && u < PW && v >= 0 && v < PH) {
      c = [244, 242, 236];
      // "dòng chữ": các vạch tối ngắt quãng
      if (u > 20 && u < PW - 20 && v > 25 && v < PH - 40 && (v % 9) < 2.2 && ((u * 0.7 + Math.floor(v / 9) * 13) % 11) < 8) c = [35, 35, 40];
      if (u > 20 && u < 120 && v > 10 && v < 18) c = [30, 30, 30];      // tiêu đề
      if (u > 130 && u < 185 && v > 265 && v < 272) c = [190, 30, 30];   // chữ ký màu đỏ
      if (opts.table && u > 15 && u < PW - 15 && v > 60 && v < 200) {     // bảng kẻ ô đậm
        var gu = Math.min(Math.abs(u - 15), Math.abs(u - (PW - 15)), Math.abs(u - 60), Math.abs(u - 130));
        var gv = Math.min(Math.abs(v - 60), Math.abs(v - 200), Math.abs(((v - 60) % 14) - 7) > 6.4 ? 0 : 9);
        if (gu < 0.9 || gv < 0.9) c = [20, 20, 20];
      }
    } else {
      var stripe = Math.floor((x + y * 0.15) / 18) % 2;
      c = stripe ? [92, 62, 38] : [110, 75, 45];
    }
    var shade = 1 - opts.shadow * Math.max(0, (x / W + y / H) - 0.8); // bóng ở góc dưới-phải
    var i = (y * W + x) * 4, n = (rand() - 0.5) * 10;
    img.data[i] = c[0] * shade + n; img.data[i + 1] = c[1] * shade + n; img.data[i + 2] = c[2] * shade + n; img.data[i + 3] = 255;
  }
  return img;
}

var cases = [
  { name: 'nghiêng nhẹ', width: 1000, height: 750, shadow: 0.4, quad: [{ x: 260, y: 90 }, { x: 700, y: 120 }, { x: 740, y: 690 }, { x: 210, y: 660 }] },
  { name: 'phối cảnh mạnh', width: 900, height: 1200, shadow: 0.6, quad: [{ x: 300, y: 150 }, { x: 640, y: 160 }, { x: 820, y: 1100 }, { x: 80, y: 1080 }] },
  { name: 'xoay ~30°', width: 1200, height: 900, shadow: 0.2, quad: [{ x: 520, y: 100 }, { x: 900, y: 320 }, { x: 640, y: 780 }, { x: 260, y: 560 }] }
];

// Giấy tràn ra ngoài khung (mép trái + mép dưới) và có bảng kẻ đậm bên trong:
// phải nhận cả trang (phần nhìn thấy), không được nhận nhầm khung bảng.
function insideQuad(q, x, y) {
  var sg = 0;
  for (var i = 0; i < 4; i++) {
    var a = q[i], b = q[(i + 1) % 4], c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c) { var t = c > 0 ? 1 : -1; if (sg && t !== sg) return false; sg = t; }
  }
  return true;
}
function iou(A, B, w, h) {
  var I = 0, U = 0;
  for (var y = 0; y < h; y += 3) for (var x = 0; x < w; x += 3) {
    var a = insideQuad(A, x, y), b = insideQuad(B, x, y);
    if (a && b) I++; if (a || b) U++;
  }
  return I / U;
}
var outCases = [
  { name: 'tràn mép trái + dưới, có bảng', width: 900, height: 650, shadow: 0.3, table: true,
    quad: [{ x: -40, y: 95 }, { x: 700, y: 40 }, { x: 800, y: 1000 }, { x: -60, y: 1060 }] },
  { name: 'tràn mép dưới, có bảng', width: 1000, height: 750, shadow: 0.2, table: true,
    quad: [{ x: 190, y: 50 }, { x: 800, y: 70 }, { x: 870, y: 1000 }, { x: 120, y: 980 }] }
];

var failed = 0;
outCases.forEach(function (tc, k) {
  var img = makeScene(Object.assign({ seed: k + 21 }, tc));
  var det = DS.detectDocument(img), v = iou(det.corners, tc.quad, tc.width, tc.height);
  if (v > 0.95) console.log('✓ ' + tc.name + ': IoU ' + v.toFixed(3) + ', phương pháp ' + det.method);
  else { failed++; console.log('✗ ' + tc.name + ': IoU ' + v.toFixed(3) + ' (góc ' + JSON.stringify(det.corners.map(function (p) { return [Math.round(p.x), Math.round(p.y)]; })) + ')'); }
});

cases.forEach(function (tc, k) {
  try {
    var img = makeScene(Object.assign({ seed: k + 7 }, tc));
    var t = Date.now(), det = DS.detectDocument(img), ms = Date.now() - t;
    var err = Math.max.apply(null, det.corners.map(function (c, i) { return Math.hypot(c.x - tc.quad[i].x, c.y - tc.quad[i].y); }));
    assert.ok(det.found, 'không tìm thấy tờ giấy');
    var tol = Math.max(tc.width, tc.height) * 0.012;
    assert.ok(err < tol, 'sai số góc ' + err.toFixed(1) + 'px > ' + tol.toFixed(1) + 'px');

    var warped = DS.warpPerspective(img, det.corners);
    var magic = DS.enhance(warped, 'magic'), bw = DS.enhance(warped, 'bw');
    // nền giấy sau tăng cường phải gần trắng (đo ở vùng lề trống giữa trang, gần mép trái)
    var px = Math.round(warped.width * 0.05), py = Math.round(warped.height * 0.5), o = (py * warped.width + px) * 4;
    assert.ok(magic.data[o] > 235 && magic.data[o + 1] > 235, 'nền chưa trắng: ' + magic.data[o]);
    var black = 0;
    for (var i = 0; i < bw.data.length; i += 4) {
      assert.ok(bw.data[i] === 0 || bw.data[i] === 255, 'ảnh đen trắng phải nhị phân');
      if (bw.data[i] === 0) black++;
    }
    var ratio = black / (bw.width * bw.height);
    assert.ok(ratio > 0.03 && ratio < 0.4, 'tỉ lệ điểm đen bất thường: ' + ratio.toFixed(3));
    console.log('✓ ' + tc.name + ': sai số góc ' + err.toFixed(1) + 'px, ' + ms + ' ms, phương pháp ' + det.method);
  } catch (e) {
    failed++;
    console.log('✗ ' + tc.name + ': ' + e.message);
  }
});

// Ảnh không có tờ giấy → phải trả về khung mặc định, không lỗi
var blank = { data: new Uint8ClampedArray(400 * 300 * 4).fill(128), width: 400, height: 300 };
var d0 = DS.detectDocument(blank);
if (d0.found) { failed++; console.log('✗ ảnh trống: báo nhầm có giấy'); } else console.log('✓ ảnh trống: dùng khung mặc định');

// Tỉ lệ A4 phải được khôi phục khi nắn ảnh chụp thẳng
var size = DS.outputSize([{ x: 0, y: 0 }, { x: 210, y: 0 }, { x: 210, y: 297 }, { x: 0, y: 297 }]);
if (Math.abs(size.height / size.width - Math.SQRT2) > 0.01) { failed++; console.log('✗ tỉ lệ A4'); } else console.log('✓ tỉ lệ A4');

// ---------------------------------------------------------------------------
// Trang đã nắn phẳng (tổng hợp): dòng "chữ" có dấu phía trên (như tiếng Việt), vài dấu nặng phía dưới
// ---------------------------------------------------------------------------
function flatPage(W, H, opts) {
  opts = opts || {};
  var img = { data: new Uint8ClampedArray(W * H * 4).fill(255), width: W, height: H }, rand = rng(opts.seed || 3);
  function put(x, y, v) { if (x >= 0 && y >= 0 && x < W && y < H) { var i = (y * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; } }
  function rect(x0, y0, w, h, v) { for (var y = y0; y < y0 + h; y++) for (var x = x0; x < x0 + w; x++) put(x, y, v); }
  for (var y = 60; y < H - 80; y += 26) {
    for (var x = 50; x < W - 60;) {
      var wl = 3 + Math.floor(rand() * 4);                     // một "từ" gồm vài chữ cái
      for (var c = 0; c < wl && x < W - 60; c++, x += 10) {
        var tall = rand() < 0.3;
        rect(x, y + (tall ? 0 : 4), 7, tall ? 14 : 10, 25);    // thân chữ
        if (rand() < 0.45) rect(x + 2, y - 5, 3, 3, 25);        // dấu phía trên (sắc, huyền, mũ…)
        else if (rand() < 0.08) rect(x + 2, y + 17, 3, 3, 25);  // dấu nặng phía dưới
      }
      x += 12;
    }
  }
  return img;
}
function lum(img, x, y) { var i = (y * img.width + x) * 4; return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; }
function check(name, cond, detail) {
  if (cond) console.log('✓ ' + name + (detail ? ': ' + detail : ''));
  else { failed++; console.log('✗ ' + name + (detail ? ': ' + detail : '')); }
}

// Tự xoay: trang bị xoay 0/90/180/270 → phải trả về đúng góc xoay ngược lại
(function () {
  var page = flatPage(700, 990), res = [];
  [0, 90, 180, 270].forEach(function (rot) {
    var got = DS.detectOrientation(DS.rotateBy(page, rot));
    res.push(rot + '°→' + got + '°' + (got === (360 - rot) % 360 ? '' : ' (sai)'));
  });
  check('tự nhận hướng trang (xoay ngang / lộn ngược)', res.join(' ').indexOf('sai') < 0, res.join(', '));
})();

// Bóng đổ sắc + bóng mép: sau "Màu nét" nền phải trắng đều, chữ còn nguyên
(function () {
  var W = 700, H = 990, page = flatPage(W, H, { seed: 9 }), sh = { data: new Uint8ClampedArray(page.data), width: W, height: H };
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var f = 1;
    if (x + 0.6 * y > 900) f *= 0.6;                       // bóng tay/điện thoại, mép sắc
    if (x < 60) f *= 0.65 + 0.35 * x / 60;                  // bóng mép giấy
    var i = (y * W + x) * 4;
    sh.data[i] *= f; sh.data[i + 1] *= f * 0.97; sh.data[i + 2] *= f * 0.9;
  }
  var out = DS.enhance(sh, 'magic'), grayBg = 0, bgN = 0, txtKept = 0, txtN = 0;
  for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) {
    var orig = lum(page, x, y), o = lum(out, x, y);
    if (orig > 250) { bgN++; if (o < 235) grayBg++; } else { txtN++; if (o < 140) txtKept++; }
  }
  check('khử bóng đổ', grayBg / bgN < 0.01 && txtKept / txtN > 0.97,
    'nền còn xám ' + (100 * grayBg / bgN).toFixed(2) + '%, chữ giữ ' + (100 * txtKept / txtN).toFixed(1) + '%');
})();

// Lẹm góc: mảng nền tối ở góc + chữ sát mép → góc thành trắng, chữ còn
(function () {
  var W = 700, H = 990, page = flatPage(W, H, { seed: 4 }), x, y;
  for (y = 0; y < 70; y++) for (x = W - 70 + y; x < W; x++) { var i = (y * W + x) * 4; page.data[i] = 70; page.data[i + 1] = 60; page.data[i + 2] = 50; }
  var out = DS.enhance(page, 'magic'), dark = 0, n = 0, kept = 0, tn = 0, ref = flatPage(W, H, { seed: 4 });
  for (y = 0; y < 60; y++) for (x = W - 50; x < W; x++) { n++; if (lum(out, x, y) < 200) dark++; }
  for (y = 70; y < H; y++) for (x = 0; x < W; x++) if (lum(ref, x, y) < 100) { tn++; if (lum(out, x, y) < 140) kept++; }
  check('xoá lẹm góc', dark / n < 0.02 && kept / tn > 0.98, 'góc còn tối ' + (100 * dark / n).toFixed(1) + '%, chữ giữ ' + (100 * kept / tn).toFixed(1) + '%');
})();

// Tỉ lệ khổ giấy khi chụp nghiêng đối xứng (trước đây A4 bị co gần vuông)
(function () {
  function project(W, H, f, tiltDeg) { // camera lỗ kim nhìn tờ A4 nghiêng quanh trục ngang
    var t = tiltDeg * Math.PI / 180, pw = 0.21, ph = 0.297, dist = 0.5, cx = W / 2, cy = H / 2;
    return [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2]].map(function (p) {
      var Y = p[1] * Math.cos(t), Z = dist + p[1] * Math.sin(t);
      return { x: cx + f * p[0] / Z, y: cy + f * Y / Z };
    });
  }
  var res = [], bad = 0;
  [[30, 0.75], [45, 0.75], [55, 0.7], [45, 0.85]].forEach(function (c) {
    var q = project(1200, 1600, c[1] * 1600, c[0]), o = DS.outputSize(q, 2480, 1200, 1600);
    var r = o.width / o.height, err = Math.abs(r - 1 / Math.SQRT2) / (1 / Math.SQRT2);
    if (err > 0.03) bad++;
    res.push('nghiêng ' + c[0] + '°: ' + r.toFixed(3));
  });
  check('tỉ lệ A4 khi chụp nghiêng', !bad, res.join(', ') + ' (A4 = 0.707)');
})();

if (failed) { console.log(failed + ' kiểm thử thất bại'); process.exit(1); }
console.log('Tất cả kiểm thử đều đạt');

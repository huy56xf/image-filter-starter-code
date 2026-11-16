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

var failed = 0;
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

if (failed) { console.log(failed + ' kiểm thử thất bại'); process.exit(1); }
console.log('Tất cả kiểm thử đều đạt');

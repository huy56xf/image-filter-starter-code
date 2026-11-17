/*
 * scanner-core.js — Lõi xử lý ảnh cho ứng dụng quét tài liệu (kiểu CamScanner).
 *
 * Viết bằng JavaScript thuần, không phụ thuộc thư viện nào, nên chạy được cả
 * trong trình duyệt (window.DocScanner) lẫn Node.js (require).
 *
 * Ảnh được biểu diễn dạng { data: Uint8ClampedArray RGBA, width, height }
 * (giống ImageData của canvas / bitmap của Jimp).
 *
 * Quy trình:
 *   1. detectDocument()   – tìm 4 góc tờ giấy trong ảnh
 *        thu nhỏ → xám → Gaussian blur → Canny → giãn biên
 *        → sinh ứng viên (vùng kín bởi biên, thành phần biên, ngưỡng Otsu)
 *        → bao lồi → tứ giác diện tích lớn nhất → chấm điểm theo độ bám biên
 *        → tinh chỉnh từng cạnh bằng cách khớp đường thẳng (least squares)
 *   2. warpPerspective()  – nắn phối cảnh (homography 3x3) về hình chữ nhật
 *   3. enhance()          – làm phẳng ánh sáng (chia cho nền ước lượng),
 *        tăng tương phản; các chế độ: original / magic / gray / bw
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocScanner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tiện ích cơ bản
  // ---------------------------------------------------------------------------

  function createImage(width, height) {
    return { data: new Uint8ClampedArray(width * height * 4), width: width, height: height };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** RGBA -> mảng xám Float32 (luma BT.601). */
  function toGray(img) {
    var n = img.width * img.height, d = img.data, g = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return g;
  }

  /** Thu nhỏ ảnh RGBA bằng trung bình vùng (area averaging) – chống răng cưa. */
  function downscale(img, maxSide) {
    var w = img.width, h = img.height, s = Math.min(1, maxSide / Math.max(w, h));
    if (s >= 1) return { image: img, scale: 1 };
    var nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
    var out = createImage(nw, nh), sd = img.data, od = out.data;
    var fx = w / nw, fy = h / nh;
    for (var y = 0; y < nh; y++) {
      var y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      for (var x = 0; x < nw; x++) {
        var x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
        var r = 0, g = 0, b = 0, a = 0, c = 0;
        for (var yy = y0; yy < y1; yy++) {
          var p = (yy * w + x0) * 4;
          for (var xx = x0; xx < x1; xx++, p += 4) { r += sd[p]; g += sd[p + 1]; b += sd[p + 2]; a += sd[p + 3]; c++; }
        }
        var o = (y * nw + x) * 4;
        od[o] = r / c; od[o + 1] = g / c; od[o + 2] = b / c; od[o + 3] = a / c;
      }
    }
    return { image: out, scale: nw / w };
  }

  /** Gaussian blur tách được (separable) cho mảng 1 kênh. */
  function gaussianBlur(src, w, h, sigma) {
    var r = Math.max(1, Math.ceil(sigma * 2.5)), k = new Float32Array(2 * r + 1), sum = 0, i;
    for (i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
    for (i = 0; i < k.length; i++) k[i] /= sum;
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, acc;
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        acc = 0;
        for (i = -r; i <= r; i++) acc += src[row + clamp(x + i, 0, w - 1)] * k[i + r];
        tmp[row + x] = acc;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        acc = 0;
        for (i = -r; i <= r; i++) acc += tmp[clamp(y + i, 0, h - 1) * w + x] * k[i + r];
        out[y * w + x] = acc;
      }
    }
    return out;
  }

  /** Box blur nhanh bằng ảnh tích phân (integral image). */
  function boxBlur(src, w, h, radius) {
    var W = w + 1, ii = new Float64Array(W * (h + 1)), x, y;
    for (y = 0; y < h; y++) {
      var rs = 0;
      for (x = 0; x < w; x++) { rs += src[y * w + x]; ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + rs; }
    }
    var out = new Float32Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
        var s = ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
        out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
      }
    }
    return out;
  }

  /** Lọc max (giãn – dilation) tách được, bán kính r. */
  function maxFilter(src, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, i, m;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      m = -Infinity;
      for (i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) if (src[y * w + i] > m) m = src[y * w + i];
      tmp[y * w + x] = m;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      m = -Infinity;
      for (i = Math.max(0, y - r); i <= Math.min(h - 1, y + r); i++) if (tmp[i * w + x] > m) m = tmp[i * w + x];
      out[y * w + x] = m;
    }
    return out;
  }

  /** Lọc min (co – erosion) = -max(-x). */
  function minFilter(src, w, h, r) {
    var neg = new Float32Array(src.length), i;
    for (i = 0; i < src.length; i++) neg[i] = -src[i];
    var m = maxFilter(neg, w, h, r);
    for (i = 0; i < m.length; i++) m[i] = -m[i];
    return m;
  }

  /**
   * Phép đóng (closing) trên ảnh xám: max rồi min. Xoá các nét tối mảnh hơn ~2r
   * (chữ, đường kẻ bảng, dấu mộc) nhưng giữ nguyên các vùng lớn như tờ giấy và vị trí mép của nó.
   */
  function grayClosing(g, w, h, r) { return minFilter(maxFilter(g, w, h, r), w, h, r); }

  function percentile(arr, p) {
    // histogram-based percentile for values in [0, maxV]
    var maxV = 0, i, n = arr.length;
    for (i = 0; i < n; i++) if (arr[i] > maxV) maxV = arr[i];
    if (maxV === 0) return 0;
    var bins = 1024, hist = new Uint32Array(bins), f = (bins - 1) / maxV;
    for (i = 0; i < n; i++) hist[(arr[i] * f) | 0]++;
    var target = p * n, acc = 0;
    for (i = 0; i < bins; i++) { acc += hist[i]; if (acc >= target) return i / f; }
    return maxV;
  }

  function otsu(gray) {
    var hist = new Float64Array(256), n = gray.length, i;
    for (i = 0; i < n; i++) hist[clamp(gray[i] | 0, 0, 255)]++;
    var sumAll = 0; for (i = 0; i < 256; i++) sumAll += i * hist[i];
    var wB = 0, sumB = 0, best = 0, thr = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = n - wB; if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    return thr;
  }

  // ---------------------------------------------------------------------------
  // Canny edge detector
  // ---------------------------------------------------------------------------

  function sobel(g, w, h) {
    var gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
        var sx = (c + 2 * f + r) - (a + 2 * d + p);
        var sy = (p + 2 * q + r) - (a + 2 * b + c);
        gx[i] = sx; gy[i] = sy; mag[i] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    return { gx: gx, gy: gy, mag: mag };
  }

  function canny(grad, w, h, low, high) {
    var gx = grad.gx, gy = grad.gy, mag = grad.mag;
    var nms = new Uint8Array(w * h); // 0 none, 1 weak, 2 strong
    var t22 = Math.tan(Math.PI / 8), t67 = Math.tan(3 * Math.PI / 8);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x, m = mag[i];
        if (m < low) continue;
        var ax = Math.abs(gx[i]), ay = Math.abs(gy[i]), n1, n2;
        if (ay <= ax * t22) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
        else if (ay >= ax * t67) { n1 = mag[i - w]; n2 = mag[i + w]; }
        else if ((gx[i] > 0) === (gy[i] > 0)) { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }
        else { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }
        if (m >= n1 && m > n2) nms[i] = m >= high ? 2 : 1;
      }
    }
    // hysteresis
    var out = new Uint8Array(w * h), stack = new Int32Array(w * h), sp = 0;
    for (var k = 0; k < w * h; k++) if (nms[k] === 2) { out[k] = 1; stack[sp++] = k; }
    while (sp > 0) {
      var cur = stack[--sp], cx = cur % w, cy = (cur / w) | 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var j = ny * w + nx;
        if (!out[j] && nms[j] === 1) { out[j] = 1; stack[sp++] = j; }
      }
    }
    return out;
  }

  function dilateBinary(bin, w, h, r) {
    var f = new Float32Array(w * h);
    for (var i = 0; i < f.length; i++) f[i] = bin[i];
    var m = maxFilter(f, w, h, r), out = new Uint8Array(w * h);
    for (i = 0; i < out.length; i++) out[i] = m[i] > 0 ? 1 : 0;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Thành phần liên thông + hình học
  // ---------------------------------------------------------------------------

  /**
   * Gán nhãn thành phần liên thông (4-neighbour) cho các pixel có mask[i] === value.
   * Trả về danh sách thành phần: bbox, diện tích, điểm biên trái/phải theo từng hàng
   * (đủ để tính bao lồi), cờ chạm viền ảnh.
   */
  function components(mask, w, h, value, minArea) {
    var labels = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [], id = 0;
    for (var s = 0; s < w * h; s++) {
      if (mask[s] !== value || labels[s]) continue;
      id++;
      var sp = 0, area = 0, minX = w, maxX = 0, minY = h, maxY = 0, touches = false;
      var rowMin = {}, rowMax = {};
      stack[sp++] = s; labels[s] = id;
      while (sp > 0) {
        var p = stack[--sp], x = p % w, y = (p / w) | 0;
        area++;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
        if (rowMin[y] === undefined || x < rowMin[y]) rowMin[y] = x;
        if (rowMax[y] === undefined || x > rowMax[y]) rowMax[y] = x;
        if (x > 0 && mask[p - 1] === value && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] === value && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] === value && !labels[p - w]) { labels[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] === value && !labels[p + w]) { labels[p + w] = id; stack[sp++] = p + w; }
      }
      if ((maxX - minX + 1) * (maxY - minY + 1) < minArea) continue;
      var pts = [];
      for (var key in rowMin) {
        var yy = +key;
        pts.push({ x: rowMin[key], y: yy }, { x: rowMax[key] + 1, y: yy }, { x: rowMin[key], y: yy + 1 }, { x: rowMax[key] + 1, y: yy + 1 });
      }
      comps.push({ area: area, minX: minX, maxX: maxX, minY: minY, maxY: maxY, touches: touches, points: pts });
    }
    return comps;
  }

  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

  /** Bao lồi – thuật toán Andrew monotone chain. */
  function convexHull(points) {
    var pts = points.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    if (pts.length < 3) return pts;
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function polygonArea(poly) {
    var a = 0;
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i], q = poly[(i + 1) % poly.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  /** Đơn giản hoá đa giác khép kín bằng Douglas–Peucker. */
  function simplifyClosed(poly, eps) {
    if (poly.length <= 4) return poly;
    function dp(pts, a, b, keep) {
      var maxD = 0, idx = -1, A = pts[a], B = pts[b];
      var dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      for (var i = a + 1; i < b; i++) {
        var d = Math.abs(dy * (pts[i].x - A.x) - dx * (pts[i].y - A.y)) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) { dp(pts, a, idx, keep); keep[idx] = true; dp(pts, idx, b, keep); }
    }
    // chia đa giác tại điểm xa nhất so với điểm 0
    var far = 0, fd = -1;
    for (var i = 1; i < poly.length; i++) {
      var d = (poly[i].x - poly[0].x) * (poly[i].x - poly[0].x) + (poly[i].y - poly[0].y) * (poly[i].y - poly[0].y);
      if (d > fd) { fd = d; far = i; }
    }
    var keep = []; keep[0] = true; keep[far] = true;
    dp(poly, 0, far, keep);
    var ring = poly.slice(far).concat([poly[0]]), keep2 = [];
    dp(ring, 0, ring.length - 1, keep2);
    var out = [];
    for (i = 0; i <= far; i++) if (keep[i]) out.push(poly[i]);
    for (i = 1; i < ring.length - 1; i++) if (keep2[i]) out.push(ring[i]);
    return out;
  }

  /** Tứ giác có diện tích lớn nhất với đỉnh nằm trên đa giác lồi (O(n^3)). */
  function maxAreaQuad(hull) {
    var n = hull.length;
    if (n < 4) return null;
    var best = -1, bq = null;
    function tri(a, b, c) { return Math.abs(cross(hull[a], hull[b], hull[c])) / 2; }
    for (var i = 0; i < n; i++) {
      for (var k = i + 2; k < n; k++) {
        if (i === 0 && k === n - 1) continue;
        var bj = -1, bjv = -1, bl = -1, blv = -1, j, l, v;
        for (j = i + 1; j < k; j++) { v = tri(i, j, k); if (v > bjv) { bjv = v; bj = j; } }
        for (l = k + 1; l < n + i; l++) { v = tri(k, l % n, i); if (v > blv) { blv = v; bl = l % n; } }
        if (bj < 0 || bl < 0) continue;
        if (bjv + blv > best) { best = bjv + blv; bq = [hull[i], hull[bj], hull[k], hull[bl]]; }
      }
    }
    return bq;
  }

  /** Sắp xếp 4 góc theo thứ tự: trên-trái, trên-phải, dưới-phải, dưới-trái. */
  function orderCorners(pts) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= 4; cy /= 4;
    var s = pts.map(function (p) { return { x: p.x, y: p.y, a: Math.atan2(p.y - cy, p.x - cx) }; });
    s.sort(function (a, b) { return a.a - b.a; }); // theo chiều kim đồng hồ (trục y hướng xuống)
    // điểm trên-trái = điểm có x+y nhỏ nhất
    var start = 0, bestSum = Infinity;
    for (i = 0; i < 4; i++) if (s[i].x + s[i].y < bestSum) { bestSum = s[i].x + s[i].y; start = i; }
    var out = [];
    for (i = 0; i < 4; i++) { var p = s[(start + i) % 4]; out.push({ x: p.x, y: p.y }); }
    return out;
  }

  function isConvexQuad(q) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
      if (Math.abs(c) < 1e-9) return false;
      var s = c > 0 ? 1 : -1;
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  function minInteriorAngleCos(q) {
    // trả về |cos| lớn nhất của các góc trong (gần 1 = góc quá nhọn/quá tù)
    var worst = 0;
    for (var i = 0; i < 4; i++) {
      var p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      var ax = p.x - c.x, ay = p.y - c.y, bx = n.x - c.x, by = n.y - c.y;
      var cos = (ax * bx + ay * by) / (Math.sqrt(ax * ax + ay * ay) * Math.sqrt(bx * bx + by * by) || 1);
      worst = Math.max(worst, Math.abs(cos));
    }
    return worst;
  }

  // ---------------------------------------------------------------------------
  // Chấm điểm & tinh chỉnh tứ giác
  // ---------------------------------------------------------------------------

  /**
   * Độ bám biên của một cạnh: tỉ lệ điểm lấy mẫu trên cạnh mà ở gần đó (±band px
   * theo pháp tuyến) có gradient vuông góc với cạnh đủ mạnh.
   */
  // Cạnh nằm trùng mép khung hình = tờ giấy tràn ra ngoài ảnh (xem borderPaperSupport).
  function borderTol(w, h) { return Math.max(1.5, Math.max(w, h) * 0.004); }

  /** Trả về đường biên ảnh (dạng điểm + hướng) nếu đoạn AB nằm trên mép ảnh, ngược lại null. */
  function borderSide(A, B, w, h) {
    var t = borderTol(w, h);
    if (Math.abs(A.x) <= t && Math.abs(B.x) <= t) return { px: 0, py: 0, dx: 0, dy: 1 };
    if (Math.abs(A.x - (w - 1)) <= t && Math.abs(B.x - (w - 1)) <= t) return { px: w - 1, py: 0, dx: 0, dy: 1 };
    if (Math.abs(A.y) <= t && Math.abs(B.y) <= t) return { px: 0, py: 0, dx: 1, dy: 0 };
    if (Math.abs(A.y - (h - 1)) <= t && Math.abs(B.y - (h - 1)) <= t) return { px: 0, py: h - 1, dx: 1, dy: 0 };
    return null;
  }

  function borderLines(w, h) {
    return [
      { t: 0, rho: 0, c: 1, s: 0, border: true }, { t: 0, rho: w - 1, c: 1, s: 0, border: true },
      { t: 90, rho: 0, c: 0, s: 1, border: true }, { t: 90, rho: h - 1, c: 0, s: 1, border: true }
    ];
  }

  /**
   * Mức độ (0..1) cạnh AB là một ĐƯỜNG KẺ trên giấy (vd. khung bảng) chứ không phải MÉP GIẤY.
   * Lấy trung bình mặt cắt độ sáng vuông góc với cạnh dọc suốt chiều dài:
   *   đường kẻ → sáng | tối | sáng, hai bên gần bằng nhau;
   *   mép giấy → dạng bậc: một bên giấy, một bên nền.
   * Trung bình hoá giúp bỏ qua chữ nằm sát hay nền có hoa văn.
   */
  function ruledFraction(gray, w, h, A, B) {
    var dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 8) return 0;
    var nx = -dy / len, ny = dx / len, d = Math.max(6, Math.round(Math.max(w, h) / 70)), R = 2 * d;
    var sum = new Float64Array(2 * R + 1), cnt = new Uint32Array(2 * R + 1), aSum = 0, bSum = 0, abN = 0;
    function g(px, py, o) {
      var x = Math.round(px + nx * o), y = Math.round(py + ny * o);
      return x < 0 || y < 0 || x >= w || y >= h ? -1 : gray[y * w + x];
    }
    for (var k = 1; k < 48; k++) {
      var t = k / 48, px = A.x + dx * t, py = A.y + dy * t, o;
      // căn tâm theo điểm tối nhất trong ±3px (cạnh có thể hơi lệch góc so với nét kẻ)
      var c0 = 0, cv = 256;
      for (o = -3; o <= 3; o++) { var v0 = g(px, py, o); if (v0 >= 0 && v0 < cv) { cv = v0; c0 = o; } }
      var am = -1, bm = -1;
      for (o = -R; o <= R; o++) {
        var v = g(px, py, o + c0);
        if (v < 0) continue;
        sum[o + R] += v; cnt[o + R]++;
        // nền mỗi bên = điểm sáng nhất trong [d, 2d] → không bị chữ dày đặc kéo tối
        if (o >= d && v > am) am = v;
        if (o <= -d && v > bm) bm = v;
      }
      if (am >= 0 && bm >= 0) { aSum += am; bSum += bm; abN++; }
    }
    function P(o) { return cnt[o + R] ? sum[o + R] / cnt[o + R] : -1; }
    if (!abN) return 0;
    var a = aSum / abN, b = bSum / abN, c = 255, o2;
    for (o2 = -1; o2 <= 1; o2++) if (P(o2) >= 0 && P(o2) < c) c = P(o2);
    var ridge = Math.min(a, b) - c, step = Math.abs(a - b);
    if (ridge < 12 || step > 0.15 * Math.max(a, b)) return 0;
    return clamp((ridge - 1.5 * step) / 30, 0, 1);
  }

  /**
   * Điểm cho cạnh nằm trên mép khung hình: tỉ lệ điểm ngay phía trong mép trông như
   * giấy (sáng gần bằng giấy, ít màu). Giấy tràn ra ngoài ảnh → cao; nền rối, màu → thấp.
   */
  function borderPaperSupport(ctx, A, B, q) {
    var w = ctx.w, h = ctx.h, d = ctx.rgba, cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += q[i].x / 4; cy += q[i].y / 4; }
    var dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len, mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; } // hướng vào trong tứ giác
    var off = Math.max(3, Math.round(Math.max(w, h) / 80)), win = Math.max(2, Math.round(Math.max(w, h) / 120)), n = 0, ok = 0;
    for (var k = 1; k < 40; k++) {
      var t = k / 40, x = Math.round(A.x + dx * t + nx * off), y = Math.round(A.y + dy * t + ny * off);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      // ô nhỏ quanh điểm: đa số điểm là nền giấy (sáng, ít màu) thì coi là giấy;
      // chữ/nét kẻ chỉ chiếm phần nhỏ, còn nền sọc/hoa văn thì không đạt
      var good = 0, tot = 0;
      for (var yy = Math.max(0, y - win); yy <= Math.min(h - 1, y + win); yy++) {
        for (var xx = Math.max(0, x - win); xx <= Math.min(w - 1, x + win); xx++) {
          var jj = (yy * w + xx) * 4, r = d[jj], g = d[jj + 1], b = d[jj + 2];
          var L = 0.299 * r + 0.587 * g + 0.114 * b, sat = Math.max(r, g, b) - Math.min(r, g, b);
          tot++;
          if (L >= ctx.paperRef * 0.72 && sat < 45) good++;
        }
      }
      n++;
      if (good >= 0.6 * tot) ok++;
    }
    return n ? 0.6 * ok / n : 0;
  }

  /** Điểm của cạnh thứ k của tứ giác q (dùng chung cho chấm nhanh Hough và chấm đầy đủ). */
  function sideScore(ctx, q, k, band, stepLen) {
    var A = q[k], B = q[(k + 1) % 4];
    // nhiều tứ giác Hough dùng chung một cạnh → nhớ kết quả (cạnh trên mép ảnh phụ thuộc
    // hướng vào trong nên thêm tâm tứ giác vào khoá)
    var key = Math.round(A.x * 2) + ',' + Math.round(A.y * 2) + ',' + Math.round(B.x * 2) + ',' + Math.round(B.y * 2) + ',' + band + ',' + (stepLen || 0);
    if (borderSide(A, B, ctx.w, ctx.h)) key += ',' + Math.round((q[0].x + q[2].x) / 8) + ',' + Math.round((q[0].y + q[2].y) / 8);
    if (!ctx.cache) ctx.cache = {};
    var hit = ctx.cache[key];
    if (hit) return hit;
    return (ctx.cache[key] = sideScoreRaw(ctx, q, A, B, band, stepLen));
  }

  function sideScoreRaw(ctx, q, A, B, band, stepLen) {
    if (borderSide(A, B, ctx.w, ctx.h)) return { s: borderPaperSupport(ctx, A, B, q), border: true };
    var s = sideSupport(ctx.grad, ctx.w, ctx.h, A, B, ctx.thr, band, stepLen);
    s *= 1 - 0.7 * ruledFraction(ctx.gray, ctx.w, ctx.h, A, B); // đường kẻ bảng ≠ mép giấy
    // ảnh đã xoá chữ: mép giấy mờ vẫn rõ, đường kẻ/chữ đã biến mất
    // (hệ số 0.9: khi hoà, ưu tiên cạnh khớp biên ảnh gốc vì chính xác hơn ảnh đã làm mờ)
    if (ctx.gradC) s = Math.max(s, 0.9 * sideSupport(ctx.gradC, ctx.w, ctx.h, A, B, ctx.thrC, band, stepLen));
    return { s: s, border: false };
  }

  function sideSupport(grad, w, h, A, B, thr, band, stepLen) {
    var dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 4) return 0;
    // Mép giấy có "cực" nhất quán (giấy luôn sáng hơn / tối hơn nền dọc theo cả cạnh),
    // còn dòng chữ hay hoa văn cho gradient đổi dấu liên tục → đếm riêng 2 dấu.
    var nx = -dy / len, ny = dx / len, steps = Math.max(8, Math.round(len / (stepLen || 1.5)));
    var pos = 0, neg = 0, total = 0;
    for (var s = 1; s < steps; s++) {
      var t = s / steps, px = A.x + dx * t, py = A.y + dy * t, bestP = 0, bestN = 0;
      for (var o = -band; o <= band; o++) {
        var x = Math.round(px + nx * o), y = Math.round(py + ny * o);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        var i = y * w + x, proj = grad.gx[i] * nx + grad.gy[i] * ny;
        if (proj > bestP) bestP = proj; else if (-proj > bestN) bestN = -proj;
      }
      total++;
      if (bestP >= thr) pos++;
      if (bestN >= thr) neg++;
    }
    return total ? Math.max(pos, neg) / total : 0;
  }

  // ---------------------------------------------------------------------------
  // Biến đổi Hough – tìm các đường thẳng dài (ứng viên cho 4 cạnh tờ giấy)
  // ---------------------------------------------------------------------------

  function houghLines(edges, w, h) {
    var nT = 180, diag = Math.ceil(Math.sqrt(w * w + h * h)), nR = 2 * diag + 1;
    var acc = new Uint32Array(nT * nR), cosT = new Float32Array(nT), sinT = new Float32Array(nT), t, x, y;
    for (t = 0; t < nT; t++) { cosT[t] = Math.cos(t * Math.PI / nT); sinT[t] = Math.sin(t * Math.PI / nT); }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!edges[y * w + x]) continue;
      for (t = 0; t < nT; t++) acc[t * nR + Math.round(x * cosT[t] + y * sinT[t]) + diag]++;
    }
    var minVotes = Math.min(w, h) * 0.12, peaks = [];
    for (t = 0; t < nT; t++) for (var r = 1; r < nR - 1; r++) {
      var v = acc[t * nR + r];
      if (v < minVotes) continue;
      var isMax = true;
      for (var dt = -3; dt <= 3 && isMax; dt++) for (var dr = -6; dr <= 6; dr++) {
        if (!dt && !dr) continue;
        var tt = t + dt, rr = r + dr;
        if (tt < 0) { tt += nT; rr = 2 * diag - rr; } else if (tt >= nT) { tt -= nT; rr = 2 * diag - rr; }
        if (rr < 0 || rr >= nR) continue;
        var u = acc[tt * nR + rr];
        if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
      }
      if (isMax) peaks.push({ t: t, rho: r - diag, votes: v, c: cosT[t], s: sinT[t] });
    }
    // giữ tối đa 4 đường mạnh nhất cho mỗi nhóm góc 15° → đa dạng hướng
    peaks.sort(function (a, b) { return b.votes - a.votes; });
    var perBucket = {}, out = [];
    peaks.forEach(function (p) {
      var bkt = Math.floor(p.t / 15);
      perBucket[bkt] = (perBucket[bkt] || 0) + 1;
      if (perBucket[bkt] <= 4 && out.length < 40) out.push(p);
    });
    return out;
  }

  function intersectLines(a, b) {
    var den = a.c * b.s - a.s * b.c;
    if (Math.abs(den) < 1e-6) return null;
    return { x: (a.rho * b.s - b.rho * a.s) / den, y: (a.c * b.rho - b.c * a.rho) / den };
  }

  function angleDiff(a, b) { var d = Math.abs(a.t - b.t) % 180; return Math.min(d, 180 - d); }

  /** Ghép 2 cặp đường gần song song thành tứ giác, giữ lại các tứ giác điểm cao nhất. */
  function houghQuads(lines, ctx, keep) {
    var grad = ctx.grad, w = ctx.w, h = ctx.h;
    lines = lines.concat(borderLines(w, h));
    var pairs = [], i, j, minSep = Math.min(w, h) * 0.15, cx = w / 2, cy = h / 2;
    for (i = 0; i < lines.length; i++) for (j = i + 1; j < lines.length; j++) {
      if (angleDiff(lines[i], lines[j]) > 25) continue;
      var di = lines[i].c * cx + lines[i].s * cy - lines[i].rho, dj = lines[j].c * cx + lines[j].s * cy - lines[j].rho;
      // so sánh khoảng cách có dấu tới tâm ảnh (chỉnh hướng nếu 2 pháp tuyến ngược chiều)
      if (lines[i].c * lines[j].c + lines[i].s * lines[j].s < 0) dj = -dj;
      if (Math.abs(di - dj) < minSep) continue;
      pairs.push([lines[i], lines[j]]);
    }
    var mx = w * 0.03, my = h * 0.03, results = [];
    for (i = 0; i < pairs.length; i++) for (j = i + 1; j < pairs.length; j++) {
      var A = pairs[i], B = pairs[j];
      if (angleDiff(A[0], B[0]) < 50) continue;
      var pts = [intersectLines(A[0], B[0]), intersectLines(B[0], A[1]), intersectLines(A[1], B[1]), intersectLines(B[1], A[0])];
      var ok = true;
      for (var k = 0; k < 4 && ok; k++) {
        var p = pts[k];
        if (!p || p.x < -mx || p.y < -my || p.x > w - 1 + mx || p.y > h - 1 + my) ok = false;
      }
      if (!ok) continue;
      var q = orderCorners(pts);
      if (!isConvexQuad(q) || polygonArea(q) < w * h * 0.08 || minInteriorAngleCos(q) > 0.8) continue;
      var nb = (A[0].border ? 1 : 0) + (A[1].border ? 1 : 0) + (B[0].border ? 1 : 0) + (B[1].border ? 1 : 0);
      var sup = 0, minS = 1;
      for (k = 0; k < 4; k++) {
        var s = sideScore(ctx, q, k, 1, 4).s;
        sup += s; if (s < minS) minS = s;
      }
      results.push({ quad: q, quick: (sup / 4) * 0.6 + minS * 0.4 + 0.2 * Math.sqrt(polygonArea(q) / (w * h)) });
    }
    results.sort(function (a, b) { return b.quick - a.quick; });
    return results.slice(0, keep);
  }

  function scoreQuad(q, ctx) {
    var w = ctx.w, h = ctx.h;
    if (!isConvexQuad(q)) return null;
    var area = polygonArea(q), frac = area / (w * h);
    if (frac < 0.08) return null;
    if (minInteriorAngleCos(q) > 0.8) return null; // góc < ~37° hoặc > ~143°
    var sup = [], band = Math.max(2, Math.round(Math.max(w, h) / 160)), nBorder = 0;
    for (var i = 0; i < 4; i++) {
      var r = sideScore(ctx, q, i, band);
      if (r.border) nBorder++;
      sup.push(r.s);
    }
    var minS = Math.min.apply(null, sup), mean = (sup[0] + sup[1] + sup[2] + sup[3]) / 4;
    var score = (0.6 * mean + 0.4 * minS) * (0.55 + 0.45 * Math.sqrt(Math.min(frac, 0.95)));
    if (nBorder >= 3) score *= 0.9; // giấy phủ gần hết / kín khung hình
    return { quad: q, score: score, support: sup, minSupport: minS, areaFrac: frac, borderSides: nBorder };
  }

  /**
   * Tinh chỉnh: với mỗi cạnh, gom các điểm có gradient vuông góc mạnh trong dải
   * gần cạnh, khớp đường thẳng bằng PCA (tổng bình phương khoảng cách vuông góc),
   * rồi lấy giao điểm 2 cạnh kề làm góc mới.
   */
  function refineQuad(q, grad, w, h, thr, maxShift) {
    var lines = [], band = Math.max(3, Math.round(Math.max(w, h) / (maxShift ? 1 / maxShift : 100)));
    for (var s = 0; s < 4; s++) {
      var A = q[s], B = q[(s + 1) % 4], dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx * dx + dy * dy);
      var bl = borderSide(A, B, w, h);
      if (bl) { lines.push(bl); continue; }
      var nx = -dy / len, ny = dx / len, steps = Math.round(len), pts = [], k, t, px, py, o, x, y, i;
      // Xác định "cực" của mép (nền→giấy sáng lên hay tối đi) ngay sát đường ban đầu,
      // để không bị hút sang mép của tiêu đề/khung bảng nằm gần mép giấy (cực ngược lại).
      var sgn = 0;
      for (k = 0; k <= 40; k++) {
        t = 0.1 + 0.8 * k / 40; px = A.x + dx * t; py = A.y + dy * t;
        for (o = -2; o <= 2; o++) {
          x = Math.round(px + nx * o); y = Math.round(py + ny * o);
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          i = y * w + x; sgn += grad.gx[i] * nx + grad.gy[i] * ny;
        }
      }
      sgn = sgn >= 0 ? 1 : -1;
      for (k = 0; k <= steps; k++) {
        t = 0.06 + 0.88 * k / steps; px = A.x + dx * t; py = A.y + dy * t;
        var bestV = 0, bp = null;
        for (o = -band; o <= band; o++) {
          x = Math.round(px + nx * o); y = Math.round(py + ny * o);
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          i = y * w + x;
          var v = sgn * (grad.gx[i] * nx + grad.gy[i] * ny);
          if (v < thr) continue;
          v *= 1 - 0.5 * Math.abs(o) / (band + 1); // ưu tiên điểm gần đường ban đầu
          if (v > bestV) { bestV = v; bp = { x: px + nx * o, y: py + ny * o }; }
        }
        if (bp) pts.push(bp);
      }
      if (pts.length < Math.max(8, steps * 0.3)) { lines.push(null); continue; }
      var mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0;
      pts.forEach(function (p) { mx += p.x; my += p.y; }); mx /= pts.length; my /= pts.length;
      pts.forEach(function (p) { var a = p.x - mx, b = p.y - my; sxx += a * a; syy += b * b; sxy += a * b; });
      var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      var ldx = Math.cos(ang), ldy = Math.sin(ang);
      // không cho đường khớp lệch quá nhiều so với cạnh ban đầu
      if (Math.abs(ldx * dx / len + ldy * dy / len) < Math.cos(8 * Math.PI / 180)) { lines.push(null); continue; }
      lines.push({ px: mx, py: my, dx: ldx, dy: ldy });
    }
    var out = [];
    for (var c = 0; c < 4; c++) {
      var L1 = lines[(c + 3) % 4], L2 = lines[c], P = null;
      if (L1 && L2) {
        var den = L1.dx * L2.dy - L1.dy * L2.dx;
        if (Math.abs(den) > 1e-6) {
          var tt = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / den;
          P = { x: L1.px + L1.dx * tt, y: L1.py + L1.dy * tt };
          var dd = Math.hypot(P.x - q[c].x, P.y - q[c].y);
          if (dd > Math.max(w, h) * (maxShift ? maxShift * 1.5 : 0.08)) P = null;
        }
      }
      out.push(P || { x: q[c].x, y: q[c].y });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 1) Nhận diện tờ giấy
  // ---------------------------------------------------------------------------

  /**
   * Tìm 4 góc tài liệu.
   * @returns {{corners: Array<{x,y}>, confidence: number, found: boolean, method: string}}
   *   corners theo toạ độ ảnh gốc, thứ tự TL, TR, BR, BL.
   */
  function detectDocument(img, opts) {
    opts = opts || {};
    var procSize = opts.procSize || 480;
    var ds = downscale(img, procSize), small = ds.image, sc = ds.scale;
    var w = small.width, h = small.height, minArea = w * h * 0.08;
    var rawGray = toGray(small);
    var gray = gaussianBlur(rawGray, w, h, 1.4);
    var grad = sobel(gray, w, h);

    // Ngưỡng gradient tự động theo phân vị
    var hi = Math.max(40, percentile(grad.mag, 0.9)), lo = hi * 0.4;
    var supportThr = Math.max(25, percentile(grad.mag, 0.75) * 0.8);

    // Nhánh "xoá chữ": closing → làm mượt → gradient. Biên còn lại chủ yếu là mép giấy.
    var closeR = Math.max(2, Math.round(Math.max(w, h) / 100));
    var closedRaw = grayClosing(rawGray, w, h, closeR);
    var grayC = gaussianBlur(closedRaw, w, h, 2);
    var gradC = sobel(grayC, w, h);
    var hiC = Math.max(16, percentile(gradC.mag, 0.92)), loC = hiC * 0.4;
    var thrC = Math.max(12, hiC * 0.45);

    var candidates = [];
    var sctx = { grad: grad, gray: rawGray, rgba: small.data, w: w, h: h, thr: supportThr, paperRef: percentile(rawGray, 0.92),
                 gradC: gradC, thrC: thrC };
    function addFromComp(c, tag) {
      var hull = convexHull(c.points);
      if (hull.length < 4) return;
      var hullArea = polygonArea(hull);
      if (hullArea < minArea) return;
      var simp = hull, eps = 1;
      while (simp.length > 40) { simp = simplifyClosed(hull, eps); eps *= 1.5; }
      var q = maxAreaQuad(simp);
      if (!q) return;
      q = orderCorners(q);
      var fit = polygonArea(q) / hullArea; // ~1 nếu vùng thực sự là tứ giác
      if (fit < 0.8) return;
      candidates.push({ quad: q, tag: tag, fit: fit });
    }

    // (a) nhiều mức ngưỡng Canny → (i) vùng kín bởi biên, (ii) thành phần biên
    var houghEdges = null;
    [[1, 1], [0.6, 2], [1.6, 1]].forEach(function (cfg) {
      var edges = canny(grad, w, h, lo * cfg[0], hi * cfg[0]);
      if (!houghEdges) houghEdges = edges;
      var dil = dilateBinary(edges, w, h, cfg[1]);
      components(dil, w, h, 0, minArea).forEach(function (c) {
        if (!c.touches && c.area > minArea * 0.5) addFromComp(c, 'region');
      });
      components(dil, w, h, 1, minArea).forEach(function (c) { addFromComp(c, 'edges'); });
    });

    // (b) ngưỡng Otsu theo độ sáng: giấy thường sáng hơn nền (hoặc ngược lại)
    var t = otsu(gray), bin = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) bin[i] = gray[i] > t ? 1 : 0;
    var binOpen = dilateBinary(bin.map(function (v) { return 1 - v; }), w, h, 1).map(function (v) { return 1 - v; }); // erode
    components(binOpen, w, h, 1, minArea).forEach(function (c) { addFromComp(c, 'bright'); });
    components(binOpen, w, h, 0, minArea).forEach(function (c) { if (!c.touches) addFromComp(c, 'dark'); });

    // (c) Hough: 4 đường thẳng dài nhất tạo thành tứ giác – chịu được nền rối,
    //     mép giấy bị đứt đoạn hoặc một góc bị che.
    houghQuads(houghLines(houghEdges, w, h), sctx, 24).forEach(function (r) {
      candidates.push({ quad: r.quad, tag: 'hough', fit: 1 });
    });

    // (d) cùng các bước trên ảnh đã xoá chữ: ngưỡng Otsu (giấy sáng hơn nền) …
    var tC = otsu(grayC), binC = new Uint8Array(w * h);
    for (var iC = 0; iC < w * h; iC++) binC[iC] = grayC[iC] > tC ? 1 : 0;
    components(binC, w, h, 1, minArea).forEach(function (c) { addFromComp(c, 'clean-bright'); });
    // … và Canny + vùng kín + Hough
    [[1, 1], [0.6, 1]].forEach(function (cfg, ci) {
      var edgesC = canny(gradC, w, h, loC * cfg[0], hiC * cfg[0]);
      var dilC = dilateBinary(edgesC, w, h, cfg[1]);
      components(dilC, w, h, 0, minArea).forEach(function (c) {
        if (!c.touches && c.area > minArea * 0.5) addFromComp(c, 'clean-region');
      });
      components(dilC, w, h, 1, minArea).forEach(function (c) { addFromComp(c, 'clean-edges'); });
      if (ci === 0) {
        houghQuads(houghLines(edgesC, w, h), sctx, 24).forEach(function (r) {
          candidates.push({ quad: r.quad, tag: 'clean-hough', fit: 1 });
        });
      }
    });

    var best = null;
    // Tứ giác toàn khung hình: đúng khi tờ giấy phủ kín ảnh (chụp cận)
    candidates.push({ quad: defaultCorners(w, h, 0), tag: 'frame', fit: 1 });
    candidates.forEach(function (c) {
      var refined = orderCorners(refineQuad(c.quad, grad, w, h, supportThr));
      [refined, c.quad].forEach(function (q) {
        var s = scoreQuad(q, sctx);
        if (!s) return;
        s.score *= 0.85 + 0.15 * Math.min(1, c.fit);
        s.method = c.tag;
        if (!best || s.score > best.score) best = s;
      });
    });

    if (opts.debug) opts.debug.candidates = candidates, opts.debug.scoreQuad = function (q) { return scoreQuad(q, sctx); }, opts.debug.sc = sc, opts.debug.grayC = grayC, opts.debug.gradC = gradC, opts.debug.w = w, opts.debug.h = h, opts.debug.thrC = thrC;
    // cả 4 cạnh trùng khung hình = không thấy mép giấy nào → dùng cả ảnh, báo chưa chắc chắn
    if (best && best.borderSides === 4) best = null;
    var found = !!best && best.minSupport >= 0.35 && best.score >= 0.4;
    var corners;
    if (found) {
      corners = best.quad.map(function (p) { return { x: p.x / sc, y: p.y / sc }; });
      // Tinh chỉnh lần 2 ở độ phân giải cao hơn để góc chính xác tới từng pixel
      var fine = downscale(img, opts.refineSize || 1400);
      if (fine.scale > sc * 1.3) {
        var fw = fine.image.width, fh = fine.image.height, fs = fine.scale;
        var fgrad = sobel(gaussianBlur(toGray(fine.image), fw, fh, 1.2), fw, fh);
        var fthr = Math.max(20, percentile(fgrad.mag, 0.75) * 0.8);
        var fq = refineQuad(corners.map(function (p) { return { x: p.x * fs, y: p.y * fs }; }), fgrad, fw, fh, fthr, 0.02);
        corners = orderCorners(fq).map(function (p) { return { x: p.x / fs, y: p.y / fs }; });
      }
      // cho phép góc nằm hơi ngoài khung hình (tờ giấy bị cắt một góc)
      // góc nằm sát mép khung hình (cạnh trùng mép ảnh) → gắn đúng vào mép
      var snap = 2 / sc;
      corners = corners.map(function (p) {
        return {
          x: Math.abs(p.x) < snap ? 0 : Math.abs(p.x - (img.width - 1)) < snap ? img.width - 1 : p.x,
          y: Math.abs(p.y) < snap ? 0 : Math.abs(p.y - (img.height - 1)) < snap ? img.height - 1 : p.y
        };
      });
      var mxo = img.width * 0.1, myo = img.height * 0.1;
      corners = corners.map(function (p) { return { x: clamp(p.x, -mxo, img.width - 1 + mxo), y: clamp(p.y, -myo, img.height - 1 + myo) }; });
    } else {
      // Không thấy mép giấy rõ (giấy trắng trên nền trắng, thiếu sáng…): ước lượng theo nội dung in
      var cq = opts.live ? null : contentQuad(candidates, sctx, rawGray, closedRaw);
      if (cq) {
        corners = cq.map(function (p) { return { x: clamp(p.x / sc, 0, img.width - 1), y: clamp(p.y / sc, 0, img.height - 1) }; });
        return { corners: corners, found: false, confidence: best ? Math.round(best.score * 100) / 100 : 0, method: 'content' };
      }
      corners = defaultCorners(img.width, img.height, 0);
    }
    return {
      corners: corners,
      found: found,
      confidence: best ? Math.round(best.score * 100) / 100 : 0,
      method: found ? best.method : 'fallback'
    };
  }

  /**
   * Khung trang ước lượng từ NỘI DUNG khi mép giấy không thấy được:
   *  1. lấy tứ giác "cấu trúc" rõ nhất (thường là khung bảng / khối kẻ) để biết phối cảnh;
   *  2. dàn phẳng mọi điểm mực (tối hơn nền giấy cục bộ) theo phối cảnh đó;
   *  3. lấy khung bao nội dung (bỏ 1.5% điểm ngoại lai) + lề nhỏ, rồi chiếu ngược về ảnh.
   */
  function contentQuad(candidates, ctx, rawGray, closedRaw) {
    var w = ctx.w, h = ctx.h, best = null, i, k;
    candidates.forEach(function (c) {
      var q = c.quad;
      if (!isConvexQuad(q) || minInteriorAngleCos(q) > 0.6) return;
      var frac = polygonArea(q) / (w * h);
      if (frac < 0.1) return;
      var sum = 0, mn = 1;
      for (k = 0; k < 4; k++) {
        if (borderSide(q[k], q[(k + 1) % 4], w, h)) return;
        var sp = sideSupport(ctx.grad, w, h, q[k], q[(k + 1) % 4], ctx.thr, 2);
        sum += sp; if (sp < mn) mn = sp;
      }
      if (mn < 0.6) return;
      var sc = (sum / 4) * Math.sqrt(frac);
      if (!best || sc > best.sc) best = { q: q, sc: sc };
    });
    var ref = best ? best.q : defaultCorners(w, h, 0);
    var unit = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    var H;
    try { H = getPerspectiveTransform(ref, unit); } catch (e) { return null; }
    var us = [], vs = [];
    for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
      i = y * w + x;
      if (rawGray[i] > closedRaw[i] - 35) continue; // không phải mực
      var d = H[6] * x + H[7] * y + H[8];
      us.push((H[0] * x + H[1] * y + H[2]) / d); vs.push((H[3] * x + H[4] * y + H[5]) / d);
    }
    if (us.length < w * h * 0.005) return null;
    function pct(a, p) { var s = a.slice().sort(function (m, n) { return m - n; }); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
    var u0 = pct(us, 0.015), u1 = pct(us, 0.985), v0 = pct(vs, 0.015), v1 = pct(vs, 0.985);
    var mu = (u1 - u0) * 0.02, mv = (v1 - v0) * 0.015;
    var box = [{ x: u0 - mu, y: v0 - mv }, { x: u1 + mu, y: v0 - mv }, { x: u1 + mu, y: v1 + mv }, { x: u0 - mu, y: v1 + mv }];
    var Hi;
    try { Hi = getPerspectiveTransform(unit, ref); } catch (e) { return null; }
    var out = box.map(function (p) {
      var dd = Hi[6] * p.x + Hi[7] * p.y + Hi[8];
      return { x: (Hi[0] * p.x + Hi[1] * p.y + Hi[2]) / dd, y: (Hi[3] * p.x + Hi[4] * p.y + Hi[5]) / dd };
    });
    var frac2 = polygonArea(out) / (w * h);
    if (!isConvexQuad(out) || frac2 < 0.15 || frac2 > 1.3) return null;
    return orderCorners(out);
  }

  function defaultCorners(w, h, margin) {
    var mx = w * margin, my = h * margin;
    return [{ x: mx, y: my }, { x: w - 1 - mx, y: my }, { x: w - 1 - mx, y: h - 1 - my }, { x: mx, y: h - 1 - my }];
  }

  // ---------------------------------------------------------------------------
  // 2) Nắn phối cảnh (perspective transform)
  // ---------------------------------------------------------------------------

  /** Giải hệ tuyến tính Ax=b (Gauss có chọn trụ). */
  function solve(A, b) {
    var n = b.length, M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      if (Math.abs(M[c][c]) < 1e-12) throw new Error('Ma trận suy biến');
      for (r = 0; r < n; r++) {
        if (r === c) continue;
        var f = M[r][c] / M[c][c];
        for (var k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map(function (r, i) { return r[n] / r[i]; });
  }

  /** Homography H (3x3, h33=1) sao cho H * src[i] ~ dst[i]. */
  function getPerspectiveTransform(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    var hh = solve(A, b);
    return [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
  }

  function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }

  /**
   * Ước lượng kích thước ảnh đầu ra. Dùng độ dài cạnh lớn nhất; nếu tỉ lệ gần
   * khổ A4 (1:√2) / Letter thì "bắt dính" vào tỉ lệ chuẩn.
   */
  /**
   * Ước lượng tỉ lệ thật (rộng/cao) của hình chữ nhật bị chụp nghiêng, theo
   * Zhang & He, "Whiteboard scanning and image enhancement" (2007): từ 4 góc suy ra
   * tiêu cự camera f rồi tính tỉ lệ. Trả về null nếu cấu hình suy biến (chụp thẳng,
   * hai cạnh song song) – khi đó dùng độ dài cạnh.
   */
  function realAspectRatio(c, imgW, imgH, opts) {
    if (!imgW || !imgH) return null;
    var u0 = imgW / 2, v0 = imgH / 2;
    var m1 = [c[0].x, c[0].y, 1], m2 = [c[1].x, c[1].y, 1], m3 = [c[3].x, c[3].y, 1], m4 = [c[2].x, c[2].y, 1];
    function cr(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function dt(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    var d2 = dt(cr(m2, m4), m3), d3 = dt(cr(m3, m4), m2);
    if (Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) return null;
    var k2 = dt(cr(m1, m4), m3) / d2, k3 = dt(cr(m1, m4), m2) / d3;
    var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    var n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    var f2 = null;
    if (Math.abs(n2[2]) > 1e-6 && Math.abs(n3[2]) > 1e-6) {
      f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0) +
             (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2]);
    }
    // Tiêu cự: dùng giá trị ước lượng nếu hợp lý cho camera điện thoại; nếu không ước lượng được
    // (chụp nghiêng đối xứng → một cặp cạnh song song, tiêu cự không xác định) hoặc ra giá trị vô lý,
    // dùng tiêu cự điển hình của camera điện thoại (24–26mm tương đương ≈ 0.75 × cạnh dài ảnh), hoặc tiêu cự thật đọc từ EXIF nếu có.
    // Trước đây trường hợp này rơi về đo độ dài cạnh → chiều bị nghiêng co lại, trang A4 thành gần vuông.
    var maxDim = Math.max(imgW, imgH), fPrior = (opts && opts.focal) || 0.75 * maxDim;
    var f = f2 > 0 ? Math.sqrt(f2) : 0;
    if (opts && opts.focal) f = opts.focal;                  // EXIF: tin cậy nhất
    else if (!(f >= 0.55 * maxDim && f <= 1.8 * maxDim)) f = fPrior;
    function norm2(n) {
      var a = (n[0] - u0 * n[2]) / f, b = (n[1] - v0 * n[2]) / f;
      return a * a + b * b + n[2] * n[2];
    }
    var ar = Math.sqrt(norm2(n2) / norm2(n3));
    return isFinite(ar) && ar > 0.1 && ar < 10 ? ar : null;
  }

  function outputSize(c, maxSide, imgW, imgH, focal) {
    var wTop = dist(c[0], c[1]), wBot = dist(c[3], c[2]), hL = dist(c[0], c[3]), hR = dist(c[1], c[2]);
    var W = Math.max(wTop, wBot), H = Math.max(hL, hR);
    var ar = realAspectRatio(c, imgW, imgH, { focal: focal });
    if (ar) {
      // giữ nguyên độ phân giải theo chiều lớn hơn, chiều kia theo tỉ lệ thật
      if (W / H > ar) H = W / ar; else W = H * ar;
    }
    // Bắt dính về khổ chuẩn. Có EXIF thì tỉ lệ rất chính xác → dung sai A4 5%; không có thì 12%.
    // Ưu tiên A4 (thông dụng ở VN); Letter chỉ khi khớp rất sát.
    var ratio = H / W, a4 = focal ? 0.05 : 0.12, std = [
      { r: Math.SQRT2, tol: a4 }, { r: 1 / Math.SQRT2, tol: a4 },
      { r: 11 / 8.5, tol: 0.025 }, { r: 8.5 / 11, tol: 0.025 }
    ], pick = null, bestE = Infinity;
    for (var i = 0; i < std.length; i++) {
      var e = Math.abs(ratio - std[i].r) / std[i].r;
      if (e < std[i].tol && e < bestE) { bestE = e; pick = std[i].r; }
    }
    if (pick) { var sq = Math.sqrt(W * H); W = sq / Math.sqrt(pick); H = sq * Math.sqrt(pick); }
    var s = Math.min(1, (maxSide || 2480) / Math.max(W, H));
    return { width: Math.max(1, Math.round(W * s)), height: Math.max(1, Math.round(H * s)) };
  }

  function warpPerspective(img, corners, opts) {
    opts = opts || {};
    var size = opts.width && opts.height ? { width: opts.width, height: opts.height } : outputSize(corners, opts.maxSide, img.width, img.height, opts.focal);
    var W = size.width, Ht = size.height;
    // Cắt lẹm vào trong một chút (mặc định 0.6%) để loại viền nền/bóng sát mép giấy
    var inset = opts.inset === undefined ? 0.006 : opts.inset, ix = W * inset, iy = Ht * inset;
    var dstPts = [{ x: -ix, y: -iy }, { x: W + ix, y: -iy }, { x: W + ix, y: Ht + iy }, { x: -ix, y: Ht + iy }];
    var H = getPerspectiveTransform(dstPts, corners); // ánh xạ ngược: đích -> nguồn
    var out = createImage(W, Ht), od = out.data, sd = img.data, sw = img.width, sh = img.height;
    for (var y = 0; y < Ht; y++) {
      var yc = y + 0.5;
      for (var x = 0; x < W; x++) {
        var xc = x + 0.5;
        var den = H[6] * xc + H[7] * yc + H[8];
        var sx = (H[0] * xc + H[1] * yc + H[2]) / den - 0.5;
        var sy = (H[3] * xc + H[4] * yc + H[5]) / den - 0.5;
        var o = (y * W + x) * 4;
        var x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        var xa = clamp(x0, 0, sw - 1), xb = clamp(x0 + 1, 0, sw - 1), ya = clamp(y0, 0, sh - 1), yb = clamp(y0 + 1, 0, sh - 1);
        var p00 = (ya * sw + xa) * 4, p10 = (ya * sw + xb) * 4, p01 = (yb * sw + xa) * 4, p11 = (yb * sw + xb) * 4;
        for (var ch = 0; ch < 3; ch++) {
          var top = sd[p00 + ch] + (sd[p10 + ch] - sd[p00 + ch]) * fx;
          var bot = sd[p01 + ch] + (sd[p11 + ch] - sd[p01 + ch]) * fx;
          od[o + ch] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3) Tăng cường ảnh "như máy scan"
  // ---------------------------------------------------------------------------

  /** Phóng to bilinear mảng 1 kênh từ (sw,sh) lên (w,h). */
  function upsample(src, sw, sh, w, h) {
    var out = new Float32Array(w * h), fx = sw / w, fy = sh / h;
    for (var y = 0; y < h; y++) {
      var sy = (y + 0.5) * fy - 0.5, y0 = Math.floor(sy), ty = sy - y0;
      var ya = clamp(y0, 0, sh - 1), yb = clamp(y0 + 1, 0, sh - 1);
      for (var x = 0; x < w; x++) {
        var sx = (x + 0.5) * fx - 0.5, x0 = Math.floor(sx), tx = sx - x0;
        var xa = clamp(x0, 0, sw - 1), xb = clamp(x0 + 1, 0, sw - 1);
        var a = src[ya * sw + xa] + (src[ya * sw + xb] - src[ya * sw + xa]) * tx;
        var b = src[yb * sw + xa] + (src[yb * sw + xb] - src[yb * sw + xa]) * tx;
        out[y * w + x] = a + (b - a) * ty;
      }
    }
    return out;
  }

  /**
   * Ước lượng "nền giấy" (ánh sáng chiếu lên giấy) cho từng kênh:
   * thu nhỏ → lọc max (xoá chữ tối) → làm mượt → phóng to.
   * Chia ảnh cho nền này sẽ khử bóng đổ và làm giấy trắng đều.
   */
  function estimateBackground(img) {
    var ds = downscale(img, 560), s = ds.image, sw = s.width, sh = s.height, n = sw * sh;
    var r = Math.max(2, Math.round(Math.max(sw, sh) / 75));
    var res = [];
    for (var ch = 0; ch < 3; ch++) {
      var c = new Float32Array(n);
      for (var i = 0; i < n; i++) c[i] = s.data[i * 4 + ch];
      // Phép ĐÓNG (max rồi min) thay vì chỉ max: xoá chữ nhưng giữ đúng vị trí mép bóng đổ.
      // Chỉ lọc max thì vùng sáng loang vào trong bóng → để lại vệt xám dọc mép bóng.
      var m = grayClosing(c, sw, sh, r);
      m = boxBlur(m, sw, sh, Math.max(1, r >> 1));
      res.push(upsample(m, sw, sh, img.width, img.height));
    }
    return res;
  }

  function normalizeIllumination(img) {
    var bg = estimateBackground(img), n = img.width * img.height, out = createImage(img.width, img.height);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      for (var ch = 0; ch < 3; ch++) out.data[j + ch] = Math.min(255, img.data[j + ch] / Math.max(bg[ch][i], 1) * 255);
      out.data[j + 3] = 255;
    }
    return out;
  }

  /** Kéo giãn mức: điểm đen = phân vị thấp, điểm trắng = phân vị cao. */
  function levels(img, blackP, whiteP, gamma, whiteCap) {
    var n = img.width * img.height, g = toGray(img);
    var b = percentile(g, blackP), wv = percentile(g, whiteP);
    // whiteCap: mọi điểm sáng hơn mức này thành trắng hẳn → xoá chữ mặt sau in thấu,
    // vết bóng mờ còn sót (chữ in thật tối hơn nhiều nên không bị ảnh hưởng)
    if (whiteCap && wv > whiteCap) wv = whiteCap;
    if (wv - b < 30) { b = Math.max(0, wv - 30); }
    var lut = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) lut[v] = 255 * Math.pow(clamp((v - b) / (wv - b), 0, 1), gamma);
    var out = createImage(img.width, img.height);
    for (var j = 0; j < n * 4; j += 4) {
      out.data[j] = lut[img.data[j] | 0]; out.data[j + 1] = lut[img.data[j + 1] | 0]; out.data[j + 2] = lut[img.data[j + 2] | 0];
      out.data[j + 3] = 255;
    }
    return out;
  }

  function saturate(img, amount) {
    var d = img.data;
    for (var j = 0; j < d.length; j += 4) {
      var l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      d[j] = l + (d[j] - l) * amount; d[j + 1] = l + (d[j + 1] - l) * amount; d[j + 2] = l + (d[j + 2] - l) * amount;
    }
    return img;
  }

  function grayImage(g, w, h) {
    var out = createImage(w, h);
    for (var i = 0, j = 0; i < g.length; i++, j += 4) { out.data[j] = out.data[j + 1] = out.data[j + 2] = g[i]; out.data[j + 3] = 255; }
    return out;
  }

  /** Nhị phân hoá thích nghi (kiểu Sauvola đơn giản) trên ảnh đã chuẩn hoá ánh sáng. */
  function binarize(img) {
    var w = img.width, h = img.height, g = toGray(img);
    var r = Math.max(8, Math.round(Math.max(w, h) / 50));
    var mean = boxBlur(g, w, h, r);
    var gt = Math.min(otsu(g), 150);
    var out = new Float32Array(w * h);
    for (var i = 0; i < g.length; i++) {
      var dark = g[i] < gt || g[i] < mean[i] * 0.86;
      out[i] = dark && g[i] < 215 ? 0 : 255;
    }
    return grayImage(out, w, h);
  }

  /**
   * Dọn mép bản scan: tô màu giấy cho các vùng KHÔNG PHẢI GIẤY (nền bàn, góc giấy bị gấp/thiếu,
   * bóng đậm sát mép) nằm trong dải sát mép ảnh và NỐI LIỀN với mép ảnh.
   * Chữ không chạm mép nên giữ nguyên. Kết quả: trang vuông vắn, không lẹm góc.
   */
  function cleanBorders(img, bandFrac) {
    // Tìm vùng cần tô trên ảnh thu nhỏ (nhanh), rồi tô ở độ phân giải đầy đủ chỉ trong dải sát mép.
    var W = img.width, H = img.height, D = img.data;
    var ds = downscale(img, 1000), sm = ds.image, w = sm.width, h = sm.height, d = sm.data, n = w * h, i;
    var g = toGray(sm), ref = percentile(g, 0.9);
    var bf = bandFrac || 0.08, band = Math.max(4, Math.round(Math.min(w, h) * bf));
    // màu giấy: trung bình các điểm sáng (nền giấy)
    var pr = 0, pg = 0, pb = 0, pc = 0;
    for (i = 0; i < n; i += 3) if (g[i] >= ref * 0.92) { pr += d[i * 4]; pg += d[i * 4 + 1]; pb += d[i * 4 + 2]; pc++; }
    if (!pc) return img;
    pr /= pc; pg /= pc; pb /= pc;
    var psat = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
    function notPaperRGB(r, gg, b, L) { return L < ref * 0.8 || Math.max(r, gg, b) - Math.min(r, gg, b) > psat + 45; }
    function inBand(x, y) { return x < band || y < band || x >= w - band || y >= h - band; }
    // Chỉ lan qua mảng "không phải giấy" DÀY (nền, góc gấp): co mặt nạ bán kính rr để loại nét chữ
    // mảnh, nếu không vùng tô sẽ lan theo nét chữ sát mép và xoá mất chữ.
    // Điểm tối hơn hẳn nền cục bộ (nét chữ, kể cả chữ nằm trong vùng bóng) không bao giờ bị tô.
    var rr = Math.max(2, Math.round(Math.min(w, h) / 250));
    // sát mép (1.5%) gần như không có chữ → ở đó tô cả dải tối mảnh (bóng mép giấy), không bảo vệ
    var thin = Math.max(2, Math.round(Math.min(w, h) * 0.015));
    function inThin(k) { var xx = k % w, yy = (k / w) | 0; return xx < thin || yy < thin || xx >= w - thin || yy >= h - thin; }
    var localBg = grayClosing(g, w, h, rr * 2);
    var np = new Float32Array(n);
    for (i = 0; i < n; i++) {
      np[i] = inThin(i) ? (g[i] < ref * 0.9 || notPaperRGB(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], g[i]) ? 1 : 0)
                        : (notPaperRGB(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], g[i]) && localBg[i] - g[i] < 30 ? 1 : 0);
    }
    var thick = minFilter(np, w, h, rr);
    var mark = new Float32Array(n), stack = new Int32Array(n), sp = 0, x, y, filled = 0;
    function ok(k) { return thick[k] > 0 || (np[k] > 0 && inThin(k)); }
    function seed(k) { if (!mark[k] && ok(k)) { mark[k] = 1; stack[sp++] = k; } }
    for (x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp > 0) {
      var k = stack[--sp]; x = k % w; y = (k / w) | 0; filled++;
      if (x > 0 && inBand(x - 1, y)) seed(k - 1);
      if (x < w - 1 && inBand(x + 1, y)) seed(k + 1);
      if (y > 0 && inBand(x, y - 1)) seed(k - w);
      if (y < h - 1 && inBand(x, y + 1)) seed(k + w);
    }
    if (!filled) return img;
    var grown = maxFilter(mark, w, h, rr + 1); // nở lại phần đã co
    // tô ở độ phân giải đầy đủ, chỉ trong dải sát mép
    var out = createImage(W, H);
    out.data.set(D);
    var sx = w / W, sy = h / H, BW = Math.ceil((band + rr + 2) / sx), BH = Math.ceil((band + rr + 2) / sy);
    for (var Y = 0; Y < H; Y++) {
      var yS = Math.min(h - 1, (Y * sy) | 0), rowBand = Y < BH || Y >= H - BH;
      for (var X = 0; X < W; X++) {
        if (!rowBand && X >= BW && X < W - BW) { X = W - BW - 1; continue; }
        var kS = yS * w + Math.min(w - 1, (X * sx) | 0);
        if (!(grown[kS] > 0)) continue;
        var j = (Y * W + X) * 4, r = D[j], gg = D[j + 1], b = D[j + 2], L = 0.299 * r + 0.587 * gg + 0.114 * b;
        if (inThin(kS) ? !(L < ref * 0.9 || notPaperRGB(r, gg, b, L)) : (!notPaperRGB(r, gg, b, L) || localBg[kS] - L >= 30)) continue;
        out.data[j] = pr; out.data[j + 1] = pg; out.data[j + 2] = pb;
      }
    }
    return out;
  }

  /**
   * @param mode 'original' | 'magic' (màu, nền trắng) | 'gray' | 'bw' (đen trắng)
   */
  function enhance(img, mode) {
    if (mode !== 'original') img = cleanBorders(img);
    switch (mode) {
      case 'original':
        return img;
      case 'gray': {
        var n1 = levels(normalizeIllumination(img), 0.01, 0.6, 1.2, 225);
        return grayImage(toGray(n1), n1.width, n1.height);
      }
      case 'bw':
        return binarize(normalizeIllumination(img));
      case 'magic':
      default:
        return saturate(levels(normalizeIllumination(img), 0.005, 0.5, 1.35, 222), 1.25);
    }
  }

  // ---------------------------------------------------------------------------
  // Tiện ích khác
  // ---------------------------------------------------------------------------

  function rotate90(img, clockwise) {
    var w = img.width, h = img.height, out = createImage(h, w);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var nx = clockwise ? h - 1 - y : y, ny = clockwise ? x : w - 1 - x;
      var s = (y * w + x) * 4, d = (ny * h + nx) * 4;
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3];
    }
    return out;
  }

  /**
   * Đọc tiêu cự quy đổi 35mm (EXIF FocalLengthIn35mmFilm, hoặc FocalLength × hệ số nếu thiếu)
   * từ dữ liệu JPEG, rồi đổi ra tiêu cự theo pixel cho ảnh rộng w × cao h.
   * Trả về null nếu không có EXIF. (iPhone luôn ghi FocalLengthIn35mmFilm.)
   */
  function focalFromExif(buf, w, h) {
    try {
      var d = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
      if (d.getUint16(0) !== 0xFFD8) return null;
      var off = 2;
      while (off + 4 < d.byteLength) {
        var marker = d.getUint16(off), len = d.getUint16(off + 2);
        if (marker === 0xFFE1 && d.getUint32(off + 4) === 0x45786966) { // "Exif"
          var t = off + 10, le = d.getUint16(t) === 0x4949;
          var u16 = function (o) { return d.getUint16(t + o, le); }, u32 = function (o) { return d.getUint32(t + o, le); };
          var ifd = function (o, want) {
            var n = u16(o), out = {};
            for (var i = 0; i < n; i++) {
              var e = o + 2 + i * 12, tag = u16(e);
              if (want.indexOf(tag) >= 0) out[tag] = { type: u16(e + 2), val: e + 8 };
            }
            return out;
          };
          var ifd0 = ifd(u32(4), [0x8769]);
          if (!ifd0[0x8769]) return null;
          var ex = ifd(u32(ifd0[0x8769].val), [0xA405, 0x920A]);
          var f35 = ex[0xA405] ? u16(ex[0xA405].val) : 0;
          if (f35 > 0) return f35 / 43.27 * Math.sqrt(w * w + h * h); // 43.27mm = đường chéo khổ 35mm
          return null;
        }
        if (marker === 0xFFDA || len < 2) break;
        off += 2 + len;
      }
    } catch (e) { /* EXIF hỏng → bỏ qua */ }
    return null;
  }

  /**
   * Tự nhận hướng trang theo chữ in. Trả về số độ cần xoay THEO chiều kim đồng hồ (0/90/180/270)
   * để chữ nằm ngang, đứng thẳng.
   *  1. Mặt nạ mực (tối hơn nền cục bộ), bỏ các đường kẻ dài (khung bảng).
   *  2. Hướng dòng chữ: dòng ngang → tổng mực theo HÀNG dao động mạnh (dòng/khoảng trống xen kẽ);
   *     dòng đứng → dao động theo CỘT.
   *  3. Phía "trên" của chữ: tiếng Việt (và chữ Latin) có nhiều dấu + nét đi lên hơn nét đi xuống,
   *     nên trong mỗi dòng, phía nào ngoài thân chữ nhiều mực hơn là phía trên.
   */
  function detectOrientation(img) {
    var ds = downscale(img, 1000), sm = ds.image, w = sm.width, h = sm.height, n = w * h, i, x, y;
    var g = toGray(sm), r = Math.max(2, Math.round(Math.max(w, h) / 150));
    var bg = grayClosing(g, w, h, r), ink = new Uint8Array(n), total = 0;
    for (i = 0; i < n; i++) if (bg[i] - g[i] > 40) { ink[i] = 1; total++; }
    if (total < n * 0.004) return 0; // gần như trắng trơn
    // bỏ đường kẻ dài ngang/dọc
    var runH = Math.round(w * 0.08), runV = Math.round(h * 0.08), keep = ink.slice(), a;
    for (y = 0; y < h; y++) for (x = 0; x < w;) {
      if (!ink[y * w + x]) { x++; continue; }
      for (a = x; a < w && ink[y * w + a]; a++);
      if (a - x > runH) for (var k = x; k < a; k++) keep[y * w + k] = 0;
      x = a;
    }
    for (x = 0; x < w; x++) for (y = 0; y < h;) {
      if (!ink[y * w + x]) { y++; continue; }
      for (a = y; a < h && ink[a * w + x]; a++);
      if (a - y > runV) for (var k2 = y; k2 < a; k2++) keep[k2 * w + x] = 0;
      y = a;
    }
    // Gán nhãn thành phần liên thông (8 hướng) của mặt nạ mực
    var lab = new Int32Array(n), stack = new Int32Array(n), comps = [], id = 0;
    for (i = 0; i < n; i++) {
      if (!keep[i] || lab[i]) continue;
      id++;
      var sp = 0, area = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack[sp++] = i; lab[i] = id;
      while (sp > 0) {
        var q = stack[--sp], qx = q % w, qy = (q / w) | 0;
        area++; sx += qx; sy += qy;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var nq = ny * w + nx;
          if (keep[nq] && !lab[nq]) { lab[nq] = id; stack[sp++] = nq; }
        }
      }
      comps[id] = { area: area, cx: sx / area, cy: sy / area, bw: x1 - x0 + 1, bh: y1 - y0 + 1 };
    }
    var areas = [];
    for (i = 1; i <= id; i++) if (comps[i].area >= 6) areas.push(comps[i].area);
    if (areas.length < 40) return 0;
    areas.sort(function (m, k3) { return m - k3; });
    var aMed = areas[areas.length >> 1];
    var size = Math.sqrt(aMed) * 2.2; // ≈ cỡ một chữ cái
    // Mỗi DẤU (mảnh nhỏ đứng riêng) bỏ phiếu: thân chữ gần nhất nằm ở hướng nào → "lên" là hướng ngược lại
    var votes = [0, 0, 0, 0]; // lên = trên, phải, dưới, trái
    var dirs = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // hướng TÌM THÂN CHỮ: xuống, trái, lên, phải
    for (i = 1; i <= id; i++) {
      var c = comps[i];
      if (c.area > aMed * 0.3 || c.area < 2 || c.bw > size || c.bh > size) continue;
      var best = -1, bd = Infinity, second = Infinity;
      for (var di = 0; di < 4; di++) {
        for (var st = 1; st <= size; st++) {
          var px = Math.round(c.cx + dirs[di][0] * st), py = Math.round(c.cy + dirs[di][1] * st);
          if (px < 0 || py < 0 || px >= w || py >= h) break;
          var L = lab[py * w + px];
          if (L && L !== i && comps[L].area >= aMed * 0.5) {
            if (st < bd) { second = bd; bd = st; best = di; } else if (st < second) second = st;
            break;
          }
        }
      }
      if (best >= 0 && bd * 1.6 < second) votes[best]++;
    }
    // Hướng dòng (docstrum): chữ cái gần nhất của mỗi chữ cái nằm DỌC theo dòng.
    var cell = Math.max(4, Math.round(size * 1.5)), gw = Math.ceil(w / cell), grid = {}, bigs = [];
    for (i = 1; i <= id; i++) {
      var cb = comps[i];
      if (cb.area < aMed * 0.4 || cb.area > aMed * 6 || cb.bw > size * 3 || cb.bh > size * 3) continue;
      bigs.push(cb);
      var key = Math.floor(cb.cy / cell) * gw + Math.floor(cb.cx / cell);
      (grid[key] = grid[key] || []).push(cb);
    }
    var hor = 0, ver = 0;
    bigs.forEach(function (cb) {
      var gx = Math.floor(cb.cx / cell), gy = Math.floor(cb.cy / cell), nb = null, nd = Infinity;
      for (var yy = gy - 1; yy <= gy + 1; yy++) for (var xx = gx - 1; xx <= gx + 1; xx++) {
        var arr = grid[yy * gw + xx];
        if (!arr || xx < 0 || xx >= gw) continue;
        for (var t = 0; t < arr.length; t++) {
          var o2 = arr[t];
          if (o2 === cb) continue;
          var dd = (o2.cx - cb.cx) * (o2.cx - cb.cx) + (o2.cy - cb.cy) * (o2.cy - cb.cy);
          if (dd < nd) { nd = dd; nb = o2; }
        }
      }
      if (!nb) return;
      if (Math.abs(nb.cx - cb.cx) > Math.abs(nb.cy - cb.cy)) hor++; else ver++;
    });
    var vertical = ver > hor;
    // votes: 0 = dấu ở TRÊN thân chữ, 1 = ở PHẢI, 2 = ở DƯỚI, 3 = ở TRÁI.
    // Chỉ xét 2 hướng vuông góc với dòng (dấu câu đứng cạnh chữ bị bỏ qua).
    var a1 = vertical ? 3 : 0, a2 = vertical ? 1 : 2;   // dòng đứng: trái/phải; dòng ngang: trên/dưới
    if (votes[a1] + votes[a2] < 12) return vertical ? 90 : 0;
    if (!vertical) return votes[2] > votes[0] * 1.5 ? 180 : 0; // lộn ngược chỉ khi bằng chứng mạnh
    // dấu ở TRÁI → phía "lên" của chữ là bên trái → xoay phải 90°; ở PHẢI → xoay trái (270°)
    return votes[3] >= votes[1] ? 90 : 270;
  }

  function rotateBy(img, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg === 90) return rotate90(img, true);
    if (deg === 270) return rotate90(img, false);
    if (deg === 180) return rotate90(rotate90(img, true), true);
    return img;
  }

  /** Quy trình đầy đủ: nhận diện → nắn → tự xoay → tăng cường. */
  function scan(img, opts) {
    opts = opts || {};
    var det = opts.corners ? { corners: opts.corners, found: true, confidence: 1, method: 'manual' } : detectDocument(img);
    var warped = warpPerspective(img, det.corners, { maxSide: opts.maxSide, focal: opts.focal });
    if (opts.autoRotate !== false) warped = rotateBy(warped, detectOrientation(warped));
    return { image: enhance(warped, opts.mode || 'magic'), detection: det };
  }

  return {
    detectDocument: detectDocument,
    defaultCorners: defaultCorners,
    orderCorners: orderCorners,
    getPerspectiveTransform: getPerspectiveTransform,
    focalFromExif: focalFromExif,
    warpPerspective: warpPerspective,
    outputSize: outputSize,
    enhance: enhance,
    rotate90: rotate90,
    rotateBy: rotateBy,
    detectOrientation: detectOrientation,
    downscale: downscale,
    scan: scan
  };
});

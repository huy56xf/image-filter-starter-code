/* app.js — Giao diện ứng dụng quét tài liệu (dùng DocScanner trong scanner-core.js). */
(function () {
  'use strict';

  var WORK_MAX = 2600;      // cạnh dài tối đa của ảnh làm việc (~300 dpi cho A4)
  var HANDLE_R = 14;        // bán kính tay nắm góc (px CSS)

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    src: null,          // ảnh gốc {data,width,height}
    srcCanvas: null,    // canvas chứa ảnh gốc để vẽ nhanh
    corners: null,      // 4 góc theo toạ độ ảnh gốc
    detection: null,
    warped: null,       // ảnh đã nắn (cache, chưa lọc)
    warpedKey: '',
    mode: 'magic',
    rotation: 0,        // 0..3 (bội số 90°, chiều kim đồng hồ)
    result: null,       // ảnh kết quả cuối cùng
    pages: [],          // [{ blob, url, width, height }]
    queue: []           // các file còn chờ quét
  };

  // ---------------------------------------------------------------------------
  // Điều hướng giữa các bước
  // ---------------------------------------------------------------------------
  function show(step) {
    if (step !== 'stepLive') stopLive();
    ['stepPick', 'stepLive', 'stepCrop', 'stepResult', 'stepPages'].forEach(function (id) {
      $(id).classList.toggle('active', id === step);
    });
    if (step === 'stepCrop') requestAnimationFrame(layoutCrop);
    if (step === 'stepResult') requestAnimationFrame(drawResult);
  }

  // ---------------------------------------------------------------------------
  // Đọc ảnh
  // ---------------------------------------------------------------------------
  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }
  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh')); };
      img.src = url;
    });
  }

  function handleFiles(files) {
    var list = Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type); });
    if (!list.length) return;
    state.queue = list.slice(1);
    openFile(list[0]);
  }

  /** Nạp nguồn ảnh (ảnh tải lên hoặc khung hình camera) làm ảnh làm việc. */
  function setSource(drawable, w, h) {
    var s = Math.min(1, WORK_MAX / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    var ctx = c.getContext('2d');
    ctx.drawImage(drawable, 0, 0, c.width, c.height);
    var id = ctx.getImageData(0, 0, c.width, c.height);
    state.src = { data: id.data, width: id.width, height: id.height };
    state.srcCanvas = c;
    state.rotation = 0;
    state.warped = null;
    return s;
  }

  function openFile(file) {
    loadBitmap(file).then(function (bmp) {
      setSource(bmp, bmp.width, bmp.height);
      runDetection();
      show('stepCrop');
    }).catch(function (e) { alert(e.message); });
  }

  function runDetection(fallbackCorners) {
    var t = performance.now();
    var det = DocScanner.detectDocument(state.src);
    if (!det.found && fallbackCorners) det = { corners: fallbackCorners, found: true, method: 'live' };
    state.detection = det;
    state.corners = det.corners;
    $('detectInfo').textContent = det.found
      ? 'Đã tìm thấy tờ giấy (' + Math.round(performance.now() - t) + ' ms). Kéo các góc nếu cần chỉnh.'
      : det.method === 'content'
        ? 'Mép giấy không rõ — đã ước lượng khung theo nội dung, hãy kiểm tra 4 góc.'
        : 'Không chắc chắn vị trí tờ giấy — hãy kéo 4 góc vào đúng mép giấy.';
    drawCrop();
  }

  // ---------------------------------------------------------------------------
  // Quét trực tiếp: nhận diện trên khung hình camera, vẽ khung realtime,
  // tự chụp khi khung đứng yên.
  // ---------------------------------------------------------------------------
  var LIVE_SIZE = 320;        // cạnh dài khung hình dùng để nhận diện
  var STABLE_MS = 1200;       // giữ yên bao lâu thì tự chụp
  var live = { stream: null, worker: null, busy: false, target: null, disp: null, miss: 0,
               stableSince: 0, raf: 0, small: null, scale: 1, lastKick: 0, capturing: false };

  function makeWorker() {
    // Worker dùng chung mã lõi: bản đóng gói 1 file có <script id="scanner-core-src">,
    // bản chạy bằng server thì nạp js/scanner-core.js.
    var el = document.getElementById('scanner-core-src');
    var code = (el ? el.textContent : 'importScripts(' + JSON.stringify(new URL('js/scanner-core.js', location.href).href) + ');') +
      '\nonmessage = function (e) { var m = e.data;' +
      ' var d = DocScanner.detectDocument({ data: new Uint8ClampedArray(m.buf), width: m.w, height: m.h }, { procSize: m.w > m.h ? m.w : m.h, refineSize: 1, live: true });' +
      ' postMessage(d); };';
    try { return new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))); } catch (e) { return null; }
  }

  function startLive() {
    $('pickMsg').hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return liveError('Trình duyệt không hỗ trợ camera trực tiếp.');
    show('stepLive');
    $('liveHint').textContent = 'Đang mở camera…';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(function (stream) {
        if (!$('stepLive').classList.contains('active')) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        live.stream = stream;
        var v = $('liveVideo');
        v.srcObject = stream;
        v.play().catch(function () {});
        if (!live.worker) {
          live.worker = makeWorker();
          if (live.worker) {
            live.worker.onmessage = function (e) { onLiveResult(e.data); };
            live.worker.onerror = function () { live.worker = null; live.busy = false; };
          }
        }
        live.target = live.disp = null; live.miss = 0; live.stableSince = 0; live.busy = false; live.capturing = false;
        live.raf = requestAnimationFrame(liveTick);
      })
      .catch(function (err) {
        show('stepPick');
        liveError('Không mở được camera (' + (err && err.name || 'lỗi') + '). Trang cần chạy qua HTTPS và được cấp quyền camera; hoặc dùng nút "Chụp ảnh".');
      });
  }

  function liveError(msg) { $('pickMsg').textContent = msg; $('pickMsg').hidden = false; }

  function stopLive() {
    if (live.raf) cancelAnimationFrame(live.raf);
    live.raf = 0;
    if (live.stream) { live.stream.getTracks().forEach(function (t) { t.stop(); }); live.stream = null; }
    var v = $('liveVideo');
    if (v) v.srcObject = null;
  }

  function liveTick(now) {
    live.raf = requestAnimationFrame(liveTick);
    var v = $('liveVideo');
    if (v.readyState >= 2 && v.videoWidth && !live.busy && now - live.lastKick > 60) kickDetection(v, now);
    drawLiveOverlay(now);
  }

  function kickDetection(v, now) {
    var s = Math.min(1, LIVE_SIZE / Math.max(v.videoWidth, v.videoHeight));
    var w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
    if (!live.small) live.small = document.createElement('canvas');
    var c = live.small;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    var id = ctx.getImageData(0, 0, w, h);
    live.scale = s; live.busy = true; live.lastKick = now;
    if (live.worker) {
      live.worker.postMessage({ buf: id.data.buffer, w: w, h: h }, [id.data.buffer]);
    } else {
      // dự phòng khi không tạo được Worker: chạy trên luồng chính
      setTimeout(function () {
        onLiveResult(DocScanner.detectDocument({ data: id.data, width: w, height: h }, { procSize: Math.max(w, h), refineSize: 1, live: true }));
      }, 0);
    }
  }

  function onLiveResult(det) {
    live.busy = false;
    if (!live.stream) return;
    var now = performance.now();
    if (det.found) {
      var pts = det.corners.map(function (p) { return { x: p.x / live.scale, y: p.y / live.scale }; });
      var v = $('liveVideo'), diag = Math.hypot(v.videoWidth, v.videoHeight);
      var moved = live.target ? Math.max.apply(null, pts.map(function (p, i) { return Math.hypot(p.x - live.target[i].x, p.y - live.target[i].y); })) / diag : 1;
      if (moved > 0.02 || !live.stableSince) live.stableSince = now;
      live.target = pts; live.miss = 0;
      if (!live.disp) live.disp = pts.map(function (p) { return { x: p.x, y: p.y }; });
      if ($('chkAuto').checked && now - live.stableSince > STABLE_MS && !live.capturing) capture();
    } else if (++live.miss >= 3) {
      live.target = null; live.stableSince = 0;
    }
  }

  function drawLiveOverlay(now) {
    var wrap = $('liveWrap'), cv = $('liveOverlay'), v = $('liveVideo');
    var dpr = window.devicePixelRatio || 1, W = wrap.clientWidth, H = wrap.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var hint = $('liveHint');
    if (!v.videoWidth) return;
    if (!live.target) { live.disp = null; hint.textContent = 'Đưa tờ giấy vào khung hình'; return; }
    // làm mượt: khung hiển thị trượt dần về vị trí mới nhất
    live.disp = live.disp.map(function (p, i) { var t = live.target[i]; return { x: p.x + (t.x - p.x) * 0.35, y: p.y + (t.y - p.y) * 0.35 }; });
    var s = Math.min(W / v.videoWidth, H / v.videoHeight), ox = (W - v.videoWidth * s) / 2, oy = (H - v.videoHeight * s) / 2;
    var pts = live.disp.map(function (p) { return { x: ox + p.x * s, y: oy + p.y * s }; });
    var held = live.stableSince ? Math.min(1, (now - live.stableSince) / STABLE_MS) : 0;
    ctx.beginPath();
    pts.forEach(function (p, k) { k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(45,212,191,' + (0.12 + 0.18 * held) + ')';
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = held >= 1 ? '#22c55e' : '#2dd4bf'; ctx.stroke();
    pts.forEach(function (p) { ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); });
    hint.textContent = $('chkAuto').checked
      ? (held < 0.15 ? 'Giữ yên máy…' : 'Giữ yên… ' + Math.round(held * 100) + '%')
      : 'Đã thấy tờ giấy — bấm Chụp';
  }

  function capture() {
    var v = $('liveVideo');
    if (!v.videoWidth || live.capturing) return;
    live.capturing = true;
    $('liveHint').textContent = 'Đang xử lý…';
    var vw = v.videoWidth, vh = v.videoHeight, liveCorners = live.target;
    var s = setSource(v, vw, vh);
    stopLive();
    var fallback = liveCorners ? liveCorners.map(function (p) { return { x: p.x * s, y: p.y * s }; }) : null;
    show('stepCrop');
    setTimeout(function () { runDetection(fallback); }, 0);
  }

  // ---------------------------------------------------------------------------
  // Màn hình chỉnh góc
  // ---------------------------------------------------------------------------
  var crop = { scale: 1, offX: 0, offY: 0, dpr: 1, drag: -1 };

  function layoutCrop() {
    if (!state.src) return;
    var wrap = $('cropWrap'), cv = $('cropCanvas');
    var pad = 24, availW = wrap.clientWidth - pad * 2, availH = wrap.clientHeight - pad * 2;
    var s = Math.min(availW / state.src.width, availH / state.src.height);
    var cssW = Math.round(state.src.width * s) + pad * 2, cssH = Math.round(state.src.height * s) + pad * 2;
    crop.dpr = window.devicePixelRatio || 1;
    crop.scale = s; crop.offX = pad; crop.offY = pad;
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    cv.width = Math.round(cssW * crop.dpr); cv.height = Math.round(cssH * crop.dpr);
    drawCrop();
  }

  function toScreen(p) { return { x: crop.offX + p.x * crop.scale, y: crop.offY + p.y * crop.scale }; }
  function toImage(x, y) { return { x: (x - crop.offX) / crop.scale, y: (y - crop.offY) / crop.scale }; }

  function drawCrop() {
    var cv = $('cropCanvas'), ctx = cv.getContext('2d');
    if (!state.src || !cv.width) return;
    ctx.setTransform(crop.dpr, 0, 0, crop.dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(state.srcCanvas, crop.offX, crop.offY, state.src.width * crop.scale, state.src.height * crop.scale);
    var pts = state.corners.map(toScreen);
    // làm tối phần ngoài tứ giác
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cv.width / crop.dpr, cv.height / crop.dpr);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 3; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill('evenodd');
    ctx.restore();
    ctx.beginPath();
    pts.forEach(function (p, k) { k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.closePath();
    ctx.lineWidth = 2; ctx.strokeStyle = '#2dd4bf'; ctx.stroke();
    pts.forEach(function (p, k) {
      ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = k === crop.drag ? 'rgba(45,212,191,0.6)' : 'rgba(45,212,191,0.25)';
      ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    });
  }

  function pointerPos(e) {
    var r = $('cropCanvas').getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function drawLoupe(p, imgPt) {
    var lp = $('loupe'), ctx = lp.getContext('2d'), zoom = 3, R = 70;
    lp.hidden = false;
    var wrap = $('cropWrap').getBoundingClientRect(), cvr = $('cropCanvas').getBoundingClientRect();
    var x = cvr.left - wrap.left + p.x - R, y = cvr.top - wrap.top + p.y - R * 2 - 30;
    if (y < 0) y = cvr.top - wrap.top + p.y + 30;
    lp.style.left = Math.max(0, x) + 'px'; lp.style.top = y + 'px';
    ctx.save();
    ctx.clearRect(0, 0, 140, 140);
    ctx.beginPath(); ctx.arc(R, R, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 140, 140);
    var srcSize = 140 / (zoom * crop.scale); // kích thước vùng ảnh gốc hiển thị trong kính lúp
    ctx.drawImage(state.srcCanvas, imgPt.x - srcSize / 2, imgPt.y - srcSize / 2, srcSize, srcSize, 0, 0, 140, 140);
    ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(R, R - 14); ctx.lineTo(R, R + 14); ctx.moveTo(R - 14, R); ctx.lineTo(R + 14, R); ctx.stroke();
    ctx.restore();
  }

  function initCropEvents() {
    var cv = $('cropCanvas');
    cv.addEventListener('pointerdown', function (e) {
      var p = pointerPos(e), best = -1, bd = 40;
      state.corners.forEach(function (c, i) {
        var s = toScreen(c), d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bd) { bd = d; best = i; }
      });
      if (best < 0) return;
      crop.drag = best;
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
      drawCrop();
      drawLoupe(p, state.corners[best]);
    });
    cv.addEventListener('pointermove', function (e) {
      if (crop.drag < 0) return;
      var p = pointerPos(e), ip = toImage(p.x, p.y);
      var mx = state.src.width * 0.1, my = state.src.height * 0.1;
      ip.x = Math.max(-mx, Math.min(state.src.width - 1 + mx, ip.x));
      ip.y = Math.max(-my, Math.min(state.src.height - 1 + my, ip.y));
      state.corners[crop.drag] = ip;
      drawCrop();
      drawLoupe(toScreen(ip), ip);
    });
    function end() {
      if (crop.drag < 0) return;
      crop.drag = -1;
      $('loupe').hidden = true;
      drawCrop();
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------------------
  // Quét & hiển thị kết quả
  // ---------------------------------------------------------------------------
  function toCanvas(img) {
    var c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height), 0, 0);
    return c;
  }

  function process() {
    var corners = DocScanner.orderCorners(state.corners);
    var key = JSON.stringify(corners);
    if (!state.warped || state.warpedKey !== key) {
      state.warped = DocScanner.warpPerspective(state.src, corners);
      state.warpedKey = key;
    }
    var out = DocScanner.enhance(state.warped, state.mode);
    for (var r = 0; r < state.rotation; r++) out = DocScanner.rotate90(out, true);
    state.result = toCanvas(out);
    // chuẩn bị sẵn file JPEG: trên iPhone, bảng chia sẻ phải mở NGAY trong lúc bấm nút
    // (không được chờ xử lý bất đồng bộ), nên file phải có sẵn từ trước
    state.resultBlob = null;
    var target = state.result;
    target.toBlob(function (b) { if (state.result === target) state.resultBlob = b; }, 'image/jpeg', 0.92);
  }

  function withBusy(fn) {
    $('busy').hidden = false;
    setTimeout(function () {
      try { fn(); } catch (e) { console.error(e); alert('Lỗi xử lý: ' + e.message); }
      $('busy').hidden = true;
    }, 30);
  }

  function rescan() { withBusy(function () { process(); drawResult(); }); }

  function drawResult() {
    var cv = $('resultCanvas');
    if (!state.result) return;
    var wrap = cv.parentElement, pad = 16;
    var s = Math.min((wrap.clientWidth - pad * 2) / state.result.width, (wrap.clientHeight - pad * 2) / state.result.height, 1);
    var dpr = window.devicePixelRatio || 1;
    cv.style.width = Math.round(state.result.width * s) + 'px';
    cv.style.height = Math.round(state.result.height * s) + 'px';
    cv.width = Math.round(state.result.width * s * dpr);
    cv.height = Math.round(state.result.height * s * dpr);
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.result, 0, 0, cv.width, cv.height);
  }

  // Trong khung xem Artifact của claude.ai, tải file phải đi qua capability "downloads";
  // chạy bình thường (server riêng) thì dùng link <a download>.
  var downloadsApi = null;
  function getDownloadsApi() {
    if (!downloadsApi) {
      downloadsApi = window.claude && window.claude.use
        ? Promise.resolve(window.claude.use('downloads')).catch(function () { return null; })
        : Promise.resolve(null);
    }
    return downloadsApi;
  }

  function download(blob, name) {
    getDownloadsApi().then(function (api) {
      if (!api) return downloadViaLink(blob, name);
      api.save({ filename: name, data: blob }).catch(function (e) {
        if (e && e.code !== 'declined') console.warn('Không lưu được file:', e.code, e.message);
      });
    });
  }

  function downloadViaLink(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function exportImage(type, ext) {
    state.result.toBlob(function (b) { download(b, 'scan-' + stamp() + '.' + ext); }, type, 0.92);
  }

  // ---------------------------------------------------------------------------
  // Tài liệu nhiều trang
  // ---------------------------------------------------------------------------
  function addPage() {
    var c = state.result;
    c.toBlob(function (blob) {
      state.pages.push({ blob: blob, url: URL.createObjectURL(blob), width: c.width, height: c.height });
      renderPages();
      if (state.queue.length) openFile(state.queue.shift());
      else show('stepPages');
    }, 'image/jpeg', 0.9);
  }

  function renderPages() {
    $('btnPages').hidden = state.pages.length === 0;
    $('pageCount').textContent = state.pages.length;
    var list = $('pageList');
    list.innerHTML = '';
    state.pages.forEach(function (p, i) {
      var el = document.createElement('div');
      el.className = 'page';
      el.innerHTML = '<img alt="Trang ' + (i + 1) + '"><div class="row"><span>Trang ' + (i + 1) + '</span>' +
        '<span><button data-act="up" title="Lên">↑</button><button data-act="down" title="Xuống">↓</button>' +
        '<button data-act="del" title="Xoá">✕</button></span></div>';
      el.querySelector('img').src = p.url;
      el.addEventListener('click', function (e) {
        var act = e.target.getAttribute('data-act');
        if (act === 'del') { URL.revokeObjectURL(p.url); state.pages.splice(i, 1); }
        else if (act === 'up' && i > 0) state.pages.splice(i - 1, 0, state.pages.splice(i, 1)[0]);
        else if (act === 'down' && i < state.pages.length - 1) state.pages.splice(i + 1, 0, state.pages.splice(i, 1)[0]);
        else return;
        renderPages();
      });
      list.appendChild(el);
    });
    $('btnPdf').disabled = state.pages.length === 0;
    $('btnSharePdf').disabled = state.pages.length === 0;
    preparePdf();
  }

  function makePdf() {
    return Promise.all(state.pages.map(function (p) {
      return p.blob.arrayBuffer().then(function (buf) { return { jpeg: new Uint8Array(buf), width: p.width, height: p.height }; });
    })).then(buildPdf);
  }

  function exportPdf() { makePdf().then(function (pdf) { download(pdf, 'scan-' + stamp() + '.pdf'); }); }

  /** Dựng sẵn PDF mỗi khi danh sách trang thay đổi (để nút Chia sẻ mở được ngay). */
  function preparePdf() {
    state.pdfBlob = null;
    if (!state.pages.length) return;
    var stampAt = state.pages.slice();
    makePdf().then(function (pdf) {
      if (stampAt.length === state.pages.length && stampAt.every(function (p, i) { return p === state.pages[i]; })) state.pdfBlob = pdf;
    });
  }

  // ---------------------------------------------------------------------------
  // Chia sẻ: mở bảng chia sẻ của hệ điều hành (iPhone/Android) → Zalo, OneDrive,
  // Lưu vào Tệp, Mail… Không hỗ trợ thì tải file về.
  // ---------------------------------------------------------------------------
  function shareFile(blob, name, type, title) {
    var msg = $('shareMsg');
    if (!blob) { flash('Đang chuẩn bị file, bấm lại sau giây lát…'); return; }
    var file;
    try { file = new File([blob], name, { type: type }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: title }).catch(function (e) {
        if (e && e.name === 'AbortError') return; // người dùng đóng bảng chia sẻ
        download(blob, name);
        flash('Không mở được bảng chia sẻ — đã tải file về máy.');
      });
    } else {
      download(blob, name);
      flash('Trình duyệt này không chia sẻ được file — đã tải file về. Trên iPhone hãy mở bằng Safari.');
    }
    function flash(t) {
      if (!msg) { alert(t); return; }
      msg.textContent = t; msg.hidden = false;
      clearTimeout(flash.t); flash.t = setTimeout(function () { msg.hidden = true; }, 6000);
    }
  }

  // ---------------------------------------------------------------------------
  // Gắn sự kiện
  // ---------------------------------------------------------------------------
  function init() {
    $('fileInput').addEventListener('change', function (e) { handleFiles(e.target.files); e.target.value = ''; });
    $('fileCamera').addEventListener('change', function (e) { handleFiles(e.target.files); e.target.value = ''; });
    var dz = $('dropZone');
    ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
    document.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
    document.addEventListener('paste', function (e) {
      var files = [];
      Array.prototype.forEach.call(e.clipboardData.items || [], function (it) { if (it.kind === 'file') files.push(it.getAsFile()); });
      handleFiles(files);
    });

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) $('btnLive').hidden = false;
    $('btnLive').onclick = startLive;
    $('btnLiveCancel').onclick = function () { show(state.pages.length ? 'stepPages' : 'stepPick'); };
    $('btnShutter').onclick = capture;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && live.stream) show('stepPick');
    });

    initCropEvents();
    $('btnBack').onclick = function () { state.queue = []; show(state.pages.length ? 'stepPages' : 'stepPick'); };
    $('btnAuto').onclick = runDetection;
    $('btnFull').onclick = function () {
      state.corners = DocScanner.defaultCorners(state.src.width, state.src.height, 0);
      drawCrop();
    };
    $('btnScan').onclick = function () { show('stepResult'); rescan(); };

    Array.prototype.forEach.call(document.querySelectorAll('.filter'), function (b) {
      b.onclick = function () {
        document.querySelectorAll('.filter').forEach(function (x) { x.classList.toggle('active', x === b); });
        state.mode = b.getAttribute('data-mode');
        rescan();
      };
    });
    $('btnRecrop').onclick = function () { show('stepCrop'); };
    $('btnRotL').onclick = function () { state.rotation = (state.rotation + 3) % 4; rescan(); };
    $('btnRotR').onclick = function () { state.rotation = (state.rotation + 1) % 4; rescan(); };
    $('btnJpg').onclick = function () { exportImage('image/jpeg', 'jpg'); };
    $('btnPng').onclick = function () { exportImage('image/png', 'png'); };
    $('btnAdd').onclick = addPage;
    $('btnPages').onclick = function () { show('stepPages'); };
    $('btnMore').onclick = function () { show('stepPick'); };
    $('btnPdf').onclick = exportPdf;
    $('btnSharePdf').onclick = function () { shareFile(state.pdfBlob, 'scan-' + stamp() + '.pdf', 'application/pdf', 'Tài liệu scan'); };
    $('btnShareImg').onclick = function () { shareFile(state.resultBlob, 'scan-' + stamp() + '.jpg', 'image/jpeg', 'Ảnh scan'); };

    // Cài như app (PWA): đăng ký service worker để chạy offline.
    // Bỏ qua trong bản xem thử 1 file (khung xem không hỗ trợ service worker).
    if ('serviceWorker' in navigator && !document.getElementById('scanner-core-src') &&
        (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    window.addEventListener('resize', function () {
      if ($('stepCrop').classList.contains('active')) layoutCrop();
      if ($('stepResult').classList.contains('active')) drawResult();
    });
    renderPages();
  }

  init();
})();

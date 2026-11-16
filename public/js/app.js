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
    ['stepPick', 'stepCrop', 'stepResult', 'stepPages'].forEach(function (id) {
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

  function openFile(file) {
    loadBitmap(file).then(function (bmp) {
      var w = bmp.width, h = bmp.height, s = Math.min(1, WORK_MAX / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      var ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      var id = ctx.getImageData(0, 0, c.width, c.height);
      state.src = { data: id.data, width: id.width, height: id.height };
      state.srcCanvas = c;
      state.rotation = 0;
      state.warped = null;
      runDetection();
      show('stepCrop');
    }).catch(function (e) { alert(e.message); });
  }

  function runDetection() {
    var t = performance.now();
    var det = DocScanner.detectDocument(state.src);
    state.detection = det;
    state.corners = det.corners;
    $('detectInfo').textContent = det.found
      ? 'Đã tìm thấy tờ giấy (' + Math.round(performance.now() - t) + ' ms). Kéo các góc nếu cần chỉnh.'
      : 'Không chắc chắn vị trí tờ giấy — hãy kéo 4 góc vào đúng mép giấy.';
    drawCrop();
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

  function download(blob, name) {
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
  }

  function exportPdf() {
    Promise.all(state.pages.map(function (p) {
      return p.blob.arrayBuffer().then(function (buf) { return { jpeg: new Uint8Array(buf), width: p.width, height: p.height }; });
    })).then(function (pages) { download(buildPdf(pages), 'scan-' + stamp() + '.pdf'); });
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

    window.addEventListener('resize', function () {
      if ($('stepCrop').classList.contains('active')) layoutCrop();
      if ($('stepResult').classList.contains('active')) drawResult();
    });
    renderPages();
  }

  init();
})();

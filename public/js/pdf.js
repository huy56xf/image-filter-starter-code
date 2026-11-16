/*
 * pdf.js — Tạo file PDF nhiều trang từ các ảnh JPEG (không cần thư viện).
 * Mỗi trang chứa đúng một ảnh JPEG (bộ lọc DCTDecode), khổ trang theo tỉ lệ ảnh,
 * chiều rộng cố định 595pt (= chiều rộng A4).
 */
(function (root) {
  'use strict';

  function enc(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /**
   * @param pages Array<{ jpeg: Uint8Array, width: number, height: number }>
   * @returns Blob (application/pdf)
   */
  function buildPdf(pages) {
    var chunks = [], offsets = [], pos = 0;
    function push(bytes) { chunks.push(bytes); pos += bytes.length; }
    function obj(id, body, stream) {
      offsets[id] = pos;
      push(enc(id + ' 0 obj\n' + body + '\n'));
      if (stream) { push(enc('stream\n')); push(stream); push(enc('\nendstream\n')); }
      push(enc('endobj\n'));
    }

    push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    var n = pages.length, kids = [];
    // id: 1 catalog, 2 pages, rồi mỗi trang 3 object: page, image, content
    for (var i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>');
    pages.forEach(function (p, i) {
      var pid = 3 + i * 3, iid = pid + 1, cid = pid + 2;
      var pw = 595, ph = Math.round(595 * p.height / p.width * 100) / 100;
      obj(pid, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] ' +
        '/Resources << /XObject << /Im' + i + ' ' + iid + ' 0 R >> >> /Contents ' + cid + ' 0 R >>');
      obj(iid, '<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>', p.jpeg);
      var content = enc('q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im' + i + ' Do Q');
      obj(cid, '<< /Length ' + content.length + ' >>', content);
    });

    var xref = pos, total = 3 + n * 3, x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var k = 1; k < total; k++) x += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
    push(enc(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
    return new Blob(chunks, { type: 'application/pdf' });
  }

  root.buildPdf = buildPdf;
})(typeof self !== 'undefined' ? self : this);

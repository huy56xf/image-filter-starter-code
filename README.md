# Máy quét tài liệu (Document Scanner) + Image Filter API

Ứng dụng quét tài liệu kiểu **CamScanner**: chụp/chọn ảnh có tờ giấy → **tự nhận diện 4 góc** →
**nắn phẳng phối cảnh** → **làm trắng nền, khử bóng** → tải về JPG/PNG hoặc gộp nhiều trang thành **PDF**.

Toàn bộ thuật toán viết bằng JavaScript thuần (không OpenCV), chạy được **ngay trong trình duyệt**
(ảnh không rời khỏi máy) và **trên server** qua API.

Tìm hiểu chi tiết công nghệ: [docs/CONG-NGHE-SCAN.md](docs/CONG-NGHE-SCAN.md)

## Cài lên iPhone (như một app)

Ứng dụng là **PWA**: không cần App Store, cài trực tiếp từ Safari.

1. Đăng web lên một địa chỉ HTTPS — đơn giản nhất là **GitHub Pages** (đã có sẵn
   `.github/workflows/pages.yml`): vào *Settings → Pages → Source: GitHub Actions*, gộp code vào nhánh `main`;
   link sẽ có dạng `https://<tài-khoản>.github.io/image-filter-starter-code/`.
2. Trên iPhone mở link bằng **Safari** → nút **Chia sẻ** → **Thêm vào Màn hình chính**.
3. Mở app từ icon "Quét giấy": chạy toàn màn hình, dùng được camera, **chạy cả khi không có mạng**
   (mọi xử lý ảnh nằm trên máy, không gửi ảnh đi đâu).

**Lưu / gửi file**: nút **Chia sẻ / Lưu** (ảnh) và **Chia sẻ PDF** mở bảng chia sẻ của iOS:
- **Zalo** → chọn người/nhóm để gửi file;
- **OneDrive** (cần cài app OneDrive) hoặc **Lưu vào Tệp → OneDrive**;
- Mail, AirDrop, Google Drive…

## Chạy thử

```bash
npm install
npm run dev          # http://localhost:8082
npm test             # kiểm thử lõi xử lý ảnh
```

Thử trên điện thoại qua HTTPS (để dùng camera trực tiếp): `cloudflared tunnel --url http://localhost:8082`
rồi mở link `https://….trycloudflare.com` được in ra.

Mở `http://localhost:8082` (trên điện thoại cùng mạng LAN: `http://<ip-máy>:8082`; muốn mở camera trực tiếp
trên điện thoại cần HTTPS hoặc dùng nút "Chụp ảnh" — nút này mở app camera qua `capture="environment"`).

1. **Quét trực tiếp** (khung tờ giấy vẽ realtime trên camera, giữ yên để tự chụp — cần HTTPS hoặc localhost),
   hoặc **Chụp ảnh / Chọn từ thư viện** (kéo-thả, dán Ctrl+V; chọn nhiều ảnh để quét liên tiếp).
2. Kiểm tra khung xanh quanh tờ giấy, kéo các góc nếu cần (có kính lúp phóng to).
3. **Quét** → chọn bộ lọc: *Màu nét*, *Xám*, *Đen trắng*, *Gốc*; xoay trái/phải.
4. **Tải JPG/PNG** hoặc **Thêm vào tài liệu** → sắp xếp trang → **Xuất PDF**.

## API

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| `GET` | `/scan?image_url=<URL>&mode=magic\|gray\|bw\|original` | Quét ảnh từ URL công khai |
| `POST` | `/scan?mode=...` (body: ảnh, `Content-Type: image/*`) | Quét ảnh tải lên |
| `GET` | `/filteredimage?image_url=<URL>` | API lọc ảnh cũ (resize 256px, xám) |

```bash
curl --data-binary @photo.jpg -H "Content-Type: image/jpeg" \
     "http://localhost:8082/scan?mode=bw" -o scan.png -D -
```

Header phản hồi: `X-Document-Found`, `X-Document-Confidence`, `X-Document-Corners` (toạ độ 4 góc tìm được).

## Cấu trúc

```
public/
  index.html, css/app.css   giao diện web (mobile-first)
  js/scanner-core.js        lõi: nhận diện giấy, homography, tăng cường ảnh (dùng chung browser + Node)
  js/pdf.js                 tạo PDF nhiều trang từ JPEG
  js/app.js                 logic giao diện (chỉnh góc, bộ lọc, trang)
src/
  server.ts                 Express: API + phục vụ giao diện
  util/scanner.ts           bọc lõi xử lý cho server (đọc/ghi ảnh bằng Jimp)
test/scanner.test.js        kiểm thử bằng ảnh tổng hợp có phối cảnh, bóng đổ, nhiễu
docs/CONG-NGHE-SCAN.md      giải thích công nghệ
```

> Triển khai Elastic Beanstalk: script `npm run build` hiện chỉ đóng gói thư mục `www/`;
> cần chép thêm thư mục `public/` vào gói để có giao diện và API `/scan`.

## Image Filter API (dự án gốc)

check screenshot of elastic beanstalk and eb init, eb create in file  Screenshot of elastic beanstalks.docx

check elastic beanstalk api:
http://image-filter-starter-code-dev422.us-east-1.elasticbeanstalk.com/filteredimage?image_url=https://media-cdn-v2.laodong.vn/Storage/NewsPortal/2020/6/30/816260/Cho-1.jpg

local api:
http://localhost:8082/filteredimage?image_url=https://media-cdn-v2.laodong.vn/Storage/NewsPortal/2020/6/30/816260/Cho-1.jpg

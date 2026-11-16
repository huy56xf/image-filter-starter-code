# Máy quét tài liệu (Document Scanner) + Image Filter API

Ứng dụng quét tài liệu kiểu **CamScanner**: chụp/chọn ảnh có tờ giấy → **tự nhận diện 4 góc** →
**nắn phẳng phối cảnh** → **làm trắng nền, khử bóng** → tải về JPG/PNG hoặc gộp nhiều trang thành **PDF**.

Toàn bộ thuật toán viết bằng JavaScript thuần (không OpenCV), chạy được **ngay trong trình duyệt**
(ảnh không rời khỏi máy) và **trên server** qua API.

Tìm hiểu chi tiết công nghệ: [docs/CONG-NGHE-SCAN.md](docs/CONG-NGHE-SCAN.md)

## Chạy thử

```bash
npm install
npm run dev          # http://localhost:8082
npm test             # kiểm thử lõi xử lý ảnh
```

Mở `http://localhost:8082` (trên điện thoại cùng mạng LAN: `http://<ip-máy>:8082`; muốn mở camera trực tiếp
trên điện thoại cần HTTPS hoặc dùng nút "Chụp ảnh" — nút này mở app camera qua `capture="environment"`).

1. **Chụp ảnh / Chọn từ thư viện** (hoặc kéo-thả, dán Ctrl+V; chọn nhiều ảnh để quét liên tiếp).
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

# Công nghệ biến ảnh chụp thành bản scan (kiểu CamScanner)

Tài liệu này giải thích các ứng dụng như CamScanner, Adobe Scan, Microsoft Lens, Google Drive Scan
biến một tấm ảnh chụp tài liệu bằng điện thoại thành "bản scan" phẳng, nền trắng, chữ rõ,
và cách ứng dụng trong repo này làm lại quy trình đó (`public/js/scanner-core.js`).

## 1. Tổng quan quy trình

```
Ảnh chụp ─► (1) Nhận diện tờ giấy ─► (2) Nắn phối cảnh ─► (3) Tăng cường ảnh ─► (4) Xuất JPG/PNG/PDF (+ OCR)
              tìm 4 góc               homography 3x3       khử bóng, làm trắng
```

| Bước | Mục đích | Kỹ thuật cổ điển | Ứng dụng thương mại hiện nay |
|---|---|---|---|
| 1. Nhận diện | Tìm 4 góc tờ giấy | Canny + contour + `approxPolyDP`, Hough lines | Mạng nơ-ron phân vùng / dự đoán góc (vd. Dropbox dùng mạng phát hiện biên + Hough), chạy theo thời gian thực trên khung hình camera |
| 2. Nắn phẳng | Đưa tứ giác về hình chữ nhật | `getPerspectiveTransform` + `warpPerspective` | Như cổ điển; một số app còn "làm phẳng trang sách cong" (dewarping) bằng mô hình 3D/ML |
| 3. Tăng cường | Nền trắng đều, chữ đen rõ | Chuẩn hoá ánh sáng, ngưỡng thích nghi (Otsu, Sauvola) | Bộ lọc "Magic Color"/"Auto", khử bóng tay, khử moiré, siêu phân giải |
| 4. Hậu xử lý | Lưu, tìm kiếm | Ghép PDF | OCR (Tesseract / ML Kit) tạo PDF tìm kiếm được |

## 2. Nhận diện tờ giấy

Ý tưởng: tờ giấy là **tứ giác lồi lớn nhất** trong ảnh có **4 cạnh trùng với biên mạnh**.

1. **Thu nhỏ** ảnh về ~480px (nhanh hơn, ít nhiễu chi tiết chữ).
2. **Ảnh xám + Gaussian blur** để làm mờ chữ và vân nền.
3. **Canny**: gradient Sobel → triệt tiêu điểm không cực đại (NMS) → ngưỡng trễ (hysteresis).
   Ngưỡng tự động theo phân vị độ lớn gradient (thử 3 mức khác nhau).
4. **Sinh ứng viên** tứ giác theo nhiều cách (mỗi cách mạnh trong một tình huống):
   - *Vùng kín bởi biên*: thành phần liên thông của phần không phải biên (lòng tờ giấy).
   - *Thành phần biên*: đường viền giấy là một chuỗi biên khép kín.
   - *Ngưỡng Otsu*: giấy thường sáng hơn nền.
   - *Biến đổi Hough*: tìm các đường thẳng dài, ghép 2 cặp gần song song thành tứ giác —
     chịu được nền rối, mép giấy đứt đoạn, góc bị che hoặc lọt ra ngoài khung hình.
   Với mỗi vùng: **bao lồi** (monotone chain) → **tứ giác diện tích lớn nhất** nội tiếp bao lồi.
5. **Chấm điểm** từng tứ giác: tỉ lệ điểm trên mỗi cạnh có gradient *vuông góc với cạnh* đủ mạnh và
   *cùng dấu* (mép giấy luôn "sáng lên" hoặc "tối đi" nhất quán, còn dòng chữ thì đổi dấu liên tục),
   kết hợp với diện tích; loại tứ giác lõm, góc quá nhọn/tù, quá nhỏ.
6. **Tinh chỉnh dưới pixel**: ở độ phân giải ~1400px, gom các điểm biên dọc mỗi cạnh, khớp đường
   thẳng bằng bình phương tối thiểu (PCA) rồi lấy giao điểm 2 cạnh kề làm góc.

Nếu điểm tin cậy thấp, ứng dụng trả về khung mặc định và người dùng **kéo 4 góc** (có kính lúp phóng to)
— đây cũng là cách CamScanner xử lý trường hợp khó.

## 3. Nắn phối cảnh (perspective transform)

Ảnh của một mặt phẳng chụp từ góc bất kỳ liên hệ với ảnh chụp thẳng qua **ma trận homography** H (3×3, 8 bậc tự do):

```
[u v 1]ᵀ ~ H · [x y 1]ᵀ      u = (h11 x + h12 y + h13) / (h31 x + h32 y + 1), …
```

4 cặp điểm (4 góc ↔ 4 góc hình chữ nhật) cho 8 phương trình → giải hệ tuyến tính 8×8 (Gauss).
Khi xuất ảnh, với mỗi pixel đích ta tính ngược vị trí trong ảnh gốc rồi **nội suy song tuyến** (bilinear).

**Kích thước / tỉ lệ thật của tờ giấy**: độ dài cạnh trên ảnh bị méo do phối cảnh, nên ứng dụng dùng phương
pháp của *Zhang & He (2007), "Whiteboard scanning and image enhancement"*: từ 4 góc suy ra tiêu cự camera,
rồi tính đúng tỉ lệ rộng/cao. Nếu kết quả gần khổ chuẩn (A4 = 1:√2, Letter) thì "bắt dính" vào tỉ lệ đó.
Ảnh được cắt lẹm vào ~0.6% để bỏ viền nền sát mép.

## 4. Tăng cường "như máy scan"

Máy scan chiếu sáng đều; ảnh điện thoại thì có bóng đổ, ánh đèn vàng, sáng không đều. Cách khử:

1. **Ước lượng nền giấy** (bản đồ ánh sáng) cho từng kênh màu: thu nhỏ → **lọc max** (giãn hình thái học,
   xoá nét chữ tối) → làm mượt (box blur) → phóng to lại.
2. **Chia ảnh cho nền**: `out = I / nền × 255`. Giấy (≈ nền) thành trắng 255 ở mọi nơi → mất bóng, mất ám màu;
   chữ (tối hơn nền) giữ tương phản tương đối.
3. Tuỳ chế độ:
   - **Màu nét (Magic)**: kéo giãn mức đen/trắng + gamma làm đậm chữ + tăng bão hoà (giữ dấu mộc đỏ, chữ ký xanh).
   - **Xám**: như trên nhưng ảnh xám.
   - **Đen trắng**: nhị phân hoá thích nghi — một điểm là đen nếu tối hơn ngưỡng Otsu toàn cục *hoặc* tối hơn
     ~14% so với trung bình cục bộ (tính nhanh bằng ảnh tích phân), tương tự Sauvola.
   - **Gốc**: chỉ nắn phẳng.

## 5. Xuất file

- JPG/PNG qua `canvas.toBlob`.
- **PDF nhiều trang** tự viết (`public/js/pdf.js`): mỗi trang nhúng thẳng dữ liệu JPEG (bộ lọc `DCTDecode`),
  không cần thư viện.
- Mở rộng: gắn Tesseract.js để OCR và tạo PDF có lớp chữ tìm kiếm được.

## 6. Hướng nâng cấp

- Phát hiện theo thời gian thực trên luồng camera (`getUserMedia`) + tự chụp khi khung ổn định.
- Dùng mô hình học sâu (vd. HED/U-Net nhẹ, hoặc mô hình phân vùng tài liệu) thay Canny cho ảnh rất khó
  (giấy trắng trên bàn trắng, nền nhiều vân).
- Làm phẳng trang sách cong (page dewarping), xoá ngón tay, tự xoay theo hướng chữ (OCR orientation).
- Chuyển xử lý sang Web Worker / WebAssembly (OpenCV.js) để mượt hơn với ảnh 12MP+.

## Tài liệu tham khảo

- Z. Zhang, L.-W. He — *Whiteboard scanning and image enhancement*, Digital Signal Processing, 2007.
- J. Canny — *A Computational Approach to Edge Detection*, IEEE PAMI, 1986.
- J. Sauvola, M. Pietikäinen — *Adaptive document image binarization*, Pattern Recognition, 2000.
- N. Otsu — *A threshold selection method from gray-level histograms*, 1979.
- Dropbox Tech Blog — *Fast and Accurate Document Detection for Scanning* (2016).
- OpenCV docs — `Canny`, `findContours`, `approxPolyDP`, `getPerspectiveTransform`, `warpPerspective`.

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
   - *Mép khung hình*: 4 mép ảnh cũng là "đường thẳng" ứng viên, nên tứ giác được phép có cạnh nằm
     trên mép ảnh khi tờ giấy tràn ra ngoài khung (chụp cận). Cạnh như vậy chỉ được điểm khi dải ảnh
     sát mép trông như giấy (đa số điểm sáng, ít màu).
   - *Phân biệt đường kẻ với mép giấy*: khung bảng, ô kẻ có biên rất mạnh nhưng là **nét tối mảnh,
     hai bên đều là giấy trắng**; mép giấy là **bậc chuyển** giấy → nền. Lấy mặt cắt độ sáng vuông góc
     với cạnh (căn tâm từng mẫu, lấy nền sáng nhất mỗi bên để bỏ qua chữ) và giảm điểm các cạnh dạng "đường kẻ".
6. **Tinh chỉnh dưới pixel**: ở độ phân giải ~1400px, gom các điểm biên dọc mỗi cạnh, khớp đường
   thẳng bằng bình phương tối thiểu (PCA) rồi lấy giao điểm 2 cạnh kề làm góc.

Nếu điểm tin cậy thấp, ứng dụng trả về khung mặc định và người dùng **kéo 4 góc** (có kính lúp phóng to)
— đây cũng là cách CamScanner xử lý trường hợp khó.

### 2.1 Các họ thuật toán tìm khung trang giấy

| Cách tiếp cận | Ý tưởng | Mạnh | Yếu |
|---|---|---|---|
| Canny + contour + `approxPolyDP` (OpenCV kinh điển) | Tìm đường viền khép kín, xấp xỉ đa giác 4 đỉnh | Nhanh, đơn giản | Gãy khi mép đứt đoạn, nền rối, bị che góc |
| Biến đổi Hough / LSD (Line Segment Detector) | Tìm đường thẳng dài, ghép 4 đường thành tứ giác | Chịu được mép đứt, góc bị che/lọt khung | Nhiều tổ hợp; dễ bắt nhầm khung bảng, mép bàn |
| Phân vùng (Otsu, GrabCut, closing hình thái) | Giấy là vùng sáng lớn, đồng màu | Tốt khi giấy tương phản với nền | Giấy trắng trên nền trắng |
| Học sâu – biên (HED, mạng phát hiện biên của Dropbox) | Mạng nơ-ron chỉ giữ lại biên "mép tài liệu", bỏ biên chữ | Rất bền, chạy realtime trên điện thoại | Cần dữ liệu huấn luyện + mô hình |
| Học sâu – phân vùng / điểm góc (U-Net, DocAligner, heatmap 4 góc) | Dự đoán mặt nạ trang hoặc trực tiếp 4 góc | Tốt nhất với giấy chồng giấy, thiếu sáng | Mô hình vài MB, cần WebGL/WASM |

CamScanner, Adobe Scan, Microsoft Lens… dùng học sâu cho bước này và **chạy liên tục trên luồng camera**:
khung được vẽ realtime, làm mượt theo thời gian, và tự chụp khi khung đứng yên.

### 2.2 Ứng dụng này làm gì

Kết hợp các cách cổ điển và chấm điểm chung:

- Hai nhánh ảnh: ảnh gốc, và **ảnh đã xoá chữ** bằng phép đóng (lọc max rồi lọc min, bán kính ~1% ảnh).
  Phép đóng xoá mọi nét tối mảnh (chữ, đường kẻ, dấu mộc) nhưng giữ nguyên mép tờ giấy, nên biên mờ của
  mép giấy không bị chữ "lấn át" khi tính ngưỡng.
- Ứng viên từ: vùng kín, thành phần biên, Otsu, Hough (trên cả hai nhánh) và cả **mép khung hình**.
- Chấm điểm cạnh: độ bám biên cùng dấu, trừ điểm cạnh là "đường kẻ trên giấy", cạnh trùng mép ảnh chỉ được
  điểm khi dải sát mép trông như giấy.
- **Dự phòng theo nội dung** khi mép giấy gần như vô hình (giấy trắng trên chồng giấy trắng, thiếu sáng):
  dùng khung bảng/khối kẻ rõ nhất để biết phối cảnh, dàn phẳng các điểm mực, lấy khung bao nội dung + lề rồi
  chiếu ngược lại → khung vẫn đúng hướng nghiêng và ôm sát trang thay vì lấy cả ảnh.
- **Quét trực tiếp**: mỗi khung hình video thu nhỏ còn 320px, nhận diện trong Web Worker (không giật giao diện),
  khung hiển thị trượt mượt về kết quả mới, đổi màu khi đứng yên; giữ yên 1,2 giây thì tự chụp ở độ phân giải
  đầy đủ và nhận diện lại chính xác hơn.

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

### 3.1 Nắn cong (giấy cong, gáy sách, giấy võng)

Phép biến đổi phối cảnh chỉ đúng với mặt phẳng. Giấy cong thì sau bước trên các dòng chữ vẫn lượn. Ứng dụng nắn
tiếp dựa trên chính nội dung trang (sau khi đã xoay đúng chiều):

1. Mặt nạ mực → bỏ nét dọc dài (cột bảng) và mảnh nhỏ (dấu thanh, để dòng trên/dưới không dính nhau)
   → "bôi" ngang để mỗi dòng chữ / đường kẻ ngang thành một dải.
2. Mỗi dải dài, mảnh: đường tâm `y = f(x)` (đa thức bậc 5, loại điểm lệch, bỏ dòng không sạch).
3. Trường dịch chuyển **dọc** trơn trên cả trang `dy(x,y) = Σ c_ij·x^i·y^j` (bậc 5 theo x, ≤ 2 theo y), khớp bình
   phương tối thiểu từ độ lệch của mọi dòng so với chính nó (nên cũng khử luôn độ nghiêng còn sót).
4. Ánh xạ lại `(x, y) ← (x, y + dy)`. Chỉ dịch dọc, và trường biến đổi chậm hơn nhiều so với cỡ chữ → mỗi chữ chỉ được
   dời nguyên khối, **không bị méo**; dòng chữ và đường kẻ bảng thẳng lại.

An toàn: < 3 dòng đáng tin, độ cong < 2px (trang đã phẳng) hoặc lớn bất thường → giữ nguyên. Có thể tắt bằng ô
**Nắn cong** ở màn kết quả. (Các app thương mại còn dùng mô hình 3D mặt giấy hoặc học sâu để nắn cả chiều ngang
— chữ sát gáy sách bị co lại; ở đây cố ý chỉ nắn dọc để không làm biến dạng chữ.)

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

import Jimp = require("jimp");
import path from "path";

// Lõi xử lý dùng chung với trình duyệt (public/js/scanner-core.js)
// tslint:disable-next-line:no-var-requires
const DocScanner = require(path.join(__dirname, "..", "..", "public", "js", "scanner-core.js"));

export type ScanMode = "magic" | "gray" | "bw" | "original";
export const SCAN_MODES: ScanMode[] = ["magic", "gray", "bw", "original"];

export interface ScanResult {
  buffer: Buffer;
  mime: string;
  found: boolean;
  confidence: number;
  corners: Array<{ x: number; y: number }>;
}

// scanImage
// Nhận diện tờ giấy trong ảnh, nắn phối cảnh và tăng cường như bản scan.
// INPUTS
//    input: Buffer chứa ảnh (JPEG/PNG/BMP...) hoặc URL công khai tới ảnh
//    mode:  magic | gray | bw | original
// RETURNS
//    ảnh kết quả (JPEG, hoặc PNG với chế độ bw) + thông tin nhận diện
export async function scanImage(input: Buffer | string, mode: ScanMode = "magic"): Promise<ScanResult> {
  const photo = await Jimp.read(input as any);
  // Giới hạn độ phân giải làm việc ~300dpi khổ A4 để xử lý nhanh
  const maxSide = 2600;
  if (Math.max(photo.bitmap.width, photo.bitmap.height) > maxSide) {
    if (photo.bitmap.width >= photo.bitmap.height) photo.resize(maxSide, Jimp.AUTO);
    else photo.resize(Jimp.AUTO, maxSide);
  }
  const img = { data: photo.bitmap.data, width: photo.bitmap.width, height: photo.bitmap.height };
  const res = DocScanner.scan(img, { mode });
  const out = new Jimp(res.image.width, res.image.height);
  out.bitmap.data = Buffer.from(res.image.data.buffer, res.image.data.byteOffset, res.image.data.length);
  const mime = mode === "bw" ? Jimp.MIME_PNG : Jimp.MIME_JPEG;
  if (mime === Jimp.MIME_JPEG) out.quality(90);
  const buffer = await out.getBufferAsync(mime);
  return {
    buffer,
    mime,
    found: res.detection.found,
    confidence: res.detection.confidence,
    corners: res.detection.corners,
  };
}

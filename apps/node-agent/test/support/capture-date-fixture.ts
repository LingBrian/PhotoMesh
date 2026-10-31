export function jpegWithExifCaptureDate(
  dateTime = '2024:04:02 12:04:05',
  offsetTime = '+03:00'
): Uint8Array {
  const dateBytes = new TextEncoder().encode(`${dateTime}\0`);
  const offsetBytes = new TextEncoder().encode(`${offsetTime}\0`);
  if (dateBytes.byteLength !== 20 || offsetBytes.byteLength !== 7) throw new Error('fixture values must match fixed EXIF lengths');
  const tiff = new Uint8Array(83);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8769, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, 2, true);
  view.setUint16(28, 0x9003, true);
  view.setUint16(30, 2, true);
  view.setUint32(32, dateBytes.byteLength, true);
  view.setUint32(36, 56, true);
  view.setUint16(40, 0x9011, true);
  view.setUint16(42, 2, true);
  view.setUint32(44, offsetBytes.byteLength, true);
  view.setUint32(48, 76, true);
  view.setUint32(52, 0, true);
  tiff.set(dateBytes, 56);
  tiff.set(offsetBytes, 76);

  const exifHeader = new TextEncoder().encode('Exif\0\0');
  const payload = new Uint8Array(exifHeader.byteLength + tiff.byteLength);
  payload.set(exifHeader);
  payload.set(tiff, exifHeader.byteLength);
  const jpeg = new Uint8Array(payload.byteLength + 8);
  jpeg.set([0xff, 0xd8, 0xff, 0xe1], 0);
  new DataView(jpeg.buffer).setUint16(4, payload.byteLength + 2, false);
  jpeg.set(payload, 6);
  jpeg.set([0xff, 0xd9], jpeg.byteLength - 2);
  return jpeg;
}

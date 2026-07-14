// Generate a radar/dashboard style .ico file for Claude Cockpit
// Uses only Node.js built-in modules

const fs = require('fs');
const path = require('path');

const SIZE = 64;

// Create RGBA pixel buffer (SIZE x SIZE)
const pixels = Buffer.alloc(SIZE * SIZE * 4, 0); // all transparent

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const idx = (y * SIZE + x) * 4;
  pixels[idx]     = r;
  pixels[idx + 1] = g;
  pixels[idx + 2] = b;
  pixels[idx + 3] = a;
}

// Colors
const GREEN  = [0xa6, 0xe3, 0xa1, 255]; // #a6e3a1
const DIM    = [0x6c, 0x9e, 0x69, 180]; // dimmer green for grid lines
const BG     = [0x1e, 0x1e, 0x2e, 255]; // #1e1e2e background

// --- Fill background circle ---
const cx = 31.5, cy = 31.5, R = 30;

function dist(x, y) {
  return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
}

// Fill background
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = dist(x, y);
    if (d <= R) {
      setPixel(x, y, BG[0], BG[1], BG[2], 255);
    }
  }
}

// --- Draw thick outer circle (border) ---
function drawCircle(cx, cy, r, thickness, color) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = dist(x, y);
      if (d >= r - thickness && d <= r) {
        setPixel(x, y, color[0], color[1], color[2], color[3]);
      }
    }
  }
}

drawCircle(cx, cy, R, 2.5, GREEN);

// --- Draw inner rings (like radar) ---
drawCircle(cx, cy, 20, 1.2, DIM);
drawCircle(cx, cy, 10, 1.2, DIM);

// --- Draw crosshair lines ---
function drawLine(x0, y0, x1, y1, color, thickness) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(len * 4);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const fx = x0 + dx * t;
    const fy = y0 + dy * t;
    // paint a small square of the given thickness
    const half = (thickness - 1) / 2;
    for (let oy = -Math.floor(half); oy <= Math.ceil(half); oy++) {
      for (let ox = -Math.floor(half); ox <= Math.ceil(half); ox++) {
        setPixel(Math.round(fx + ox), Math.round(fy + oy), color[0], color[1], color[2], color[3]);
      }
    }
  }
}

// Horizontal line (only inside the outer circle)
drawLine(cx - R + 2.5, cy, cx + R - 2.5, cy, DIM, 1);
// Vertical line
drawLine(cx, cy - R + 2.5, cx, cy + R - 2.5, DIM, 1);

// --- Draw a sweep arc (radar sweep from center pointing ~45 degrees) ---
// Draw a line from center toward upper-right quadrant
drawLine(cx, cy, cx + 20, cy - 20, GREEN, 2);

// --- Draw center dot ---
function fillCircle(cx, cy, r, color) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (dist(x, y) <= r) {
        setPixel(x, y, color[0], color[1], color[2], color[3]);
      }
    }
  }
}

// Overwrite center area with bg first (already done), then dot
// Draw the sweep line first, then center dot on top
fillCircle(32, 32, 3, GREEN);

// --- Draw a blip dot on the sweep line ---
fillCircle(Math.round(cx + 14), Math.round(cy - 14), 2.5, GREEN);

// ============================================================
// Now encode as ICO with embedded BMP (32-bit BITMAPINFOHEADER)
// ============================================================

// ICO header: 6 bytes
//   WORD reserved = 0
//   WORD type     = 1 (icon)
//   WORD count    = 1

// Directory entry: 16 bytes per image
//   BYTE width   (0 = 256)
//   BYTE height  (0 = 256)
//   BYTE colorCount
//   BYTE reserved
//   WORD planes
//   WORD bitCount (32)
//   DWORD sizeInBytes
//   DWORD offset

// BMP data: BITMAPINFOHEADER (40 bytes) + pixel data (BGRA, bottom-up, no AND mask needed for 32-bit)

const bmpHeaderSize = 40;
const pixelDataSize = SIZE * SIZE * 4; // 32-bit BGRA
const bmpSize = bmpHeaderSize + pixelDataSize;

// ICO header
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);  // reserved
icoHeader.writeUInt16LE(1, 2);  // type = 1 (icon)
icoHeader.writeUInt16LE(1, 4);  // count = 1

// BITMAPINFOHEADER
const bmpHeader = Buffer.alloc(bmpHeaderSize);
bmpHeader.writeUInt32LE(bmpHeaderSize, 0);  // biSize
bmpHeader.writeInt32LE(SIZE, 4);            // biWidth
bmpHeader.writeInt32LE(SIZE * 2, 8);        // biHeight (x2 for XOR + AND mask convention)
bmpHeader.writeUInt16LE(1, 12);             // biPlanes
bmpHeader.writeUInt16LE(32, 14);            // biBitCount (32-bit)
bmpHeader.writeUInt32LE(0, 16);             // biCompression (BI_RGB)
bmpHeader.writeUInt32LE(pixelDataSize, 20); // biSizeImage
bmpHeader.writeInt32LE(0, 24);              // biXPelsPerMeter
bmpHeader.writeInt32LE(0, 28);              // biYPelsPerMeter
bmpHeader.writeUInt32LE(0, 32);             // biClrUsed
bmpHeader.writeUInt32LE(0, 36);             // biClrImportant

// Pixel data: BMP is bottom-up, and ICO uses BGRA order
const bmpPixels = Buffer.alloc(pixelDataSize);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const srcIdx = (y * SIZE + x) * 4;           // top-to-bottom
    const dstRow = SIZE - 1 - y;                 // flip vertically
    const dstIdx = (dstRow * SIZE + x) * 4;
    bmpPixels[dstIdx]     = pixels[srcIdx + 2];  // B
    bmpPixels[dstIdx + 1] = pixels[srcIdx + 1];  // G
    bmpPixels[dstIdx + 2] = pixels[srcIdx];      // R
    bmpPixels[dstIdx + 3] = pixels[srcIdx + 3];  // A
  }
}

// ICO directory entry
const dirEntry = Buffer.alloc(16);
dirEntry.writeUInt8(SIZE, 0);          // width
dirEntry.writeUInt8(SIZE, 1);          // height
dirEntry.writeUInt8(0, 2);             // colorCount
dirEntry.writeUInt8(0, 3);             // reserved
dirEntry.writeUInt16LE(1, 4);          // planes
dirEntry.writeUInt16LE(32, 6);         // bitCount
dirEntry.writeUInt32LE(bmpSize, 8);    // sizeInBytes
dirEntry.writeUInt32LE(6 + 16, 12);    // offset = icoHeader(6) + dirEntry(16)

const icoBuffer = Buffer.concat([icoHeader, dirEntry, bmpHeader, bmpPixels]);

const outPath = path.join(__dirname, 'icon.ico');
fs.writeFileSync(outPath, icoBuffer);
console.log(`Written: ${outPath} (${icoBuffer.length} bytes)`);

// Generate simple PNG icons for the Chrome extension
// Run with: node make_icons.js
const fs = require('fs')
const path = require('path')

// Minimal PNG generator for a solid colored circle icon
function createPNG(size) {
  // Create a simple image with a blue circle on transparent background
  const pixels = Buffer.alloc(size * size * 4, 0) // RGBA

  const cx = size / 2
  const cy = size / 2
  const r = size * 0.4

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const idx = (y * size + x) * 4

      if (dist <= r) {
        // Blue circle (#89b4fa)
        pixels[idx] = 0x89     // R
        pixels[idx + 1] = 0xb4 // G
        pixels[idx + 2] = 0xfa // B
        pixels[idx + 3] = 0xff // A
      } else if (dist <= r + 1) {
        // Anti-aliased edge
        const alpha = Math.max(0, Math.min(255, Math.round((r + 1 - dist) * 255)))
        pixels[idx] = 0x89
        pixels[idx + 1] = 0xb4
        pixels[idx + 2] = 0xfa
        pixels[idx + 3] = alpha
      }
    }
  }

  return encodePNG(size, size, pixels)
}

function encodePNG(width, height, rgba) {
  const zlib = require('zlib')

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR chunk
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type (RGBA)
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // Raw image data with filter bytes
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }

  const compressed = zlib.deflateSync(raw)

  // Build chunks
  const chunks = [
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]

  return Buffer.concat([signature, ...chunks])
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)

  const typeBytes = Buffer.from(type, 'ascii')
  const crcData = Buffer.concat([typeBytes, data])

  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcData), 0)

  return Buffer.concat([len, typeBytes, data, crc])
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Generate icons
for (const size of [16, 48, 128]) {
  const png = createPNG(size)
  const outPath = path.join(__dirname, `icon${size}.png`)
  fs.writeFileSync(outPath, png)
  console.log(`Created ${outPath} (${png.length} bytes)`)
}

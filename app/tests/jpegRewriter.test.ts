import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '@ipp/core'
import { Readable, Writable } from 'stream'
import { pipeline } from 'stream/promises'
import { createJpegRewriter, isJpeg, loadDownloadMetadataOptions, RewriteOptions } from '../src/stream/jpegRewriter'
import { buildIim, buildXmp, Entry, readExif, serializeTiff, truncateUtf8 } from '../src/stream/metadataBlocks'

// The rewriter never decodes pixels, so these tests use synthetic JPEGs: real
// marker structure, dummy table and image bytes. Output was also checked
// against exiftool and a PIL decode (pixels identical) while developing.

const ascii = (tag: number, text: string): Entry => {
  const value = Buffer.from(text + '\0')
  return { tag, type: 2, count: value.length, value }
}
const short = (tag: number, n: number): Entry => ({ tag, type: 3, count: 1, value: Buffer.from([n & 0xFF, n >> 8]) })
const undef = (tag: number, bytes: number[]): Entry => ({ tag, type: 7, count: bytes.length, value: Buffer.from(bytes) })

const seg = (marker: number, payload: Buffer) => {
  const head = Buffer.from([0xFF, marker, payload.length + 2 >> 8, (payload.length + 2) & 0xFF])
  return Buffer.concat([head, payload])
}
const ENTROPY = Buffer.from([0x11, 0xFF, 0x00, 0x22, 0xFF, 0xD0, 0x33])

function makeJpeg (opts: { exif?: Buffer, trailing?: Buffer, midStreamFfd9?: boolean } = {}): Buffer {
  const parts = [
    Buffer.from([0xFF, 0xD8]),
    seg(0xE0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xE1, Buffer.concat([Buffer.from('Exif\0\0'), opts.exif || Buffer.alloc(0)])),
    seg(0xE1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>OLD-XMP-SECRET</x:xmpmeta>')),
    seg(0xED, Buffer.from('Photoshop 3.0\0OLD-IPTC-SECRET')),
    seg(0xE2, Buffer.from('MPF\0OLD-MPF')),
    seg(0xE2, Buffer.from('ICC_PROFILE\0\x01\x01PROFILE')),
    seg(0xEE, Buffer.from('Adobe\0\x64\x80\0\0\0\0\0')),
    seg(0xFE, Buffer.from('OLD-COMMENT-SECRET')),
    seg(0xDB, Buffer.alloc(65, 7)),
    seg(0xC0, Buffer.from([8, 0, 4, 0, 4, 1, 1, 0x11, 0])),
    seg(0xDA, Buffer.from([1, 1, 0, 0, 0x3F, 0])),
    ENTROPY
  ]
  if (opts.midStreamFfd9) {
    // A second scan after a table whose bytes happen to be FF D9
    parts.push(seg(0xC4, Buffer.from([0x00, 0xFF, 0xD9, 0x01])), seg(0xDA, Buffer.from([1, 1, 0, 0, 0x3F, 0])), Buffer.from([0x44, 0x55]))
  }
  parts.push(Buffer.from([0xFF, 0xD9]))
  if (opts.trailing) parts.push(opts.trailing)
  return Buffer.concat(parts)
}

const sourceExif = (le = true) => serializeTiff(le, [
  ascii(0x010F, 'Canon'), ascii(0x0110, 'EOS R5'), short(0x0112, 1), ascii(0x013B, 'Old Artist'), ascii(0x0131, 'Firmware 1')
], [
  short(0x8827, 400), ascii(0x9003, '2024:05:01 10:00:00'), ascii(0xA434, 'RF 50mm F1.8 L USM'), undef(0x927C, [1, 2, 3, 4, 5, 6]), short(0xA002, 4000)
], [
  ascii(0x0001, 'N'), ascii(0x0003, 'W')
])

const fields = { creator: ['Brent Example'], copyrightNotice: '© 2026 Brent Example', copyrightStatus: 'copyrighted' as const }
const opts = (keepExif: RewriteOptions['keepExif'], f = fields): RewriteOptions => ({ keepExif, fields: f })

async function rewrite (input: Buffer, options: RewriteOptions, chunkSize = input.length || 1): Promise<Buffer> {
  const chunks: Buffer[] = []
  const pieces: Buffer[] = []
  for (let i = 0; i < input.length; i += chunkSize) pieces.push(input.subarray(i, i + chunkSize))
  await pipeline(Readable.from(pieces), createJpegRewriter(options), new Writable({ write (c, _e, cb) { chunks.push(c); cb() } }))
  return Buffer.concat(chunks)
}

/** Split a JPEG's header into [marker, payload] pairs up to and including the first SOS. */
function segments (jpeg: Buffer) {
  const out: { marker: number, data: Buffer }[] = []
  let pos = 2
  for (;;) {
    const marker = jpeg[pos + 1]
    const length = jpeg.readUInt16BE(pos + 2)
    out.push({ marker, data: jpeg.subarray(pos + 4, pos + 2 + length) })
    pos += 2 + length
    if (marker === 0xDA) return { segments: out, rest: jpeg.subarray(pos) }
  }
}
const exifOf = (jpeg: Buffer) => {
  const s = segments(jpeg).segments.find(x => x.marker === 0xE1 && x.data.toString('latin1', 0, 6) === 'Exif\0\0')
  return s && readExif(s.data)
}

describe('createJpegRewriter', () => {
  it('discards every original metadata block and writes the configured ones', async () => {
    const out = await rewrite(makeJpeg({ exif: sourceExif() }), opts(new Set()))
    const text = out.toString('latin1')
    for (const secret of ['OLD-XMP-SECRET', 'OLD-IPTC-SECRET', 'OLD-MPF', 'OLD-COMMENT-SECRET', 'Canon', 'EOS R5', 'Old Artist', 'RF 50mm']) {
      expect(text).not.toContain(secret)
    }
    const exif = exifOf(out)!
    expect(exif.ifd0.get(0x013B)!.toString()).toBe('Brent Example\0')
    expect(exif.ifd0.get(0x8298)!.toString()).toBe('© 2026 Brent Example\0')
    expect(exif.ifd0.size).toBe(2)
    expect(exif.gps.size).toBe(0)
    expect(text).toContain('<xmpRights:Marked>True</xmpRights:Marked>')
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xFF, 0xD8]))
  })

  it('keeps JFIF, the ICC profile and the Adobe marker, and does not touch the image data', async () => {
    const out = await rewrite(makeJpeg(), opts(new Set()))
    const { segments: segs, rest } = segments(out)
    expect(segs[0].marker).toBe(0xE0)
    expect(segs.some(s => s.marker === 0xE2 && s.data.toString('latin1', 0, 12) === 'ICC_PROFILE\0')).toBe(true)
    expect(segs.some(s => s.marker === 0xEE)).toBe(true)
    expect(segs.some(s => s.marker === 0xE2 && s.data.toString('latin1', 0, 3) === 'MPF')).toBe(false)
    expect(segs.some(s => s.marker === 0xDB)).toBe(true)
    expect(segs[segs.length - 1].marker).toBe(0xDA)
    expect(rest).toEqual(Buffer.concat([ENTROPY, Buffer.from([0xFF, 0xD9])]))
  })

  it('keeps only the EXIF tags named in the keep list', async () => {
    const out = await rewrite(makeJpeg({ exif: sourceExif() }), opts(new Set(['orientation', 'iso', 'gps', 'lensModel'])))
    const exif = exifOf(out)!
    expect([...exif.ifd0.keys()].sort()).toEqual([0x0112, 0x013B, 0x8298, 0x8769, 0x8825])
    expect([...exif.exif.keys()].sort()).toEqual([0x8827, 0x9000, 0xA434])
    expect(exif.exif.get(0xA434)!.toString()).toBe('RF 50mm F1.8 L USM\0')
    expect(exif.gps.size).toBe(2)
  })

  it('handles big-endian source EXIF', async () => {
    const out = await rewrite(makeJpeg({ exif: sourceExif(false) }), opts(new Set(['make', 'iso'])))
    const exif = exifOf(out)!
    expect(exif.ifd0.get(0x010F)!.toString()).toBe('Canon\0')
    expect(exif.exif.get(0x8827)).toEqual(Buffer.from([0x90, 0x01]))
  })

  it('with keep "all", drops only what cannot or should not be carried over', async () => {
    const out = await rewrite(makeJpeg({ exif: sourceExif() }), opts('all'))
    const exif = exifOf(out)!
    expect(exif.ifd0.get(0x0110)!.toString()).toBe('EOS R5\0')
    expect(exif.exif.has(0x927C)).toBe(false)
    expect(exif.exif.has(0xA002)).toBe(false)
    expect(exif.exif.has(0x8827)).toBe(true)
    expect(exif.gps.size).toBe(2)
    expect(exif.ifd0.get(0x013B)!.toString()).toBe('Brent Example\0')
  })

  it('keeps a source Artist and Copyright when none are configured and they are in the keep list', async () => {
    const out = await rewrite(makeJpeg({ exif: sourceExif() }), opts(new Set(['artist']), {}))
    expect(exifOf(out)!.ifd0.get(0x013B)!.toString()).toBe('Old Artist\0')
  })

  it('writes no EXIF block at all when there is nothing to put in it', async () => {
    const out = await rewrite(makeJpeg({ exif: sourceExif() }), opts(new Set(), { copyrightStatus: 'copyrighted' }))
    expect(exifOf(out)).toBeUndefined()
  })

  it('drops an EXIF block it cannot parse rather than passing it through', async () => {
    const out = await rewrite(makeJpeg({ exif: Buffer.from('II*\0\xff\xff\xff\x7fGARBAGE-EXIF') }), opts(new Set(['make'])))
    expect(out.toString('latin1')).not.toContain('GARBAGE-EXIF')
    expect(exifOf(out)!.ifd0.size).toBe(2)
  })

  it('gives the same result however the input is chunked', async () => {
    const input = makeJpeg({ exif: sourceExif(), midStreamFfd9: true, trailing: Buffer.from('TRAILING') })
    const whole = await rewrite(input, opts(new Set(['make', 'gps'])))
    for (const size of [1, 2, 3, 7, 64]) {
      const out = await rewrite(input, opts(new Set(['make', 'gps'])), size)
      expect(out.equals(whole)).toBe(true)
    }
  })

  it('discards anything after the end-of-image marker', async () => {
    const out = await rewrite(makeJpeg({ trailing: Buffer.from('TRAILING-SECRET') }), opts(new Set()))
    expect(out.toString('latin1')).not.toContain('TRAILING-SECRET')
    expect(out.subarray(out.length - 2)).toEqual(Buffer.from([0xFF, 0xD9]))
  })

  it('does not mistake FF D9 inside a later segment for the end of the image', async () => {
    const out = await rewrite(makeJpeg({ midStreamFfd9: true, trailing: Buffer.from('TRAILING') }), opts(new Set()))
    expect(out.includes(Buffer.from([0x44, 0x55, 0xFF, 0xD9]))).toBe(true)
    expect(out.toString('latin1')).not.toContain('TRAILING')
  })

  it('forwards input that is not a JPEG unchanged', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\n-----not-a-jpeg-----', 'latin1')
    expect((await rewrite(png, opts(new Set()), 5)).equals(png)).toBe(true)
  })

  it('fails on a JPEG that ends before its image data', async () => {
    const whole = makeJpeg()
    await expect(rewrite(whole.subarray(0, 60), opts(new Set()))).rejects.toThrow(/Malformed/)
  })

  it('fails on a JPEG with no scan', async () => {
    const bad = Buffer.concat([Buffer.from([0xFF, 0xD8]), seg(0xDB, Buffer.alloc(65)), Buffer.from([0xFF, 0xD9])])
    await expect(rewrite(bad, opts(new Set()))).rejects.toThrow(/Malformed/)
  })
})

describe('metadata blocks', () => {
  it('escapes XML in the XMP packet', () => {
    const xmp = buildXmp({ creator: ['A & <B> "C"'], copyrightNotice: '</rdf:li><evil/>' })!.toString()
    expect(xmp).toContain('A &amp; &lt;B&gt; &quot;C&quot;')
    expect(xmp).not.toContain('<evil/>')
  })

  it('maps copyright status to xmpRights:Marked, and leaves unknown out', () => {
    expect(buildXmp({ copyrightStatus: 'public-domain', credit: 'x' })!.toString()).toContain('<xmpRights:Marked>False</')
    expect(buildXmp({ copyrightStatus: 'unknown', credit: 'x' })!.toString()).not.toContain('Marked')
    expect(buildXmp({ copyrightStatus: 'unknown' })).toBeUndefined()
  })

  it('cuts IIM text at the field limit without splitting a UTF-8 character', () => {
    expect(truncateUtf8('ééé', 5).toString()).toBe('éé')
    const iim = buildIim({ creator: ['x'.repeat(40)] })!
    expect(iim.includes(Buffer.from('x'.repeat(32)))).toBe(true)
    expect(iim.includes(Buffer.from('x'.repeat(33)))).toBe(false)
    expect(buildIim({ creatorWebsite: 'https://example.com' })).toBeUndefined()
  })
})

describe('isJpeg', () => {
  it('matches JPEG content types only', () => {
    expect(isJpeg('image/jpeg')).toBe(true)
    expect(isJpeg('image/jpeg; charset=binary')).toBe(true)
    expect(isJpeg('image/webp')).toBe(false)
    expect(isJpeg(null)).toBe(false)
  })
})

describe('loadDownloadMetadataOptions', () => {
  beforeEach(() => { delete process.env.CONFIG; loadConfig() })
  afterEach(() => { delete process.env.CONFIG; loadConfig() })
  const setConfig = (c: unknown) => { process.env.CONFIG = JSON.stringify(c); loadConfig() }

  it('is off by default', () => {
    expect(loadDownloadMetadataOptions()).toBeNull()
  })

  it('reads fields, trims them and treats empty strings as unset', () => {
    setConfig({ ipp: { downloadMetadata: { enabled: true, iptc: { creator: ' Brent ', creatorCity: '', copyrightStatus: 'public-domain' } } } })
    const o = loadDownloadMetadataOptions()!
    expect(o.fields.creator).toEqual(['Brent'])
    expect(o.fields.creatorCity).toBeUndefined()
    expect(o.fields.copyrightStatus).toBe('public-domain')
    expect([...(o.keepExif as Set<string>)]).toEqual(['orientation'])
  })

  it('accepts several creators, "all", and ignores unknown keep names and bad statuses', () => {
    setConfig({ ipp: { downloadMetadata: { enabled: true, exif: { keep: ['make', 'nonsense', 5, 'gps'] }, iptc: { creator: ['A', 'B'], copyrightStatus: 'sure' } } } })
    const o = loadDownloadMetadataOptions()!
    expect(o.fields.creator).toEqual(['A', 'B'])
    expect(o.fields.copyrightStatus).toBeUndefined()
    expect([...(o.keepExif as Set<string>)].sort()).toEqual(['gps', 'make'])
    setConfig({ ipp: { downloadMetadata: { enabled: true, exif: { keep: 'all' } } } })
    expect(loadDownloadMetadataOptions()!.keepExif).toBe('all')
  })

  it('keeps no original EXIF when the share has "Show metadata" off, but still writes the copyright fields', () => {
    setConfig({ ipp: { downloadMetadata: { enabled: true, exif: { keep: ['make', 'gps'] }, iptc: { creator: 'Brent' } } } })
    const off = loadDownloadMetadataOptions({ showMetadata: false })!
    expect([...(off.keepExif as Set<string>)]).toEqual([])
    expect(off.fields.creator).toEqual(['Brent'])
    expect([...(loadDownloadMetadataOptions({ showMetadata: true })!.keepExif as Set<string>)].sort()).toEqual(['gps', 'make'])
    expect([...(loadDownloadMetadataOptions({})!.keepExif as Set<string>)].sort()).toEqual(['gps', 'make'])
    setConfig({ ipp: { downloadMetadata: { enabled: true, exif: { keep: 'all' } } } })
    expect([...(loadDownloadMetadataOptions({ showMetadata: false })!.keepExif as Set<string>)]).toEqual([])
  })

  it('only turns on for a literal true', () => {
    setConfig({ ipp: { downloadMetadata: { enabled: 'yes' } } })
    expect(loadDownloadMetadataOptions()).toBeNull()
  })
})

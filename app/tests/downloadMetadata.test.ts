import { describe, it, expect, vi, afterEach } from 'vitest'
import { Asset, AssetType, KeyType, loadConfig, SharedLink } from '@ipp/core'
import { Writable } from 'stream'
import { once } from 'events'
import type { Request, Response } from 'express-serve-static-core'
import { assetBuffer } from '../src/stream/asset'
import { downloadAssets } from '../src/stream/download'
import { ImageSize, IncomingShareRequest } from '../src/types'

// Wires ipp.downloadMetadata into the single-file and zip download paths:
// JPEG downloads are rewritten, everything else is left alone.

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.CONFIG
  loadConfig()
})

const setConfig = (config: unknown) => { process.env.CONFIG = JSON.stringify(config); loadConfig() }
const enabled = { ipp: { downloadMetadata: { enabled: true, iptc: { creator: 'Brent Example', copyrightNotice: '© Brent Example' } } } }

const seg = (marker: number, payload: Buffer) =>
  Buffer.concat([Buffer.from([0xFF, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xFF]), payload])

// An old EXIF block (just "Exif\0\0" plus a marker string: it need not parse, it must not survive) and a comment
const JPEG = Buffer.concat([
  Buffer.from([0xFF, 0xD8]),
  seg(0xE1, Buffer.from('Exif\0\0SECRET-GPS-AND-CAMERA')),
  seg(0xFE, Buffer.from('SECRET-COMMENT')),
  seg(0xDB, Buffer.alloc(65, 3)),
  seg(0xDA, Buffer.from([1, 1, 0, 0, 0x3F, 0])),
  Buffer.alloc(5000, 0x41),
  Buffer.from([0xFF, 0xD9])
])

const asset: Asset = {
  id: 'a1',
  key: 'testkey',
  keyType: KeyType.key,
  type: AssetType.image,
  isTrashed: false,
  originalFileName: 'a1.jpg',
  originalMimeType: 'image/jpeg'
}

class FakeRes extends Writable {
  chunks: Buffer[] = []
  statusCode = 200
  headers: Record<string, string> = {}
  constructor () { super(); this.on('error', () => {}) }
  setHeader (name: string, value: string) { this.headers[name.toLowerCase()] = value; return this }
  set (name: string, value: string) { return this.setHeader(name, value) }
  status (code: number) { this.statusCode = code; return this }
  send () { this.end(); return this }
  _write (chunk: Buffer, _enc: string, cb: () => void) { this.chunks.push(chunk); cb() }
  get output () { return Buffer.concat(this.chunks) }
}
const asResponse = (res: FakeRes) => res as unknown as Response

const stubFetch = (body: Buffer, contentType: string) => vi.stubGlobal('fetch', vi.fn(async () => new globalThis.Response(body, {
  status: 200,
  headers: { 'content-type': contentType, 'content-length': String(body.length), etag: '"abc"' }
})))

const request = (range = ''): IncomingShareRequest => ({ req: { method: 'GET' } as Request, key: 'testkey', range })

describe('single-file download', () => {
  it('rewrites a JPEG download and drops the stale length and etag', async () => {
    setConfig(enabled)
    stubFetch(JPEG, 'image/jpeg')
    const res = new FakeRes()
    await assetBuffer(request(), asResponse(res), asset, ImageSize.original)
    const text = res.output.toString('latin1')
    expect(text).not.toContain('SECRET')
    expect(text).toContain('Brent Example')
    expect(res.headers['content-length']).toBeUndefined()
    expect(res.headers.etag).toBeUndefined()
    expect(res.headers['content-type']).toBe('image/jpeg')
  })

  it('leaves the file and its headers alone when the feature is off', async () => {
    stubFetch(JPEG, 'image/jpeg')
    const res = new FakeRes()
    await assetBuffer(request(), asResponse(res), asset, ImageSize.original)
    expect(res.output.equals(JPEG)).toBe(true)
    expect(res.headers['content-length']).toBe(String(JPEG.length))
  })

  it('does not rewrite what is not a download', async () => {
    setConfig(enabled)
    stubFetch(JPEG, 'image/jpeg')
    const res = new FakeRes()
    await assetBuffer(request(), asResponse(res), asset, ImageSize.thumbnail)
    expect(res.output.equals(JPEG)).toBe(true)
  })

  it('leaves non-JPEG downloads untouched', async () => {
    setConfig(enabled)
    const png = Buffer.from('\x89PNG\r\n\x1a\nSECRET-PNG-METADATA', 'latin1')
    stubFetch(png, 'image/png')
    const res = new FakeRes()
    await assetBuffer(request(), asResponse(res), { ...asset, originalMimeType: 'image/png' }, ImageSize.original)
    expect(res.output.equals(png)).toBe(true)
  })
})

describe('zip download', () => {
  const share: SharedLink = { key: 'testkey', keyType: KeyType.key, type: 'ALBUM', description: 'Album', assets: [] }

  /** The bytes of each stored entry, located through the central directory. */
  function entries (zip: Buffer): Buffer[] {
    const out: Buffer[] = []
    let offset = zip.indexOf('PK\x01\x02', 0, 'binary')
    while (offset !== -1) {
      const size = zip.readUInt32LE(offset + 24)
      const nameLength = zip.readUInt16LE(offset + 28)
      const extraLength = zip.readUInt16LE(offset + 30)
      const commentLength = zip.readUInt16LE(offset + 32)
      const local = zip.readUInt32LE(offset + 42)
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      out.push(zip.subarray(start, start + size))
      offset = zip.indexOf('PK\x01\x02', offset + 46 + nameLength + extraLength + commentLength, 'binary')
    }
    return out
  }

  async function zipOf (contentType: string, body: Buffer): Promise<Buffer[]> {
    stubFetch(body, contentType)
    const res = new FakeRes()
    const done = once(res, 'finish')
    await downloadAssets(asResponse(res), share, [asset, { ...asset, id: 'a2' }])
    await done
    return entries(res.output)
  }

  it('rewrites each JPEG entry', async () => {
    setConfig(enabled)
    const files = await zipOf('image/jpeg', JPEG)
    expect(files).toHaveLength(2)
    for (const file of files) {
      expect(file.toString('latin1')).not.toContain('SECRET')
      expect(file.toString('latin1')).toContain('Brent Example')
      expect(file.subarray(0, 2)).toEqual(Buffer.from([0xFF, 0xD8]))
      expect(file.subarray(file.length - 2)).toEqual(Buffer.from([0xFF, 0xD9]))
    }
  })

  it('stores the original bytes when the feature is off', async () => {
    const files = await zipOf('image/jpeg', JPEG)
    expect(files.every(f => f.equals(JPEG))).toBe(true)
  })

  it('stores non-JPEG entries as they are', async () => {
    setConfig(enabled)
    const png = Buffer.from('\x89PNG\r\n\x1a\nbody', 'latin1')
    expect((await zipOf('image/png', png)).every(f => f.equals(png))).toBe(true)
  })
})

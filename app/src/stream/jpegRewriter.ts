import { Transform, TransformCallback } from 'stream'
import { getConfigOption } from '@ipp/core'
import { buildExif, buildIim, buildXmp, CopyrightFields, CopyrightStatus, KEEPABLE_EXIF } from './metadataBlocks'

export interface RewriteOptions {
  keepExif: 'all' | Set<string>
  fields: CopyrightFields
}

/** Header bytes buffered before the first scan. Real files are well under 1 MB. */
const MAX_HEADER_BYTES = 8 * 1024 * 1024

const text = (path: string): string | undefined => {
  const value = getConfigOption(path)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const STATUSES: CopyrightStatus[] = ['copyrighted', 'public-domain', 'unknown']

/**
 * Read `ipp.downloadMetadata`. Returns null when the feature is off. Unknown
 * names in `exif.keep` are ignored, which fails towards stripping.
 */
export function loadDownloadMetadataOptions (): RewriteOptions | null {
  if (getConfigOption('ipp.downloadMetadata.enabled', false) !== true) return null

  const keep = getConfigOption('ipp.downloadMetadata.exif.keep', ['orientation'])
  const keepExif = keep === 'all'
    ? 'all'
    : new Set(Array.isArray(keep) ? keep.filter(k => typeof k === 'string' && (k === 'gps' || KEEPABLE_EXIF[k])) as string[] : [])

  const rawCreator = getConfigOption('ipp.downloadMetadata.iptc.creator')
  const creator = (Array.isArray(rawCreator) ? rawCreator : [rawCreator])
    .filter(c => typeof c === 'string' && c.trim())
    .map(c => (c as string).trim())
  const status = text('ipp.downloadMetadata.iptc.copyrightStatus')
  const p = (key: string) => text('ipp.downloadMetadata.iptc.' + key)

  return {
    keepExif,
    fields: {
      creator,
      creatorJobTitle: p('creatorJobTitle'),
      creatorAddress: p('creatorAddress'),
      creatorCity: p('creatorCity'),
      creatorRegion: p('creatorRegion'),
      creatorPostalCode: p('creatorPostalCode'),
      creatorCountry: p('creatorCountry'),
      creatorPhone: p('creatorPhone'),
      creatorEmail: p('creatorEmail'),
      creatorWebsite: p('creatorWebsite'),
      copyrightNotice: p('copyrightNotice'),
      copyrightStatus: STATUSES.find(s => s === status),
      copyrightOwner: p('copyrightOwner'),
      rightsUsageTerms: p('rightsUsageTerms'),
      webStatement: p('webStatement'),
      credit: p('credit'),
      source: p('source')
    }
  }
}

export function isJpeg (contentType: string | null | undefined): boolean {
  return /^image\/jpe?g\s*(;|$)/i.test(contentType || '')
}

const enum Mode { Header, Scan, Done, Passthrough }
const enum Scan { Entropy, AfterFF, LenHi, LenLo, Skip }

const SOI = Buffer.from([0xFF, 0xD8])

const startsWith = (data: Buffer, prefix: string) => data.length >= prefix.length && data.toString('latin1', 0, prefix.length) === prefix

/**
 * Rewrite a JPEG's metadata as it streams through.
 *
 * Only the segments before the first scan are buffered; the compressed image
 * data is forwarded untouched, so memory use does not depend on file size and
 * the pixels are not re-encoded. Output order: JFIF, EXIF, XMP, IPTC-IIM, ICC
 * profile, then the structural segments (tables, frame header) as they were.
 *
 * Allowlist, not blocklist: of the original segments only JFIF, ICC profile
 * and Adobe colour-transform markers survive. All other APPn segments (EXIF,
 * XMP, IPTC, MPF, vendor blocks) and comments are discarded, and anything
 * after the end-of-image marker is dropped. Existing XMP / IPTC is never
 * passed through, only what is configured. The EXIF block is rebuilt from
 * `keepExif`.
 *
 * A malformed file fails the stream rather than passing metadata through.
 * Input that does not start with the JPEG SOI marker is forwarded unchanged.
 */
export function createJpegRewriter (options: RewriteOptions): Transform {
  const xmp = buildXmp(options.fields)
  const iim = buildIim(options.fields)
  const segment = (marker: number, payload: Buffer) => {
    const head = Buffer.from([0xFF, marker, 0, 0])
    head.writeUInt16BE(payload.length + 2, 2)
    return Buffer.concat([head, payload])
  }

  let mode = Mode.Header
  let started = false
  let buffered: Buffer = Buffer.alloc(0)
  let exifSource: Buffer | undefined
  const jfif: Buffer[] = []
  const icc: Buffer[] = []
  const structural: Buffer[] = []
  let keptBytes = 0

  let scan = Scan.Entropy
  let segmentLeft = 0
  let segmentLength = 0

  /** Consume header segments. Returns the rewritten header and the image bytes that followed it, once the first scan is reached. */
  const header = (): { head: Buffer, rest: Buffer } | undefined => {
    let pos = 0
    for (;;) {
      if (buffered.length - pos < 2) return undefined
      if (buffered[pos] !== 0xFF) throw new Error('Malformed JPEG: expected a marker')
      const marker = buffered[pos + 1]
      if (marker === 0xFF) { pos++; continue } // fill byte
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { pos += 2; continue }
      if (marker === 0xD9) throw new Error('Malformed JPEG: no image data')
      if (buffered.length - pos < 4) return undefined
      const length = buffered.readUInt16BE(pos + 2)
      if (length < 2) throw new Error('Malformed JPEG: bad segment length')
      const end = pos + 2 + length
      if (buffered.length < end) return undefined
      const data = buffered.subarray(pos + 4, end)
      const whole = buffered.subarray(pos, end)

      if (marker === 0xDA) {
        const exif = buildExif(exifSource, options.keepExif, options.fields)
        const out = [
          SOI, ...jfif,
          ...(exif ? [segment(0xE1, exif)] : []),
          ...(xmp ? [segment(0xE1, xmp)] : []),
          ...(iim ? [segment(0xED, iim)] : []),
          ...icc, ...structural, whole
        ]
        const rest = buffered.subarray(end)
        buffered = Buffer.alloc(0)
        mode = Mode.Scan
        return { head: Buffer.concat(out), rest }
      }

      if (marker === 0xE1 && !exifSource && startsWith(data, 'Exif\0\0')) {
        exifSource = Buffer.from(data.subarray(6))
      } else if (marker === 0xE0 && (startsWith(data, 'JFIF\0') || startsWith(data, 'JFXX\0'))) {
        jfif.push(Buffer.from(whole)); keptBytes += whole.length
      } else if (marker === 0xE2 && startsWith(data, 'ICC_PROFILE\0')) {
        icc.push(Buffer.from(whole)); keptBytes += whole.length
      } else if (marker === 0xEE && startsWith(data, 'Adobe')) {
        structural.push(Buffer.from(whole)); keptBytes += whole.length
      } else if (marker < 0xE0 || marker > 0xFE) {
        structural.push(Buffer.from(whole)); keptBytes += whole.length
      }
      if (keptBytes > MAX_HEADER_BYTES) throw new Error('Malformed JPEG: header too large')
      pos = end
      // Consumed segments are dropped from the buffer to keep it small
      buffered = buffered.subarray(pos)
      pos = 0
    }
  }

  /** Walk the compressed data far enough to find the end-of-image marker. Returns how many bytes of `chunk` to keep, and sets `mode` to Done at the end-of-image marker. */
  const scanChunk = (chunk: Buffer): number => {
    let i = 0
    while (i < chunk.length) {
      switch (scan) {
        case Scan.Entropy: {
          const j = chunk.indexOf(0xFF, i)
          if (j < 0) return chunk.length
          i = j + 1
          scan = Scan.AfterFF
          break
        }
        case Scan.AfterFF: {
          const m = chunk[i++]
          if (m === 0xD9) { mode = Mode.Done; return i }
          if (m === 0xFF) break
          if (m === 0x00 || m === 0x01 || (m >= 0xD0 && m <= 0xD8)) scan = Scan.Entropy
          else scan = Scan.LenHi
          break
        }
        case Scan.LenHi:
          segmentLength = chunk[i++] << 8
          scan = Scan.LenLo
          break
        case Scan.LenLo:
          segmentLength |= chunk[i++]
          segmentLeft = Math.max(0, segmentLength - 2)
          scan = segmentLeft ? Scan.Skip : Scan.Entropy
          break
        case Scan.Skip: {
          const n = Math.min(segmentLeft, chunk.length - i)
          i += n
          segmentLeft -= n
          if (!segmentLeft) scan = Scan.Entropy
          break
        }
      }
    }
    return chunk.length
  }

  const forward = (chunk: Buffer): Buffer | undefined => {
    const keep = scanChunk(chunk)
    return keep ? chunk.subarray(0, keep) : undefined
  }

  return new Transform({
    transform (chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        if (mode === Mode.Passthrough) return callback(null, chunk)
        if (mode === Mode.Done) return callback()
        if (mode === Mode.Scan) return callback(null, forward(chunk))

        buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
        if (!started) {
          if (buffered.length < 2) return callback()
          if (buffered[0] !== 0xFF || buffered[1] !== 0xD8) {
            mode = Mode.Passthrough
            const all = buffered
            buffered = Buffer.alloc(0)
            return callback(null, all)
          }
          started = true
          buffered = buffered.subarray(2)
        }
        const out = header()
        if (!out) return callback()
        this.push(out.head)
        callback(null, forward(out.rest))
      } catch (e) {
        callback(e instanceof Error ? e : new Error(String(e)))
      }
    },
    flush (callback: TransformCallback) {
      if (mode === Mode.Header && (buffered.length || started)) callback(new Error('Malformed JPEG: ended before image data'))
      else callback()
    }
  })
}

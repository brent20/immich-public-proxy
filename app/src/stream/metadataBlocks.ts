/**
 * Builders for the metadata blocks IPP writes into downloaded JPEGs: a rebuilt
 * EXIF block (an allowlist of the source's tags plus Artist/Copyright), an XMP
 * packet and a legacy IPTC-IIM block. All pure functions over Buffers.
 *
 * Field names follow the IPTC Photo Metadata Standard 2025.1, Creator and
 * Rights sections: https://iptc.org/std/photometadata/specification/
 */

export type CopyrightStatus = 'copyrighted' | 'public-domain' | 'unknown'

export interface CopyrightFields {
  creator?: string[]
  creatorJobTitle?: string
  creatorAddress?: string
  creatorCity?: string
  creatorRegion?: string
  creatorPostalCode?: string
  creatorCountry?: string
  creatorPhone?: string
  creatorEmail?: string
  creatorWebsite?: string
  copyrightNotice?: string
  copyrightStatus?: CopyrightStatus
  copyrightOwner?: string
  rightsUsageTerms?: string
  webStatement?: string
  credit?: string
  source?: string
}

/** Largest payload a JPEG segment can carry (the 2-byte length counts itself). */
export const MAX_SEGMENT_PAYLOAD = 65533

type ExifLocation = 'ifd0' | 'exif'

/** Names accepted by `ipp.downloadMetadata.exif.keep`, besides `all` and `gps`. */
export const KEEPABLE_EXIF: Record<string, { ifd: ExifLocation, tags: number[] }> = {
  make: { ifd: 'ifd0', tags: [0x010F] },
  model: { ifd: 'ifd0', tags: [0x0110] },
  orientation: { ifd: 'ifd0', tags: [0x0112] },
  software: { ifd: 'ifd0', tags: [0x0131] },
  dateTime: { ifd: 'ifd0', tags: [0x0132] },
  imageDescription: { ifd: 'ifd0', tags: [0x010E] },
  artist: { ifd: 'ifd0', tags: [0x013B] },
  copyright: { ifd: 'ifd0', tags: [0x8298] },
  resolution: { ifd: 'ifd0', tags: [0x011A, 0x011B, 0x0128] },
  exposureTime: { ifd: 'exif', tags: [0x829A] },
  fNumber: { ifd: 'exif', tags: [0x829D] },
  exposureProgram: { ifd: 'exif', tags: [0x8822] },
  iso: { ifd: 'exif', tags: [0x8827] },
  dateTimeOriginal: { ifd: 'exif', tags: [0x9003, 0x9011, 0x9291] },
  dateTimeDigitized: { ifd: 'exif', tags: [0x9004, 0x9012, 0x9292] },
  shutterSpeed: { ifd: 'exif', tags: [0x9201] },
  aperture: { ifd: 'exif', tags: [0x9202] },
  exposureBias: { ifd: 'exif', tags: [0x9204] },
  meteringMode: { ifd: 'exif', tags: [0x9207] },
  flash: { ifd: 'exif', tags: [0x9209] },
  focalLength: { ifd: 'exif', tags: [0x920A] },
  colorSpace: { ifd: 'exif', tags: [0xA001] },
  whiteBalance: { ifd: 'exif', tags: [0xA403] },
  focalLengthIn35mm: { ifd: 'exif', tags: [0xA405] },
  lensModel: { ifd: 'exif', tags: [0xA432, 0xA433, 0xA434] }
}

const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_ARTIST = 0x013B
const TAG_COPYRIGHT = 0x8298
const TAG_EXIF_VERSION = 0x9000

/**
 * With `keep: all`, everything is copied except what would be wrong or leak
 * once the file is rewritten: IFD pointers (rebuilt), the thumbnail, embedded
 * XMP / IPTC / Photoshop blocks, MakerNote (its offsets break when moved), the
 * interoperability IFD, and pixel dimensions (the served image is not
 * necessarily the original's size).
 */
const DROP_FROM_ALL_IFD0 = [TAG_EXIF_IFD, TAG_GPS_IFD, 0xA005, 0x0201, 0x0202, 0x02BC, 0x83BB, 0x8649]
const DROP_FROM_ALL_EXIF = [0x9000, 0x927C, 0xA005, 0xA002, 0xA003]

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }
const TYPE_ASCII = 2
const TYPE_LONG = 4
const TYPE_UNDEFINED = 7

export interface Entry { tag: number, type: number, count: number, value: Buffer }

/** Read the entries of one IFD, copying each value's raw bytes. Throws on any out-of-bounds read. */
function readIfd (tiff: Buffer, le: boolean, offset: number): Entry[] {
  const u16 = (o: number) => le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)
  const u32 = (o: number) => le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)
  const entries: Entry[] = []
  const n = u16(offset)
  for (let i = 0; i < n; i++) {
    const base = offset + 2 + i * 12
    const tag = u16(base)
    const type = u16(base + 2)
    const count = u32(base + 4)
    const size = TYPE_SIZE[type]
    if (!size) continue
    const length = size * count
    if (length > tiff.length) throw new RangeError('EXIF value larger than the block')
    const start = length <= 4 ? base + 8 : u32(base + 8)
    if (start + length > tiff.length) throw new RangeError('EXIF value out of bounds')
    entries.push({ tag, type, count, value: Buffer.from(tiff.subarray(start, start + length)) })
  }
  return entries
}

interface ParsedExif { le: boolean, ifd0: Entry[], exif: Entry[], gps: Entry[] }

/** Parse the TIFF structure inside an EXIF APP1 segment, following the two sub-IFD pointers once each. */
function parseTiff (tiff: Buffer): ParsedExif {
  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') throw new RangeError('Not a TIFF header')
  const le = order === 'II'
  if ((le ? tiff.readUInt16LE(2) : tiff.readUInt16BE(2)) !== 42) throw new RangeError('Bad TIFF magic')
  const ifd0 = readIfd(tiff, le, le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4))
  const pointer = (tag: number) => {
    const e = ifd0.find(x => x.tag === tag && x.type === TYPE_LONG && x.count === 1)
    return e ? (le ? e.value.readUInt32LE(0) : e.value.readUInt32BE(0)) : undefined
  }
  const exifOffset = pointer(TAG_EXIF_IFD)
  const gpsOffset = pointer(TAG_GPS_IFD)
  return {
    le,
    ifd0,
    exif: exifOffset === undefined ? [] : readIfd(tiff, le, exifOffset),
    gps: gpsOffset === undefined ? [] : readIfd(tiff, le, gpsOffset)
  }
}

function ascii (tag: number, text: string): Entry {
  const value = Buffer.from(text + '\0', 'utf8')
  return { tag, type: TYPE_ASCII, count: value.length, value }
}

function selectEntries (parsed: ParsedExif, keep: 'all' | Set<string>): ParsedExif {
  if (keep === 'all') {
    return {
      le: parsed.le,
      ifd0: parsed.ifd0.filter(e => DROP_FROM_ALL_IFD0.indexOf(e.tag) < 0),
      exif: parsed.exif.filter(e => DROP_FROM_ALL_EXIF.indexOf(e.tag) < 0),
      gps: parsed.gps
    }
  }
  const wanted = (ifd: ExifLocation) => {
    const tags: number[] = []
    keep.forEach(name => {
      const k = KEEPABLE_EXIF[name]
      if (k && k.ifd === ifd) k.tags.forEach(t => tags.push(t))
    })
    return tags
  }
  const ifd0Tags = wanted('ifd0')
  const exifTags = wanted('exif')
  return {
    le: parsed.le,
    ifd0: parsed.ifd0.filter(e => ifd0Tags.indexOf(e.tag) >= 0),
    exif: parsed.exif.filter(e => exifTags.indexOf(e.tag) >= 0),
    gps: keep.has('gps') ? parsed.gps : []
  }
}

export function serializeTiff (le: boolean, ifd0: Entry[], exif: Entry[], gps: Entry[]): Buffer {
  const all0 = ifd0.slice()
  if (exif.length) all0.push({ tag: TAG_EXIF_IFD, type: TYPE_LONG, count: 1, value: Buffer.alloc(4) })
  if (gps.length) all0.push({ tag: TAG_GPS_IFD, type: TYPE_LONG, count: 1, value: Buffer.alloc(4) })
  const ifds = [all0, exif, gps].map(list => list.slice().sort((a, b) => a.tag - b.tag))
  const ifdSize = (list: Entry[]) => list.length ? 2 + list.length * 12 + 4 : 0

  const offsets: number[] = []
  let cursor = 8
  ifds.forEach(list => { offsets.push(cursor); cursor += ifdSize(list) })
  const dataStart = cursor
  const dataOffsets = new Map<Entry, number>()
  ifds.forEach(list => list.forEach(e => {
    if (e.value.length > 4) {
      dataOffsets.set(e, cursor)
      cursor += e.value.length + (e.value.length % 2)
    }
  }))

  const out = Buffer.alloc(cursor)
  const w16 = (v: number, o: number) => le ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o)
  const w32 = (v: number, o: number) => le ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o)
  out.write(le ? 'II' : 'MM', 0, 'latin1')
  w16(42, 2)
  w32(offsets[0], 4)
  ifds.forEach((list, i) => {
    if (!list.length) return
    w16(list.length, offsets[i])
    list.forEach((e, j) => {
      const base = offsets[i] + 2 + j * 12
      w16(e.tag, base)
      w16(e.type, base + 2)
      w32(e.count, base + 4)
      if (i === 0 && e.tag === TAG_EXIF_IFD) w32(offsets[1], base + 8)
      else if (i === 0 && e.tag === TAG_GPS_IFD) w32(offsets[2], base + 8)
      else if (e.value.length > 4) {
        const at = dataOffsets.get(e) as number
        w32(at, base + 8)
        e.value.copy(out, at)
      } else e.value.copy(out, base + 8)
    })
  })
  if (dataStart > cursor) throw new RangeError('EXIF layout error')
  return out
}

/**
 * Build the EXIF APP1 payload ("Exif\0\0" + TIFF): the tags of `source` allowed
 * by `keep`, plus Artist and Copyright from `fields`. Returns undefined when
 * there is nothing to write. An unparseable source block is treated as empty,
 * so a damaged EXIF block can never pass through.
 */
export function buildExif (source: Buffer | undefined, keep: 'all' | Set<string>, fields: CopyrightFields): Buffer | undefined {
  let parsed: ParsedExif = { le: true, ifd0: [], exif: [], gps: [] }
  if (source) {
    try { parsed = selectEntries(parseTiff(source), keep) } catch (e) { /* keep nothing */ }
  }
  const build = (p: ParsedExif) => {
    const ifd0 = p.ifd0.filter(e => !(e.tag === TAG_ARTIST && fields.creator?.length) && !(e.tag === TAG_COPYRIGHT && fields.copyrightNotice))
    if (fields.creator?.length) ifd0.push(ascii(TAG_ARTIST, fields.creator.join(', ')))
    if (fields.copyrightNotice) ifd0.push(ascii(TAG_COPYRIGHT, fields.copyrightNotice))
    const exif = p.exif.slice()
    if (exif.length) exif.push({ tag: TAG_EXIF_VERSION, type: TYPE_UNDEFINED, count: 4, value: Buffer.from('0232', 'latin1') })
    if (!ifd0.length && !exif.length && !p.gps.length) return undefined
    return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), serializeTiff(p.le, ifd0, exif, p.gps)])
  }
  let block = build(parsed)
  if (block && block.length > MAX_SEGMENT_PAYLOAD) block = build({ le: parsed.le, ifd0: [], exif: [], gps: [] })
  if (block && block.length > MAX_SEGMENT_PAYLOAD) throw new RangeError('Copyright fields too large for an EXIF block')
  return block
}

/** Read the tags of an EXIF APP1 payload as `tag -> raw value`, per IFD. Used by the tests. */
export function readExif (payload: Buffer): { ifd0: Map<number, Buffer>, exif: Map<number, Buffer>, gps: Map<number, Buffer> } {
  const p = parseTiff(payload.subarray(6))
  const toMap = (list: Entry[]) => new Map(list.map(e => [e.tag, e.value] as [number, Buffer]))
  return { ifd0: toMap(p.ifd0), exif: toMap(p.exif), gps: toMap(p.gps) }
}

const xml = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/** Build an XMP packet from the configured fields, or undefined if none are set. */
export function buildXmp (f: CopyrightFields): Buffer | undefined {
  const parts: string[] = []
  const alt = (tag: string, text: string) =>
    `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${xml(text)}</rdf:li></rdf:Alt></${tag}>`
  const simple = (tag: string, text?: string) => { if (text) parts.push(`<${tag}>${xml(text)}</${tag}>`) }

  if (f.creator?.length) {
    parts.push(`<dc:creator><rdf:Seq>${f.creator.map(c => `<rdf:li>${xml(c)}</rdf:li>`).join('')}</rdf:Seq></dc:creator>`)
  }
  simple('photoshop:AuthorsPosition', f.creatorJobTitle)
  const contact: string[] = []
  const ci = (tag: string, text?: string) => { if (text) contact.push(`<Iptc4xmpCore:${tag}>${xml(text)}</Iptc4xmpCore:${tag}>`) }
  ci('CiAdrExtadr', f.creatorAddress)
  ci('CiAdrCity', f.creatorCity)
  ci('CiAdrRegion', f.creatorRegion)
  ci('CiAdrPcode', f.creatorPostalCode)
  ci('CiAdrCtry', f.creatorCountry)
  ci('CiTelWork', f.creatorPhone)
  ci('CiEmailWork', f.creatorEmail)
  ci('CiUrlWork', f.creatorWebsite)
  if (contact.length) parts.push(`<Iptc4xmpCore:CreatorContactInfo rdf:parseType="Resource">${contact.join('')}</Iptc4xmpCore:CreatorContactInfo>`)
  if (f.copyrightNotice) parts.push(alt('dc:rights', f.copyrightNotice))
  if (f.copyrightStatus === 'copyrighted') parts.push('<xmpRights:Marked>True</xmpRights:Marked>')
  if (f.copyrightStatus === 'public-domain') parts.push('<xmpRights:Marked>False</xmpRights:Marked>')
  if (f.copyrightOwner) {
    parts.push(`<plus:CopyrightOwner><rdf:Seq><rdf:li rdf:parseType="Resource"><plus:CopyrightOwnerName>${xml(f.copyrightOwner)}</plus:CopyrightOwnerName></rdf:li></rdf:Seq></plus:CopyrightOwner>`)
  }
  if (f.rightsUsageTerms) parts.push(alt('xmpRights:UsageTerms', f.rightsUsageTerms))
  simple('xmpRights:WebStatement', f.webStatement)
  simple('photoshop:Credit', f.credit)
  simple('photoshop:Source', f.source)
  if (!parts.length) return undefined

  const packet = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"' +
    ' xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"' +
    ' xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"' +
    ' xmlns:plus="http://ns.useplus.org/ldf/xmp/1.0/">' +
    parts.join('') +
    '</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>'
  const out = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(packet, 'utf8')])
  if (out.length > MAX_SEGMENT_PAYLOAD) throw new RangeError('Copyright fields too large for an XMP block')
  return out
}

/** Cut `text` to at most `max` bytes of UTF-8 without splitting a character. */
export function truncateUtf8 (text: string, max: number): Buffer {
  const full = Buffer.from(text, 'utf8')
  if (full.length <= max) return full
  let end = max
  while (end > 0 && (full[end] & 0xC0) === 0x80) end--
  return full.subarray(0, end)
}

/**
 * Build the legacy IPTC-IIM block (Photoshop "8BIM" resource 0x0404) for older
 * readers. IIM fields have fixed length limits, so long values are cut here;
 * the XMP block always carries the full text. Returns undefined when no
 * IIM-mappable field is set.
 */
export function buildIim (f: CopyrightFields): Buffer | undefined {
  const sets: Buffer[] = []
  const add = (dataset: number, value: Buffer) => {
    const head = Buffer.from([0x1C, 2, dataset, value.length >> 8, value.length & 0xFF])
    sets.push(Buffer.concat([head, value]))
  }
  ;(f.creator || []).forEach(c => add(80, truncateUtf8(c, 32)))
  if (f.creatorJobTitle) add(85, truncateUtf8(f.creatorJobTitle, 32))
  if (f.credit) add(110, truncateUtf8(f.credit, 32))
  if (f.source) add(115, truncateUtf8(f.source, 32))
  if (f.copyrightNotice) add(116, truncateUtf8(f.copyrightNotice, 128))
  if (!sets.length) return undefined

  // 1:90 CodedCharacterSet = UTF-8 (ESC % G)
  const charset = Buffer.from([0x1C, 1, 90, 0, 3, 0x1B, 0x25, 0x47])
  const iim = Buffer.concat([charset, ...sets])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(iim.length, 0)
  return Buffer.concat([
    Buffer.from('Photoshop 3.0\0', 'latin1'),
    Buffer.from('8BIM', 'latin1'),
    Buffer.from([0x04, 0x04, 0x00, 0x00]), // resource 0x0404, empty Pascal name + pad
    size,
    iim,
    iim.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)
  ])
}

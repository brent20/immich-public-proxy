# Download metadata

Configured under `ipp.downloadMetadata`. When a visitor downloads a JPEG, IPP can remove the camera, exposure and location data from it and write your creator and copyright information in its place, following the [IPTC Photo Metadata Standard](https://iptc.org/std/photometadata/specification/IPTC-PhotoMetadata-2025.1.html). It applies to single-file downloads and to files inside a "Download all" zip. It has no effect on what the gallery shows; that is [Metadata](/config/metadata).

## Example

Strip everything except the image orientation, and mark every downloaded JPEG as yours:

```json
{
  "ipp": {
    "downloadMetadata": {
      "enabled": true,
      "exif": { "keep": ["orientation"] },
      "iptc": {
        "creator": "Jane Photographer",
        "creatorWebsite": "https://example.com",
        "copyrightNotice": "© 2026 Jane Photographer. All rights reserved.",
        "copyrightStatus": "copyrighted",
        "rightsUsageTerms": "Personal use only. Contact me for other uses.",
        "webStatement": "https://example.com/licence"
      }
    }
  }
}
```

## How it works

- Only downloads are rewritten. Images shown in the gallery and lightbox are not.
- Only JPEG files are rewritten. Other formats (PNG, WebP, HEIC, video) are downloaded exactly as Immich provides them, with any metadata they carry. Immich's preview images are JPEG by default.
- The image itself is not re-encoded, so there is no quality loss, and the file is streamed rather than held in memory.
- Metadata is replaced by an allowlist. Of the original file, only the JFIF header, the ICC colour profile and Adobe colour markers survive. Every other embedded block is discarded, including the original XMP and IPTC, vendor blocks and comments, and anything stored after the end of the image. Only the EXIF tags you list in `exif.keep` are carried over.
- The creator and rights fields are written to EXIF (`Artist`, `Copyright`), to XMP and to the legacy IPTC-IIM block, so both modern and older software can read them.
- If the share has **Show metadata** switched off in Immich, no original EXIF is kept, whatever `exif.keep` says. Your creator and copyright fields are still written.
- A JPEG that is damaged enough to fail parsing fails the download. It is never served with its original metadata.
- The file's size and `ETag` change, so IPP stops sending `Content-Length` and `ETag` for these downloads.

## Options

**Type:** `object` · **Default:** see below

| Option    | Type     | Description                                                                                          |
|-----------|----------|------------------------------------------------------------------------------------------------------|
| `enabled` | `bool`   | Turn the feature on. **Default:** `false`.                                                           |
| `exif`    | `object` | Which original EXIF data to keep. See [EXIF](#exif).                                                 |
| `iptc`    | `object` | The creator and copyright fields to write. See [IPTC fields](#iptc-fields).                          |

## EXIF

Under `ipp.downloadMetadata.exif`.

| Option | Type                        | Default            | Description                                                                                  |
|--------|-----------------------------|--------------------|----------------------------------------------------------------------------------------------|
| `keep` | `string[]` or `"all"`       | `["orientation"]`  | EXIF fields to carry over from the original. Everything not listed is removed. `[]` removes all of it. |

The names you can list:

| Name                | Carries over                                                          |
|---------------------|-----------------------------------------------------------------------|
| `make`, `model`     | Camera manufacturer and model.                                        |
| `lensModel`         | Lens model, make and specification.                                   |
| `exposureTime`      | Shutter speed.                                                        |
| `fNumber`           | Aperture.                                                             |
| `iso`               | ISO sensitivity.                                                      |
| `focalLength`, `focalLengthIn35mm` | Focal length.                                          |
| `exposureProgram`, `exposureBias`, `meteringMode`, `flash`, `whiteBalance`, `shutterSpeed`, `aperture` | The matching exposure settings. |
| `dateTimeOriginal`  | Date and time taken, with its time offset and sub-seconds.            |
| `dateTimeDigitized` | Date and time digitised, with its time offset and sub-seconds.        |
| `dateTime`          | File modification time.                                               |
| `orientation`       | Image rotation. Dropping it can make a rotated photo display sideways. |
| `colorSpace`        | Colour space tag.                                                     |
| `resolution`        | Resolution and unit.                                                  |
| `software`          | Software that last wrote the file.                                    |
| `imageDescription`  | The EXIF description.                                                 |
| `artist`, `copyright` | The original `Artist` and `Copyright`. Ignored when the matching [IPTC field](#iptc-fields) is set, which replaces it. |
| `gps`               | The whole GPS location block. **This reveals where the photo was taken.** |

Names that are not in this list are ignored, which means a typo removes data rather than leaking it.

`"all"` carries over everything except the MakerNote, the embedded thumbnail, pixel dimensions and embedded XMP / IPTC blocks. That includes GPS coordinates and any serial numbers, so use it only when you do want a visitor to have the camera's own data.

## IPTC fields

Under `ipp.downloadMetadata.iptc`. Every field defaults to an empty string, which means it is not written. The names follow the IPTC Photo Metadata Standard 2025.1 (Creator and Rights sections).

| Option              | Type                  | IPTC field                      | Description                                                                                          |
|---------------------|-----------------------|---------------------------------|------------------------------------------------------------------------------------------------------|
| `creator`           | `string` or `string[]`| Creator                         | The photographer's name. A list writes several creators.                                             |
| `creatorJobTitle`   | `string`              | Creator's Job Title             | For example "Photographer".                                                                          |
| `creatorAddress`    | `string`              | Creator's Contact Info: Address | Street address.                                                                                      |
| `creatorCity`       | `string`              | Creator's Contact Info: City    |                                                                                                      |
| `creatorRegion`     | `string`              | Creator's Contact Info: State/Province |                                                                                              |
| `creatorPostalCode` | `string`              | Creator's Contact Info: Postal Code |                                                                                                  |
| `creatorCountry`    | `string`              | Creator's Contact Info: Country |                                                                                                      |
| `creatorPhone`      | `string`              | Creator's Contact Info: Phone   |                                                                                                      |
| `creatorEmail`      | `string`              | Creator's Contact Info: Email   |                                                                                                      |
| `creatorWebsite`    | `string`              | Creator's Contact Info: Web URL | The creator's website.                                                                               |
| `copyrightNotice`   | `string`              | Copyright Notice                | For example "© 2026 Jane Photographer".                                                              |
| `copyrightStatus`   | `string`              | Copyright Status                | `"copyrighted"`, `"public-domain"` or `"unknown"`. `"unknown"` writes nothing. **Default:** `"unknown"`. |
| `copyrightOwner`    | `string`              | Copyright Owner (PLUS)          | Who owns the copyright, if not the creator.                                                          |
| `rightsUsageTerms`  | `string`              | Rights Usage Terms              | Free text on how the image may be used.                                                              |
| `webStatement`      | `string`              | Web Statement of Rights         | URL of a page stating the rights or licence.                                                         |
| `credit`            | `string`              | Credit Line                     | How the image should be credited.                                                                    |
| `source`            | `string`              | Source                          | Where the image came from.                                                                           |

> [!NOTE]
> The legacy IPTC-IIM block has fixed field lengths: 32 bytes for creator, job title, credit and source, and 128 bytes for the copyright notice. Longer values are cut there. The XMP block, which modern software reads first, always carries the full text. The contact fields exist only in XMP.

> [!WARNING]
> Everything you configure is written into every download and is visible to anyone who has the file. Do not put an address or phone number here unless you want it public.

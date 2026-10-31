# ADR-058: PM-086 media format and license support matrix

## Status

Accepted as a current capability and dependency matrix. It does not enable a decoder or change original-file handling.

## Current matrix

| Input family | Index/original | Preview/thumbnail | Resource boundary | Dependency/license evidence |
| --- | --- | --- | --- | --- |
| JPEG/JPG | index and preserve immutable original | supported derived WebP preview | 16 MiB thumbnail input, 12M pixels, 256 KiB output, 10 s | `sharp`/libvips dependency audit required; project is Apache-2.0 |
| PNG | index and preserve immutable original | supported derived WebP preview | same thumbnail limits; alpha retained in derived output | same audit; no source rewrite |
| WebP | index and preserve immutable original | supported derived WebP preview | same thumbnail limits | same audit; no source rewrite |
| HEIC/AVIF | index and preserve immutable original | unsupported in current thumbnail transformer; explicit unavailable result | never bypass limits by fallback decoder | future decoder requires license/security review |
| RAW (manufacturer formats) | index and preserve immutable original | no RAW decode in current transformer; optional embedded preview is future work | large source must remain bounded and streamed | future codec/library license evidence required |
| Video/Live Photo video | index and preserve immutable original | no video decode/transcode in current transformer | no silent extraction or transcode | FFmpeg/video dependency not enabled; separate review |
| Animated/multi-page image | index and preserve immutable original | rejected for current thumbnail/version transform | reject before output publication | decoder behavior must remain fail-closed |

The original bytes are never edited, re-encoded, deleted, or used as an output destination. A format that is indexed but not previewable remains visible with an explicit availability/error state rather than being silently converted.

## License and supply-chain gate

The repository Apache-2.0 declaration is not sufficient evidence for transitive native codecs. Every enabled media dependency must have pinned versions, source/license notices, vulnerability review, and a reproducible SBOM/license-security check. Proprietary or patent-sensitive codecs (including some HEIC/AVIF/RAW/video combinations) require an explicit legal/security review before enabling distribution or server-side decoding. No new dependency is added by PM-086.

## Acceptance

Tests must cover supported JPEG/PNG/WebP previews, zero/oversized/over-pixel/multi-page rejection, explicit unsupported HEIC/AVIF/RAW/video behavior, output limits, and unchanged source SHA-256. PM-089 owns any future RAW/HEIC compatibility decision.

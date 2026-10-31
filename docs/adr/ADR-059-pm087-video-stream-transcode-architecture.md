# ADR-059: PM-087 video streaming/transcode architecture

## Status

Architecture and approval gate only. No video decoder, FFmpeg dependency, stream endpoint, or transcode worker is added by PM-087.

## Boundaries

Video originals and Live Photo video companions remain immutable managed/external source bytes. Indexing records format, dimensions, duration when safely available, and availability; it never requires a preview or rewrites a source. All previews, covers, proxy files, HLS segments, and temporary work files live in an isolated derived/job directory with a source SHA-256 and profile/version in the key.

The future media worker is an optional isolated process. It receives an authorized asset reference and bounded read stream, not arbitrary filesystem paths or bearer credentials. It can be disabled independently of indexing, upload, P2P, metadata, and backup. A worker failure leaves the original and prior derived outputs unchanged. Publication is atomic no-replace after output size, duration, codec, and hash checks.

## Streaming and transcode modes

1. **Direct authorized range read:** preferred when the client supports the original container and the backend can enforce library/path ACL on every request and range.
2. **Bounded cover/preview:** a reviewed decoder extracts a fixed-size derived cover with timeout, memory, pixel, duration, and output limits.
3. **Proxy/transcode:** only for an explicitly enabled profile and device capability. Use a bounded queue, one job at a time on a 2GB NAS, cancellation, disk admission guard, and resumable job state. HLS/segments are cache-keyed to grant epoch and source hash; revoked authorization invalidates future segment reads.

No automatic 8K/HDR or codec fallback may consume unbounded resources. If a profile is unavailable, the UI offers an explicit unsupported/disabled state or authorized original download; it does not silently alter the source.

## Resource and license gates

The node must measure available storage/RSS/queue capacity before enqueueing. 2GB or no-GPU deployments default to transcode disabled and must retain core upload, search, sync, and backup operation. CPU fallback is optional and bounded; hardware acceleration is enabled only after capability probing. FFmpeg/ffprobe or another codec stack requires pinned build provenance, SBOM, source and license notices, vulnerability review, and legal/patent review for enabled codecs. No proprietary codec is assumed available.

## Required evidence before PM-088

Security review must approve worker isolation and path handling. Performance tests must cover timeout, cancellation, partial output, full disk, queue saturation, malformed containers, memory limits, and source-hash preservation. Integration tests must prove ACL on direct/range/cover/segment requests, cache epoch invalidation, restart recovery, and no original-byte mutation. Production enabling, dependency addition, and public streaming remain separately approved operations.

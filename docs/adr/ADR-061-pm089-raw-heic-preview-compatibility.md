# ADR-061: PM-089 RAW/HEIC preview compatibility decision

## Status

Current decision is defer/unsupported. JPEG, PNG, and WebP remain the only enabled image preview formats. No RAW, HEIC/HEIF, or AVIF decoder is enabled by this slice.

## Decision

The Node records and preserves advanced-format originals as immutable indexed files, but returns an explicit `decoder_not_enabled` capability decision instead of probing, silently extracting an embedded preview, or converting bytes. Unknown formats fail closed. The UI must present a clear unavailable/unsupported state and must not claim that a preview or derived hash was produced.

Enabling any RAW/HEIC/AVIF path requires a separate dependency and license review, including codec patent exposure, native library provenance, platform parity, SBOM/vulnerability evidence, and bounded decoder behavior. The implementation must stream/read through the authorized media path, enforce source/pixel/time/memory/output limits, verify the source SHA-256 before and after any derived operation, write only to isolated derived storage, and never modify the original.

## Security tests and gates

Tests cover explicit decisions for HEIC/HEIF/AVIF/RAW, unknown formats, currently supported formats, and the immutable-original invariant. A future compatibility change must add real fixture tests for malformed, oversized, over-pixel, multi-page, decompression-bomb, and cancellation inputs, plus cross-platform license/security review. PM-089 does not add a decoder or alter production media behavior.

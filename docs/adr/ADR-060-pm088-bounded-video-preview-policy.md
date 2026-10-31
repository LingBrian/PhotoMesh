# ADR-060: PM-088 bounded video cover/preview policy

## Status

Implemented only as a pure admission policy. The capability defaults disabled; no decoder, worker, endpoint, filesystem output, or source-byte read is added.

## Decision

A future reviewed preview worker may be admitted only when explicitly enabled, the MIME type is allowlisted (`video/mp4` or `video/webm`), source bytes are at most 256 MiB, duration is at most 10 minutes, the queue has capacity for one job, and free storage is at least twice the 16 MiB derived-output budget. Unsupported formats, oversized/long sources, full queues, and low storage fail closed before decode work.

The policy is not a codec or license approval. A future implementation must use an independently reviewed dependency, read through authorized bounded streams, write only to isolated derived storage, enforce timeout/memory/output limits, cancel and clean partial output, verify source hash, and publish atomically without touching originals. 2GB/no-GPU nodes may keep this capability disabled.

## Acceptance

- disabled, unsupported, oversized, long-duration, queue-full, and low-storage paths are tested;
- default policy performs no media I/O and exposes no path or source bytes;
- enabling remains blocked until PM-087 license/security evidence and PM-088 negative integration tests are complete.

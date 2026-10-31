# ADR-066: PM-094 dependency license and SBOM review gate

## Status

Added a conservative SPDX metadata gate and review checklist. This is not a claim that a full third-party legal, vulnerability, or SBOM audit has completed.

## Decision

Known permissive SPDX licenses (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC) may pass metadata review for non-native dependencies. Missing or unknown licenses fail closed. LGPL-family dependencies require source availability evidence and still require legal/linkage review. Any native dependency fails this gate until provenance, source/license notices, platform artifacts, vulnerability status, and codec/patent review are recorded.

The repository remains Apache-2.0. No Immich code, text, templates, images, or dependency artifacts are copied or reused. Lockfile pinning and the CI license-security job remain authoritative; this pure policy does not replace a generated SBOM or package-manager audit.

## Acceptance

CI tests cover approved permissive, missing, unknown, conditional, and native cases. Before release, generate a lockfile-derived SBOM, inspect every transitive license, record notices/source obligations, scan vulnerabilities, and retain evidence for Node/Web/Windows artifacts. Unreviewed or disputed packages are blocked rather than silently accepted.

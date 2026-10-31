# ADR-052: PM-080 remote node connection compatibility

## Status

Implemented a pure connection-policy gate; no listener, proxy, certificate, relay, or deployment behavior changes.

## Boundary

Loopback HTTP remains local-only. Explicit private-LAN P2P remains available only after authenticated peer identity verification. Remote access is supported only through an operator-controlled VPN or HTTPS reverse proxy with a verified certificate and the PhotoMesh peer identity; the Node Agent must not expose plaintext management HTTP to an untrusted network. mDNS/address discovery is never trust.

Public plaintext HTTP is always denied. HTTPS without certificate verification or peer identity is denied. An unreachable NAT/VPN path returns a degraded `nat_unreachable` result; the policy does not silently force a relay, open a port, or claim connectivity.

## Compatibility and operational requirements

The existing loopback/private-LAN defaults remain unchanged. Operators may provide VPN/HTTPS externally without changing P2P event identity, library ACLs, or bearer semantics. Certificate rotation must preserve explicit hostname/SAN validation and fail closed. Manual IP addresses remain hints only and are checked against authenticated peer IDs. No automatic STUN/ICE, public relay, or inbound firewall modification is part of PM-080.

## Acceptance and follow-up

Tests cover loopback, private LAN peer verification, HTTPS certificate/identity requirements, public HTTP rejection, and NAT-unreachable degradation. A future deployment review must verify proxy TLS configuration, VPN route isolation, certificate rotation, firewall exposure, request logging, and N/N-1 protocol behavior before remote access is enabled for production users.

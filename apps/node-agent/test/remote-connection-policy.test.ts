import { describe, expect, it } from 'vitest';
import { evaluateRemoteConnection } from '../src/auth/remote-connection-policy.js';

const base = { certificateVerified: true, peerIdentityVerified: true, reachable: true };

describe('remote connection policy', () => {
  it('allows loopback/LAN only with verified peer identity and no public HTTP', () => {
    expect(evaluateRemoteConnection({ ...base, transport: 'loopback-http', peerIdentityVerified: false })).toMatchObject({ allowed: true, mode: 'local' });
    expect(evaluateRemoteConnection({ ...base, transport: 'private-lan-p2p', peerIdentityVerified: false }).reason).toBe('peer_identity_required');
    expect(evaluateRemoteConnection({ ...base, transport: 'public-http' }).reason).toBe('public_http_forbidden');
  });
  it('requires certificate and peer verification for HTTPS and reports unreachable NAT as degraded', () => {
    expect(evaluateRemoteConnection({ ...base, transport: 'vpn-https', certificateVerified: false }).reason).toBe('certificate_required');
    expect(evaluateRemoteConnection({ ...base, transport: 'public-https', peerIdentityVerified: false }).reason).toBe('peer_identity_required');
    expect(evaluateRemoteConnection({ ...base, transport: 'vpn-https' })).toMatchObject({ allowed: true, mode: 'https' });
    expect(evaluateRemoteConnection({ ...base, transport: 'vpn-https', reachable: false })).toMatchObject({ allowed: false, mode: 'degraded', reason: 'nat_unreachable' });
  });
});

export type RemoteConnectionInput = {
  transport: 'loopback-http' | 'private-lan-p2p' | 'vpn-https' | 'public-http' | 'public-https';
  certificateVerified: boolean;
  peerIdentityVerified: boolean;
  reachable: boolean;
};
export type RemoteConnectionDecision = { allowed: boolean; mode: 'local' | 'lan' | 'https' | 'degraded'; reason: 'allowed' | 'certificate_required' | 'peer_identity_required' | 'public_http_forbidden' | 'nat_unreachable' };

export function evaluateRemoteConnection(input: RemoteConnectionInput): RemoteConnectionDecision {
  if (!input.reachable) return { allowed: false, mode: 'degraded', reason: 'nat_unreachable' };
  if (input.transport === 'public-http') return { allowed: false, mode: 'degraded', reason: 'public_http_forbidden' };
  if (input.transport === 'vpn-https' || input.transport === 'public-https') {
    if (!input.certificateVerified) return { allowed: false, mode: 'degraded', reason: 'certificate_required' };
    if (!input.peerIdentityVerified) return { allowed: false, mode: 'degraded', reason: 'peer_identity_required' };
    return { allowed: true, mode: 'https', reason: 'allowed' };
  }
  if (input.transport === 'private-lan-p2p' && !input.peerIdentityVerified) return { allowed: false, mode: 'degraded', reason: 'peer_identity_required' };
  return { allowed: true, mode: input.transport === 'loopback-http' ? 'local' : 'lan', reason: 'allowed' };
}

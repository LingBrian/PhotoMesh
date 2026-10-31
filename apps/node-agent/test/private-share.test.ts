import { describe, expect, it } from 'vitest';
import { PrivateShareService } from '../src/sharing/private-share.js';

describe('private share service', () => {
  it('binds a one-time invitation to recipient and least-privilege scope', () => {
    const service = new PrivateShareService(() => '2026-10-31T00:00:00.000Z');
    const invite = service.createInvitation('device-b', { libraryId: 'library-a', albumId: 'album-1' }, '2026-11-01T00:00:00.000Z');
    expect(service.accept(invite.shareId, 'device-c', invite.token)).toBe('recipient_mismatch');
    const accepted = service.accept(invite.shareId, 'device-b', invite.token);
    expect(accepted).toMatchObject({ status: 'accepted', grant: { recipientId: 'device-b', scope: invite.scope, revokedAt: null } });
    expect(service.isAuthorized(invite.shareId, 'device-b', 'library-a', 'album-1')).toBe(true);
    expect(service.isAuthorized(invite.shareId, 'device-b', 'library-b', 'album-1')).toBe(false);
    expect(service.accept(invite.shareId, 'device-b', invite.token)).toBe('revoked');
  });
  it('expires, revokes, and rate-limits invalid invitations without exposing secret state', () => {
    let now = '2026-10-31T00:00:00.000Z';
    const service = new PrivateShareService(() => now, 2);
    const invite = service.createInvitation('device-b', { libraryId: 'library-a', albumId: 'album-1' }, '2026-10-31T00:01:00.000Z');
    expect(service.accept(invite.shareId, 'device-b', 'wrong')).toBe('invalid');
    expect(service.accept(invite.shareId, 'device-b', 'wrong')).toBe('invalid');
    expect(service.accept(invite.shareId, 'device-b', 'wrong')).toBe('attempts_exhausted');
    const revoked = service.createInvitation('device-b', { libraryId: 'library-a', albumId: 'album-1' }, '2026-11-01T00:00:00.000Z');
    expect(service.revoke(revoked.shareId)).toBe(true);
    expect(service.accept(revoked.shareId, 'device-b', revoked.token)).toBe('revoked');
    const expired = service.createInvitation('device-b', { libraryId: 'library-a', albumId: 'album-1' }, '2026-11-01T00:00:00.000Z');
    now = '2026-11-02T00:00:00.000Z';
    expect(service.accept(expired.shareId, 'device-b', expired.token)).toBe('expired');
    expect(JSON.stringify(service)).not.toContain(invite.token);
  });
});

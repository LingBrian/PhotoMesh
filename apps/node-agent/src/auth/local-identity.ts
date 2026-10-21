import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { SqliteRepository } from '../db/repository.js';
import type { SecretStore } from './key-store.js';

const SECRET_NAME = 'node-identity-ed25519-v1';

export interface LocalIdentity {
  peerId: string;
  publicKey: Uint8Array;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>;
}

/** Private identity material is persisted only in the native OS secret store, never SQLite or logs. */
export async function loadOrCreateLocalIdentity(
  repository: Pick<SqliteRepository, 'getLocalIdentity' | 'setLocalIdentity'>,
  secrets: SecretStore,
  now = new Date().toISOString()
): Promise<LocalIdentity> {
  let serialized = secrets.get(SECRET_NAME);
  let privateKey: LocalIdentity['privateKey'];
  if (serialized === undefined) {
    if (repository.getLocalIdentity()) throw new Error('stored node identity secret is missing; refusing to replace it');
    privateKey = await generateKeyPair('Ed25519');
    serialized = Buffer.from(privateKeyToProtobuf(privateKey)).toString('base64');
    secrets.set(SECRET_NAME, serialized);
  } else {
    try {
      privateKey = privateKeyFromProtobuf(Buffer.from(serialized, 'base64'));
    } catch {
      throw new Error('stored node identity is invalid; refusing to replace it');
    }
  }
  if (privateKey.type !== 'Ed25519') throw new Error('stored node identity uses an unsupported key type');
  const peerId = peerIdFromPrivateKey(privateKey).toString();
  const publicKey = publicKeyToProtobuf(privateKey.publicKey);
  const current = repository.getLocalIdentity();
  if (current && (current.peerId !== peerId || current.publicKey !== Buffer.from(publicKey).toString('base64'))) {
    throw new Error('secure-store identity does not match the persisted node identity');
  }
  repository.setLocalIdentity(peerId, Buffer.from(publicKey).toString('base64'), now);
  return { peerId, publicKey, privateKey };
}

import crypto from 'node:crypto';

export interface VapidKeyPair {
  publicKey: string; // 65-byte uncompressed P-256 point (base64url)
  privateKey: string; // 32-byte raw P-256 private scalar (base64url)
}

export interface WebPushSubscriptionKeys {
  p256dh: string; // Client 65-byte uncompressed P-256 public key (base64url)
  auth: string; // Client 16-byte authentication secret (base64url)
}

export interface WebPushSubscription {
  endpoint: string;
  keys: WebPushSubscriptionKeys;
}

export interface EncryptedWebPushPayload {
  ciphertext: Buffer; // Complete aes128gcm binary payload (86-byte header + encrypted record + 16-byte GCM tag)
  salt: Buffer;
  serverPublicKey: Buffer;
  contentEncoding: 'aes128gcm';
}

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

/**
 * Generates an RFC 8292 VAPID P-256 keypair (uncompressed 65-byte public key + 32-byte private key).
 */
export function generateVapidKeys(): VapidKeyPair {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(ecdh.getPrivateKey())
  };
}

function createPrivateKeyObjectFromRawP256(
  privateKeyRaw: Buffer,
  publicKeyUncompressed: Buffer
): crypto.KeyObject {
  // Uncompressed P-256 point is 0x04 || X (32 bytes) || Y (32 bytes)
  const x = base64UrlEncode(publicKeyUncompressed.subarray(1, 33));
  const y = base64UrlEncode(publicKeyUncompressed.subarray(33, 65));
  const d = base64UrlEncode(privateKeyRaw);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x, y, d },
    format: 'jwk'
  });
}

function createPublicKeyObjectFromRawP256(publicKeyUncompressed: Buffer): crypto.KeyObject {
  const x = base64UrlEncode(publicKeyUncompressed.subarray(1, 33));
  const y = base64UrlEncode(publicKeyUncompressed.subarray(33, 65));
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x, y },
    format: 'jwk'
  });
}

/**
 * Builds an RFC 8292 VAPID Authorization header (`vapid t=<jwt>, k=<publicKey>`) signed with ES256 (IEEE P1363).
 */
export function buildVapidAuthHeader(
  endpoint: string,
  subject: string,
  vapidKeys: VapidKeyPair,
  expirationUnix = Math.floor(Date.now() / 1000) + 12 * 3600
): { authorization: string; jwt: string; publicKey: string } {
  const parsed = new URL(endpoint);
  const audience = `${parsed.protocol}//${parsed.host}`;

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: expirationUnix,
    sub: subject
  };

  const signingInput = `${base64UrlEncode(Buffer.from(JSON.stringify(header)))}.${base64UrlEncode(
    Buffer.from(JSON.stringify(payload))
  )}`;

  const privKeyObj = createPrivateKeyObjectFromRawP256(
    base64UrlDecode(vapidKeys.privateKey),
    base64UrlDecode(vapidKeys.publicKey)
  );

  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privKeyObj,
    dsaEncoding: 'ieee-p1363'
  });

  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;
  return {
    authorization: `vapid t=${jwt}, k=${vapidKeys.publicKey}`,
    jwt,
    publicKey: vapidKeys.publicKey
  };
}

/**
 * Verifies an RFC 8292 VAPID ES256 JWT against a base64url-encoded 65-byte P-256 public key.
 */
export function verifyVapidJwt(
  jwt: string,
  publicKeyBase64Url: string
): { valid: boolean; payload?: { aud: string; exp: number; sub: string } } {
  const parts = jwt.split('.');
  if (parts.length !== 3) return { valid: false };

  const signingInput = `${parts[0]}.${parts[1]}`;
  const sigBuf = base64UrlDecode(parts[2]);
  const pubKeyObj = createPublicKeyObjectFromRawP256(base64UrlDecode(publicKeyBase64Url));

  const valid = crypto.verify(
    'sha256',
    Buffer.from(signingInput),
    { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
    sigBuf
  );
  if (!valid) return { valid: false };

  const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf-8')) as {
    aud: string;
    exp: number;
    sub: string;
  };
  return { valid: true, payload };
}

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  const effectiveSalt = salt.length > 0 ? salt : Buffer.alloc(32, 0);
  return crypto.createHmac('sha256', effectiveSalt).update(ikm).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  // RFC 8291 only requires L <= 32 bytes (single-block HKDF-Expand with 0x01 counter byte)
  const hmac = crypto.createHmac('sha256', prk);
  hmac.update(info);
  hmac.update(Buffer.from([0x01]));
  return hmac.digest().subarray(0, length);
}

/**
 * Encrypts a Web Push notification payload according to RFC 8291 (`aes128gcm` content encoding).
 */
export function encryptWebPushPayload(
  cleartext: string | Buffer,
  subscriptionKeys: WebPushSubscriptionKeys
): EncryptedWebPushPayload {
  const uaPublic = base64UrlDecode(subscriptionKeys.p256dh);
  const authSecret = base64UrlDecode(subscriptionKeys.auth);

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Invalid subscriber p256dh public key (expected 65-byte uncompressed P-256 point)');
  }
  if (authSecret.length !== 16) {
    throw new Error('Invalid subscriber auth secret (expected 16 bytes)');
  }

  // Generate ephemeral application server P-256 keypair
  const serverEcdh = crypto.createECDH('prime256v1');
  serverEcdh.generateKeys();
  const asPublic = serverEcdh.getPublicKey();
  const ecdhSecret = serverEcdh.computeSecret(uaPublic);

  // RFC 8291 Section 3.3: Combining ECDH shared secret and authentication secret
  const prkKey = hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'ascii'),
    uaPublic,
    asPublic
  ]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188 Section 2.1: aes128gcm content-encryption key (CEK) and nonce derivation
  const salt = crypto.randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'ascii');
  const cek = hkdfExpand(prk, cekInfo, 16);
  const nonce = hkdfExpand(prk, nonceInfo, 12);

  // Pad cleartext with final-record delimiter 0x02 (RFC 8188 Section 2)
  const plainBuf = typeof cleartext === 'string' ? Buffer.from(cleartext, 'utf-8') : cleartext;
  const paddedPlaintext = Buffer.concat([plainBuf, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encryptedRecord = Buffer.concat([cipher.update(paddedPlaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Build 86-byte aes128gcm header: salt (16B) || rs (4B uint32BE = 4096) || idlen (1B = 65) || keyid (65B asPublic)
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const idLenBuf = Buffer.from([asPublic.length]);
  const header = Buffer.concat([salt, rsBuf, idLenBuf, asPublic]);

  return {
    ciphertext: Buffer.concat([header, encryptedRecord, authTag]),
    salt,
    serverPublicKey: asPublic,
    contentEncoding: 'aes128gcm'
  };
}

/**
 * Decrypts an RFC 8291 `aes128gcm` Web Push payload using the subscriber's P-256 keypair and auth secret.
 * Used for cryptographic verification in tests and local Service Worker simulation.
 */
export function decryptWebPushPayload(
  encryptedPayload: Buffer,
  subscriberPrivateKeyBase64Url: string,
  subscriberPublicKeyBase64Url: string,
  authSecretBase64Url: string
): string {
  const salt = encryptedPayload.subarray(0, 16);
  const idLen = encryptedPayload[20];
  const asPublic = encryptedPayload.subarray(21, 21 + idLen);
  const bodyAndTag = encryptedPayload.subarray(21 + idLen);
  const encryptedRecord = bodyAndTag.subarray(0, bodyAndTag.length - 16);
  const authTag = bodyAndTag.subarray(bodyAndTag.length - 16);

  const uaPublic = base64UrlDecode(subscriberPublicKeyBase64Url);
  const uaPrivate = base64UrlDecode(subscriberPrivateKeyBase64Url);
  const authSecret = base64UrlDecode(authSecretBase64Url);

  const clientEcdh = crypto.createECDH('prime256v1');
  clientEcdh.setPrivateKey(uaPrivate);
  const ecdhSecret = clientEcdh.computeSecret(asPublic);

  const prkKey = hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'ascii'),
    uaPublic,
    asPublic
  ]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(authTag);
  const decryptedPadded = Buffer.concat([decipher.update(encryptedRecord), decipher.final()]);

  // Strip trailing padding zeros and 0x02 delimiter
  let delimiterIdx = decryptedPadded.length - 1;
  while (delimiterIdx >= 0 && decryptedPadded[delimiterIdx] === 0x00) {
    delimiterIdx--;
  }
  if (delimiterIdx < 0 || decryptedPadded[delimiterIdx] !== 0x02) {
    throw new Error('Invalid RFC 8188 record delimiter');
  }
  return decryptedPadded.subarray(0, delimiterIdx).toString('utf-8');
}

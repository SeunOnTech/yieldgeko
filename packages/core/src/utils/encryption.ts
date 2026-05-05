import { webcrypto } from 'crypto';

const crypto = (typeof window !== 'undefined' ? window.crypto : webcrypto) as unknown as Crypto;

export async function generateKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPayload(
  data: any,
  key: CryptoKey
): Promise<{ iv: Uint8Array; encrypted: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    encoded as any
  );

  return { iv, encrypted };
}

export async function decryptPayload(
  encrypted: ArrayBuffer,
  iv: Uint8Array,
  key: CryptoKey
): Promise<any> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    encrypted as any
  );

  const decoded = new TextDecoder().decode(decrypted);
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
}

export async function exportKeyBase64(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("raw", key);
  return Buffer.from(exported).toString("base64");
}

export async function importKeyBase64(base64: string): Promise<CryptoKey> {
  const raw = Buffer.from(base64, "base64");
  return await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

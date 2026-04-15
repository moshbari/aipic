import CryptoJS from 'crypto-js';

const encryptionKey = process.env.ENCRYPTION_KEY || 'default-key-change-in-production';

export function encryptApiKey(key: string): string {
  return CryptoJS.AES.encrypt(key, encryptionKey).toString();
}

export function decryptApiKey(encrypted: string): string {
  const bytes = CryptoJS.AES.decrypt(encrypted, encryptionKey);
  return bytes.toString(CryptoJS.enc.Utf8);
}

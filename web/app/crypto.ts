const encoder = new TextEncoder();
const decoder = new TextDecoder();
const context = "vpetllm-remote-chat/v1";

export type RelayEnvelope = {
  type: "relay";
  v: 1;
  room_id: string;
  message_id: string;
  nonce: string;
  ciphertext: string;
};

export function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function deriveBits(secret: Uint8Array<ArrayBuffer>, roomId: string, info: string): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(roomId), info: encoder.encode(`${context}/${info}`) },
    material,
    256,
  );
}

export async function deriveKeys(secretText: string, roomId: string) {
  const secret = base64UrlDecode(secretText);
  if (secret.byteLength !== 32) throw new Error("配对密钥长度不正确");
  const encryptionBits = await deriveBits(secret, roomId, "encryption");
  const authBits = await deriveBits(secret, roomId, "authentication");
  const encryptionKey = await crypto.subtle.importKey("raw", encryptionBits, "AES-GCM", false, ["encrypt", "decrypt"]);
  const authKey = await crypto.subtle.importKey("raw", authBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const verifier = new Uint8Array(await crypto.subtle.sign("HMAC", authKey, encoder.encode(`${context}/server-auth`)));
  secret.fill(0);
  return { encryptionKey, verifier: base64UrlEncode(verifier) };
}

export async function encryptPayload(
  key: CryptoKey,
  roomId: string,
  payload: object,
): Promise<RelayEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const messageId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const aad = encoder.encode(`${context}|${roomId}|${messageId}`);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext);
  return {
    type: "relay",
    v: 1,
    room_id: roomId,
    message_id: messageId,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function decryptPayload(key: CryptoKey, roomId: string, envelope: RelayEnvelope): Promise<unknown> {
  const aad = encoder.encode(`${context}|${roomId}|${envelope.message_id}`);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(envelope.nonce), additionalData: aad, tagLength: 128 },
    key,
    base64UrlDecode(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

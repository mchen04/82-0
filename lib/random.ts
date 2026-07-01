import { randomBytes, randomUUID } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function id() {
  return randomUUID();
}

export function secretToken() {
  return randomBytes(24).toString("base64url");
}

export function lobbyCode() {
  const bytes = randomBytes(5);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export function pickRandom<T>(items: T[]) {
  if (items.length === 0) throw new Error("cannot pick from an empty list");
  const bytes = randomBytes(4);
  const value = bytes.readUInt32BE(0);
  return items[value % items.length];
}

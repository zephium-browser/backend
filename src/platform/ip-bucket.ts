import { isIP } from "node:net";
import { AppError } from "./errors";

/** Canonicalize before HMAC: equivalent spellings must share a rate bucket. */
export function canonicalIp(address: string): string {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6 || address.includes("%")) throw new AppError("unavailable", 503);
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const bytes = value
      .slice(separator + 1)
      .split(".")
      .map(Number);
    value = `${value.slice(0, separator + 1)}${((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0)).toString(16)}:${((bytes[2] ?? 0) * 256 + (bytes[3] ?? 0)).toString(16)}`;
  }
  const [left = "", right] = value.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words =
    right === undefined
      ? head
      : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const normalized = words.map((word) => Number.parseInt(word, 16));
  if (normalized.length !== 8) throw new AppError("unavailable", 503);
  if (normalized.slice(0, 5).every((word) => word === 0) && normalized[5] === 0xffff) {
    const high = normalized[6] ?? 0;
    const low = normalized[7] ?? 0;
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return normalized.map((word) => word.toString(16).padStart(4, "0")).join(":");
}

/** Send velocity groups IPv6 privacy addresses by /64; this is not a user identity. */
export function emailNetwork(address: string): string {
  const canonical = canonicalIp(address);
  return canonical.includes(":") ? `${canonical.split(":").slice(0, 4).join(":")}::/64` : canonical;
}

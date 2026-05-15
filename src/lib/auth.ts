import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "cp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_SECRET is not configured");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function createSessionToken(username: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${username}.${exp}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | undefined): {
  username: string;
} | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [username, exp, signature] = parts;
  const expected = sign(`${username}.${exp}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return { username };
}

export function validateCredentials(
  username: string,
  password: string,
): boolean {
  const u = process.env.ADMIN_USERNAME ?? "";
  const p = process.env.ADMIN_PASSWORD ?? "";
  if (!u || !p) return false;

  const ub = Buffer.from(username);
  const pb = Buffer.from(password);
  const eub = Buffer.from(u);
  const epb = Buffer.from(p);

  if (ub.length !== eub.length || pb.length !== epb.length) return false;
  return timingSafeEqual(ub, eub) && timingSafeEqual(pb, epb);
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_COOKIE_MAX_AGE = SESSION_TTL_SECONDS;

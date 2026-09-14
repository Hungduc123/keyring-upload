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
  // The username is encoded so a name containing "." cannot forge the layout.
  const payload = `${Buffer.from(username).toString("base64url")}.${exp}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

/**
 * Verify the cookie and return the name it was issued to. Roles and project
 * access are deliberately NOT carried in the token — they are looked up from
 * the user store on every request, so revoking access takes effect at once.
 */
export function verifySessionToken(token: string | undefined): {
  username: string;
} | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedUsername, exp, signature] = parts;
  const expected = sign(`${encodedUsername}.${exp}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) {
    return null;
  }

  const username = Buffer.from(encodedUsername, "base64url").toString("utf8");
  if (!username) return null;
  return { username };
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_COOKIE_MAX_AGE = SESSION_TTL_SECONDS;

import { NextResponse } from "next/server";
import {
  AUTH_COOKIE_MAX_AGE,
  AUTH_COOKIE_NAME,
  createSessionToken,
} from "@/lib/auth";
import { authenticate } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return NextResponse.json(
      { error: "Username and password are required" },
      { status: 400 },
    );
  }

  let user;
  try {
    user = authenticate(username, password);
  } catch (err) {
    // A malformed APP_USERS is a deployment error, not a bad password.
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Auth misconfigured: ${message}` },
      { status: 500 },
    );
  }

  if (!user) {
    return NextResponse.json(
      { error: "Invalid username or password" },
      { status: 401 },
    );
  }

  if (user.projects.length === 0) {
    return NextResponse.json(
      { error: "This account has no project access configured." },
      { status: 403 },
    );
  }

  const token = createSessionToken(user.username);
  const res = NextResponse.json({ ok: true, role: user.role });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE,
  });
  return res;
}

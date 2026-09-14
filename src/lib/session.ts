import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { canAccessProject, findUser, type AppUser } from "@/lib/users";
import {
  DEFAULT_PROJECT,
  isProjectKey,
  type ProjectKey,
} from "@/lib/upstash";

/**
 * The signed-in user, or null. Reads the cookie then re-reads the user from
 * the store, so a user removed from `APP_USERS` is signed out immediately even
 * while holding a valid token.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  const store = await cookies();
  const session = verifySessionToken(store.get(AUTH_COOKIE_NAME)?.value);
  if (!session) return null;
  return findUser(session.username);
}

/**
 * Like `getCurrentUser`, but reports a broken `APP_USERS` instead of throwing,
 * so a config typo shows an explanatory page rather than a blank 500.
 */
export async function getCurrentUserOrConfigError(): Promise<
  { user: AppUser | null } | { configError: string }
> {
  try {
    return { user: await getCurrentUser() };
  } catch (err) {
    return {
      configError: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Resolve the project an API request is targeting and check the caller may use
 * it. Returns either the project or the response to send back.
 *
 * `raw` is the `project` field of the body / query string. An absent project
 * falls back to the caller's first allowed project rather than the global
 * default, so an editor's request without an explicit project never touches
 * someone else's index.
 */
export async function requireProjectAccess(
  raw: unknown,
): Promise<
  { user: AppUser; project: ProjectKey } | { response: NextResponse }
> {
  let user: AppUser | null;
  try {
    user = await getCurrentUser();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      response: NextResponse.json(
        { error: `Auth misconfigured: ${message}` },
        { status: 500 },
      ),
    };
  }

  if (!user) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (user.projects.length === 0) {
    return {
      response: NextResponse.json(
        { error: "This account has no project access configured." },
        { status: 403 },
      ),
    };
  }

  if (raw === undefined || raw === null || raw === "") {
    const fallback = user.role === "admin" ? DEFAULT_PROJECT : user.projects[0];
    return { user, project: fallback };
  }

  if (!isProjectKey(raw)) {
    return {
      response: NextResponse.json(
        { error: `Unknown project "${String(raw)}"` },
        { status: 400 },
      ),
    };
  }

  if (!canAccessProject(user, raw)) {
    // Same shape as an unknown project: a limited account learns nothing about
    // which other projects exist.
    return {
      response: NextResponse.json(
        { error: `Unknown project "${raw}"` },
        { status: 403 },
      ),
    };
  }

  return { user, project: raw };
}

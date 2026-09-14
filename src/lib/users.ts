import { timingSafeEqual } from "crypto";
import { PROJECTS, isProjectKey, type ProjectKey } from "@/lib/upstash";

export type Role = "admin" | "editor";

export type AppUser = {
  username: string;
  role: Role;
  /** Projects this user may read and write. Admins get every project. */
  projects: ProjectKey[];
};

type RawUser = {
  username?: unknown;
  password?: unknown;
  role?: unknown;
  projects?: unknown;
};

type StoredUser = AppUser & { password: string };

/**
 * Users come from a single `APP_USERS` env var holding a JSON array, so adding
 * an account on Vercel is one variable edit and no redeploy of code:
 *
 *   APP_USERS=[
 *     {"username":"admin","password":"...","role":"admin"},
 *     {"username":"keyring-one","password":"...","projects":["keyring-one"]}
 *   ]
 *
 * `ADMIN_USERNAME` / `ADMIN_PASSWORD` still work as an admin account so the
 * existing deployment keeps logging in after this change.
 */
function parseAppUsers(): StoredUser[] {
  const raw = process.env.APP_USERS;
  if (!raw || !raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("APP_USERS is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("APP_USERS must be a JSON array");
  }

  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`APP_USERS[${i}] must be an object`);
    }
    const { username, password, role, projects } = entry as RawUser;

    if (typeof username !== "string" || !username.trim()) {
      throw new Error(`APP_USERS[${i}].username must be a non-empty string`);
    }
    if (typeof password !== "string" || !password) {
      throw new Error(`APP_USERS[${i}].password must be a non-empty string`);
    }
    if (role !== undefined && role !== "admin" && role !== "editor") {
      throw new Error(`APP_USERS[${i}].role must be "admin" or "editor"`);
    }

    const resolvedRole: Role = role === "admin" ? "admin" : "editor";

    let allowed: ProjectKey[];
    if (resolvedRole === "admin") {
      allowed = [...PROJECTS];
    } else if (projects === undefined) {
      allowed = [];
    } else if (!Array.isArray(projects)) {
      throw new Error(`APP_USERS[${i}].projects must be an array`);
    } else {
      allowed = projects.map((p) => {
        if (!isProjectKey(p)) {
          throw new Error(
            `APP_USERS[${i}].projects contains unknown project "${String(p)}"`,
          );
        }
        return p;
      });
    }

    return {
      username: username.trim(),
      password,
      role: resolvedRole,
      projects: allowed,
    };
  });
}

/** The legacy single-admin credentials, as a user entry when configured. */
function legacyAdmin(): StoredUser | null {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return null;
  return {
    username,
    password,
    role: "admin",
    projects: [...PROJECTS],
  };
}

function allUsers(): StoredUser[] {
  const users = parseAppUsers();
  const legacy = legacyAdmin();
  // An APP_USERS entry with the same name wins, so the env var can override
  // the legacy admin without removing ADMIN_USERNAME.
  if (legacy && !users.some((u) => u.username === legacy.username)) {
    users.push(legacy);
  }
  return users;
}

function equals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Look up a user by name. Returns null for unknown names; never throws. */
export function findUser(username: string): AppUser | null {
  const match = allUsers().find((u) => u.username === username);
  if (!match) return null;
  return { username: match.username, role: match.role, projects: match.projects };
}

/**
 * Verify credentials and return the matching user. Compares against every
 * configured account so a wrong username costs the same work as a wrong
 * password.
 */
export function authenticate(username: string, password: string): AppUser | null {
  let found: StoredUser | null = null;
  for (const user of allUsers()) {
    if (equals(user.username, username) && equals(user.password, password)) {
      found = user;
    }
  }
  if (!found) return null;
  return { username: found.username, role: found.role, projects: found.projects };
}

export function canAccessProject(user: AppUser, project: ProjectKey): boolean {
  return user.role === "admin" || user.projects.includes(project);
}

/** The project a user lands on by default: their first allowed one. */
export function defaultProjectFor(user: AppUser): ProjectKey | null {
  return user.projects[0] ?? null;
}

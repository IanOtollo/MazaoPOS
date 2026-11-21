import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { db, verifyPin } from "./db.ts";
import type { Permission } from "../shared/permissions.ts";

export interface AuthUser {
  id: number;
  name: string;
  role: string; // role name, for display
  roleId: number;
  permissions: Permission[];
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const can = (user: AuthUser, perm: Permission) => user.permissions.includes(perm);

/** Load a user (must be active) together with the permissions of their role. */
export function loadUser(userId: number): AuthUser | undefined {
  const u = db
    .prepare(
      `SELECT u.id, u.name, u.role_id AS roleId, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.active = 1`,
    )
    .get(userId) as { id: number; name: string; roleId: number; role: string } | undefined;
  if (!u) return undefined;
  const perms = db.prepare("SELECT permission FROM role_permissions WHERE role_id=?").all(u.roleId) as { permission: Permission }[];
  return { ...u, permissions: perms.map((p) => p.permission) };
}

export function createSession(userId: number): string {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token,user_id) VALUES (?,?)").run(token, userId);
  return token;
}

async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new HttpError(401, "Not signed in");
  const s = db.prepare("SELECT user_id FROM sessions WHERE token=?").get(token) as { user_id: number } | undefined;
  const user = s ? loadUser(s.user_id) : undefined;
  if (!user) throw new HttpError(401, "Session expired");
  req.user = user;
  return user;
}

/** preHandler: any signed-in user. */
export const requireLogin = () => async (req: FastifyRequest, _reply: FastifyReply) => {
  await authenticate(req);
};

/** preHandler: the signed-in user's role must hold this permission. Enforced on the server, always. */
export function requirePerm(perm: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const user = await authenticate(req);
    if (!can(user, perm)) throw new HttpError(403, "Your role does not allow this");
  };
}

/**
 * Authorisation for a sensitive action (discount, refund).
 * If the current user already holds `perm` they proceed. Otherwise someone whose role holds
 * `sales.approve` must type their PIN, and that person is recorded as the approver.
 */
export function resolveApprover(user: AuthUser, perm: Permission, approvalPin?: string): { id: number; name: string } {
  if (can(user, perm)) return { id: user.id, name: user.name };
  if (!approvalPin) throw new HttpError(403, "Manager approval required");
  const candidates = db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.pin_hash FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id AND rp.permission = 'sales.approve'
       WHERE u.active = 1`,
    )
    .all() as unknown as { id: number; name: string; pin_hash: string }[];
  const hit = candidates.find((c) => verifyPin(approvalPin, c.pin_hash));
  if (!hit) throw new HttpError(403, "Invalid approval PIN");
  return { id: hit.id, name: hit.name };
}

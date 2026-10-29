import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import argon2 from "argon2";
import { env } from "../config/env.js";
import { AuditService } from "../audit/audit.service.js";
import { randomToken, sha256 } from "../common/crypto.js";
import { PrismaService } from "../prisma/prisma.service.js";

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

const userWithRole = { include: { role: true } } as const;

@Injectable()
export class AuthService {
  // Hash of a random value, compared against when the email is unknown so a
  // failed login takes the same time whether or not the account exists.
  private readonly dummyHash = argon2.hash(randomToken());

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  static hashPassword(password: string) {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async login(email: string, password: string, client: ClientInfo) {
    const user = await this.prisma.staffUser.findUnique({ where: { email: email.toLowerCase() }, ...userWithRole });
    const ok = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !ok || !user.active) {
      await this.audit.access({ userId: user?.id, email, action: "LOGIN_FAILED", ...client, remarks: user && !user.active ? "account disabled" : undefined });
      throw new UnauthorizedException({ error: "invalid_credentials", message: "Email or password is incorrect" });
    }
    await this.prisma.staffUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.access({ userId: user.id, email: user.email, action: "LOGIN", ...client });
    return this.issue(user, client);
  }

  /** Swaps a refresh token for a new pair. A reused (already rotated) token signs the user out everywhere. */
  async refresh(rawToken: string | undefined, client: ClientInfo) {
    if (!rawToken) throw new UnauthorizedException({ error: "not_signed_in", message: "Sign in to continue" });
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: userWithRole },
    });
    if (!stored) throw new UnauthorizedException({ error: "token_invalid", message: "Sign in again" });
    if (stored.revokedAt) {
      await this.revokeAll(stored.userId);
      throw new UnauthorizedException({ error: "token_reused", message: "Sign in again" });
    }
    if (stored.expiresAt < new Date() || !stored.user.active) {
      throw new UnauthorizedException({ error: "token_expired", message: "Sign in again" });
    }
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issue(stored.user, client);
  }

  async logout(rawToken: string | undefined, client: ClientInfo) {
    if (!rawToken) return;
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!stored) return;
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    await this.audit.access({ userId: stored.userId, action: "LOGOUT", ...client });
  }

  revokeAll(userId: number) {
    return this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(userId: number) {
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id: userId }, ...userWithRole });
    return publicProfile(user);
  }

  private async issue(
    user: { id: number; email: string; name: string; role: { name: string; permissions: string[] } } & Record<string, unknown>,
    client: ClientInfo,
  ) {
    const cfg = env();
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, typ: "staff", email: user.email, name: user.name, role: user.role.name, permissions: user.role.permissions },
      { expiresIn: cfg.ACCESS_TOKEN_TTL_SECONDS },
    );
    const refreshToken = randomToken();
    const expiresAt = new Date(Date.now() + cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt, ip: client.ip, userAgent: client.userAgent?.slice(0, 300) },
    });
    return {
      accessToken,
      expiresIn: cfg.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt: expiresAt,
      user: publicProfile(user as never),
    };
  }
}

export function publicProfile(user: {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  role: { id: number; name: string; permissions: string[] };
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    active: user.active,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    role: { id: user.role.id, name: user.role.name },
    permissions: user.role.permissions,
  };
}

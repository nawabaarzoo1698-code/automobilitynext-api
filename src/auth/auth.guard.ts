import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { type Action, can, type ModuleKey } from "./permissions.js";

/** What a verified access token tells us about the caller. */
export interface StaffPrincipal {
  id: number;
  email: string;
  name: string;
  role: string;
  permissions: string[];
}

const PUBLIC = "auth:public";
const PERMISSION = "auth:permission";

/** Route needs no login (public site, login itself). */
export const Public = () => SetMetadata(PUBLIC, true);

/** Route needs a staff login holding module:action. */
export const RequirePermission = (module: ModuleKey, action: Action) => SetMetadata(PERMISSION, { module, action });

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Request & { user?: StaffPrincipal }>().user,
);

/**
 * Global guard: every route requires a valid staff access token unless marked
 * @Public(), and then the permission named by @RequirePermission().
 * Identity only ever comes from the signed token, never from the URL or body.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: StaffPrincipal }>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException({ error: "not_signed_in", message: "Sign in to continue" });

    try {
      const payload = await this.jwt.verifyAsync<StaffPrincipal & { sub: number; typ: string }>(token);
      if (payload.typ !== "staff") throw new Error("wrong token type");
      req.user = { id: payload.sub, email: payload.email, name: payload.name, role: payload.role, permissions: payload.permissions };
    } catch {
      throw new UnauthorizedException({ error: "token_invalid", message: "Your session has expired, sign in again" });
    }

    const needed = this.reflector.getAllAndOverride<{ module: ModuleKey; action: Action } | undefined>(PERMISSION, targets);
    if (needed && !can(req.user.permissions, needed.module, needed.action)) {
      throw new ForbiddenException({ error: "forbidden", message: `You need the ${needed.module}:${needed.action} permission` });
    }
    return true;
  }
}

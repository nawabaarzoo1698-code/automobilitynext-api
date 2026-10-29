import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { ZodPipe } from "../common/validation.js";
import { CurrentUser, Public, type StaffPrincipal } from "./auth.guard.js";
import { AuthService, type ClientInfo } from "./auth.service.js";

const REFRESH_COOKIE = "an_refresh";
const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });

function client(req: Request): ClientInfo {
  return { ip: req.ip, userAgent: req.headers["user-agent"] };
}

// The refresh token travels in an HttpOnly cookie for the CMS in a browser,
// so page scripts never see it. The mobile apps can't use cookies: they send
// "X-Client-Type: app", get the token in the response body, and send it back
// as { refreshToken }.
function refreshTokenFrom(req: Request): string | undefined {
  const fromBody = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : undefined;
  return req.cookies?.[REFRESH_COOKIE] ?? fromBody;
}

function forApp(req: Request) {
  return req.headers["x-client-type"] === "app";
}

function setRefreshCookie(res: Response, token: string, expires: Date) {
  const cfg = env();
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: cfg.NODE_ENV === "production",
    sameSite: "lax",
    domain: cfg.COOKIE_DOMAIN,
    path: "/v1/auth",
    expires,
  });
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, refreshExpiresAt, ...session } = await this.auth.login(body.email, body.password, client(req));
    setRefreshCookie(res, refreshToken, refreshExpiresAt);
    return forApp(req) ? { ...session, refreshToken } : session;
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, refreshExpiresAt, ...session } = await this.auth.refresh(refreshTokenFrom(req), client(req));
    setRefreshCookie(res, refreshToken, refreshExpiresAt);
    return forApp(req) ? { ...session, refreshToken } : session;
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(refreshTokenFrom(req), client(req));
    res.clearCookie(REFRESH_COOKIE, { path: "/v1/auth", domain: env().COOKIE_DOMAIN });
  }

  @Get("me")
  me(@CurrentUser() user: StaffPrincipal) {
    return this.auth.me(user.id);
  }
}

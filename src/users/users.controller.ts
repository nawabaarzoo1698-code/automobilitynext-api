import { BadRequestException, Body, ForbiddenException, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { CurrentUser, RequirePermission, type StaffPrincipal } from "../auth/auth.guard.js";
import { AuthService, publicProfile } from "../auth/auth.service.js";
import { ACTIONS, isKnownPermission, MODULES } from "../auth/permissions.js";
import { listQuerySchema, optionalId, orderBy, page, paging, searchWhere } from "../common/list-query.js";
import { parse, patchSchema } from "../common/validation.js";
import { PrismaService } from "../prisma/prisma.service.js";

// Settings → Users, Roles, Modules, Global Settings and Logs.

const password = z.string().min(10, "Use at least 10 characters").max(200);

const userCreate = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().transform((e) => e.toLowerCase()),
  phone: z.string().trim().max(20).nullish(),
  avatarUrl: z.string().url().nullish(),
  roleId: z.number().int().positive(),
  password,
  active: z.boolean().default(true),
});
const userUpdate = patchSchema(userCreate);

const roleCreate = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
  permissions: z.array(z.string()).max(200).refine((ps) => ps.every(isKnownPermission), "Unknown permission in the list"),
});

const userInclude = { role: true } as const;

// Only a full administrator ("*") can hand out full administrator rights,
// so nobody can raise their own access by editing users or roles.
function assertCanGrant(me: StaffPrincipal, permissions: readonly string[]) {
  if (permissions.includes("*") && !me.permissions.includes("*")) {
    throw new ForbiddenException({ error: "forbidden", message: "Only a full administrator can grant full administrator rights" });
  }
}

@ApiTags("cms: users")
@ApiBearerAuth()
@Controller("cms/users")
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequirePermission("users", "view")
  async list(@Query() query: unknown) {
    const q = parse(listQuerySchema.extend({ roleId: optionalId, active: z.enum(["true", "false"]).optional() }), query);
    const where = { ...searchWhere(q.search, ["name", "email", "phone"]), roleId: q.roleId, active: q.active ? q.active === "true" : undefined };
    const [rows, total] = await Promise.all([
      this.prisma.staffUser.findMany({ where, include: userInclude, orderBy: orderBy(q, ["name", "email", "createdAt", "lastLoginAt"], { id: "asc" }), ...paging(q) }),
      this.prisma.staffUser.count({ where }),
    ]);
    const signedIn = await this.signedInIds(rows.map((r) => r.id));
    return page(rows.map((r) => ({ ...publicProfile(r), loginStatus: signedIn.has(r.id) ? "Active" : "Inactive" })), total, q);
  }

  @Get(":id")
  @RequirePermission("users", "view")
  async get(@Param("id", ParseIntPipe) id: number) {
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id }, include: userInclude });
    const signedIn = await this.signedInIds([id]);
    return { ...publicProfile(user), loginStatus: signedIn.has(id) ? "Active" : "Inactive" };
  }

  @Post()
  @RequirePermission("users", "create")
  async create(@Body() body: unknown, @CurrentUser() me: StaffPrincipal) {
    const { password: pw, ...input } = parse(userCreate, body);
    assertCanGrant(me, (await this.prisma.role.findUniqueOrThrow({ where: { id: input.roleId } })).permissions);
    const user = await this.prisma.staffUser.create({ data: { ...input, passwordHash: await AuthService.hashPassword(pw) }, include: userInclude });
    await this.audit.record(me.id, "user", user.id, "create");
    return publicProfile(user);
  }

  @Patch(":id")
  @RequirePermission("users", "edit")
  async update(@Param("id", ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() me: StaffPrincipal) {
    const { password: pw, ...input } = parse(userUpdate, body) as Partial<z.infer<typeof userCreate>>;
    if (id === me.id && input.active === false) throw new BadRequestException({ error: "self_disable", message: "You cannot disable your own account" });
    if (input.roleId) assertCanGrant(me, (await this.prisma.role.findUniqueOrThrow({ where: { id: input.roleId } })).permissions);
    // Changing an administrator's account also needs administrator rights.
    assertCanGrant(me, (await this.prisma.staffUser.findUniqueOrThrow({ where: { id }, include: userInclude })).role.permissions);
    const user = await this.prisma.staffUser.update({
      where: { id },
      data: { ...input, ...(pw ? { passwordHash: await AuthService.hashPassword(pw) } : {}) },
      include: userInclude,
    });
    // A disabled account or a new password ends every session at once.
    if (input.active === false || pw) await this.auth.revokeAll(id);
    await this.audit.record(me.id, "user", id, "update", { fields: Object.keys(input).concat(pw ? ["password"] : []) });
    return publicProfile(user);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("users", "delete")
  async remove(@Param("id", ParseIntPipe) id: number, @CurrentUser() me: StaffPrincipal) {
    if (id === me.id) throw new BadRequestException({ error: "self_delete", message: "You cannot delete your own account" });
    assertCanGrant(me, (await this.prisma.staffUser.findUniqueOrThrow({ where: { id }, include: userInclude })).role.permissions);
    await this.prisma.staffUser.delete({ where: { id } });
    await this.audit.record(me.id, "user", id, "delete");
  }

  /** Users with at least one live session, for the "Login status" column. */
  private async signedInIds(ids: number[]) {
    const live = await this.prisma.refreshToken.findMany({
      where: { userId: { in: ids }, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { userId: true },
      distinct: ["userId"],
    });
    return new Set(live.map((t) => t.userId));
  }
}

@ApiTags("cms: roles")
@ApiBearerAuth()
@Controller("cms")
export class RolesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The Modules screen: every module with the actions a role can be given. */
  @Get("permissions")
  @RequirePermission("roles", "view")
  catalog() {
    return {
      actions: ACTIONS,
      modules: Object.entries(MODULES).map(([key, m]) => ({ key, ...m, permissions: m.actions.map((a) => `${key}:${a}`) })),
    };
  }

  @Get("roles")
  @RequirePermission("roles", "view")
  async list() {
    const rows = await this.prisma.role.findMany({ orderBy: { id: "asc" }, include: { _count: { select: { users: true } } } });
    return { data: rows.map(({ _count, ...r }) => ({ ...r, userCount: _count.users })) };
  }

  @Post("roles")
  @RequirePermission("roles", "create")
  async create(@Body() body: unknown, @CurrentUser() me: StaffPrincipal) {
    const data = parse(roleCreate, body);
    assertCanGrant(me, data.permissions);
    const role = await this.prisma.role.create({ data });
    await this.audit.record(me.id, "role", role.id, "create");
    return role;
  }

  @Patch("roles/:id")
  @RequirePermission("roles", "edit")
  async update(@Param("id", ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() me: StaffPrincipal) {
    const data = parse(patchSchema(roleCreate), body) as Partial<z.infer<typeof roleCreate>>;
    assertCanGrant(me, (await this.prisma.role.findUniqueOrThrow({ where: { id } })).permissions);
    if (data.permissions) assertCanGrant(me, data.permissions);
    const role = await this.prisma.role.update({ where: { id }, data });
    await this.audit.record(me.id, "role", id, "update", { permissions: role.permissions });
    return role;
  }

  @Delete("roles/:id")
  @HttpCode(204)
  @RequirePermission("roles", "delete")
  async remove(@Param("id", ParseIntPipe) id: number, @CurrentUser() me: StaffPrincipal) {
    const users = await this.prisma.staffUser.count({ where: { roleId: id } });
    if (users) throw new BadRequestException({ error: "role_in_use", message: `${users} user(s) still have this role` });
    await this.prisma.role.delete({ where: { id } });
    await this.audit.record(me.id, "role", id, "delete");
  }
}

const settingSchema = z.object({ value: z.string().max(10_000) });

@ApiTags("cms: settings & logs")
@ApiBearerAuth()
@Controller("cms")
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get("settings")
  @RequirePermission("settings", "view")
  async settings() {
    return { data: await this.prisma.setting.findMany({ orderBy: { key: "asc" } }) };
  }

  @Put("settings/:key")
  @RequirePermission("settings", "edit")
  async setSetting(@Param("key") key: string, @Body() body: unknown, @CurrentUser() me: StaffPrincipal) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(key)) throw new BadRequestException({ error: "invalid_key", message: "Use lowercase letters, digits, dot, dash or underscore" });
    const { value } = parse(settingSchema, body);
    const row = await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    await this.audit.record(me.id, "setting", 0, "set", { key });
    return row;
  }

  /** User Access log: sign-ins, sign-outs and failures with IP address. */
  @Get("logs/access")
  @RequirePermission("logs", "view")
  async accessLogs(@Query() query: unknown) {
    const q = parse(listQuerySchema.extend({ userId: optionalId }), query);
    const where = { userId: q.userId, ...searchWhere(q.search, ["email", "ip"]) };
    const [rows, total] = await Promise.all([
      this.prisma.accessLog.findMany({ where, orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, name: true, role: { select: { name: true } } } } }, ...paging(q) }),
      this.prisma.accessLog.count({ where }),
    ]);
    return page(rows, total, q);
  }

  /** Change history, e.g. ?entity=article&entityId=12 for one article's log. */
  @Get("logs/audit")
  @RequirePermission("logs", "view")
  async auditLogs(@Query() query: unknown) {
    const q = parse(listQuerySchema.extend({ entity: z.string().max(50).optional(), entityId: optionalId, userId: optionalId }), query);
    const where = { entity: q.entity, entityId: q.entityId, userId: q.userId };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, name: true, email: true } } }, ...paging(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return page(rows, total, q);
  }
}

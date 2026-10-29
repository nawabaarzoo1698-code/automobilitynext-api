import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  type Type,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { CurrentUser, RequirePermission, type StaffPrincipal } from "../auth/auth.guard.js";
import type { ModuleKey } from "../auth/permissions.js";
import { listQuerySchema, orderBy, page, paging, searchWhere } from "../common/list-query.js";
import { parse, patchSchema } from "../common/validation.js";
import { PrismaService } from "../prisma/prisma.service.js";

type Op = "list" | "get" | "create" | "update" | "delete";

// Prisma's model delegates share these methods; the generic controller only
// needs this much of their shape.
interface Delegate {
  findMany(args: object): Promise<Record<string, unknown>[]>;
  findUnique(args: object): Promise<Record<string, unknown> | null>;
  count(args: object): Promise<number>;
  create(args: object): Promise<Record<string, unknown>>;
  update(args: object): Promise<Record<string, unknown>>;
  delete(args: object): Promise<Record<string, unknown>>;
}

export interface WriteContext {
  prisma: PrismaService;
  /** Present on update: the id being changed. */
  id?: number;
}

/**
 * One CMS resource: a table with list / get / create / update / delete
 * endpoints, a permission module, and optional hooks to shape what is stored
 * and what is returned.
 */
export interface ResourceDef {
  path: string;
  module: ModuleKey;
  /** Module whose "view" permission allows reading the list, when that differs from `module`. */
  readModule?: ModuleKey;
  model: keyof PrismaService & string;
  /** Audit-log entity name; defaults to the model. */
  entity?: string;
  ops?: Op[];
  create: z.ZodObject;
  update?: z.ZodObject;
  /** Extra list filters from the query string, turned into a Prisma where. */
  filters?: { schema: z.ZodObject; where: (q: Record<string, unknown>) => object };
  searchFields: string[];
  sortFields: string[];
  defaultSort: Record<string, "asc" | "desc">;
  include?: object;
  /** Turns validated input into Prisma data (slugs, encryption, relation ids). */
  toData?: (input: Record<string, unknown>, ctx: WriteContext) => Promise<object> | object;
  toResponse?: (row: Record<string, unknown>) => unknown;
}

export function crudController(def: ResourceDef): Type<unknown> {
  const ops = new Set<Op>(def.ops ?? ["list", "get", "create", "update", "delete"]);
  const updateSchema = def.update ?? patchSchema(def.create);
  const listSchema = def.filters ? listQuerySchema.extend(def.filters.schema.shape) : listQuerySchema;
  const respond = (row: Record<string, unknown>) => (def.toResponse ? def.toResponse(row) : row);
  const entity = def.entity ?? def.model;

  @ApiTags(`cms: ${def.path}`)
  @ApiBearerAuth()
  @Controller(`cms/${def.path}`)
  class ResourceController {
    constructor(
      readonly prisma: PrismaService,
      readonly audit: AuditService,
    ) {}

    get table(): Delegate {
      return this.prisma[def.model] as unknown as Delegate;
    }

    @Get()
    @RequirePermission(def.readModule ?? def.module, "view")
    async list(@Query() query: Record<string, unknown>) {
      if (!ops.has("list")) throw new NotFoundException();
      const q = parse(listSchema, query) as z.infer<typeof listQuerySchema> & Record<string, unknown>;
      const where = { ...searchWhere(q.search, def.searchFields), ...(def.filters?.where(q) ?? {}) };
      const [rows, total] = await Promise.all([
        this.table.findMany({ where, include: def.include, orderBy: orderBy(q, def.sortFields, def.defaultSort), ...paging(q) }),
        this.table.count({ where }),
      ]);
      return page(rows.map(respond), total, q);
    }

    @Get(":id")
    @RequirePermission(def.readModule ?? def.module, "view")
    async get(@Param("id", ParseIntPipe) id: number) {
      if (!ops.has("get")) throw new NotFoundException();
      const row = await this.table.findUnique({ where: { id }, include: def.include });
      if (!row) throw new NotFoundException({ error: "not_found", message: "Record not found" });
      return respond(row);
    }

    @Post()
    @RequirePermission(def.module, "create")
    async create(@Body() body: unknown, @CurrentUser() user: StaffPrincipal) {
      if (!ops.has("create")) throw new NotFoundException();
      const input = parse(def.create, body) as Record<string, unknown>;
      const data = def.toData ? await def.toData(input, { prisma: this.prisma }) : input;
      const row = await this.table.create({ data, include: def.include });
      await this.audit.record(user.id, entity, row.id as number, "create");
      return respond(row);
    }

    @Patch(":id")
    @RequirePermission(def.module, "edit")
    async update(@Param("id", ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() user: StaffPrincipal) {
      if (!ops.has("update")) throw new NotFoundException();
      const input = parse(updateSchema, body) as Record<string, unknown>;
      const data = def.toData ? await def.toData(input, { prisma: this.prisma, id }) : input;
      const row = await this.table.update({ where: { id }, data, include: def.include });
      await this.audit.record(user.id, entity, id, "update", { fields: Object.keys(input) });
      return respond(row);
    }

    @Delete(":id")
    @HttpCode(204)
    @RequirePermission(def.module, "delete")
    async remove(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: StaffPrincipal) {
      if (!ops.has("delete")) throw new NotFoundException();
      await this.table.delete({ where: { id } });
      await this.audit.record(user.id, entity, id, "delete");
    }
  }

  Object.defineProperty(ResourceController, "name", { value: `${def.model[0].toUpperCase()}${def.model.slice(1)}CrudController` });
  return ResourceController;
}

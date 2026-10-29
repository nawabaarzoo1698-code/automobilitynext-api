import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { env } from "../config/env.js";
import { type ListQuery, orderBy, page, paging } from "../common/list-query.js";
import { slugify, uniqueSlug } from "../common/text.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ArticleCreate, ArticleUpdate } from "./article.schema.js";

/** An edit lock older than this is treated as abandoned. */
export const LOCK_MINUTES = 15;

export const articleInclude = {
  primaryCategory: { select: { id: true, name: true, slug: true } },
  secondaryCategory: { select: { id: true, name: true, slug: true } },
  agency: { select: { id: true, name: true } },
  regions: { select: { region: { select: { id: true, name: true, code: true } } } },
  tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
  bylines: { orderBy: { position: "asc" }, select: { writer: { select: { id: true, firstName: true, lastName: true, slug: true, avatarUrl: true } } } },
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
  lockedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ArticleInclude;

type ArticleRow = Prisma.ArticleGetPayload<{ include: typeof articleInclude }>;

function lockIsFresh(lockedAt: Date | null) {
  return !!lockedAt && Date.now() - lockedAt.getTime() < LOCK_MINUTES * 60_000;
}

/** The article as the CMS and the apps see it: relations flattened to small objects. */
export function articleView(a: ArticleRow) {
  const { regions, tags, bylines, lockedBy, lockedAt, deletedAt: _d, ...rest } = a;
  return {
    ...rest,
    regions: regions.map((r) => r.region),
    tags: tags.map((t) => t.tag),
    bylines: bylines.map(({ writer }) => ({ id: writer.id, name: `${writer.firstName} ${writer.lastName}`.trim(), slug: writer.slug, avatarUrl: writer.avatarUrl })),
    lock: lockedBy && lockIsFresh(lockedAt) ? { user: lockedBy, since: lockedAt } : null,
  };
}

export interface ArticleFilters {
  status?: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "UNPUBLISHED";
  categoryId?: number;
  regionId?: number;
  writerId?: number;
  storyType?: "REGULAR" | "REVIEW" | "TICKER" | "OPINION" | "INTERVIEW";
  from?: Date;
  to?: Date;
}

@Injectable()
export class ArticlesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ArticlesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    if (env().SCHEDULER_ENABLED) {
      this.timer = setInterval(() => void this.publishDue().catch((e) => this.log.error(e)), 60_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async list(q: ListQuery & ArticleFilters) {
    const where: Prisma.ArticleWhereInput = {
      deletedAt: null,
      status: q.status,
      storyType: q.storyType,
      ...(q.categoryId ? { OR: [{ primaryCategoryId: q.categoryId }, { secondaryCategoryId: q.categoryId }] } : {}),
      ...(q.regionId ? { regions: { some: { regionId: q.regionId } } } : {}),
      ...(q.writerId ? { bylines: { some: { writerId: q.writerId } } } : {}),
      ...(q.from || q.to ? { createdAt: { gte: q.from, lte: q.to } } : {}),
      ...(q.search ? { title: { contains: q.search, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.article.findMany({
        where,
        include: articleInclude,
        orderBy: orderBy(q, ["createdAt", "updatedAt", "publishedAt", "title", "views"], { createdAt: "desc" }),
        ...paging(q),
      }),
      this.prisma.article.count({ where }),
    ]);
    // Lists don't need the full body.
    return page(rows.map((r) => ({ ...articleView(r), body: undefined })), total, q);
  }

  async get(id: number) {
    const row = await this.prisma.article.findFirst({ where: { id, deletedAt: null }, include: articleInclude });
    if (!row) throw new NotFoundException({ error: "not_found", message: "Article not found" });
    return articleView(row);
  }

  async create(input: ArticleCreate, userId: number) {
    const slug = await uniqueSlug(input.slug || input.title, (s) => this.slugTaken(s));
    const tagIds = await this.resolveTags(input.tagIds, input.tagNames);
    const row = await this.prisma.article.create({
      data: {
        ...this.scalars(input),
        slug,
        createdById: userId,
        updatedById: userId,
        regions: { create: input.regionIds.map((regionId) => ({ regionId })) },
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
        bylines: { create: input.writerIds.map((writerId, position) => ({ writerId, position })) },
      },
      include: articleInclude,
    });
    await this.audit.record(userId, "article", row.id, "create");
    return articleView(row);
  }

  async update(id: number, input: ArticleUpdate, userId: number) {
    const current = await this.prisma.article.findFirst({ where: { id, deletedAt: null }, include: articleInclude });
    if (!current) throw new NotFoundException({ error: "not_found", message: "Article not found" });
    this.assertNotLockedByOther(current, userId);

    const tagIds = input.tagIds || input.tagNames ? await this.resolveTags(input.tagIds ?? [], input.tagNames ?? []) : undefined;
    const slug = input.slug ? await uniqueSlug(input.slug, (s) => this.slugTaken(s, id)) : undefined;

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.articleRevision.create({ data: { articleId: id, createdById: userId, data: snapshot(current) } });
      if (input.regionIds) {
        await tx.articleRegion.deleteMany({ where: { articleId: id } });
        await tx.articleRegion.createMany({ data: input.regionIds.map((regionId) => ({ articleId: id, regionId })) });
      }
      if (tagIds) {
        await tx.articleTag.deleteMany({ where: { articleId: id } });
        await tx.articleTag.createMany({ data: tagIds.map((tagId) => ({ articleId: id, tagId })) });
      }
      if (input.writerIds) {
        await tx.articleByline.deleteMany({ where: { articleId: id } });
        await tx.articleByline.createMany({ data: input.writerIds.map((writerId, position) => ({ articleId: id, writerId, position })) });
      }
      return tx.article.update({
        where: { id },
        data: { ...this.scalars(input), slug, updatedById: userId },
        include: articleInclude,
      });
    });
    await this.audit.record(userId, "article", id, "update", { fields: Object.keys(input) });
    return articleView(row);
  }

  /** Publish now, or schedule when `at` is in the future. */
  async publish(id: number, at: Date | undefined, userId: number) {
    const current = await this.prisma.article.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ error: "not_found", message: "Article not found" });
    const scheduled = at && at.getTime() > Date.now() + 30_000;
    const row = await this.prisma.article.update({
      where: { id },
      data: scheduled
        ? { status: "SCHEDULED", scheduledAt: at, updatedById: userId }
        : { status: "PUBLISHED", publishedAt: current.publishedAt ?? new Date(), scheduledAt: null, updatedById: userId },
      include: articleInclude,
    });
    await this.audit.record(userId, "article", id, scheduled ? "schedule" : "publish", scheduled ? { at: at!.toISOString() } : undefined);
    return articleView(row);
  }

  async unpublish(id: number, userId: number) {
    const row = await this.prisma.article.update({
      where: { id, deletedAt: null },
      data: { status: "UNPUBLISHED", scheduledAt: null, updatedById: userId },
      include: articleInclude,
    });
    await this.audit.record(userId, "article", id, "unpublish");
    return articleView(row);
  }

  /** Soft delete: the row stays for logs and can be restored by a developer. */
  async remove(id: number, userId: number) {
    await this.prisma.article.update({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), status: "UNPUBLISHED" } });
    await this.audit.record(userId, "article", id, "delete");
  }

  /** Takes the edit lock, or reports who holds it. */
  async lock(id: number, userId: number) {
    const current = await this.prisma.article.findFirst({ where: { id, deletedAt: null }, include: articleInclude });
    if (!current) throw new NotFoundException({ error: "not_found", message: "Article not found" });
    this.assertNotLockedByOther(current, userId);
    const row = await this.prisma.article.update({ where: { id }, data: { lockedById: userId, lockedAt: new Date() }, include: articleInclude });
    return articleView(row).lock;
  }

  async unlock(id: number, userId: number, force: boolean) {
    const current = await this.prisma.article.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ error: "not_found", message: "Article not found" });
    if (current.lockedById && current.lockedById !== userId && !force && lockIsFresh(current.lockedAt)) {
      throw new HttpException({ error: "locked", message: "Someone else is editing this article" }, HttpStatus.LOCKED);
    }
    await this.prisma.article.update({ where: { id }, data: { lockedById: null, lockedAt: null } });
  }

  revisions(id: number) {
    return this.prisma.articleRevision.findMany({
      where: { articleId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, createdAt: true, createdBy: { select: { id: true, name: true } }, data: true },
    });
  }

  /** Publishes scheduled articles whose time has come. Safe to run from several servers at once. */
  async publishDue(now = new Date()) {
    const due = await this.prisma.article.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now }, deletedAt: null }, select: { id: true } });
    for (const { id } of due) {
      const { count } = await this.prisma.article.updateMany({
        where: { id, status: "SCHEDULED" },
        data: { status: "PUBLISHED", publishedAt: now, scheduledAt: null },
      });
      if (count) await this.audit.record(undefined, "article", id, "publish", { scheduled: true });
    }
    return due.length;
  }

  private assertNotLockedByOther(a: { lockedById: number | null; lockedAt: Date | null; lockedBy?: { name: string } | null }, userId: number) {
    if (a.lockedById && a.lockedById !== userId && lockIsFresh(a.lockedAt)) {
      throw new HttpException(
        { error: "locked", message: `${a.lockedBy?.name ?? "Someone else"} is editing this article`, lockedBy: a.lockedBy, lockedAt: a.lockedAt },
        HttpStatus.LOCKED,
      );
    }
  }

  private scalars(input: ArticleUpdate): Prisma.ArticleUncheckedUpdateInput & Prisma.ArticleUncheckedCreateInput {
    const { regionIds: _r, writerIds: _w, tagIds: _t, tagNames: _n, slug: _s, body, reviewCriteria, ...rest } = input;
    return {
      ...(rest as Prisma.ArticleUncheckedCreateInput),
      ...(body !== undefined ? { body: body as Prisma.InputJsonValue } : {}),
      ...(reviewCriteria !== undefined ? { reviewCriteria } : {}),
    };
  }

  private async slugTaken(slug: string, exceptId?: number) {
    return !!(await this.prisma.article.findFirst({ where: { slug, NOT: exceptId ? { id: exceptId } : undefined }, select: { id: true } }));
  }

  /** Existing tag ids plus tags typed by name, creating names that are new. */
  private async resolveTags(tagIds: number[], tagNames: string[]) {
    const ids = new Set(tagIds);
    for (const name of tagNames) {
      const slug = slugify(name);
      if (!slug) throw new BadRequestException({ error: "invalid_tag", message: `"${name}" is not a usable tag` });
      const tag = await this.prisma.tag.upsert({ where: { slug }, update: {}, create: { name, slug } });
      ids.add(tag.id);
    }
    return [...ids];
  }
}

function snapshot(a: ArticleRow): Prisma.InputJsonValue {
  const v = articleView(a);
  return JSON.parse(JSON.stringify({ ...v, lock: undefined }));
}

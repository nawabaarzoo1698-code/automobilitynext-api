import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { RequirePermission } from "../auth/auth.guard.js";
import { optionalId } from "../common/list-query.js";
import { parse } from "../common/validation.js";
import { PrismaService } from "../prisma/prisma.service.js";

// Analysis & Reports. Views come from the daily roll-up table that the public
// site's view tracking fills; date ranges default to the last 30 days.

const range = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    categoryId: optionalId,
    regionId: optionalId,
    writerId: optionalId,
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .transform((q) => {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 29 * 86_400_000);
    return { ...q, from: day(from), to: day(to) };
  });

function day(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

type Range = z.infer<typeof range>;

@ApiTags("cms: reports")
@ApiBearerAuth()
@Controller("cms/reports")
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Dashboard tiles and the traffic chart. */
  @Get("overview")
  @RequirePermission("dashboard", "view")
  async overview(@Query() query: unknown) {
    const q = parse(range, query);
    const [published, drafts, scheduled, viewsByDay] = await Promise.all([
      this.prisma.article.count({ where: { status: "PUBLISHED", deletedAt: null, publishedAt: { gte: q.from, lte: endOf(q.to) } } }),
      this.prisma.article.count({ where: { status: "DRAFT", deletedAt: null } }),
      this.prisma.article.count({ where: { status: "SCHEDULED", deletedAt: null } }),
      this.viewsByDay(q),
    ]);
    return { from: q.from, to: q.to, published, drafts, scheduled, totalViews: viewsByDay.reduce((n, d) => n + d.views, 0), viewsByDay };
  }

  /** Article Report: articles with their views in the range, plus the daily views chart. */
  @Get("articles")
  @RequirePermission("reports", "view")
  async articles(@Query() query: unknown) {
    const q = parse(range, query);
    const rows = await this.prisma.$queryRaw<{ id: number; title: string; slug: string; publishedAt: Date | null; shares: number; views: bigint }[]>`
      SELECT a.id, a.title, a.slug, a."publishedAt", a.shares, COALESCE(SUM(v.views), 0) AS views
      FROM "Article" a
      JOIN "PageViewDaily" v ON v."articleId" = a.id AND v.day BETWEEN ${q.from} AND ${q.to}
      WHERE a."deletedAt" IS NULL
        AND (${q.categoryId ?? null}::int IS NULL OR a."primaryCategoryId" = ${q.categoryId ?? null}::int)
        AND (${q.regionId ?? null}::int IS NULL OR EXISTS (SELECT 1 FROM "ArticleRegion" r WHERE r."articleId" = a.id AND r."regionId" = ${q.regionId ?? null}::int))
        AND (${q.writerId ?? null}::int IS NULL OR EXISTS (SELECT 1 FROM "ArticleByline" b WHERE b."articleId" = a.id AND b."writerId" = ${q.writerId ?? null}::int))
      GROUP BY a.id
      ORDER BY views DESC
      LIMIT ${q.limit}`;
    const data = rows.map((r) => ({ ...r, views: Number(r.views) }));
    return {
      from: q.from,
      to: q.to,
      articleCount: data.length,
      shareCount: data.reduce((n, r) => n + r.shares, 0),
      totalViews: data.reduce((n, r) => n + r.views, 0),
      viewsByDay: await this.viewsByDay(q),
      data,
    };
  }

  /** Category Report: articles published and views per category. */
  @Get("categories")
  @RequirePermission("reports", "view")
  async categories(@Query() query: unknown) {
    const q = parse(range, query);
    const rows = await this.prisma.$queryRaw<{ id: number; name: string; newsCount: bigint; views: bigint }[]>`
      SELECT c.id, c.name,
        (SELECT COUNT(*) FROM "Article" a WHERE a."primaryCategoryId" = c.id AND a."deletedAt" IS NULL
           AND a.status = 'PUBLISHED' AND a."publishedAt" BETWEEN ${q.from} AND ${endOf(q.to)}) AS "newsCount",
        (SELECT COALESCE(SUM(v.views), 0) FROM "PageViewDaily" v JOIN "Article" a ON a.id = v."articleId"
           WHERE a."primaryCategoryId" = c.id AND v.day BETWEEN ${q.from} AND ${q.to}) AS views
      FROM "Category" c
      ORDER BY views DESC, c.name
      LIMIT ${q.limit}`;
    return summarise(q, rows.map((r) => ({ id: r.id, name: r.name, newsCount: Number(r.newsCount), views: Number(r.views) })));
  }

  /** Contributor Report: stories and views per writer, the basis for payouts. */
  @Get("contributors")
  @RequirePermission("reports", "view")
  async contributors(@Query() query: unknown) {
    const q = parse(range, query);
    const rows = await this.prisma.$queryRaw<{ id: number; name: string; ratePerStory: string | null; newsCount: bigint; views: bigint }[]>`
      SELECT w.id, TRIM(w."firstName" || ' ' || w."lastName") AS name, w."ratePerStory"::text AS "ratePerStory",
        (SELECT COUNT(*) FROM "ArticleByline" b JOIN "Article" a ON a.id = b."articleId"
           WHERE b."writerId" = w.id AND a."deletedAt" IS NULL AND a.status = 'PUBLISHED'
           AND a."publishedAt" BETWEEN ${q.from} AND ${endOf(q.to)}) AS "newsCount",
        (SELECT COALESCE(SUM(v.views), 0) FROM "PageViewDaily" v JOIN "ArticleByline" b ON b."articleId" = v."articleId"
           WHERE b."writerId" = w.id AND v.day BETWEEN ${q.from} AND ${q.to}) AS views
      FROM "Writer" w
      ORDER BY "newsCount" DESC, name
      LIMIT ${q.limit}`;
    return summarise(
      q,
      rows.map((r) => {
        const rate = r.ratePerStory ? Number(r.ratePerStory) : 0;
        return { id: r.id, name: r.name, newsCount: Number(r.newsCount), views: Number(r.views), ratePerStory: rate, amountDue: rate * Number(r.newsCount) };
      }),
    );
  }

  private async viewsByDay(q: Range) {
    const rows = await this.prisma.pageViewDaily.groupBy({
      by: ["day"],
      where: { day: { gte: q.from, lte: q.to }, ...(q.categoryId ? { article: { primaryCategoryId: q.categoryId } } : {}) },
      _sum: { views: true },
      orderBy: { day: "asc" },
    });
    return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), views: r._sum.views ?? 0 }));
  }
}

function endOf(d: Date) {
  return new Date(d.getTime() + 86_400_000 - 1);
}

function summarise<T extends { newsCount: number; views: number }>(q: Range, data: T[]) {
  return {
    from: q.from,
    to: q.to,
    count: data.length,
    newsCount: data.reduce((n, r) => n + r.newsCount, 0),
    totalViews: data.reduce((n, r) => n + r.views, 0),
    data,
  };
}

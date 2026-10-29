import { Body, Controller, Get, Header, HttpCode, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { Public } from "../auth/auth.guard.js";
import { env } from "../config/env.js";
import { randomToken } from "../common/crypto.js";
import { listQuerySchema, page, paging } from "../common/list-query.js";
import { parse } from "../common/validation.js";
import type { Prisma } from "../generated/prisma/client.js";
import { pageBlockSchema } from "../cms/resources.js";
import { PrismaService } from "../prisma/prisma.service.js";

// Read-only API for the news website and the mobile apps. Only published,
// active content is visible. Responses are cacheable at the CDN for a minute.

const CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

const cardSelect = {
  id: true,
  title: true,
  slug: true,
  synopsis: true,
  leadImageUrl: true,
  imageAlt: true,
  storyType: true,
  publishedAt: true,
  primaryCategory: { select: { name: true, slug: true } },
  bylines: { orderBy: { position: "asc" }, select: { writer: { select: { firstName: true, lastName: true, slug: true } } } },
} satisfies Prisma.ArticleSelect;

type Card = Prisma.ArticleGetPayload<{ select: typeof cardSelect }>;

function card(a: Card) {
  const { bylines, ...rest } = a;
  return { ...rest, authors: bylines.map(({ writer }) => ({ name: `${writer.firstName} ${writer.lastName}`.trim(), slug: writer.slug })) };
}

const live = (regionCode?: string): Prisma.ArticleWhereInput => ({
  status: "PUBLISHED",
  deletedAt: null,
  publishedAt: { lte: new Date() },
  ...(regionCode ? { regions: { some: { region: { code: regionCode } } } } : {}),
});

const regionParam = z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/).optional();

@ApiTags("public")
@Public()
@Controller("public")
export class PublicController {
  constructor(private readonly prisma: PrismaService) {}

  /** Homepage for a region (?region=IN or ME): its page blocks, each filled with stories. */
  @Get("home")
  @Header("Cache-Control", CACHE)
  async home(@Query("region") regionRaw?: string) {
    const region = parse(regionParam, regionRaw);
    const pageRow = await this.prisma.page.findFirst({
      where: { isHomepage: true, active: true, ...(region ? { region: { code: region } } : {}) },
      include: { region: { select: { name: true, code: true } } },
    });
    const blocks = z.array(pageBlockSchema).catch([]).parse(pageRow?.blocks ?? []);
    const filled = await Promise.all(
      blocks.map(async (b) => ({ id: b.id, title: b.title, showTitle: b.showTitle, template: b.template, stories: await this.blockStories(b, region) })),
    );
    // Without a configured page, show the latest stories so the site is never empty.
    const latest = filled.length ? undefined : await this.latest(region, 20);
    return { page: pageRow ? { name: pageRow.name, slug: pageRow.slug, region: pageRow.region } : null, blocks: filled, latest };
  }

  @Get("articles")
  @Header("Cache-Control", CACHE)
  async articles(@Query() query: unknown) {
    const q = parse(
      listQuerySchema.extend({ region: regionParam, category: z.string().max(120).optional(), tag: z.string().max(120).optional(), writer: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
      query,
    );
    const where: Prisma.ArticleWhereInput = {
      ...live(q.region),
      ...(q.category ? { OR: [{ primaryCategory: { slug: q.category } }, { secondaryCategory: { slug: q.category } }] } : {}),
      ...(q.tag ? { tags: { some: { tag: { slug: q.tag } } } } : {}),
      ...(q.writer ? { bylines: { some: { writer: { slug: q.writer } } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.article.findMany({ where, select: cardSelect, orderBy: { publishedAt: "desc" }, ...paging(q) }),
      this.prisma.article.count({ where }),
    ]);
    return page(rows.map(card), total, q);
  }

  /** Full article page, with SEO tags and related stories. */
  @Get("articles/:slug")
  @Header("Cache-Control", CACHE)
  async article(@Param("slug") slug: string) {
    const a = await this.prisma.article.findFirst({
      where: { ...live(), slug },
      include: {
        primaryCategory: { select: { id: true, name: true, slug: true } },
        secondaryCategory: { select: { name: true, slug: true } },
        agency: { select: { name: true } },
        tags: { select: { tag: { select: { name: true, slug: true } } } },
        regions: { select: { region: { select: { name: true, code: true } } } },
        bylines: { orderBy: { position: "asc" }, select: { writer: { select: { firstName: true, lastName: true, slug: true, avatarUrl: true, biography: true, social: true } } } },
      },
    });
    if (!a) throw new NotFoundException({ error: "not_found", message: "Article not found" });
    const [seo, related] = await Promise.all([
      this.prisma.seoMeta.findUnique({ where: { entityType_entityId: { entityType: "article", entityId: a.id } } }),
      this.prisma.article.findMany({ where: { ...live(), primaryCategoryId: a.primaryCategoryId, NOT: { id: a.id } }, select: cardSelect, orderBy: { publishedAt: "desc" }, take: 6 }),
    ]);
    const { createdById: _c, updatedById: _u, lockedById: _l, lockedAt: _la, deletedAt: _d, scheduledAt: _s, ...article } = a;
    return {
      ...article,
      tags: a.tags.map((t) => t.tag),
      regions: a.regions.map((r) => r.region),
      authors: a.bylines.map(({ writer }) => ({ name: `${writer.firstName} ${writer.lastName}`.trim(), slug: writer.slug, avatarUrl: writer.avatarUrl, biography: writer.biography, social: writer.social })),
      bylines: undefined,
      seo: {
        title: seo?.metaTitle ?? a.seoTitle ?? a.title,
        description: seo?.metaDescription ?? a.description ?? a.synopsis,
        canonicalUrl: seo?.canonicalUrl ?? `${env().SITE_URL}/${a.primaryCategory.slug}/${a.slug}`,
        ogImageUrl: seo?.ogImageUrl ?? a.leadImageUrl,
        noIndex: seo?.noIndex ?? false,
      },
      related: related.map(card),
    };
  }

  @Get("categories")
  @Header("Cache-Control", CACHE)
  async categories() {
    const rows = await this.prisma.category.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, slug: true, parentId: true, description: true, imageUrl: true } });
    return { data: rows };
  }

  @Get("categories/:slug")
  @Header("Cache-Control", CACHE)
  async category(@Param("slug") slug: string) {
    const c = await this.prisma.category.findFirst({
      where: { slug, active: true },
      select: { id: true, name: true, slug: true, description: true, imageUrl: true, parent: { select: { name: true, slug: true } }, children: { where: { active: true }, select: { name: true, slug: true } } },
    });
    if (!c) throw new NotFoundException({ error: "not_found", message: "Category not found" });
    const seo = await this.prisma.seoMeta.findUnique({ where: { entityType_entityId: { entityType: "category", entityId: c.id } } });
    return { ...c, seo };
  }

  @Get("writers/:slug")
  @Header("Cache-Control", CACHE)
  async writer(@Param("slug") slug: string) {
    const w = await this.prisma.writer.findFirst({ where: { slug, active: true }, select: { firstName: true, lastName: true, slug: true, biography: true, avatarUrl: true, social: true } });
    if (!w) throw new NotFoundException({ error: "not_found", message: "Author not found" });
    return { name: `${w.firstName} ${w.lastName}`.trim(), ...w };
  }

  @Get("tags/:slug")
  @Header("Cache-Control", CACHE)
  async tag(@Param("slug") slug: string) {
    const t = await this.prisma.tag.findFirst({ where: { slug, active: true }, select: { name: true, slug: true, topics: { where: { active: true }, select: { title: true, subtitle: true, description: true, imageUrl: true } } } });
    if (!t) throw new NotFoundException({ error: "not_found", message: "Tag not found" });
    return t;
  }

  @Get("menus")
  @Header("Cache-Control", CACHE)
  async menus() {
    return { data: await this.prisma.menu.findMany({ where: { active: true }, select: { name: true, position: true, items: true } }) };
  }

  @Get("static/:slug")
  @Header("Cache-Control", CACHE)
  async staticPage(@Param("slug") slug: string) {
    const s = await this.prisma.staticContent.findFirst({ where: { slug, active: true, kind: "PAGE" }, select: { title: true, slug: true, html: true, updatedAt: true } });
    if (!s) throw new NotFoundException({ error: "not_found", message: "Page not found" });
    return s;
  }

  /** Board of Directors and Editorial Board for the About pages. */
  @Get("people")
  @Header("Cache-Control", CACHE)
  async people() {
    const rows = await this.prisma.staticContent.findMany({
      where: { active: true, kind: { in: ["BOARD_OF_DIRECTORS", "EDITORIAL_BOARD"] } },
      orderBy: { sortOrder: "asc" },
      select: { kind: true, title: true, subtitle: true, imageUrl: true, html: true },
    });
    return {
      boardOfDirectors: rows.filter((r) => r.kind === "BOARD_OF_DIRECTORS"),
      editorialBoard: rows.filter((r) => r.kind === "EDITORIAL_BOARD"),
    };
  }

  /** Simple title and synopsis search. Moves to Meilisearch in a later phase. */
  @Get("search")
  @Header("Cache-Control", CACHE)
  async search(@Query() query: unknown) {
    const q = parse(listQuerySchema.extend({ q: z.string().trim().min(2).max(100), region: regionParam, limit: z.coerce.number().int().min(1).max(50).default(20) }), query);
    const where: Prisma.ArticleWhereInput = {
      ...live(q.region),
      OR: [{ title: { contains: q.q, mode: "insensitive" } }, { synopsis: { contains: q.q, mode: "insensitive" } }, { tags: { some: { tag: { name: { contains: q.q, mode: "insensitive" } } } } }],
    };
    const [rows, total] = await Promise.all([
      this.prisma.article.findMany({ where, select: cardSelect, orderBy: { publishedAt: "desc" }, ...paging(q) }),
      this.prisma.article.count({ where }),
    ]);
    return page(rows.map(card), total, q);
  }

  /** Used by the site's middleware to send old URLs to new ones. */
  @Get("redirects/resolve")
  @Header("Cache-Control", CACHE)
  async resolveRedirect(@Query("path") path?: string) {
    if (!path) throw new NotFoundException();
    const r = await this.prisma.redirect.findFirst({ where: { fromPath: path, active: true }, select: { toPath: true, statusCode: true } });
    if (!r) throw new NotFoundException({ error: "not_found", message: "No redirect" });
    return r;
  }

  @Get("sitemap.xml")
  @Header("Content-Type", "application/xml; charset=utf-8")
  @Header("Cache-Control", "public, max-age=900")
  async sitemap() {
    const site = env().SITE_URL;
    const [articles, categories] = await Promise.all([
      this.prisma.article.findMany({ where: live(), select: { slug: true, updatedAt: true, primaryCategory: { select: { slug: true } } }, orderBy: { publishedAt: "desc" }, take: 45_000 }),
      this.prisma.category.findMany({ where: { active: true }, select: { slug: true, updatedAt: true } }),
    ]);
    const urls = [
      `<url><loc>${site}/</loc><changefreq>hourly</changefreq></url>`,
      ...categories.map((c) => `<url><loc>${site}/${xml(c.slug)}</loc><lastmod>${c.updatedAt.toISOString()}</lastmod></url>`),
      ...articles.map((a) => `<url><loc>${site}/${xml(a.primaryCategory.slug)}/${xml(a.slug)}</loc><lastmod>${a.updatedAt.toISOString()}</lastmod></url>`),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`;
  }

  /** Google News sitemap: articles from the last 48 hours. */
  @Get("news-sitemap.xml")
  @Header("Content-Type", "application/xml; charset=utf-8")
  @Header("Cache-Control", "public, max-age=300")
  async newsSitemap() {
    const site = env().SITE_URL;
    const since = new Date(Date.now() - 48 * 3_600_000);
    const articles = await this.prisma.article.findMany({
      where: { ...live(), publishedAt: { gte: since, lte: new Date() } },
      select: { slug: true, title: true, publishedAt: true, primaryCategory: { select: { slug: true } } },
      orderBy: { publishedAt: "desc" },
      take: 1000,
    });
    const urls = articles.map(
      (a) =>
        `<url><loc>${site}/${xml(a.primaryCategory.slug)}/${xml(a.slug)}</loc><news:news><news:publication><news:name>Automobility Next</news:name><news:language>en</news:language></news:publication><news:publication_date>${a.publishedAt!.toISOString()}</news:publication_date><news:title>${xml(a.title)}</news:title></news:news></url>`,
    );
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${urls.join("")}</urlset>`;
  }

  /** Counts a page view. The site calls this once per article open. */
  @Post("track/view")
  @HttpCode(204)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async trackView(@Body() body: unknown) {
    const { articleId, region } = parse(z.object({ articleId: z.number().int().positive(), region: regionParam }), body);
    const exists = await this.prisma.article.findFirst({ where: { id: articleId, ...live() }, select: { id: true } });
    if (!exists) return;
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    await this.prisma.$transaction([
      this.prisma.pageViewDaily.upsert({
        where: { articleId_day_regionCode: { articleId, day, regionCode: region ?? "" } },
        update: { views: { increment: 1 } },
        create: { articleId, day, regionCode: region ?? "", views: 1 },
      }),
      this.prisma.article.update({ where: { id: articleId }, data: { views: { increment: 1 } } }),
    ]);
  }

  /** Newsletter sign-up. Confirmation emails are sent once email is set up (Phase 2). */
  @Post("newsletter/subscribe")
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async subscribe(@Body() body: unknown) {
    const { email, name, source } = parse(z.object({ email: z.email().transform((e) => e.toLowerCase()), name: z.string().trim().max(100).optional(), source: z.string().max(50).optional() }), body);
    await this.prisma.newsletterSubscriber.upsert({
      where: { email },
      update: {},
      create: { email, name, source, confirmToken: randomToken(24) },
    });
    // Same answer whether or not the address was already subscribed.
    return { status: "pending_confirmation" };
  }

  @Get("newsletter/confirm")
  async confirm(@Query("token") token?: string) {
    if (!token) throw new NotFoundException();
    const sub = await this.prisma.newsletterSubscriber.findUnique({ where: { confirmToken: token } });
    if (!sub) throw new NotFoundException({ error: "not_found", message: "This confirmation link is not valid" });
    await this.prisma.newsletterSubscriber.update({ where: { id: sub.id }, data: { status: "ACTIVE", confirmedAt: new Date(), confirmToken: null } });
    return { status: "subscribed" };
  }

  /** Public grievance form (required for Indian digital news publishers). */
  @Post("grievances")
  @HttpCode(201)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async grievance(@Body() body: unknown) {
    const input = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.email(),
        phone: z.string().trim().max(20).optional(),
        pinCode: z.string().trim().regex(/^[0-9]{6}$/, "6-digit PIN code").optional(),
        state: z.string().trim().max(100).optional(),
        message: z.string().trim().min(10).max(5000),
      }),
      body,
    );
    const g = await this.prisma.grievance.create({ data: input, select: { id: true, createdAt: true } });
    return { reference: `GRV-${String(g.id).padStart(6, "0")}`, receivedAt: g.createdAt };
  }

  private latest(region: string | undefined, take: number) {
    return this.prisma.article.findMany({ where: live(region), select: cardSelect, orderBy: { publishedAt: "desc" }, take }).then((r) => r.map(card));
  }

  private async blockStories(b: z.infer<typeof pageBlockSchema>, region?: string) {
    const take = b.contentCount;
    const src = b.source;
    if (src.kind === "manual") {
      const rows = await this.prisma.article.findMany({ where: { ...live(), id: { in: src.articleIds } }, select: cardSelect });
      // Keep the editor's order.
      return src.articleIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is Card => !!r).slice(0, take).map(card);
    }
    const where: Prisma.ArticleWhereInput =
      src.kind === "category"
        ? { ...live(region), OR: [{ primaryCategoryId: src.categoryId }, { secondaryCategoryId: src.categoryId }] }
        : src.kind === "tag"
          ? { ...live(region), tags: { some: { tagId: src.tagId } } }
          : live(region);
    const rows = await this.prisma.article.findMany({ where, select: cardSelect, orderBy: { publishedAt: "desc" }, take });
    return rows.map(card);
  }
}

function xml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}


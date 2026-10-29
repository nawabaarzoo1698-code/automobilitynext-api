import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newsroomBasics, setup, type TestContext } from "./helpers.js";

let t: TestContext;
let basics: Awaited<ReturnType<typeof newsroomBasics>>;
let published: { id: number; slug: string };
let editor: string;

beforeAll(async () => {
  t = await setup();
  basics = await newsroomBasics(t.prisma);
  editor = await t.token("editor@test.local");
  const make = async (title: string, extra: object = {}) =>
    (
      await t
        .http()
        .post("/v1/cms/articles")
        .set("Authorization", editor)
        .send({ title, synopsis: `${title} synopsis`, primaryCategoryId: basics.category.id, regionIds: [basics.india.id], writerIds: [basics.writer.id], tagNames: ["Tata Motors"], ...extra })
        .expect(201)
    ).body;
  published = await make("Future of Mobility: How Electric Vehicles Are Transforming");
  await t.http().post(`/v1/cms/articles/${published.id}/publish`).set("Authorization", editor).send({}).expect(200);
  const second = await make("Two-wheeler sales rise in October", { primaryCategoryId: basics.other.id, regionIds: [basics.me.id] });
  await t.http().post(`/v1/cms/articles/${second.id}/publish`).set("Authorization", editor).send({}).expect(200);
  await make("Unpublished draft about batteries");

  await t.prisma.page.create({
    data: {
      name: "EV Page",
      slug: "ev-page",
      regionId: basics.india.id,
      isHomepage: true,
      blocks: [
        { id: "ev", title: "EV & Future Mobility", showTitle: true, template: "grid", contentCount: 4, source: { kind: "category", categoryId: basics.category.id } },
        { id: "picks", title: "Editor's picks", showTitle: true, template: "list", contentCount: 4, source: { kind: "manual", articleIds: [second.id, published.id] } },
      ],
    },
  });
});
afterAll(() => t.app.close());

describe("public site API", () => {
  it("builds a region homepage from its blocks, with no login", async () => {
    const res = await t.http().get("/v1/public/home?region=in").expect(200);
    expect(res.headers["cache-control"]).toContain("max-age=60");
    expect(res.body.page).toMatchObject({ name: "EV Page", region: { code: "IN" } });
    const [ev, picks] = res.body.blocks;
    expect(ev.stories.map((s: { title: string }) => s.title)).toEqual(["Future of Mobility: How Electric Vehicles Are Transforming"]);
    // Manual picks keep the editor's order, across regions.
    expect(picks.stories.map((s: { title: string }) => s.title)).toEqual(["Two-wheeler sales rise in October", "Future of Mobility: How Electric Vehicles Are Transforming"]);
    expect(picks.stories[0].authors).toEqual([{ name: "Automobility Next Team", slug: "automobility-next-team" }]);
  });

  it("falls back to the latest stories when a region has no homepage", async () => {
    const res = await t.http().get("/v1/public/home?region=ME").expect(200);
    expect(res.body.blocks).toEqual([]);
    expect(res.body.latest.map((s: { title: string }) => s.title)).toEqual(["Two-wheeler sales rise in October"]);
  });

  it("serves a published article with SEO tags and related stories, and hides drafts", async () => {
    const res = await t.http().get(`/v1/public/articles/${published.slug}`).expect(200);
    expect(res.body.seo).toMatchObject({
      title: "Future of Mobility: How Electric Vehicles Are Transforming",
      canonicalUrl: `https://www.automobilitynext.com/electric-vehicles/${published.slug}`,
    });
    expect(res.body.lockedById).toBeUndefined();
    expect(res.body.createdById).toBeUndefined();
    await t.http().get("/v1/public/articles/unpublished-draft-about-batteries").expect(404);
  });

  it("lists by category, tag and writer, and searches", async () => {
    const byCat = await t.http().get("/v1/public/articles?category=two-wheelers").expect(200);
    expect(byCat.body.meta.total).toBe(1);
    const byTag = await t.http().get("/v1/public/articles?tag=tata-motors").expect(200);
    expect(byTag.body.meta.total).toBe(2);
    const byWriter = await t.http().get("/v1/public/articles?writer=automobility-next-team&region=IN").expect(200);
    expect(byWriter.body.meta.total).toBe(1);
    const search = await t.http().get("/v1/public/search?q=batteries").expect(200);
    expect(search.body.meta.total).toBe(0);
    const search2 = await t.http().get("/v1/public/search?q=TATA").expect(200);
    expect(search2.body.meta.total).toBe(2);
  });

  it("publishes sitemaps for Google and Google News", async () => {
    const res = await t.http().get("/v1/public/sitemap.xml").expect(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.text).toContain(`https://www.automobilitynext.com/electric-vehicles/${published.slug}`);
    expect(res.text).not.toContain("unpublished-draft");
    const news = await t.http().get("/v1/public/news-sitemap.xml").expect(200);
    expect(news.text).toContain("<news:title>Future of Mobility: How Electric Vehicles Are Transforming</news:title>");
  });

  it("counts views per day for reports", async () => {
    await t.http().post("/v1/public/track/view").send({ articleId: published.id, region: "IN" }).expect(204);
    await t.http().post("/v1/public/track/view").send({ articleId: published.id, region: "IN" }).expect(204);
    await t.http().post("/v1/public/track/view").send({ articleId: 9999 }).expect(204);
    const report = await t.http().get("/v1/cms/reports/articles").set("Authorization", editor).expect(200);
    expect(report.body).toMatchObject({ articleCount: 1, totalViews: 2 });
    expect(report.body.data[0]).toMatchObject({ id: published.id, views: 2 });
    const categories = await t.http().get("/v1/cms/reports/categories").set("Authorization", editor).expect(200);
    expect(categories.body.data.find((c: { name: string }) => c.name === "Electric Vehicles")).toMatchObject({ newsCount: 1, views: 2 });
  });

  it("accepts grievances and newsletter sign-ups", async () => {
    const g = await t.http().post("/v1/public/grievances").send({ name: "Reader", email: "r@example.com", pinCode: "110001", message: "Please correct the headline." }).expect(201);
    expect(g.body.reference).toMatch(/^GRV-\d{6}$/);
    await t.http().post("/v1/public/grievances").send({ name: "Reader", email: "r@example.com", pinCode: "11", message: "short" }).expect(400);

    await t.http().post("/v1/public/newsletter/subscribe").send({ email: "Reader@Example.com" }).expect(202);
    await t.http().post("/v1/public/newsletter/subscribe").send({ email: "reader@example.com" }).expect(202);
    const sub = await t.prisma.newsletterSubscriber.findUniqueOrThrow({ where: { email: "reader@example.com" } });
    expect(sub.status).toBe("PENDING");
    await t.http().get(`/v1/public/newsletter/confirm?token=${sub.confirmToken}`).expect(200);
    expect((await t.prisma.newsletterSubscriber.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ACTIVE");
    await t.http().get("/v1/public/newsletter/confirm?token=wrong").expect(404);
  });

  it("reports health", async () => {
    const res = await t.http().get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", database: "up" });
  });
});

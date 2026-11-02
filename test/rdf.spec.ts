import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newsroomBasics, setup, type TestContext } from "./helpers.js";

// RDF metadata (schema.org JSON-LD): entity links edited in the CMS, published by the API.
let t: TestContext;
let admin: string;
let editor: string;
let basics: Awaited<ReturnType<typeof newsroomBasics>>;
const SITE = "https://www.automobilitynext.com";

type Node = Record<string, unknown> & { "@id"?: string; "@type"?: string | string[] };
const node = (ld: { "@graph": Node[] }, id: string) => ld["@graph"].find((n) => n["@id"] === id);

beforeAll(async () => {
  t = await setup();
  basics = await newsroomBasics(t.prisma);
  admin = await t.token("admin@test.local");
  editor = await t.token("editor@test.local");
});
afterAll(() => t.app.close());

describe("RDF metadata", () => {
  let articleId: number;

  it("stores entity links on tags, categories and writers", async () => {
    const tag = await t.http().post("/v1/cms/tags").set("Authorization", admin).send({ name: "Maruti", entityType: "ORGANIZATION", sameAs: ["https://en.wikipedia.org/wiki/Maruti_Suzuki", "https://www.wikidata.org/wiki/Q470483"] }).expect(201);
    expect(tag.body).toMatchObject({ slug: "maruti", entityType: "ORGANIZATION", sameAs: ["https://en.wikipedia.org/wiki/Maruti_Suzuki", "https://www.wikidata.org/wiki/Q470483"] });
    await t.http().post("/v1/cms/tags").set("Authorization", admin).send({ name: "Bad", sameAs: ["not a link"] }).expect(400);
    await t.http().post("/v1/cms/tags").set("Authorization", admin).send({ name: "Bad", entityType: "ALIEN" }).expect(400);
    // Editing the description leaves the links alone.
    const edited = await t.http().patch(`/v1/cms/tags/${tag.body.id}`).set("Authorization", admin).send({ description: "India's largest carmaker" }).expect(200);
    expect(edited.body.sameAs).toHaveLength(2);

    await t.http().patch(`/v1/cms/categories/${basics.category.id}`).set("Authorization", editor).send({ sameAs: ["https://en.wikipedia.org/wiki/Electric_vehicle"] }).expect(200);
    await t.http().patch(`/v1/cms/writers/${basics.writer.id}`).set("Authorization", admin).send({ social: { linkedin: "https://www.linkedin.com/company/automobilitynext" }, sameAs: ["https://muckrack.com/automobilitynext"] }).expect(200);

    const draft = await t.http().post("/v1/cms/articles").set("Authorization", editor).send({
      title: "Maruti launches its first EV",
      description: "The e Vitara goes on sale.",
      primaryCategoryId: basics.category.id,
      regionIds: [basics.india.id],
      writerIds: [basics.writer.id],
      tagNames: ["Maruti"],
      storyType: "OPINION",
      body: [{ kind: "text", html: "<p>Hello</p>" }],
    }).expect(201);
    articleId = draft.body.id;
  });

  it("previews the graph of a draft in the CMS", async () => {
    const ld = (await t.http().get(`/v1/cms/articles/${articleId}/jsonld`).set("Authorization", editor).expect(200)).body;
    expect(ld["@context"]).toBe("https://schema.org");
    const article = node(ld, `${SITE}/electric-vehicles/maruti-launches-its-first-ev#article`)!;
    expect(article["@type"]).toEqual(["NewsArticle", "OpinionNewsArticle"]);
    expect(article.datePublished).toBeUndefined();
    await t.http().get(`/v1/cms/articles/${articleId}/jsonld`).expect(401);
  });

  it("publishes the graph with the article, linking tags, section and author", async () => {
    await t.http().post(`/v1/cms/articles/${articleId}/publish`).set("Authorization", editor).send({}).expect(200);
    const res = await t.http().get("/v1/public/articles/maruti-launches-its-first-ev").expect(200);
    const ld = res.body.jsonLd;

    const article = node(ld, `${SITE}/electric-vehicles/maruti-launches-its-first-ev#article`)!;
    expect(article).toMatchObject({
      headline: "Maruti launches its first EV",
      description: "The e Vitara goes on sale.",
      publisher: { "@id": `${SITE}/#organization` },
      author: [{ "@id": `${SITE}/authors/automobility-next-team#person` }],
      about: [{ "@id": `${SITE}/electric-vehicles#section` }, { "@id": `${SITE}/tag/maruti#term` }],
      mainEntityOfPage: { "@id": `${SITE}/electric-vehicles/maruti-launches-its-first-ev#webpage` },
    });
    expect(article.datePublished).toEqual(expect.any(String));

    expect(node(ld, `${SITE}/tag/maruti#term`)).toMatchObject({
      "@type": "DefinedTerm",
      additionalType: "https://schema.org/Organization",
      description: "India's largest carmaker",
      sameAs: ["https://en.wikipedia.org/wiki/Maruti_Suzuki", "https://www.wikidata.org/wiki/Q470483"],
      inDefinedTermSet: { "@id": `${SITE}/ns/segments` },
    });
    expect(node(ld, `${SITE}/electric-vehicles#section`)).toMatchObject({ sameAs: ["https://en.wikipedia.org/wiki/Electric_vehicle"] });
    expect(node(ld, `${SITE}/authors/automobility-next-team#person`)).toMatchObject({
      "@type": "Person",
      sameAs: ["https://www.linkedin.com/company/automobilitynext", "https://muckrack.com/automobilitynext"],
    });
    // Every @id the article points to is described in the same graph.
    const described = new Set(ld["@graph"].map((n: Node) => n["@id"]));
    for (const ref of [article.publisher, ...(article.author as Node[]), ...(article.about as Node[])]) expect(described).toContain((ref as Node)["@id"]);
  });

  it("serves graphs for tag, category and author pages and the topic vocabulary", async () => {
    const tag = (await t.http().get("/v1/public/tags/maruti").expect(200)).body;
    expect(tag.jsonLd["@graph"].find((n: Node) => n["@type"] === "CollectionPage").mainEntity.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, url: `${SITE}/electric-vehicles/maruti-launches-its-first-ev`, name: "Maruti launches its first EV" },
    ]);
    const category = (await t.http().get("/v1/public/categories/electric-vehicles").expect(200)).body;
    expect(node(category.jsonLd, `${SITE}/electric-vehicles#section`)).toBeDefined();
    const writer = (await t.http().get("/v1/public/writers/automobility-next-team").expect(200)).body;
    expect(writer.jsonLd["@graph"].some((n: Node) => n["@type"] === "ProfilePage")).toBe(true);

    const vocab = await t.http().get("/v1/public/ns/segments").expect(200);
    expect(vocab.headers["content-type"]).toContain("application/ld+json");
    expect(vocab.body).toMatchObject({ "@type": "DefinedTermSet", "@id": `${SITE}/ns/segments` });
    const terms = vocab.body.hasDefinedTerm.map((d: Node) => d["@id"]);
    expect(terms).toEqual(expect.arrayContaining([`${SITE}/electric-vehicles#section`, `${SITE}/tag/maruti#term`]));
  });
});

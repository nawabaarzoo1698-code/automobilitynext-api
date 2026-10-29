# Automobility Next API

The backend for the Automobility Next news platform. One API serves the CMS
("Page Engine"), the public news website (India and Middle East editions) and
the Android and iOS apps.

- **Stack:** Node.js 22, NestJS 12, TypeScript, Prisma 7, PostgreSQL 16
- **Hosting:** DigitalOcean App Platform (Bangalore), media on DigitalOcean Spaces
- **Docs:** interactive API reference at `/docs` when the server runs

## Run it locally

You need Node.js 22 and either Docker or a local PostgreSQL 16.

```bash
docker compose up -d              # PostgreSQL on localhost:5432 (plus a test database)
cp .env.example .env              # then fill JWT_SECRET and FIELD_ENCRYPTION_KEY
npm install
npm run db:migrate                # create the tables
ADMIN_EMAIL=you@automobilitynext.com ADMIN_PASSWORD='a-long-password' npm run db:seed
npm run start:dev                 # http://localhost:4000, docs at http://localhost:4000/docs
```

The seed creates the roles (Super Admin, Editor, Writer, SEO Editor), the
India and Middle East regions, the categories from the old CMS, the two region
homepages, and your administrator account. Running it again changes nothing.

| Script | What it does |
| --- | --- |
| `npm run start:dev` | Compile and restart on every change |
| `npm test` | Run the test suite against the `automobilitynext_test` database |
| `npm run typecheck` | Type-check without building |
| `npm run build` / `npm start` | Production build and start |
| `npm run db:migrate` | Create a migration after changing `prisma/schema.prisma` |
| `npm run db:deploy` | Apply migrations (what production runs) |

## The API

All routes are under `/v1`, except `/health` and `/docs`.

| Area | Routes | Who |
| --- | --- | --- |
| Sign-in | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | CMS staff |
| Articles | `/cms/articles` (list, get, create, edit, delete), `/:id/publish`, `/:id/unpublish`, `/:id/lock`, `/:id/revisions` | `articles:*` |
| Newsroom tables | `/cms/categories`, `/tags`, `/writers`, `/agencies`, `/topics`, `/topic-types` | per module |
| Webmaster | `/cms/regions`, `/menus`, `/pages`, `/static-content` | `webmaster:*` |
| SEO | `/cms/seo-meta`, `/cms/redirects` | `seo:*` |
| Media | `POST /cms/media/upload-url`, then `POST /cms/media`; list, edit, delete | `media:*` |
| Settings | `/cms/users`, `/cms/roles`, `/cms/permissions`, `/cms/settings/:key`, `/cms/logs/access`, `/cms/logs/audit`, `/cms/grievances`, `/cms/subscribers` | per module |
| Reports | `/cms/reports/overview`, `/articles`, `/categories`, `/contributors` | `dashboard:view`, `reports:view` |
| Public site and apps | `/public/home?region=IN`, `/public/articles`, `/public/articles/:slug`, `/public/categories`, `/public/writers/:slug`, `/public/tags/:slug`, `/public/menus`, `/public/static/:slug`, `/public/people`, `/public/search?q=`, `/public/sitemap.xml`, `/public/news-sitemap.xml`, `/public/redirects/resolve?path=`, `POST /public/track/view`, `POST /public/newsletter/subscribe`, `POST /public/grievances` | anyone |

Conventions:

- **Lists** take `?page=&limit=&search=&sort=field:desc` plus filters, and answer `{ data, meta: { page, limit, total } }`. `limit` is at most 200.
- **Edits** are `PATCH` with only the fields that change; anything left out stays as it is.
- **Errors** are `{ statusCode, error, message, fields? }`, e.g. `400 validation_failed` with the fields at fault, `409 already_exists`, `423 locked` when another editor holds an article.
- **Permissions** are `module:action` pairs held by a role (`GET /cms/permissions` lists them). `*` is everything. Only a full administrator can grant full administrator rights.

### Sign-in

The CMS calls `POST /v1/auth/login` with `credentials: "include"`. It gets a
15-minute access token in the response and a 30-day refresh token in an
HttpOnly cookie that page scripts can't read. Send the access token as
`Authorization: Bearer <token>`; when it expires, call `POST /v1/auth/refresh`
(again with credentials) for a new one. Refresh tokens rotate on every use,
and replaying an old one ends all of that user's sessions.

The mobile apps can't use cookies: they send the header `X-Client-Type: app`,
receive `refreshToken` in the response body, and send it back as
`{ "refreshToken": "..." }` to `/auth/refresh` and `/auth/logout`.

### Uploading media

1. `POST /v1/cms/media/upload-url` with `{ kind, fileName, mimeType, sizeBytes }` → `{ uploadUrl, storageKey, publicUrl, headers }`
2. The browser `PUT`s the file to `uploadUrl` with those `headers`.
3. `POST /v1/cms/media` with `{ kind, storageKey, title, mimeType, altText, ... }` adds it to the library.

Limits: images JPG/PNG/WEBP up to 5 MB, videos MP4/MOV/WebM up to 500 MB,
documents PDF/DOC/DOCX/XLS/XLSX up to 20 MB.

## Connecting the CMS frontend

The rebuilt CMS (`automobilitynext-cms`) reads and writes through
`src/lib/api.ts`. Each mock collection maps to a route here:

| Frontend `api.*` | API route |
| --- | --- |
| `articles` | `/cms/articles` (+ publish, lock, revisions) |
| `categories`, `tags`, `writers`, `topics`, `topicTypes` | `/cms/categories`, `/cms/tags`, `/cms/writers`, `/cms/topics`, `/cms/topic-types` |
| `menus`, `pages`, `regions`, `staticContents` | `/cms/menus`, `/cms/pages`, `/cms/regions`, `/cms/static-content` |
| `media` | `/cms/media` |
| `subscribers` | `/cms/subscribers` |
| `users`, `roles`, `modules` | `/cms/users`, `/cms/roles`, `/cms/permissions` |
| `articleLogs`, `accessLogs` | `/cms/logs/audit?entity=article`, `/cms/logs/access` |
| `login()` | `/auth/login` |

Relations are sent as ids (`primaryCategoryId`, `writerIds`, `regionIds`,
`tagIds`, or `tagNames` for new tags) and come back as small objects
(`primaryCategory: { id, name, slug }`, `bylines: [{ id, name }]`), so the
frontend's forms switch from names to ids.

Not built yet (Phase 2): newsletters and sending, ad management and
campaigns, payouts, events, data sources, scheduled social posts, push
notifications, reader accounts and comments.

## Deploying to DigitalOcean

1. In DigitalOcean, **Apps → Create App → GitHub**, pick this repository, and import `.do/app.yaml` (or run `doctl apps create --spec .do/app.yaml`).
2. In the app's **Settings → Environment Variables**, replace every `CHANGE_ME`. Generate `JWT_SECRET` with `openssl rand -base64 48` and `FIELD_ENCRYPTION_KEY` with `openssl rand -base64 32`, and keep a copy of the encryption key somewhere safe.
3. Create a **Spaces** bucket in BLR1 with the CDN on, and a Spaces access key; fill the `S3_*` values and `MEDIA_PUBLIC_BASE_URL`.
4. Deploy. Every push to `main` then deploys automatically, and the `migrate` job applies database migrations first.
5. Create the first administrator once, from the app's **Console** tab: `ADMIN_EMAIL=... ADMIN_PASSWORD='...' npx prisma db seed`.
6. Point `api.automobilitynext.com` at the app (Settings → Domains).

If the app logs a "self-signed certificate" error connecting to the database,
append `&uselibpqcompat=true` to `DATABASE_URL`; DigitalOcean's managed
PostgreSQL uses its own certificate authority.

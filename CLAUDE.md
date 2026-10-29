# Notes for working in this repo

- ESM project (`"type": "module"`): relative imports end in `.js`, even from `.ts` files.
- Prisma 7 with the `prisma-client` generator: the client is generated into `src/generated/prisma` (git-ignored) and imported from `../generated/prisma/client.js`. It connects through `@prisma/adapter-pg`.
- Run the app compiled (`npm run start:dev` or `node dist/main.js`). Running `src/main.ts` through `tsx` breaks Nest dependency injection because `@nestjs/throttler` (CommonJS) and Nest 12 (ESM) end up loaded twice.
- Validation uses zod. Use `patchSchema()` for PATCH bodies: zod 4 applies `.default()` values even inside `.partial()`, which would reset fields the client did not send.
- Simple CMS tables are declared in `src/cms/resources.ts` and served by the generic controller in `src/cms/crud.ts`. Articles, media, users and reports have their own controllers.
- Every CMS route needs `@RequirePermission(module, action)`; public routes need `@Public()`. Identity only comes from the access token.
- Tests are end-to-end against a real PostgreSQL database (`automobilitynext_test`); `npm test` applies migrations first.

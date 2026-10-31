import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { PrismaErrorFilter } from "./common/prisma-errors.filter.js";
import { env } from "./config/env.js";
import { StorageService } from "./media/media.controller.js";

/** Builds the app with everything main.ts and the tests share. */
export async function createApp(): Promise<INestApplication> {
  const cfg = env();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: cfg.NODE_ENV === "test" ? false : undefined });
  // Behind DigitalOcean's load balancer and Cloudflare: trust their X-Forwarded-For for client IPs.
  app.set("trust proxy", true);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: cfg.CORS_ORIGINS.split(",").map((o) => o.trim()), credentials: true });
  app.setGlobalPrefix("v1", { exclude: ["health"] });
  const mediaDir = app.get(StorageService).localDir;
  if (mediaDir) {
    // Local media (see StorageService): the CMS on another port shows these images.
    app.useStaticAssets(mediaDir, { prefix: "/media/", setHeaders: (res) => res.setHeader("Cross-Origin-Resource-Policy", "cross-origin") });
  }
  app.useGlobalFilters(new PrismaErrorFilter());
  app.enableShutdownHooks();

  const docs = new DocumentBuilder()
    .setTitle("Automobility Next API")
    .setDescription("CMS (/v1/cms), public site and apps (/v1/public), and staff sign-in (/v1/auth).")
    .setVersion("1")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, docs));
  return app;
}

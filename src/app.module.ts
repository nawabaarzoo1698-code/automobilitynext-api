import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ArticlesController } from "./articles/articles.controller.js";
import { ArticlesService } from "./articles/articles.service.js";
import { AuditModule } from "./audit/audit.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { crudController } from "./cms/crud.js";
import { RESOURCES } from "./cms/resources.js";
import { env } from "./config/env.js";
import { HealthController } from "./health.controller.js";
import { MediaController, StorageService } from "./media/media.controller.js";
import { PrismaModule } from "./prisma/prisma.service.js";
import { PublicController } from "./public/public.controller.js";
import { ReportsController } from "./reports/reports.controller.js";
import { RolesController, SettingsController, UsersController } from "./users/users.controller.js";

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    JwtModule.registerAsync({ useFactory: () => ({ secret: env().JWT_SECRET, signOptions: { algorithm: "HS256" }, verifyOptions: { algorithms: ["HS256"] } }) }),
    // Default limit for every route; login, forms and tracking set their own.
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
  ],
  controllers: [
    HealthController,
    AuthController,
    ArticlesController,
    ...RESOURCES.map(crudController),
    MediaController,
    UsersController,
    RolesController,
    SettingsController,
    ReportsController,
    PublicController,
  ],
  providers: [
    AuthService,
    ArticlesService,
    StorageService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

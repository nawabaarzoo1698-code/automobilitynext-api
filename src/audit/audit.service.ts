import { Global, Injectable, Module } from "@nestjs/common";
import type { AccessAction, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** Writes the rows behind the Logs screens: who changed what, and who signed in from where. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(userId: number | undefined, entity: string, entityId: number, action: string, changes?: Prisma.InputJsonValue) {
    return this.prisma.auditLog.create({ data: { userId, entity, entityId, action, changes } });
  }

  access(entry: { userId?: number; email?: string; action: AccessAction; ip?: string; userAgent?: string; remarks?: string }) {
    return this.prisma.accessLog.create({ data: entry });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}

import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { CurrentUser, RequirePermission, type StaffPrincipal } from "../auth/auth.guard.js";
import { env } from "../config/env.js";
import { listQuerySchema, page, paging, searchWhere } from "../common/list-query.js";
import { parse, patchSchema } from "../common/validation.js";
import { PrismaService } from "../prisma/prisma.service.js";

// Uploads go straight from the browser to storage (DigitalOcean Spaces or S3)
// with a short-lived signed URL, so large videos never pass through the API.
// 1. POST /cms/media/upload-url  → { uploadUrl, storageKey }
// 2. browser PUTs the file to uploadUrl
// 3. POST /cms/media with storageKey and details → the library entry

const MB = 1024 * 1024;
const RULES = {
  IMAGE: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * MB },
  VIDEO: { types: ["video/mp4", "video/quicktime", "video/webm"], maxBytes: 500 * MB },
  DOCUMENT: {
    types: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    maxBytes: 20 * MB,
  },
} as const;

const kind = z.enum(["IMAGE", "VIDEO", "DOCUMENT"]);

const uploadRequest = z.object({
  kind,
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
});

const register = z.object({
  kind,
  storageKey: z.string().regex(/^uploads\/(images|videos|documents)\/\d{4}-\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,6}$/),
  title: z.string().trim().min(1).max(200),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().positive().nullish(),
  altText: z.string().trim().max(300).nullish(),
  caption: z.string().trim().max(500).nullish(),
  credit: z.string().trim().max(200).nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
});

const editable = patchSchema(register.pick({ title: true, altText: true, caption: true, credit: true }));

@Injectable()
export class StorageService {
  private client?: S3Client;

  get configured() {
    const c = env();
    return !!(c.S3_ENDPOINT && c.S3_BUCKET && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY && c.MEDIA_PUBLIC_BASE_URL);
  }

  private s3() {
    const c = env();
    if (!this.configured) throw new ServiceUnavailableException({ error: "storage_not_configured", message: "Media storage is not set up yet" });
    this.client ??= new S3Client({
      endpoint: c.S3_ENDPOINT,
      region: c.S3_REGION,
      credentials: { accessKeyId: c.S3_ACCESS_KEY_ID!, secretAccessKey: c.S3_SECRET_ACCESS_KEY! },
    });
    return this.client;
  }

  publicUrl(key: string) {
    return `${env().MEDIA_PUBLIC_BASE_URL!.replace(/\/$/, "")}/${key}`;
  }

  uploadUrl(key: string, mimeType: string, sizeBytes: number) {
    const cmd = new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, ContentType: mimeType, ContentLength: sizeBytes, ACL: "public-read" });
    return getSignedUrl(this.s3(), cmd, { expiresIn: 600 });
  }

  async remove(key: string) {
    await this.s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
  }
}

@ApiTags("cms: media")
@ApiBearerAuth()
@Controller("cms/media")
export class MediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission("media", "view")
  async list(@Query() query: unknown) {
    const q = parse(listQuerySchema.extend({ kind: kind.optional() }), query);
    const where = { kind: q.kind, ...searchWhere(q.search, ["title", "altText", "caption"]) };
    const [rows, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({ where, orderBy: { createdAt: "desc" }, include: { uploadedBy: { select: { id: true, name: true } } }, ...paging(q) }),
      this.prisma.mediaAsset.count({ where }),
    ]);
    return page(rows, total, q);
  }

  @Post("upload-url")
  @HttpCode(200)
  @RequirePermission("media", "create")
  async uploadUrl(@Body() body: unknown) {
    const req = parse(uploadRequest, body);
    const rule = RULES[req.kind];
    if (!(rule.types as readonly string[]).includes(req.mimeType)) {
      throw new BadRequestException({ error: "file_type", message: `This file type is not allowed for ${req.kind.toLowerCase()}s` });
    }
    if (req.sizeBytes > rule.maxBytes) {
      throw new BadRequestException({ error: "file_too_large", message: `Maximum size is ${rule.maxBytes / MB} MB` });
    }
    const ext = (req.fileName.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "bin";
    const folder = { IMAGE: "images", VIDEO: "videos", DOCUMENT: "documents" }[req.kind];
    const storageKey = `uploads/${folder}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${ext}`;
    return {
      uploadUrl: await this.storage.uploadUrl(storageKey, req.mimeType, req.sizeBytes),
      storageKey,
      publicUrl: this.storage.publicUrl(storageKey),
      headers: { "Content-Type": req.mimeType, "x-amz-acl": "public-read" },
    };
  }

  @Post()
  @RequirePermission("media", "create")
  async register(@Body() body: unknown, @CurrentUser() me: StaffPrincipal) {
    const input = parse(register, body);
    if (!this.storage.configured) throw new ServiceUnavailableException({ error: "storage_not_configured", message: "Media storage is not set up yet" });
    const row = await this.prisma.mediaAsset.create({ data: { ...input, url: this.storage.publicUrl(input.storageKey), uploadedById: me.id } });
    await this.audit.record(me.id, "media", row.id, "create");
    return row;
  }

  @Patch(":id")
  @RequirePermission("media", "edit")
  async update(@Param("id", ParseIntPipe) id: number, @Body() body: unknown, @CurrentUser() me: StaffPrincipal) {
    const row = await this.prisma.mediaAsset.update({ where: { id }, data: parse(editable, body) });
    await this.audit.record(me.id, "media", id, "update");
    return row;
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("media", "delete")
  async remove(@Param("id", ParseIntPipe) id: number, @CurrentUser() me: StaffPrincipal) {
    const row = await this.prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    await this.storage.remove(row.storageKey);
    await this.prisma.mediaAsset.delete({ where: { id } });
    await this.audit.record(me.id, "media", id, "delete");
  }
}

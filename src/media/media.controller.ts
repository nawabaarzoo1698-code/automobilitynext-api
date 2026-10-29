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
  ForbiddenException,
  NotFoundException,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { CurrentUser, Public, RequirePermission, type StaffPrincipal } from "../auth/auth.guard.js";
import { env } from "../config/env.js";
import { listQuerySchema, page, paging, searchWhere } from "../common/list-query.js";
import { parse, patchSchema } from "../common/validation.js";
import { PrismaService } from "../prisma/prisma.service.js";

// Uploads go straight from the browser to storage (DigitalOcean Spaces or S3)
// with a short-lived signed URL, so large videos never pass through the API.
// 1. POST /cms/media/upload-url  → { uploadUrl, storageKey }
// 2. browser PUTs the file to uploadUrl
// 3. POST /cms/media with storageKey and details → the library entry
// Without S3 (on one computer), MEDIA_LOCAL_DIR keeps files in a folder: step 2
// then PUTs to /cms/media/local-upload and the API serves them under /media.

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

const STORAGE_KEY = /^uploads\/(images|videos|documents)\/\d{4}-\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,6}$/;

const kind = z.enum(["IMAGE", "VIDEO", "DOCUMENT"]);

const uploadRequest = z.object({
  kind,
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
});

const register = z.object({
  kind,
  storageKey: z.string().regex(STORAGE_KEY),
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

/** File extensions local storage will accept and serve (the allowed upload types). */
const LOCAL_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "mov", "webm", "pdf", "doc", "docx", "xls", "xlsx"]);

@Injectable()
export class StorageService {
  private client?: S3Client;

  private get s3Configured() {
    const c = env();
    return !!(c.S3_ENDPOINT && c.S3_BUCKET && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY && c.MEDIA_PUBLIC_BASE_URL);
  }

  /** Folder for uploads when running on one computer without S3 (never in production). */
  get localDir() {
    const c = env();
    return !this.s3Configured && c.MEDIA_LOCAL_DIR && c.NODE_ENV !== "production" ? path.resolve(c.MEDIA_LOCAL_DIR) : undefined;
  }

  get configured() {
    return this.s3Configured || !!this.localDir;
  }

  private s3() {
    const c = env();
    if (!this.s3Configured) throw new ServiceUnavailableException({ error: "storage_not_configured", message: "Media storage is not set up yet" });
    this.client ??= new S3Client({
      endpoint: c.S3_ENDPOINT,
      region: c.S3_REGION,
      credentials: { accessKeyId: c.S3_ACCESS_KEY_ID!, secretAccessKey: c.S3_SECRET_ACCESS_KEY! },
    });
    return this.client;
  }

  publicUrl(key: string) {
    const base = this.localDir ? `${env().API_PUBLIC_URL.replace(/\/$/, "")}/media` : env().MEDIA_PUBLIC_BASE_URL!.replace(/\/$/, "");
    return `${base}/${key}`;
  }

  /** Headers the browser must send with its PUT to the upload URL. */
  uploadHeaders(mimeType: string): Record<string, string> {
    return this.localDir ? { "Content-Type": mimeType } : { "Content-Type": mimeType, "x-amz-acl": "public-read" };
  }

  uploadUrl(key: string, mimeType: string, sizeBytes: number) {
    if (this.localDir) {
      const ticket = { key, type: mimeType, size: String(sizeBytes), exp: String(Date.now() + 600_000) };
      const query = new URLSearchParams({ ...ticket, sig: this.sign(ticket) });
      return Promise.resolve(`${env().API_PUBLIC_URL.replace(/\/$/, "")}/v1/cms/media/local-upload?${query}`);
    }
    const cmd = new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, ContentType: mimeType, ContentLength: sizeBytes, ACL: "public-read" });
    return getSignedUrl(this.s3(), cmd, { expiresIn: 600 });
  }

  /** Saves a browser upload to the local folder, checking the signed ticket from uploadUrl(). */
  async saveLocal(q: Record<string, string | undefined>, contentType: string | undefined, body: Readable) {
    const dir = this.localDir;
    if (!dir) throw new NotFoundException();
    const ticket = { key: q.key ?? "", type: q.type ?? "", size: q.size ?? "", exp: q.exp ?? "" };
    const expected = Buffer.from(this.sign(ticket));
    const given = Buffer.from(q.sig ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected) || Number(ticket.exp) < Date.now()) {
      throw new ForbiddenException({ error: "bad_upload_url", message: "This upload link is invalid or has expired" });
    }
    if (contentType !== ticket.type) throw new BadRequestException({ error: "file_type", message: "Content-Type does not match the upload link" });
    const file = this.localPath(ticket.key);
    const size = Number(ticket.size);
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        done(received > size ? new BadRequestException({ error: "file_too_large", message: "The file is larger than announced" }) : null, chunk);
      },
    });
    await mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.part`;
    try {
      await pipeline(body, limit, createWriteStream(partial));
      if (received !== size) throw new BadRequestException({ error: "incomplete_upload", message: "The upload was incomplete" });
      await rename(partial, file);
    } catch (e) {
      await rm(partial, { force: true });
      throw e;
    }
  }

  async remove(key: string) {
    if (this.localDir) return rm(this.localPath(key), { force: true });
    await this.s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
  }

  private localPath(key: string) {
    const ext = key.split(".").pop() ?? "";
    if (!STORAGE_KEY.test(key) || !LOCAL_EXTENSIONS.has(ext)) throw new BadRequestException({ error: "bad_key", message: "Invalid storage key" });
    return path.join(this.localDir!, key);
  }

  private sign(t: { key: string; type: string; size: string; exp: string }) {
    return createHmac("sha256", env().JWT_SECRET).update(`local-upload\n${t.key}\n${t.type}\n${t.size}\n${t.exp}`).digest("hex");
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
      headers: this.storage.uploadHeaders(req.mimeType),
    };
  }

  /** Step 2 when media is kept on this computer (MEDIA_LOCAL_DIR): the signed URL replaces sign-in. */
  @Put("local-upload")
  @Public()
  async localUpload(@Query() query: Record<string, string | undefined>, @Req() req: Request) {
    await this.storage.saveLocal(query, req.headers["content-type"], req);
    return { ok: true };
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

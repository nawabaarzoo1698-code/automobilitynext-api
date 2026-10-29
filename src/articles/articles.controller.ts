import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { CurrentUser, RequirePermission, type StaffPrincipal } from "../auth/auth.guard.js";
import { can } from "../auth/permissions.js";
import { listQuerySchema, optionalDate, optionalId } from "../common/list-query.js";
import { parse, ZodPipe } from "../common/validation.js";
import { articleCreateSchema, articleUpdateSchema, type ArticleUpdate, publishSchema } from "./article.schema.js";
import { ArticlesService } from "./articles.service.js";

const articleListSchema = listQuerySchema.extend({
  status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED", "UNPUBLISHED"]).optional(),
  storyType: z.enum(["REGULAR", "REVIEW", "TICKER", "OPINION", "INTERVIEW"]).optional(),
  categoryId: optionalId,
  regionId: optionalId,
  writerId: optionalId,
  from: optionalDate,
  to: optionalDate,
});

@ApiTags("cms: articles")
@ApiBearerAuth()
@Controller("cms/articles")
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get()
  @RequirePermission("articles", "view")
  list(@Query() query: unknown) {
    return this.articles.list(parse(articleListSchema, query));
  }

  @Get(":id")
  @RequirePermission("articles", "view")
  get(@Param("id", ParseIntPipe) id: number) {
    return this.articles.get(id);
  }

  @Post()
  @RequirePermission("articles", "create")
  create(@Body(new ZodPipe(articleCreateSchema)) body: z.infer<typeof articleCreateSchema>, @CurrentUser() user: StaffPrincipal) {
    return this.articles.create(body, user.id);
  }

  @Patch(":id")
  @RequirePermission("articles", "edit")
  update(@Param("id", ParseIntPipe) id: number, @Body(new ZodPipe(articleUpdateSchema)) body: ArticleUpdate, @CurrentUser() user: StaffPrincipal) {
    return this.articles.update(id, body, user.id);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("articles", "delete")
  remove(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: StaffPrincipal) {
    return this.articles.remove(id, user.id);
  }

  @Post(":id/publish")
  @HttpCode(200)
  @RequirePermission("articles", "publish")
  publish(@Param("id", ParseIntPipe) id: number, @Body(new ZodPipe(publishSchema)) body: z.infer<typeof publishSchema>, @CurrentUser() user: StaffPrincipal) {
    return this.articles.publish(id, body.at, user.id);
  }

  @Post(":id/unpublish")
  @HttpCode(200)
  @RequirePermission("articles", "publish")
  unpublish(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: StaffPrincipal) {
    return this.articles.unpublish(id, user.id);
  }

  /** Call when an editor opens the article, and again every few minutes while they edit. */
  @Post(":id/lock")
  @HttpCode(200)
  @RequirePermission("articles", "edit")
  lock(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: StaffPrincipal) {
    return this.articles.lock(id, user.id);
  }

  /** Call when the editor closes the article. Users who can publish may pass ?force=true. */
  @Delete(":id/lock")
  @HttpCode(204)
  @RequirePermission("articles", "edit")
  unlock(@Param("id", ParseIntPipe) id: number, @Query("force") force: string | undefined, @CurrentUser() user: StaffPrincipal) {
    return this.articles.unlock(id, user.id, force === "true" && can(user.permissions, "articles", "publish"));
  }

  @Get(":id/revisions")
  @RequirePermission("articles", "view")
  revisions(@Param("id", ParseIntPipe) id: number) {
    return this.articles.revisions(id);
  }
}

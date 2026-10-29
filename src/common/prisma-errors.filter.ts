import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { Prisma } from "../generated/prisma/client.js";

// Turns common database errors into clear HTTP answers instead of 500s.
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaErrorFilter implements ExceptionFilter {
  catch(err: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    switch (err.code) {
      case "P2002":
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: 409,
          error: "already_exists",
          message: "A record with the same unique value already exists",
          fields: (err.meta?.target as string[] | undefined) ?? [],
        });
      case "P2025":
        return res.status(HttpStatus.NOT_FOUND).json({ statusCode: 404, error: "not_found", message: "Record not found" });
      case "P2003":
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: 409,
          error: "in_use",
          message: "This record is linked to other records, or a linked record does not exist",
        });
      default:
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, error: "database_error", message: "Database error" });
    }
  }
}

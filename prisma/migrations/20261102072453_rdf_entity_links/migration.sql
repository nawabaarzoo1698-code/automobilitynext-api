-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('THING', 'ORGANIZATION', 'BRAND', 'PERSON', 'PLACE', 'PRODUCT', 'EVENT');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "sameAs" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "description" TEXT,
ADD COLUMN     "entityType" "EntityType" NOT NULL DEFAULT 'THING',
ADD COLUMN     "sameAs" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Writer" ADD COLUMN     "sameAs" TEXT[] DEFAULT ARRAY[]::TEXT[];

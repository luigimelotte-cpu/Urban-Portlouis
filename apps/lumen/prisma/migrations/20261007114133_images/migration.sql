-- CreateEnum
CREATE TYPE "ImageKind" AS ENUM ('PORTRAIT', 'SELFIE', 'SCENE');

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "kind" "ImageKind" NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL,
    "providerId" TEXT,
    "model" TEXT,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Image_userId_characterId_createdAt_idx" ON "Image"("userId", "characterId", "createdAt");

-- CreateIndex
CREATE INDEX "Image_messageId_idx" ON "Image"("messageId");

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: images are generated per user, so cap a runaway client.
ALTER TABLE "Image" ADD CONSTRAINT "Image_size_limit" CHECK (octet_length("data") <= 8000000);

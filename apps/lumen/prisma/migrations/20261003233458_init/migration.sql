-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ContentMode" AS ENUM ('SAFE', 'MATURE', 'ADULT');

-- CreateEnum
CREATE TYPE "ConversationStyle" AS ENUM ('CHAT', 'ROLEPLAY', 'STORY');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'CHARACTER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('EPISODIC', 'LONG_TERM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "birthYear" INTEGER,
    "ageVerifiedAt" TIMESTAMP(3),
    "adultOptIn" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "name" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" TEXT NOT NULL,
    "tagline" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avatarUrl" TEXT,
    "maxContentMode" "ContentMode" NOT NULL DEFAULT 'MATURE',
    "profile" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "title" TEXT,
    "style" "ConversationStyle" NOT NULL DEFAULT 'ROLEPLAY',
    "contentMode" "ContentMode" NOT NULL DEFAULT 'SAFE',
    "summary" TEXT NOT NULL DEFAULT '',
    "summarizedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "characterId" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" "MemoryKind" NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "factKey" TEXT,
    "importance" DOUBLE PRECISION NOT NULL,
    "emotion" TEXT,
    "peopleInvolved" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relationshipEffect" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(768),
    "reinforcement" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationshipState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "trust" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "affection" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "attraction" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "comfort" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "attachment" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "tension" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "conflict" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'STRANGER',
    "milestones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelationshipState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmotionalState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmotionalState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnv" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "capabilities" JSONB NOT NULL,
    "contextWindow" INTEGER NOT NULL DEFAULT 32000,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 1024,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "roles" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "options" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Character_visibility_createdAt_idx" ON "Character"("visibility", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Memory_userId_characterId_kind_idx" ON "Memory"("userId", "characterId", "kind");

-- CreateIndex
CREATE INDEX "Memory_userId_characterId_factKey_idx" ON "Memory"("userId", "characterId", "factKey");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipState_userId_characterId_key" ON "RelationshipState"("userId", "characterId");

-- CreateIndex
CREATE UNIQUE INDEX "EmotionalState_userId_characterId_key" ON "EmotionalState"("userId", "characterId");

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmotionalState" ADD CONSTRAINT "EmotionalState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmotionalState" ADD CONSTRAINT "EmotionalState_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written additions ────────────────────────────────────────────────
-- Hard guarantee, independent of application code: every character is an adult.
ALTER TABLE "Character" ADD CONSTRAINT "Character_age_adult" CHECK ("age" >= 18);

-- Relationship variables live in 0..100.
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_ranges" CHECK (
  "trust" BETWEEN 0 AND 100 AND "affection" BETWEEN 0 AND 100 AND
  "attraction" BETWEEN 0 AND 100 AND "comfort" BETWEEN 0 AND 100 AND
  "attachment" BETWEEN 0 AND 100 AND "tension" BETWEEN 0 AND 100 AND
  "conflict" BETWEEN 0 AND 100
);

ALTER TABLE "Memory" ADD CONSTRAINT "Memory_importance_range" CHECK ("importance" BETWEEN 0 AND 1);

-- Approximate nearest-neighbour index for memory recall (cosine distance).
CREATE INDEX "Memory_embedding_hnsw" ON "Memory" USING hnsw ("embedding" vector_cosine_ops);

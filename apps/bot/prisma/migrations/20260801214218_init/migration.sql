-- CreateTable
CREATE TABLE "DiscordServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "discordGuildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "DiscordServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "characterName" TEXT,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CampaignMember_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduledFor" DATETIME,
    "voiceChannelId" TEXT,
    "logChannelId" TEXT,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Session_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscordServer_discordGuildId_key" ON "DiscordServer"("discordGuildId");

-- CreateIndex
CREATE INDEX "Campaign_serverId_idx" ON "Campaign"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_serverId_normalizedName_key" ON "Campaign"("serverId", "normalizedName");

-- CreateIndex
CREATE INDEX "CampaignMember_discordUserId_idx" ON "CampaignMember"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMember_campaignId_discordUserId_key" ON "CampaignMember"("campaignId", "discordUserId");

-- CreateIndex
CREATE INDEX "Session_campaignId_status_idx" ON "Session"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Session_campaignId_sequenceNumber_key" ON "Session"("campaignId", "sequenceNumber");

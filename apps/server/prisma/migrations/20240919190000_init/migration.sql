-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PLAYER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PlayerKind" AS ENUM ('HUMAN', 'BOT');

-- CreateEnum
CREATE TYPE "BotProfile" AS ENUM ('TAG', 'LOOSE_PASSIVE', 'MANIAC', 'GTO');

-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('WAITING', 'IN_HAND', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('EMPTY', 'OCCUPIED', 'SIT_OUT');

-- CreateEnum
CREATE TYPE "HandPhase" AS ENUM ('WAITING', 'PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'COMPLETE');

-- CreateEnum
CREATE TYPE "PokerAction" AS ENUM ('POST_SB', 'POST_BB', 'POST_DEAD', 'FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN', 'TIMEOUT_FOLD', 'TIMEOUT_CHECK');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "role" "UserRole" NOT NULL DEFAULT 'PLAYER',
    "kind" "PlayerKind" NOT NULL DEFAULT 'HUMAN',
    "botProfile" "BotProfile",
    "bankroll" INTEGER NOT NULL DEFAULT 10000,
    "avatarHue" INTEGER NOT NULL DEFAULT 210,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostId" TEXT,
    "status" "TableStatus" NOT NULL DEFAULT 'WAITING',
    "maxSeats" INTEGER NOT NULL DEFAULT 6,
    "smallBlind" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "minBuyIn" INTEGER NOT NULL,
    "maxBuyIn" INTEGER NOT NULL,
    "timeBankMs" INTEGER NOT NULL DEFAULT 15000,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TableSeat" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "userId" TEXT,
    "playerKind" "PlayerKind" NOT NULL DEFAULT 'HUMAN',
    "botProfile" "BotProfile",
    "stack" INTEGER NOT NULL DEFAULT 0,
    "status" "SeatStatus" NOT NULL DEFAULT 'EMPTY',
    "sittingOut" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hand" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "handNumber" INTEGER NOT NULL,
    "phase" "HandPhase" NOT NULL DEFAULT 'COMPLETE',
    "dealerSeat" INTEGER NOT NULL,
    "sbSeat" INTEGER,
    "bbSeat" INTEGER,
    "board" TEXT[],
    "potTotal" INTEGER NOT NULL DEFAULT 0,
    "rake" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "snapshot" JSONB,

    CONSTRAINT "Hand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandPlayer" (
    "id" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "userId" TEXT,
    "seatIndex" INTEGER NOT NULL,
    "playerKind" "PlayerKind" NOT NULL,
    "botProfile" "BotProfile",
    "holeCards" TEXT[],
    "startingStack" INTEGER NOT NULL,
    "endingStack" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "showedCards" BOOLEAN NOT NULL DEFAULT false,
    "won" BOOLEAN NOT NULL DEFAULT false,
    "handRankName" TEXT,
    "handRankValue" BIGINT,

    CONSTRAINT "HandPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandAction" (
    "id" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "street" "HandPhase" NOT NULL,
    "action" "PokerAction" NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "toAmount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandPot" (
    "id" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "potIndex" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "eligibleSeats" INTEGER[],
    "winnerSeats" INTEGER[],
    "oddChipSeat" INTEGER,

    CONSTRAINT "HandPot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotStatistic" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profile" "BotProfile" NOT NULL,
    "handsPlayed" INTEGER NOT NULL DEFAULT 0,
    "vpipHands" INTEGER NOT NULL DEFAULT 0,
    "pfrHands" INTEGER NOT NULL DEFAULT 0,
    "aggressionBets" INTEGER NOT NULL DEFAULT 0,
    "aggressionCalls" INTEGER NOT NULL DEFAULT 0,
    "showdowns" INTEGER NOT NULL DEFAULT 0,
    "showdownsWon" INTEGER NOT NULL DEFAULT 0,
    "chipsWon" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotStatistic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshToken_key" ON "Session"("refreshToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Table_status_idx" ON "Table"("status");

-- CreateIndex
CREATE INDEX "TableSeat_userId_idx" ON "TableSeat"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TableSeat_tableId_seatIndex_key" ON "TableSeat"("tableId", "seatIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Hand_tableId_handNumber_key" ON "Hand"("tableId", "handNumber");

-- CreateIndex
CREATE INDEX "HandPlayer_userId_idx" ON "HandPlayer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HandPlayer_handId_seatIndex_key" ON "HandPlayer"("handId", "seatIndex");

-- CreateIndex
CREATE UNIQUE INDEX "HandAction_handId_seq_key" ON "HandAction"("handId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "HandPot_handId_potIndex_key" ON "HandPot"("handId", "potIndex");

-- CreateIndex
CREATE UNIQUE INDEX "BotStatistic_userId_key" ON "BotStatistic"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSeat" ADD CONSTRAINT "TableSeat_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSeat" ADD CONSTRAINT "TableSeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hand" ADD CONSTRAINT "Hand_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandPlayer" ADD CONSTRAINT "HandPlayer_handId_fkey" FOREIGN KEY ("handId") REFERENCES "Hand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandPlayer" ADD CONSTRAINT "HandPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandAction" ADD CONSTRAINT "HandAction_handId_fkey" FOREIGN KEY ("handId") REFERENCES "Hand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandPot" ADD CONSTRAINT "HandPot_handId_fkey" FOREIGN KEY ("handId") REFERENCES "Hand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotStatistic" ADD CONSTRAINT "BotStatistic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

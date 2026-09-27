import type { BotProfile, PlayerKind, TableStatus, UserRole } from "./constants.js";

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  isGuest: boolean;
  role: UserRole;
  kind: PlayerKind;
  botProfile: BotProfile | null;
  bankroll: number;
  avatarHue: number;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
}

export interface CreateTableRequest {
  name?: string;
  maxSeats?: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  /** Legacy clients may send zero. New tables never create bots. */
  botCount?: 0;
}

export interface TableListItem {
  id: string;
  isSeated: boolean;
  name: string;
  status: TableStatus;
  maxSeats: number;
  occupiedSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  botCount: number;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

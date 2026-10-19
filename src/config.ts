import "dotenv/config";
import { randomBytes } from "node:crypto";

export interface Config {
  send21ApiKey: string | null;
  send21ApiBase: string;
  webhookSecret: string;
  port: number;
  publicUrl: string;
  expiryHours: number;
  shortfallPercent: number;
  dataFile: string;
  trustProxy: boolean;
  mock: boolean;
}

const num = (v: string | undefined, def: number, min: number, max: number, name: string): number => {
  const n = v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.SEND21_API_KEY?.trim() || null;
  const mock = !apiKey;
  if (apiKey && !apiKey.startsWith("s21_")) throw new Error("SEND21_API_KEY should start with s21_");
  const secret = env.SEND21_WEBHOOK_SECRET?.trim();
  if (!mock && !secret) throw new Error("SEND21_WEBHOOK_SECRET is missing (npm run webhook:register)");
  const port = num(env.PORT, 3000, 1, 65535, "PORT");
  return {
    send21ApiKey: apiKey,
    send21ApiBase: env.SEND21_API_BASE?.trim() || "https://send21.io",
    // Mock mode makes a random secret per run unless you set one.
    webhookSecret: secret || randomBytes(32).toString("hex"),
    port,
    publicUrl: (env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, ""),
    expiryHours: Math.round(num(env.SPLIT_EXPIRY_HOURS, 72, 1, 720, "SPLIT_EXPIRY_HOURS")),
    shortfallPercent: num(env.SPLIT_SHORTFALL_PERCENT, 2, 0, 10, "SPLIT_SHORTFALL_PERCENT"),
    dataFile: env.DATA_FILE?.trim() || "./data/split.json",
    trustProxy: env.TRUST_PROXY === "1",
    mock,
  };
}

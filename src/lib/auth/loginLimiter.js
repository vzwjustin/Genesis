// Progressive lockout for dashboard login. Persisted to disk between restarts.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

import crypto from "crypto";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt }
const MAX_ATTEMPTS_ENTRIES = 10_000;
const ATTEMPTS_FILE = path.join(DATA_DIR, "auth", "login-attempts.json");
let attemptsLoaded = false;

function now() { return Date.now(); }

function loadAttempts() {
  if (attemptsLoaded) return;
  attemptsLoaded = true;
  try {
    const raw = fs.readFileSync(ATTEMPTS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      for (const [ip, entry] of Object.entries(data)) {
        if (entry && typeof entry === "object") attempts.set(ip, entry);
      }
    }
  } catch {
    // fresh start
  }
}

function persistAttempts() {
  try {
    fs.mkdirSync(path.dirname(ATTEMPTS_FILE), { recursive: true });
    fs.writeFileSync(ATTEMPTS_FILE, JSON.stringify(Object.fromEntries(attempts)));
  } catch (e) {
    console.warn("[loginLimiter] Failed to persist attempts:", e.message);
  }
}

// Bound the in-memory Map so a flood of distinct IPs can't grow it unbounded.
// Evict expired entries first, then oldest insertions until under the cap.
function evictIfNeeded() {
  if (attempts.size < MAX_ATTEMPTS_ENTRIES) return;
  const t = now();
  for (const [ip, e] of attempts) {
    if (e && e.lastFailAt && t - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || t >= e.lockUntil)) {
      attempts.delete(ip);
    }
  }
  while (attempts.size >= MAX_ATTEMPTS_ENTRIES) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

function getEntry(ip) {
  loadAttempts();
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLock(ip) {
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(ip) {
  const e = getEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  evictIfNeeded();
  attempts.set(ip, e);
  persistAttempts();
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip) {
  loadAttempts();
  attempts.delete(ip);
  persistAttempts();
}

// When no socket IP is available, fall back to a coarse fingerprint. The
// authorization header is deliberately EXCLUDED: it carries the password
// attempt, so including it would give every guess a fresh key and the
// fail counter could never accumulate — defeating the lockout entirely.
// User-Agent alone is spoofable; the resulting bucket is intentionally
// shared so a single client can't trivially escape its own counter by
// rotating one credential. Operators behind a proxy should set
// TRUST_PROXY_HEADERS=true so the real client IP is used instead.
function getFallbackClientKey(request) {
  const ua = request.headers.get("user-agent") || "";
  const hash = crypto.createHash("sha256").update(ua).digest("hex").slice(0, 16);
  return `fp:${hash}`;
}

export function getClientIp(request) {
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      // Leftmost entry is the originating client (trusted because TRUST_PROXY_HEADERS gates this).
      const ip = xff.split(",").map((s) => s.trim()).filter(Boolean)[0];
      if (ip) return ip;
    }
    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp.trim();
  }

  const socketIp = request.socket?.remoteAddress || request.ip;
  if (socketIp) return String(socketIp).replace(/^::ffff:/, "");

  return getFallbackClientKey(request);
}

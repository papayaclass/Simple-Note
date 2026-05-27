import { app } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getPreferences } from './preferences.js';

interface CacheEntry {
  rates: Record<string, number>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let memCache: CacheEntry | null = null;

function cachePath(): string {
  return join(app.getPath('userData'), 'rate-cache.json');
}

async function loadCache(): Promise<CacheEntry | null> {
  if (memCache) return memCache;
  try {
    const text = await readFile(cachePath(), 'utf-8');
    memCache = JSON.parse(text) as CacheEntry;
    return memCache;
  } catch {
    return null;
  }
}

async function saveCache(entry: CacheEntry): Promise<void> {
  memCache = entry;
  const p = cachePath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(entry), 'utf-8');
}

async function fetchFresh(apiKey: string): Promise<CacheEntry> {
  const url = `https://v6.exchangerate-api.com/v6/${encodeURIComponent(apiKey)}/latest/TWD`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = (await res.json()) as { result: string; conversion_rates: Record<string, number> };
  if (data.result !== 'success') throw new Error(`API result: ${data.result}`);
  const entry: CacheEntry = { rates: data.conversion_rates, fetchedAt: Date.now() };
  await saveCache(entry);
  return entry;
}

export async function getRate(
  currency: string
): Promise<{ ok: true; rate: number; fetchedAt: number } | { ok: false; reason: string }> {
  const code = currency.toUpperCase();
  if (code === 'TWD') return { ok: true, rate: 1, fetchedAt: Date.now() };
  const apiKey = getPreferences().exchangeRateApiKey;
  if (!apiKey) return { ok: false, reason: '需設定 API Key' };

  let cache = await loadCache();
  const isFresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (!isFresh) {
    try {
      cache = await fetchFresh(apiKey);
    } catch (e) {
      if (!cache) return { ok: false, reason: '離線或 API 錯誤' };
    }
  }
  if (!cache) return { ok: false, reason: '無資料' };
  const twdPerCurrency = cache.rates[code];
  if (!twdPerCurrency) return { ok: false, reason: `未支援 ${code}` };
  // rates are TWD-based: conversion_rates[X] = "1 TWD = N X"
  // so to convert N X back to TWD we divide
  return { ok: true, rate: 1 / twdPerCurrency, fetchedAt: cache.fetchedAt };
}

export function clearRateCache(): void {
  memCache = null;
}

import type { AlphaOpportunity } from '../types';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function logLiquidityScore(liquidityUSD: number): number {
  const normalized = (Math.log10(Math.max(liquidityUSD, 1)) - 5) / 3;
  return clamp(normalized, 0, 1);
}

export function ratioScore(value: number | undefined | null, low: number, high: number, fallback: number): number {
  if (!value || !Number.isFinite(value) || value <= 0) return fallback;
  return clamp((value - low) / Math.max(high - low, 1e-6), 0, 1);
}

export function numberFromExtra(opportunity: AlphaOpportunity, key: string): number | undefined {
  const raw = opportunity.metadata.extra?.[key];
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function boolFromExtra(opportunity: AlphaOpportunity, key: string): boolean {
  const raw = opportunity.metadata.extra?.[key];
  return raw === true || raw === 'true';
}

export function stringFromExtra(opportunity: AlphaOpportunity, key: string): string | undefined {
  const raw = opportunity.metadata.extra?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

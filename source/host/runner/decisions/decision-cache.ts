/**
 * Client-side cache for decision results.
 *
 * The classifier is NOT deterministic and NOT cached by the service: 50
 * byte-identical requests produced 15 different answers. Two consequences for
 * the client:
 *
 * 1. Without a cache the same item is re-asked on every event and the answer
 *    flips underneath the caller. The cache key is a content hash of
 *    (model, state, question), so a hit means "byte-identical question", which
 *    is exactly the case where the caller wants one stable answer.
 * 2. The cache is bounded by count and TTL so a long-lived host process cannot
 *    grow without limit.
 *
 * Probabilities are only meaningful relative to the option set of the same
 * call. The key includes the whole question (type, instructions, criteria), so
 * a hit always carries the same option set and the numbers stay comparable.
 */

import { createHash } from "node:crypto";

import type { DecisionQuestion } from "./decision-prompt.js";

/** 15 minutes. Long enough to cover a burst of repeated events for one item, short enough that a session move re-asks. */
export const DEFAULT_DECISION_CACHE_TTL_MS = 15 * 60_000;

/** Bounded by count, not by bytes: every entry is one small decision. */
export const DEFAULT_DECISION_CACHE_MAX_ENTRIES = 512;

export interface DecisionCacheOptions {
  readonly ttlMs?: number | undefined;
  readonly maxEntries?: number | undefined;
  /** Injectable clock, defaults to `performance.now()`. */
  readonly now?: (() => number) | undefined;
}

export interface DecisionCacheKeyPayload {
  readonly model: string;
  readonly state: string;
  readonly question: DecisionQuestion;
  /** Optional band policy. Part of the key, because the cached Decision stores the band it was classified with. */
  readonly band?: unknown;
}

/** Stable JSON: object keys sorted recursively, array order kept (a rubric is ordered). */
export function canonicalDecisionJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      const source = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
      return sorted;
    }
    return input;
  };
  return JSON.stringify(canonical(value)) ?? "null";
}

/**
 * Content hash of (model, state, question, band policy).
 *
 * The band policy belongs in the key because the cached `Decision` carries the band it was
 * classified with. Without it, a lax caller caches `band:"decide"` under a permissive
 * threshold and a later caller that TIGHTENED the policy replays that verdict — the failure
 * lands in the unsafe direction, where the guard is bypassed rather than merely conservative.
 * Fragmenting the cache by policy is the cheaper of the two honest options: the alternative
 * is caching the raw probabilities and recomputing the band on replay, which turns
 * `Decision.band` from a stored field into a computed one and changes the observable shape.
 * In practice the plugin-search integration never passes `band`, so the real cache is not
 * fragmented at all.
 *
 * The hash also seeds the question id, so identical questions are logged identically.
 */
export function decisionCacheKey(payload: DecisionCacheKeyPayload): string {
  return createHash("sha256")
    .update(canonicalDecisionJson({ model: payload.model, question: payload.question, state: payload.state, band: payload.band ?? null }))
    .digest("hex");
}

/** A short, stable, human-readable question id derived from the same content. */
export function decisionQuestionId(cacheKey: string): string {
  return cacheKey.slice(0, 16);
}

interface DecisionCacheSlot<TValue> {
  readonly value: TValue;
  readonly storedAtMs: number;
}

/**
 * Bounded TTL cache with least-recently-used eviction. Generic on purpose: it
 * stores the decision objects without importing the client layer, so the two
 * modules stay independent.
 */
export class DecisionCache<TValue> {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly #entries = new Map<string, DecisionCacheSlot<TValue>>();
  readonly #now: () => number;

  constructor(options: DecisionCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_DECISION_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_DECISION_CACHE_MAX_ENTRIES;
    this.#now = options.now ?? (() => performance.now());
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error(`Decision cache ttlMs must be positive; got ${this.ttlMs}.`);
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) throw new Error(`Decision cache maxEntries must be a positive integer; got ${this.maxEntries}.`);
  }

  get size(): number {
    this.#dropExpired();
    return this.#entries.size;
  }

  /** Returns the stored value and refreshes its recency, or `undefined` on a miss or an expired entry. */
  get(key: string): TValue | undefined {
    const slot = this.#entries.get(key);
    if (slot === undefined) return undefined;
    if (this.#now() - slot.storedAtMs >= this.ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, slot);
    return slot.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: TValue): void {
    this.#entries.delete(key); // re-insert below so the entry becomes the most recent one
    this.#entries.set(key, { value, storedAtMs: this.#now() });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  #dropExpired(): void {
    const nowMs = this.#now();
    for (const [key, slot] of this.#entries) {
      if (nowMs - slot.storedAtMs >= this.ttlMs) this.#entries.delete(key);
    }
  }
}
import { getSearxngURL } from './config/serverRegistry';

export interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
}

export interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
}

export interface SearxngSearchResponse {
  results: SearxngSearchResult[];
  suggestions: string[];
}

// Simple in-memory cache with TTL
const searchCache = new Map<
  string,
  { data: SearxngSearchResponse; timestamp: number }
>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 200;

function getCacheKey(query: string, opts?: SearxngSearchOptions): string {
  return `${query}::${JSON.stringify(opts || {})}`;
}

function getCached(key: string): SearxngSearchResponse | null {
  const entry = searchCache.get(key);
  if (!entry || Date.now() - entry.timestamp > CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: SearxngSearchResponse): void {
  if (searchCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { data, timestamp: Date.now() });
}

export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
): Promise<SearxngSearchResponse> => {
  // Check cache first
  const cacheKey = getCacheKey(query, opts);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const searxngURL = getSearxngURL();

  const url = new URL(`${searxngURL}/search?format=json`);
  url.searchParams.append('q', query);

  if (opts) {
    Object.keys(opts).forEach((key) => {
      const value = opts[key as keyof SearxngSearchOptions];
      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }
      url.searchParams.append(key, value as string);
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`SearXNG error: ${res.statusText}`);
    }

    const data = await res.json();

    const results: SearxngSearchResult[] = data.results;
    const suggestions: string[] = data.suggestions;

    const result = { results, suggestions };
    
    // Cache successful results
    setCache(cacheKey, result);
    
    return result;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('SearXNG search timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

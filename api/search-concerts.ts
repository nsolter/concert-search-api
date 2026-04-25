import { waitUntil } from '@vercel/functions';
import { getCachedSearch, storeConcerts } from './concert-cache';
import type { ConcertResult } from './types';

export const config = { runtime: 'edge' };

// Simple in-memory rate limiter (resets on cold starts)
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1, resetAt: now + RATE_WINDOW_MS };
  }

  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count, resetAt: entry.resetAt };
}

const SYSTEM_PROMPT = `You are a concert/event search assistant. Given an artist name and location (and optional year filter), find concerts/events matching the criteria.

If a year is specified, return ONLY concerts from that specific year — do not include concerts from other years. If no year is specified, search across ALL years — from the artist's earliest shows to any upcoming dates — and search multiple times with different queries to ensure complete coverage (e.g. "Muse concerts Denver history", "Muse Colorado past shows", "Muse Colorado 2026 tour").

Return a JSON array where each entry has these fields:
- artist: the performing artist/band name
- tour: the tour name (empty string if unknown)
- venue: the venue name
- city: the city and state (or country), e.g. "Denver, Colorado"
- date: the date in YYYY-MM-DD format
- time: the start time if known, e.g. "19:00", or empty string

Return ONLY the raw JSON array, no markdown fences, no commentary. Include all concerts you find evidence for, even if some details like time are missing — just leave those fields as empty strings. Only omit a concert if you have reason to believe it didn't happen.`;

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rateCheck = checkRateLimit(ip);
  const rateLimitHeaders = {
    'Content-Type': 'application/json',
    'X-RateLimit-Limit': String(RATE_LIMIT),
    'X-RateLimit-Remaining': String(rateCheck.remaining),
    'X-RateLimit-Reset': String(Math.ceil(rateCheck.resetAt / 1000)),
  };

  if (!rateCheck.allowed) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }),
      { status: 429, headers: rateLimitHeaders },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { artist?: string; location?: string; year?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.artist?.trim() || !body.location?.trim()) {
    return new Response(JSON.stringify({ error: 'artist and location are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const artist = body.artist.trim();
  const location = body.location.trim();
  const year = body.year?.trim() || undefined;
  const isDeep = body.mode !== 'quick';

  // Return cached results if we have them at sufficient depth.
  try {
    const cached = await getCachedSearch(artist, location, year);
    if (cached && (cached.isDeep || !isDeep)) {
      return new Response(JSON.stringify(cached.concerts), {
        status: 200,
        headers: { ...rateLimitHeaders, 'X-Cache': 'HIT' },
      });
    }
  } catch {
    // DB unavailable — fall through to Claude
  }

  const maxWebSearches = isDeep ? 5 : 2;

  const parts: string[] = [`Artist: ${artist}`];
  parts.push(`Location: ${location}`);
  if (year) parts.push(`Year: ${year}`);

  const userMessage = parts.join('\n');

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxWebSearches }],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(
      JSON.stringify({
        error: `Upstream error: ${anthropicRes.status}`,
        detail: errText.slice(0, 200),
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const data = await anthropicRes.json();

  // Concatenate ALL text blocks — with web search, the JSON may be in a later text block
  const allText = (data.content as Array<{ type: string; text?: string }>)
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n');

  // Extract JSON array from anywhere in the combined text — handles prose, code fences, etc.
  let jsonStr = '[]';
  const fencedMatch = allText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch) {
    jsonStr = fencedMatch[1].trim();
  } else {
    // Find the first [...] in the text
    const bracketMatch = allText.match(/\[[\s\S]*\]/);
    if (bracketMatch) {
      jsonStr = bracketMatch[0];
    }
  }

  let concerts: ConcertResult[];
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    concerts = parsed.map((c: Record<string, unknown>, i: number) => ({
      id: `c-${i}-${Date.now()}`,
      artist: String(c.artist ?? ''),
      tour: String(c.tour ?? ''),
      venue: String(c.venue ?? ''),
      city: String(c.city ?? ''),
      date: String(c.date ?? ''),
      time: String(c.time ?? ''),
    }));
  } catch {
    concerts = [];
  }

  // Store in the background so the response is not delayed.
  waitUntil(storeConcerts(artist, location, year, isDeep, concerts).catch(() => {}));

  return new Response(JSON.stringify(concerts), {
    status: 200,
    headers: { ...rateLimitHeaders, 'X-Cache': 'MISS' },
  });
}

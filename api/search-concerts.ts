import type { ConcertResult } from './types';

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a concert/event search assistant. Given an artist name and optional location and year filters, return a JSON array of concerts/events that match. Each entry must have these fields:
- artist: the performing artist/band name
- tour: the tour name (empty string if unknown)
- venue: the venue name
- city: the city and country, e.g. "Turku, Finland"
- date: the date in YYYY-MM-DD format
- time: the start time if known, e.g. "19:00", or empty string

Return ONLY the raw JSON array, no markdown fences, no commentary. If you are not confident about specific results, return an empty array []. Do not fabricate events — only return concerts you are reasonably sure occurred or are scheduled.`;

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { artist?: string; location?: string; year?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.artist?.trim()) {
    return new Response(JSON.stringify({ error: 'artist is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parts: string[] = [`Artist: ${body.artist.trim()}`];
  if (body.location?.trim()) parts.push(`Location: ${body.location.trim()}`);
  if (body.year?.trim()) parts.push(`Year: ${body.year.trim()}`);

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-20250414',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: parts.join('\n') }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(
      JSON.stringify({ error: `Upstream error: ${anthropicRes.status}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const data: { content: Array<{ type: string; text?: string }> } =
    await anthropicRes.json();

  const text = data.content?.find(c => c.type === 'text')?.text ?? '[]';
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let concerts: ConcertResult[];
  try {
    const parsed = JSON.parse(cleaned);
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

  return new Response(JSON.stringify(concerts), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

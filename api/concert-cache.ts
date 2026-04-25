import { sql } from './db';
import type { ConcertResult } from './types';

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function toDateStr(d: unknown): string {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export interface CacheEntry {
  concerts: ConcertResult[];
  isDeep: boolean;
}

type Row = Record<string, unknown>;

function rowToConcert(r: Row): ConcertResult {
  return {
    id: String(r.concert_id),
    artist: String(r.artist ?? ''),
    tour: String(r.tour ?? ''),
    venue: String(r.venue ?? ''),
    city: String(r.city ?? ''),
    date: toDateStr(r.date),
    time: String(r.time ?? ''),
  };
}

export async function getCachedSearch(
  artist: string,
  location: string,
  year: string | undefined,
): Promise<CacheEntry | null> {
  const artistKey = normalize(artist);
  const locationKey = normalize(location);
  const yearNum = year ? parseInt(year, 10) : null;

  if (yearNum !== null) {
    // Year-specific: exact match only.
    const rows = (await sql`
      SELECT cs.is_deep,
        c.id AS concert_id,
        c.artist, c.tour, c.venue, c.city, c.date, c.time
      FROM concert_searches cs
      LEFT JOIN search_concerts sc ON sc.search_id = cs.id
      LEFT JOIN concerts        c  ON c.id = sc.concert_id
      WHERE cs.artist_key   = ${artistKey}
        AND cs.location_key = ${locationKey}
        AND cs.year         = ${yearNum}
    `) as Row[];

    if (rows.length === 0 || !rows[0].concert_id) return null;
    return { isDeep: Boolean(rows[0].is_deep), concerts: rows.map(rowToConcert) };
  }

  // All-years query: collect concerts from every year bucket we have for this
  // artist+location (year-specific searches included), deduplicated by concert id.
  // Depth is determined by whether there's an explicit all-years deep entry —
  // having only year-specific entries means we haven't done a full sweep.
  const [concertRows, depthRows] = (await sql.transaction([
    sql`
      SELECT DISTINCT ON (c.id)
        c.id AS concert_id,
        c.artist, c.tour, c.venue, c.city, c.date, c.time
      FROM concert_searches cs
      JOIN search_concerts sc ON sc.search_id = cs.id
      JOIN concerts        c  ON c.id = sc.concert_id
      WHERE cs.artist_key   = ${artistKey}
        AND cs.location_key = ${locationKey}
      ORDER BY c.id
    `,
    sql`
      SELECT is_deep
      FROM concert_searches
      WHERE artist_key   = ${artistKey}
        AND location_key = ${locationKey}
        AND year IS NULL
    `,
  ])) as Row[][];

  if (concertRows.length === 0) return null;
  return {
    isDeep: depthRows.length > 0 && Boolean(depthRows[0].is_deep),
    concerts: concertRows.map(rowToConcert),
  };
}

export async function storeConcerts(
  artist: string,
  location: string,
  year: string | undefined,
  isDeep: boolean,
  concerts: ConcertResult[],
): Promise<void> {
  if (concerts.length === 0) return;

  const artistKey = normalize(artist);
  const locationKey = normalize(location);
  const yearNum = year ? parseInt(year, 10) : null;

  // Batch 1: upsert each concert + upsert the search entry in one transaction.
  // Concerts are upserted first; if a conflict occurs, we keep the most complete
  // data (prefer non-empty tour/time over empty).
  const concertUpserts = concerts.map(c => sql`
    INSERT INTO concerts (artist, artist_key, tour, venue, city, city_key, date, time)
    VALUES (
      ${c.artist},
      ${artistKey},
      ${c.tour ?? ''},
      ${c.venue},
      ${c.city},
      ${normalize(c.city)},
      ${c.date || null},
      ${c.time ?? ''}
    )
    ON CONFLICT (artist_key, city_key, COALESCE(date, '0001-01-01'::date), venue) DO UPDATE SET
      tour = CASE WHEN EXCLUDED.tour <> '' THEN EXCLUDED.tour ELSE concerts.tour END,
      time = CASE WHEN EXCLUDED.time <> '' THEN EXCLUDED.time ELSE concerts.time END
    RETURNING id
  `);

  const searchUpsert = sql`
    INSERT INTO concert_searches (artist_key, location_key, year, is_deep)
    VALUES (${artistKey}, ${locationKey}, ${yearNum}, ${isDeep})
    ON CONFLICT (artist_key, location_key, COALESCE(year, 0)) DO UPDATE SET
      is_deep     = concert_searches.is_deep OR EXCLUDED.is_deep,
      searched_at = now()
    RETURNING id
  `;

  const batch1 = (await sql.transaction([...concertUpserts, searchUpsert])) as Row[][];

  const concertIds = batch1.slice(0, -1).map(r => r[0]?.id as string).filter(Boolean);
  const searchId = batch1[batch1.length - 1][0]?.id as string;

  if (!searchId || concertIds.length === 0) return;

  // Batch 2: link concerts to the search (ON CONFLICT DO NOTHING handles upgrades
  // from shallow → deep where some concerts are already linked).
  await sql.transaction(
    concertIds.map(cid => sql`
      INSERT INTO search_concerts (search_id, concert_id)
      VALUES (${searchId}, ${cid})
      ON CONFLICT DO NOTHING
    `),
  );
}

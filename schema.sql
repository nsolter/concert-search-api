-- Run once against your Neon database to set up the concert cache schema.

CREATE TABLE concert_searches (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_key    text        NOT NULL,  -- lowercased + trimmed artist
  location_key  text        NOT NULL,  -- lowercased + trimmed user-supplied location
  year          int         NULL,      -- NULL means "all years"
  is_deep       boolean     NOT NULL DEFAULT false,
  searched_at   timestamptz NOT NULL DEFAULT now()
);

-- COALESCE(year, 0) makes two NULL-year rows conflict (0 is not a valid year).
-- This is the PG13-compatible alternative to UNIQUE ... NULLS NOT DISTINCT.
CREATE UNIQUE INDEX concert_searches_unique
  ON concert_searches (artist_key, location_key, COALESCE(year, 0));

CREATE INDEX ON concert_searches (artist_key, location_key, year);

CREATE TABLE concerts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  artist      text        NOT NULL,
  artist_key  text        NOT NULL,
  tour        text        NOT NULL DEFAULT '',
  venue       text        NOT NULL,
  city        text        NOT NULL,
  city_key    text        NOT NULL,  -- lowercased + trimmed city for deduplication
  date        date,                  -- NULL if unknown
  time        text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- COALESCE(date, '0001-01-01') treats unknown dates as a fixed sentinel for dedup.
CREATE UNIQUE INDEX concerts_unique
  ON concerts (artist_key, city_key, COALESCE(date, '0001-01-01'::date), venue);

CREATE INDEX ON concerts (artist_key, city_key);

CREATE TABLE search_concerts (
  search_id   uuid NOT NULL REFERENCES concert_searches(id),
  concert_id  uuid NOT NULL REFERENCES concerts(id),
  PRIMARY KEY (search_id, concert_id)
);

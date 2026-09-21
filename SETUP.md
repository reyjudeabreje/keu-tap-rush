# Online leaderboard setup

The game works without a backend. In that state it stays playable and shows `ONLINE LEADERBOARD NOT CONNECTED`; it never displays invented rankings.

The backend uses Supabase hosted Postgres through a server-side proxy. The current architecture does not use the Supabase browser SDK, so no Supabase client key is needed in `index.html` or `script.js`. If direct browser Supabase access is added later, it may use only the public/publishable key; the service-role key must remain server-only.

## 1. Create the database

1. Create a project at [supabase.com](https://supabase.com/).
2. Open **SQL Editor** and run:

```sql
create table public.scores (
  id uuid primary key default gen_random_uuid(),
  player_id text,
  nickname text not null check (char_length(nickname) between 1 and 16),
  mode text not null check (mode in ('easy', 'normal', 'hard', 'superHard', 'god')),
  score integer not null check (score >= 0),
  highest_combo integer not null check (highest_combo >= 0),
  total_taps integer not null check (total_taps >= 0),
  speed_bonus integer not null check (speed_bonus >= 0),
  created_at timestamptz not null default now()
);

create index scores_score_idx on public.scores (score desc, created_at asc);

-- Run this against the existing public.active_players table.
alter table public.active_players
  add column if not exists player_id text,
  add column if not exists session_id text,
  add column if not exists nickname text,
  add column if not exists mode text,
  add column if not exists status text not null default 'offline',
  add column if not exists last_seen_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'active_players' and column_name = 'last_seen'
  ) then
    update public.active_players
    set last_seen_at = coalesce(last_seen_at, last_seen)
    where last_seen_at is null;
  end if;
end $$;

create unique index if not exists active_players_session_id_idx on public.active_players (session_id);
create index if not exists active_players_status_idx on public.active_players (status);
create index if not exists active_players_last_seen_at_idx on public.active_players (last_seen_at);
create index if not exists active_players_mode_idx on public.active_players (mode);

alter table public.scores enable row level security;
alter table public.active_players enable row level security;
```

If `public.scores` already exists, add the nullable identity column without changing existing scores:

```sql
alter table public.scores add column if not exists player_id text;
```

The backend uses the server-only service-role key, which bypasses RLS after the server validates each request. Do not add public `anon` policies for inserts or updates: the browser talks only to `server.js`, and the service role is never sent to the browser. If RLS was already enabled, leave it enabled and ensure the server's service-role access remains available.

3. Keep Supabase Data API access restricted to the server. Do not put the service role key in `index.html`, `script.js`, or any public environment variable.

## 2. Run the validated server

Use Node.js 18 or newer, then set environment variables in your terminal or deployment provider:

```bash
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVER_ONLY_SERVICE_ROLE_KEY"
# Optional but recommended: a long random secret used to sign anonymous player cookies.
export PLAYER_ID_COOKIE_SECRET="YOUR_SERVER_ONLY_PLAYER_COOKIE_SECRET"
node server.js
```

Open `http://localhost:4173`. For deployment, use a server host that supports Node.js and set the same variables there. Set `PORT` when the host provides its own port.

Never commit the service role key or player cookie secret. Use the host's secret/environment-variable settings or a local untracked `.env` loaded by your process manager. `SUPABASE_PUBLISHABLE_KEY` is not required by this proxy architecture and must never be used in place of the service-role key on the server. The server creates an opaque, signed, `HttpOnly` cookie and derives the internal player ID from it; the browser never submits or selects `player_id`.

When `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing, the API reports `connected: false`; the game remains playable locally and the online UI displays `SUPABASE NOT CONNECTED` without inventing players or scores.

The profile UI uses `GET /api/profile` for verified player-owned aggregates, `GET /api/my-scores` for the newest 20 player-owned scores (optionally filtered by `mode`), and `PATCH /api/profile/nickname` for a validated display nickname. These endpoints derive identity from the signed HttpOnly cookie; they do not accept a browser-supplied `player_id`.

`GET /api/profile` also returns server-calculated `xp`, `level`, `title`, `nextLevelXp`, and detailed `badges`. XP is reproducible from each verified score row: 10 per game, 1 per tap, 5 per highest combo point, plus the applicable score bonus (10 at 25+, 25 at 50+, or 50 at 100+). No XP table or client-stored progress is used.

## 3. What is validated

`server.js` creates a short-lived game session at start, binds it to the persistent anonymous player identity, accepts only a session's selected mode and nickname, requires the full configured duration to have elapsed, allows one submission, validates nickname length and all numeric fields, recomputes the speed bonus, and caps the score against the game's scoring formula. The database timestamp is assigned by Supabase. This is basic protection, not a cheat-proof anti-cheat system; a fully trustless game would require authoritative server-side input events.

The browser submits no score until the game reaches Game Over. If the API or Supabase is unavailable, submission fails visibly and no local score is presented as global.

## 4. Live players and refresh behavior

The migration above is additive and does not delete scores or presence rows. Its conditional block copies an existing legacy `last_seen` value into `last_seen_at`; if that legacy column does not exist, new rows receive `last_seen_at` from the server. Starting a run creates or updates an `active_players` row with the server-derived `player_id`, validated nickname and mode, `status = 'online'`, and a heartbeat timestamp. The browser sends a lightweight heartbeat every 12 seconds. Game Over or navigation marks the row offline when practical, and the API only returns `online` rows whose `last_seen_at` is within 45 seconds, so abandoned sessions disappear automatically even if cleanup did not run. The UI polls active players every 8 seconds only while the leaderboard is open. Supabase Realtime is not required for this architecture.

The presence API is `POST /api/presence/start`, `POST /api/presence/heartbeat`, `POST /api/presence/stop`, and `GET /api/players/live`. The older player routes remain compatibility aliases. Live responses contain only nickname, mode, status, last_seen_at, and a current-player marker; they never contain player or session IDs.

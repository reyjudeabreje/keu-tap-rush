# Online leaderboard setup

The game works without a backend. In that state it stays playable and shows `ONLINE LEADERBOARD NOT CONNECTED`; it never displays invented rankings.

The backend uses Supabase hosted Postgres through a server-side proxy. The current architecture does not use the Supabase browser SDK, so no Supabase client key is needed in `index.html` or `script.js`. If direct browser Supabase access is added later, it may use only the public/publishable key; the service-role key must remain server-only.

## 1. Create the database

1. Create a project at [supabase.com](https://supabase.com/).
2. Open **SQL Editor** and run:

```sql
create table public.scores (
  id uuid primary key default gen_random_uuid(),
  nickname text not null check (char_length(nickname) between 1 and 16),
  mode text not null check (mode in ('easy', 'normal', 'hard', 'superHard', 'god')),
  score integer not null check (score >= 0),
  highest_combo integer not null check (highest_combo >= 0),
  total_taps integer not null check (total_taps >= 0),
  speed_bonus integer not null check (speed_bonus >= 0),
  created_at timestamptz not null default now()
);

create index scores_score_idx on public.scores (score desc, created_at asc);
create unique index active_players_session_id_idx on public.active_players (session_id);

alter table public.scores enable row level security;
alter table public.active_players enable row level security;
```

The backend uses the server-only service-role key, which bypasses RLS after the server validates each request. Do not add public `anon` policies for inserts or updates: the browser talks only to `server.js`, and the service role is never sent to the browser. If RLS was already enabled, leave it enabled and ensure the server's service-role access remains available.

3. Keep Supabase Data API access restricted to the server. Do not put the service role key in `index.html`, `script.js`, or any public environment variable.

## 2. Run the validated server

Use Node.js 18 or newer, then set environment variables in your terminal or deployment provider:

```bash
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVER_ONLY_SERVICE_ROLE_KEY"
node server.js
```

Open `http://localhost:4173`. For deployment, use a server host that supports Node.js and set the same variables there. Set `PORT` when the host provides its own port.

Never commit the service role key. Use the host's secret/environment-variable settings or a local untracked `.env` loaded by your process manager. `SUPABASE_PUBLISHABLE_KEY` is not required by this proxy architecture and must never be used in place of the service-role key on the server.

When `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing, the API reports `connected: false`; the game remains playable locally and the online UI displays `SUPABASE NOT CONNECTED` without inventing players or scores.

## 3. What is validated

`server.js` creates a short-lived game session at start, accepts only a session's selected mode, requires the full configured duration to have elapsed, allows one submission, validates nickname length and all numeric fields, recomputes the speed bonus, and caps the score against the game's scoring formula. The database timestamp is assigned by Supabase. This is basic protection, not a cheat-proof anti-cheat system; a fully trustless game would require authoritative server-side input events.

The browser submits no score until the game reaches Game Over. If the API or Supabase is unavailable, submission fails visibly and no local score is presented as global.

## 4. Live players and refresh behavior

Starting a run creates an `active_players` row. The browser sends a lightweight heartbeat every five seconds with the current score. Game Over removes the row, and the API only returns rows whose `last_seen` is within 15 seconds, so abandoned sessions disappear automatically. The UI polls active players every five seconds and requests the top 10 leaderboard only when the leaderboard view is opened, filtered, refreshed, or a score is submitted. Supabase Realtime is not required for this architecture.

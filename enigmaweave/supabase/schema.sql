-- ============================================================
-- MORPHED — accounts, achievements, and Versus (live PvP) schema
-- ============================================================
-- Run this whole file once in the Supabase SQL editor for your existing
-- project (the same one backing the `leaderboard` table). It only adds
-- new tables/functions — nothing here touches `leaderboard`.
--
-- Design notes:
--  * Identity is Supabase anonymous auth (auth.signInAnonymously() on the
--    client). Every device gets a real auth.uid() from day one, so it can
--    be upgraded to a permanent email/social login later via
--    supabase.auth.linkIdentity() without changing any of this schema —
--    the profiles.id just keeps pointing at the same auth.users row.
--  * The shared match board lives in ONE row per match (mp_matches). All
--    writes to that row go through SECURITY DEFINER RPC functions, never
--    direct UPDATEs from the client — that's what keeps two players from
--    corrupting each other's placements or forging scores.
--  * There's no always-on server process, so matchmaking and turn-expiry
--    are both "first client to notice, wins the race" patterns — safe
--    because the functions are written to be idempotent (re-running them
--    after the fact is a no-op).
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- PROFILES ----------
create table if not exists profiles (
    id           uuid primary key references auth.users(id) on delete cascade,
    display_name text not null default 'PLAYER',
    lifetime_sparks bigint not null default 0,   -- for Sparks-total achievements; never decreases
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

alter table profiles enable row level security;

-- NOTE: Postgres has no "create policy if not exists", so every policy is
-- dropped first. That's what makes this whole file safe to re-run.
drop policy if exists "profiles: read own" on profiles;
create policy "profiles: read own" on profiles
    for select using (id = auth.uid());

drop policy if exists "profiles: insert own" on profiles;
create policy "profiles: insert own" on profiles
    for insert with check (id = auth.uid());

drop policy if exists "profiles: update own" on profiles;
create policy "profiles: update own" on profiles
    for update using (id = auth.uid());

-- ---------- ACHIEVEMENTS ----------
create table if not exists player_achievements (
    profile_id     uuid not null references profiles(id) on delete cascade,
    achievement_id text not null,
    unlocked_at    timestamptz not null default now(),
    primary key (profile_id, achievement_id)
);

alter table player_achievements enable row level security;

drop policy if exists "achievements: read own" on player_achievements;
create policy "achievements: read own" on player_achievements
    for select using (profile_id = auth.uid());

drop policy if exists "achievements: insert own" on player_achievements;
create policy "achievements: insert own" on player_achievements
    for insert with check (profile_id = auth.uid());

-- ---------- SLIDE MODE LEADERBOARD ----------
-- One row per player: how many distinct levels they've solved and their
-- total move count across those levels. Ranked by levels solved first,
-- fewest total moves as the tie-break. Levels are identical for everyone
-- (they're baked into the client), so this is a fair comparison.
create table if not exists slide_scores (
    profile_id    uuid primary key references profiles(id) on delete cascade,
    display_name  text not null default 'PLAYER',
    levels_solved int  not null default 0,
    total_moves   int  not null default 0,
    updated_at    timestamptz not null default now()
);

alter table slide_scores enable row level security;

-- Readable by everyone (it's a leaderboard), writable only for your own row.
drop policy if exists "slide: read all" on slide_scores;
create policy "slide: read all" on slide_scores
    for select using (true);

drop policy if exists "slide: insert own" on slide_scores;
create policy "slide: insert own" on slide_scores
    for insert with check (profile_id = auth.uid());

drop policy if exists "slide: update own" on slide_scores;
create policy "slide: update own" on slide_scores
    for update using (profile_id = auth.uid());

-- ---------- VERSUS: MATCHMAKING QUEUE ----------
-- No direct client access — only touched by the RPC functions below.
create table if not exists mp_queue (
    profile_id   uuid primary key references profiles(id) on delete cascade,
    display_name text not null,
    skin_id      text not null,
    joined_at    timestamptz not null default now()
);

alter table mp_queue enable row level security;
-- (no policies -> default deny for direct client access; RPCs bypass RLS)

-- ---------- VERSUS: MATCH ASSIGNMENT NOTIFICATIONS ----------
-- When mp_try_match pairs two waiting players, it writes one row per
-- player here. Each client subscribes (Realtime) to its own row so the
-- player who was sitting in the queue finds out a match was made.
create table if not exists mp_assignments (
    profile_id  uuid primary key references profiles(id) on delete cascade,
    match_id    uuid not null,
    assigned_at timestamptz not null default now()
);

alter table mp_assignments enable row level security;

drop policy if exists "assignments: read own" on mp_assignments;
create policy "assignments: read own" on mp_assignments
    for select using (profile_id = auth.uid());

-- ---------- VERSUS: LIVE MATCHES ----------
create table if not exists mp_matches (
    id               uuid primary key default gen_random_uuid(),
    status           text not null default 'active',   -- 'active' | 'finished'
    grid             jsonb not null,                    -- 6x6 array of 0/1
    players          jsonb not null,                    -- array of player state objects, see below
    turn_index       int not null default 0,
    turn_seconds     int not null default 30,
    turn_started_at  timestamptz not null,
    match_seconds    int not null default 480,           -- 8 minutes
    match_started_at timestamptz not null default now(),
    winner_profile_id uuid,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

-- players[i] shape (kept as plain JSON so the client can read/write it
-- directly without a separate table):
--   { "profile_id": "...", "name": "...", "skin": "cyber",
--     "score": 0, "multiplier": 1, "moves_this_turn": 0,
--     "queue": [...pieces...], "held": null, "can_hold": true }
-- moves_this_turn counts placements made during the CURRENT turn. A turn
-- lasts the full turn_seconds and you may place as many pieces as you can
-- fit in it; the counter exists so mp_expire_turn can tell "played their
-- turn" from "sat there and did nothing" (the latter takes the penalty).

alter table mp_matches enable row level security;

drop policy if exists "matches: read if participant" on mp_matches;
create policy "matches: read if participant" on mp_matches
    for select using (
        exists (
            select 1 from jsonb_array_elements(players) p
            where (p->>'profile_id')::uuid = auth.uid()
        )
    );
-- No insert/update/delete policies — only the SECURITY DEFINER functions
-- below may write to this table.

-- Realtime: publish changes on the two tables clients subscribe to.
do $$
begin
    alter publication supabase_realtime add table mp_matches;
exception when duplicate_object then null;
end $$;

do $$
begin
    alter publication supabase_realtime add table mp_assignments;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- mp_cleanup_stale — housekeeping for abandoned state.
-- Without an always-on server, players who close the tab mid-queue or
-- mid-match would leave rows behind forever. This runs opportunistically
-- at the top of mp_try_match (i.e. whenever anyone looks for a game), so
-- the tables self-clean without a cron job. Safe to call any time.
--   * queue rows older than 2 minutes  -> the client stopped polling
--   * matches past their clock + 60s   -> nobody called mp_expire_turn
--   * assignments older than 10 minutes-> long since consumed
-- ============================================================
create or replace function mp_cleanup_stale()
returns void
language sql
security definer
set search_path = public
as $$
    delete from mp_queue where joined_at < now() - interval '2 minutes';

    update mp_matches
    set status = 'finished', updated_at = now()
    where status = 'active'
      and now() > match_started_at + make_interval(secs => match_seconds) + interval '60 seconds';

    delete from mp_assignments where assigned_at < now() - interval '10 minutes';
$$;

grant execute on function mp_cleanup_stale() to authenticated;

-- ============================================================
-- RPC: mp_try_match
-- Called when a player wants to start Versus. Tries to pair with anyone
-- already waiting; if nobody's waiting, joins the queue instead.
-- ============================================================
create or replace function mp_try_match(p_display_name text, p_skin_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_self       uuid := auth.uid();
    v_opponent   mp_queue%rowtype;
    v_match_id   uuid;
    v_grid       jsonb;
    v_players    jsonb;
    v_turn_start timestamptz;
begin
    if v_self is null then
        raise exception 'not authenticated';
    end if;

    -- Opportunistic housekeeping so abandoned queue rows / dead matches
    -- never pile up (see mp_cleanup_stale above).
    perform mp_cleanup_stale();

    -- Make sure a profile row exists (idempotent).
    insert into profiles (id, display_name)
        values (v_self, coalesce(p_display_name, 'PLAYER'))
        on conflict (id) do update set display_name = excluded.display_name, updated_at = now();

    -- Look for someone else already waiting (skip rows locked by a
    -- concurrent caller instead of blocking on them).
    select * into v_opponent
        from mp_queue
        where profile_id <> v_self
        order by joined_at asc
        limit 1
        for update skip locked;

    if found then
        delete from mp_queue where profile_id = v_opponent.profile_id;
        delete from mp_queue where profile_id = v_self;  -- in case of a stale row

        -- Fresh random 6x6 board, same distribution as the client's initGame().
        select jsonb_agg(row_arr) into v_grid
        from (
            select jsonb_agg((case when random() > 0.5 then 1 else 0 end)) as row_arr
            from generate_series(1, 6) as r, generate_series(1, 6) as c
            group by r
        ) g;

        v_players := jsonb_build_array(
            jsonb_build_object(
                'profile_id', v_opponent.profile_id,
                'name', v_opponent.display_name,
                'skin', v_opponent.skin_id,
                'score', 0, 'multiplier', 1, 'moves_this_turn', 0,
                'queue', '[]'::jsonb, 'held', null, 'can_hold', true
            ),
            jsonb_build_object(
                'profile_id', v_self,
                'name', coalesce(p_display_name, 'PLAYER'),
                'skin', p_skin_id,
                'score', 0, 'multiplier', 1, 'moves_this_turn', 0,
                'queue', '[]'::jsonb, 'held', null, 'can_hold', true
            )
        );

        -- 3s grace period so both clients can call mp_join_ready() and
        -- push their starting piece queue before the first turn's clock
        -- starts running.
        v_turn_start := now() + interval '3 seconds';

        insert into mp_matches (status, grid, players, turn_index, turn_started_at, match_started_at)
        values ('active', v_grid, v_players, 0, v_turn_start, now())
        returning id into v_match_id;

        insert into mp_assignments (profile_id, match_id)
            values (v_opponent.profile_id, v_match_id), (v_self, v_match_id)
            on conflict (profile_id) do update set match_id = excluded.match_id, assigned_at = now();

        return jsonb_build_object('matched', true, 'match_id', v_match_id);
    else
        insert into mp_queue (profile_id, display_name, skin_id, joined_at)
            values (v_self, coalesce(p_display_name, 'PLAYER'), p_skin_id, now())
            on conflict (profile_id) do update set joined_at = now(), display_name = excluded.display_name, skin_id = excluded.skin_id;

        return jsonb_build_object('matched', false);
    end if;
end;
$$;

grant execute on function mp_try_match(text, text) to authenticated;

-- ============================================================
-- RPC: mp_leave_queue — cancel matchmaking.
-- ============================================================
create or replace function mp_leave_queue()
returns void
language sql
security definer
set search_path = public
as $$
    delete from mp_queue where profile_id = auth.uid();
$$;

grant execute on function mp_leave_queue() to authenticated;

-- ============================================================
-- RPC: mp_join_ready — push your starting queue/held state into a match
-- you were just placed into, before the first turn begins.
-- ============================================================
create or replace function mp_join_ready(p_match_id uuid, p_queue jsonb, p_held jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_self  uuid := auth.uid();
    v_match mp_matches%rowtype;
    v_players jsonb;
    v_idx int;
begin
    select * into v_match from mp_matches where id = p_match_id for update;
    if not found then raise exception 'match not found'; end if;

    select ord - 1 into v_idx
        from jsonb_array_elements(v_match.players) with ordinality as t(p, ord)
        where (t.p->>'profile_id')::uuid = v_self;

    if v_idx is null then raise exception 'not a participant'; end if;

    v_players := jsonb_set(v_match.players, array[v_idx::text, 'queue'], coalesce(p_queue, '[]'::jsonb));
    v_players := jsonb_set(v_players, array[v_idx::text, 'held'], coalesce(p_held, 'null'::jsonb));

    update mp_matches set players = v_players, updated_at = now() where id = p_match_id;

    select * into v_match from mp_matches where id = p_match_id;
    return to_jsonb(v_match);
end;
$$;

grant execute on function mp_join_ready(uuid, jsonb, jsonb) to authenticated;

-- ============================================================
-- RPC: mp_place_piece — the authoritative move handler.
-- Validates it's your turn and the turn hasn't expired, validates the
-- Morphed color-match placement rule server-side, flips the cells,
-- scores it and checks for a board clear.
--
-- NOTE: placing does NOT end your turn. You keep placing as many pieces
-- as you can until turn_seconds runs out; only mp_expire_turn advances
-- turn_index. Each placement bumps moves_this_turn so the expiry handler
-- knows whether you actually played.
-- ============================================================
create or replace function mp_place_piece(
    p_match_id uuid,
    p_piece    jsonb,     -- 2D array of 0/1, same shape the client uses
    p_row      int,       -- top-left row of the piece's bounding box
    p_col      int,
    p_new_queue jsonb,    -- this player's queue AFTER popping the placed piece
    p_new_held  jsonb,
    p_new_can_hold boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_self        uuid := auth.uid();
    v_match       mp_matches%rowtype;
    v_idx         int;
    v_turn_player jsonb;
    v_grid        jsonb := '[]'::jsonb;
    v_required    int;
    v_cell        int;
    v_blocks      int := 0;
    v_score       int;
    v_mult        int;
    v_sum         int := 0;
    v_num_players int;
    v_cleared     boolean := false;
    r int; c int; tr int; tc int;
    v_prow jsonb; v_grow jsonb;
begin
    select * into v_match from mp_matches where id = p_match_id for update;
    if not found then raise exception 'match not found'; end if;
    if v_match.status <> 'active' then raise exception 'match not active'; end if;

    v_num_players := jsonb_array_length(v_match.players);
    v_turn_player := v_match.players -> v_match.turn_index;

    if (v_turn_player->>'profile_id')::uuid <> v_self then
        raise exception 'not your turn';
    end if;
    if now() > v_match.turn_started_at + make_interval(secs => v_match.turn_seconds) then
        raise exception 'turn expired — call mp_expire_turn first';
    end if;

    -- Validate placement: every covered cell must already be the same color.
    for r in 0 .. jsonb_array_length(p_piece) - 1 loop
        v_prow := p_piece -> r;
        for c in 0 .. jsonb_array_length(v_prow) - 1 loop
            if (v_prow ->> c)::int = 1 then
                tr := p_row + r;
                tc := p_col + c;
                if tr < 0 or tr >= 6 or tc < 0 or tc >= 6 then
                    raise exception 'out of bounds';
                end if;
                v_cell := ((v_match.grid -> tr) ->> tc)::int;
                if v_required is null then
                    v_required := v_cell;
                elsif v_cell <> v_required then
                    raise exception 'color mismatch';
                end if;
            end if;
        end loop;
    end loop;

    -- Apply: flip every covered cell.
    v_grid := v_match.grid;
    for r in 0 .. jsonb_array_length(p_piece) - 1 loop
        v_prow := p_piece -> r;
        for c in 0 .. jsonb_array_length(v_prow) - 1 loop
            if (v_prow ->> c)::int = 1 then
                tr := p_row + r;
                tc := p_col + c;
                v_cell := ((v_grid -> tr) ->> tc)::int;
                v_grid := jsonb_set(v_grid, array[tr::text, tc::text], to_jsonb(1 - v_cell));
                v_blocks := v_blocks + 1;
            end if;
        end loop;
    end loop;

    v_mult := coalesce((v_turn_player->>'multiplier')::int, 1);
    v_score := coalesce((v_turn_player->>'score')::int, 0) + (v_blocks * 10 * v_mult);

    -- Board clear ("blacked out" / "whited out")?
    for r in 0 .. 5 loop
        v_grow := v_grid -> r;
        for c in 0 .. 5 loop
            v_sum := v_sum + (v_grow ->> c)::int;
        end loop;
    end loop;
    if v_sum = 0 or v_sum = 36 then
        v_score := v_score + (1000 * v_mult);
        v_mult := 1 + floor(v_score / 800);
        v_cleared := true;
    end if;

    -- Write this player's updated slot.
    v_turn_player := jsonb_set(v_turn_player, '{score}', to_jsonb(v_score));
    v_turn_player := jsonb_set(v_turn_player, '{multiplier}', to_jsonb(v_mult));
    v_turn_player := jsonb_set(v_turn_player, '{queue}', coalesce(p_new_queue, '[]'::jsonb));
    v_turn_player := jsonb_set(v_turn_player, '{held}', coalesce(p_new_held, 'null'::jsonb));
    v_turn_player := jsonb_set(v_turn_player, '{can_hold}', to_jsonb(coalesce(p_new_can_hold, true)));
    v_turn_player := jsonb_set(v_turn_player, '{moves_this_turn}',
                               to_jsonb(coalesce((v_turn_player->>'moves_this_turn')::int, 0) + 1));

    -- turn_index and turn_started_at deliberately untouched: the player
    -- keeps the floor for the rest of their 30 seconds.
    update mp_matches
    set grid = v_grid,
        players = jsonb_set(v_match.players, array[v_match.turn_index::text], v_turn_player),
        status = case when now() >= v_match.match_started_at + make_interval(secs => v_match.match_seconds)
                      then 'finished' else 'active' end,
        updated_at = now()
    where id = p_match_id;

    select * into v_match from mp_matches where id = p_match_id;
    return to_jsonb(v_match) || jsonb_build_object('cleared', v_cleared);
end;
$$;

grant execute on function mp_place_piece(uuid, jsonb, int, int, jsonb, jsonb, boolean) to authenticated;

-- ============================================================
-- RPC: mp_expire_turn — idempotent watchdog. Any connected client can
-- call this once a second; it only does something if the current
-- turn's (or match's) clock has actually run out.
--
-- The clock running out is the NORMAL way a turn ends (you place as many
-- pieces as you can within it), so it costs nothing by itself. The
-- penalty applies only when the player let the whole turn pass without
-- landing a single piece — stuck or idle. Either way they're never
-- eliminated; play just passes to the next player.
-- ============================================================
create or replace function mp_expire_turn(p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_match       mp_matches%rowtype;
    v_num_players int;
    v_players     jsonb;
    v_player      jsonb;
    v_score       int;
    v_penalty     constant int := 50;
    v_next_idx    int;
    v_moves       int;
    v_failed      boolean := false;
    v_finished    boolean := false;
begin
    select * into v_match from mp_matches where id = p_match_id for update;
    if not found then raise exception 'match not found'; end if;
    if v_match.status <> 'active' then return to_jsonb(v_match); end if;

    if now() >= v_match.match_started_at + make_interval(secs => v_match.match_seconds) then
        update mp_matches set status = 'finished', updated_at = now() where id = p_match_id;
        select * into v_match from mp_matches where id = p_match_id;
        return to_jsonb(v_match);
    end if;

    if now() <= v_match.turn_started_at + make_interval(secs => v_match.turn_seconds) then
        return to_jsonb(v_match);   -- not actually expired yet, nothing to do
    end if;

    v_num_players := jsonb_array_length(v_match.players);
    v_player := v_match.players -> v_match.turn_index;
    v_moves := coalesce((v_player->>'moves_this_turn')::int, 0);

    -- Penalty ONLY for a turn where nothing was placed. Placing even one
    -- piece means the turn was played and simply ran out of time.
    if v_moves = 0 then
        v_score := greatest(0, coalesce((v_player->>'score')::int, 0) - v_penalty);
        v_player := jsonb_set(v_player, '{score}', to_jsonb(v_score));
        v_failed := true;
    end if;

    -- Reset the counter for this player's next turn.
    v_player := jsonb_set(v_player, '{moves_this_turn}', '0'::jsonb);
    v_players := jsonb_set(v_match.players, array[v_match.turn_index::text], v_player);

    v_next_idx := (v_match.turn_index + 1) % v_num_players;
    -- Incoming player starts their turn with a clean counter too.
    v_players := jsonb_set(v_players, array[v_next_idx::text, 'moves_this_turn'], '0'::jsonb);

    v_finished := now() >= v_match.match_started_at + make_interval(secs => v_match.match_seconds);

    update mp_matches
    set players = v_players,
        turn_index = v_next_idx,
        turn_started_at = now(),
        status = case when v_finished then 'finished' else 'active' end,
        updated_at = now()
    where id = p_match_id;

    select * into v_match from mp_matches where id = p_match_id;
    return to_jsonb(v_match) || jsonb_build_object(
        'failed_player', case when v_failed then v_player->>'profile_id' else null end,
        'penalty', case when v_failed then v_penalty else 0 end);
end;
$$;

grant execute on function mp_expire_turn(uuid) to authenticated;

-- ============================================================
-- mp_piece_fits — can this piece be legally placed anywhere on this grid?
-- Mirrors the client's canFitAnywhere(): a placement is legal when every
-- cell the piece covers is in bounds and all of them are currently the
-- same colour. Used to verify a "stuck" claim server-side.
-- ============================================================
create or replace function mp_piece_fits(p_grid jsonb, p_piece jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
    v_rows int; v_cols int;
    v_required int; v_cell int; v_ok boolean;
    r int; c int; pr int; pc int; tr int; tc int;
    v_prow jsonb;
begin
    if p_piece is null or jsonb_typeof(p_piece) <> 'array' then return false; end if;
    v_rows := jsonb_array_length(p_piece);
    if v_rows = 0 then return false; end if;
    v_cols := jsonb_array_length(p_piece -> 0);

    for r in 0 .. 6 - v_rows loop
        for c in 0 .. 6 - v_cols loop
            v_required := null;
            v_ok := true;
            for pr in 0 .. v_rows - 1 loop
                v_prow := p_piece -> pr;
                for pc in 0 .. jsonb_array_length(v_prow) - 1 loop
                    if (v_prow ->> pc)::int = 1 then
                        tr := r + pr; tc := c + pc;
                        if tr < 0 or tr >= 6 or tc < 0 or tc >= 6 then
                            v_ok := false;
                        else
                            v_cell := ((p_grid -> tr) ->> tc)::int;
                            if v_required is null then v_required := v_cell;
                            elsif v_cell <> v_required then v_ok := false;
                            end if;
                        end if;
                    end if;
                    exit when not v_ok;
                end loop;
                exit when not v_ok;
            end loop;
            if v_ok then return true; end if;
        end loop;
    end loop;
    return false;
end;
$$;

-- ============================================================
-- RPC: mp_fail_scramble — you're stuck, so take the hit and get a new hand.
-- Mirrors the solo game-over test: you're stuck only when neither your
-- current piece nor your held piece fits anywhere AND your hold slot is
-- occupied (an empty hold always gives you an out). Being stuck is a FAIL:
-- −1000 points, then your queue is replaced so play can continue rather
-- than the match stalling.
--
-- The stuck test is enforced here, not trusted from the client, so nobody
-- can reroll a bad-but-playable hand on demand.
-- ============================================================
create or replace function mp_fail_scramble(p_match_id uuid, p_new_queue jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_self    uuid := auth.uid();
    v_match   mp_matches%rowtype;
    v_idx     int;
    v_player  jsonb;
    v_queue   jsonb;
    v_held    jsonb;
    v_penalty constant int := 1000;
    v_score   int;
begin
    select * into v_match from mp_matches where id = p_match_id for update;
    if not found then raise exception 'match not found'; end if;
    if v_match.status <> 'active' then return to_jsonb(v_match); end if;

    select ord - 1 into v_idx
        from jsonb_array_elements(v_match.players) with ordinality as t(p, ord)
        where (t.p->>'profile_id')::uuid = v_self;
    if v_idx is null then raise exception 'not a participant'; end if;
    if v_idx <> v_match.turn_index then raise exception 'not your turn'; end if;

    v_player := v_match.players -> v_idx;
    v_queue  := v_player -> 'queue';
    v_held   := v_player -> 'held';

    -- Verify the stuck claim.
    if jsonb_typeof(v_held) = 'null' or v_held is null then
        raise exception 'not stuck: hold is empty';
    end if;
    if jsonb_array_length(coalesce(v_queue, '[]'::jsonb)) > 0
       and mp_piece_fits(v_match.grid, v_queue -> 0) then
        raise exception 'not stuck: current piece fits';
    end if;
    if mp_piece_fits(v_match.grid, v_held) then
        raise exception 'not stuck: held piece fits';
    end if;

    v_score := greatest(0, coalesce((v_player->>'score')::int, 0) - v_penalty);
    v_player := jsonb_set(v_player, '{score}', to_jsonb(v_score));
    v_player := jsonb_set(v_player, '{queue}', coalesce(p_new_queue, '[]'::jsonb));
    v_player := jsonb_set(v_player, '{held}', 'null'::jsonb);
    v_player := jsonb_set(v_player, '{can_hold}', 'true'::jsonb);

    update mp_matches
    set players = jsonb_set(v_match.players, array[v_idx::text], v_player),
        updated_at = now()
    where id = p_match_id;

    select * into v_match from mp_matches where id = p_match_id;
    return to_jsonb(v_match) || jsonb_build_object('scrambled', true, 'penalty', v_penalty);
end;
$$;

grant execute on function mp_fail_scramble(uuid, jsonb) to authenticated;

-- ============================================================
-- RPC: mp_forfeit_match — quit a match early.
-- Ends the match immediately and hands the win to the opponent
-- regardless of score. The forfeiting player is flagged in the players
-- JSON so the results screen can label it. Idempotent: forfeiting an
-- already-finished match just returns the current row.
-- ============================================================
create or replace function mp_forfeit_match(p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_self     uuid := auth.uid();
    v_match    mp_matches%rowtype;
    v_idx      int;
    v_players  jsonb;
    v_opponent uuid;
begin
    select * into v_match from mp_matches where id = p_match_id for update;
    if not found then raise exception 'match not found'; end if;
    if v_match.status <> 'active' then return to_jsonb(v_match); end if;

    select ord - 1 into v_idx
        from jsonb_array_elements(v_match.players) with ordinality as t(p, ord)
        where (t.p->>'profile_id')::uuid = v_self;
    if v_idx is null then raise exception 'not a participant'; end if;

    -- Winner = the first participant who isn't the forfeiter.
    select (p->>'profile_id')::uuid into v_opponent
        from jsonb_array_elements(v_match.players) p
        where (p->>'profile_id')::uuid <> v_self
        limit 1;

    v_players := jsonb_set(v_match.players, array[v_idx::text, 'forfeited'], 'true'::jsonb);

    update mp_matches
    set status = 'finished',
        players = v_players,
        winner_profile_id = v_opponent,
        updated_at = now()
    where id = p_match_id;

    -- Also make sure this player isn't left sitting in the queue.
    delete from mp_queue where profile_id = v_self;

    select * into v_match from mp_matches where id = p_match_id;
    return to_jsonb(v_match);
end;
$$;

grant execute on function mp_forfeit_match(uuid) to authenticated;

-- ============================================================
-- RPC: mp_add_lifetime_sparks — call whenever addSparks() runs, so
-- lifetime-Sparks achievements (which must never decrease when Sparks
-- are spent) can be tracked server-side too and survive a reinstall.
-- ============================================================
create or replace function mp_add_lifetime_sparks(p_amount int)
returns void
language sql
security definer
set search_path = public
as $$
    update profiles set lifetime_sparks = lifetime_sparks + greatest(0, p_amount), updated_at = now()
    where id = auth.uid();
$$;

grant execute on function mp_add_lifetime_sparks(int) to authenticated;

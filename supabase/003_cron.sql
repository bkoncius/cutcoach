-- Schedules the reminder dispatcher. Run in Supabase: SQL Editor -> New query.
--
-- This is the committed TEMPLATE — replace <YOUR-CRON-SECRET> before running.
-- `supabase/003_cron.local.sql` is the filled-in, ready-to-paste copy (gitignored,
-- because a real secret must never land in git). Use that one.
--
-- PREREQUISITE that fails silently if you miss it: Vercel Authentication must be OFF
-- for production, or every call lands on vercel.com's login page (302) and pg_cron
-- reports SUCCESS forever while nothing happens. See 003_cron.local.sql.
--
-- Why not Vercel Cron? On the Hobby plan cron is capped at once per day with ±59 min
-- precision, and a sub-daily expression fails at DEPLOY time, not at runtime. Cron
-- schedules are UTC and one job serves every user, so matching a per-user local 07:30
-- needs a tick finer than the reminder spacing. Hobby cannot do it at any job count.
--
-- pg_cron is free-tier, does sub-minute, and pg_net can send the same
-- `Authorization: Bearer` header Vercel Cron would. The endpoint is scheduler-agnostic,
-- so moving to Vercel Pro later is: add a vercel.json crons block, run the unschedule
-- at the bottom of this file. No code change.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Vault keeps the secret out of the job definition, which is world-readable to anyone
-- with SQL access via cron.job.
select vault.create_secret('<YOUR-CRON-SECRET>', 'cutcoach_cron_secret', 'Bearer token for /api/cron/dispatch');

-- Every 5 minutes. The dispatcher returns early when nothing is due, so ~288 daily
-- invocations cost one indexed query each and only a handful do real work.
select cron.schedule('cutcoach-dispatch', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://cutcoach-bkoncius-projects.vercel.app/api/cron/dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cutcoach_cron_secret')
    ),
    timeout_milliseconds := 20000
  );
$$);


-- ---------------------------------------------------------------------------
-- DEBUGGING — read this before concluding "the cron works".
--
-- pg_net is FIRE AND FORGET. net.http_post() queues a request and returns an id
-- immediately; it does NOT surface HTTP failures to pg_cron. So if the secret here
-- doesn't match CRON_SECRET on Vercel, your endpoint 401s on every call, cron.job_run_details
-- reports SUCCEEDED, and nothing happens — forever, with no error anywhere.
--
-- ALWAYS check net._http_response, not just job_run_details:

--   select * from cron.job_run_details where jobname = 'cutcoach-dispatch'
--     order by start_time desc limit 10;

--   -- the one that actually tells you the truth:
--   select id, status_code, content, error_msg, created
--     from net._http_response order by created desc limit 10;
--   -- status_code 200 = good. 401 = secret mismatch. 500 = read `content`.

-- Change the schedule (re-running cron.schedule with the same name replaces it):
--   select cron.schedule('cutcoach-dispatch', '*/10 * * * *', $$ ... $$);

-- Turn it off:
--   select cron.unschedule('cutcoach-dispatch');

-- Rotate the secret (update Vercel's CRON_SECRET to match in the same sitting):
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'cutcoach_cron_secret'),
--     '<NEW-SECRET>'
--   );

-- NOTE: the Supabase free tier pauses a project after 7 days of inactivity, which
-- stops pg_cron with it. Daily app use keeps it awake.

-- CutCoach program library. Run once after 005_engine.sql. Safe to re-run.
--
-- program_id references lib/programs.js LIBRARY keys — deliberately NOT a foreign key
-- or enum: the library is code, and an unknown id degrades gracefully through
-- getTemplate()'s fallback instead of failing a write. Same reasoning as
-- workouts.template staying free text.

alter table profiles add column if not exists program_id text;
alter table profiles add column if not exists emphasis text
  check (emphasis in ('balanced','lower_glutes','upper'));

-- Every pre-library row was on the original 4-day upper/lower, which is library entry
-- ul4-gym with the SAME template ids — history, prefill, and rotation carry over.
update profiles set program_id = 'ul4-gym' where program_id is null;

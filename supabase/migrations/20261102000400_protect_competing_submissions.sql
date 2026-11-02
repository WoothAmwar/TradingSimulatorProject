-- Deleting a submission that a lobby entry or a round score points at silently cleared the link
-- (on delete set null), erasing the record of what competed in a lobby or produced a score. The
-- foreign keys now refuse such deletes. NO ACTION rather than RESTRICT so deleting a group or
-- lobby, which cascades to both sides, still works.

alter table public.lobby_entries
  drop constraint lobby_entries_active_submission_id_fkey,
  add constraint lobby_entries_active_submission_id_fkey
    foreign key (active_submission_id) references public.submissions (id) on delete no action;

alter table public.round_attempts
  drop constraint round_attempts_submission_id_fkey,
  add constraint round_attempts_submission_id_fkey
    foreign key (submission_id) references public.submissions (id) on delete no action;

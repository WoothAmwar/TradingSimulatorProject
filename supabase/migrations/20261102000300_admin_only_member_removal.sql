-- Members could delete their own membership and then join another group with its invite link,
-- getting around one-group-per-student. Nothing in the app lets members leave; admins remove
-- members from the home page, so removal is now admin-only.

alter policy group_members_delete on public.group_members
  using ((select private.is_admin()));

-- Live bots run on the engine, which has no C/C++ compiler. The browser that saves a C or C++
-- submission compiles it to WebAssembly and uploads the build to this private bucket as
-- <group_id>/<submission_id>.wasm; the engine downloads it with the service key. Members may
-- write and read builds of their own group's C/C++ submissions only.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bot-builds', 'bot-builds', false, 8388608, array['application/wasm'])
on conflict (id) do nothing;

create function private.owns_bot_build(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.submissions s
    where (storage.foldername(p_name))[1] = s.group_id::text
      and storage.filename(p_name) = s.id::text || '.wasm'
      and s.language in ('c', 'cpp')
      and private.is_member(s.group_id)
  )
$$;

revoke all on function private.owns_bot_build(text) from public;
grant execute on function private.owns_bot_build(text) to authenticated, service_role;

-- Uploads use upsert (a member may rebuild), which needs all three.
create policy bot_builds_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bot-builds' and private.owns_bot_build(name));

create policy bot_builds_update on storage.objects for update to authenticated
  using (bucket_id = 'bot-builds' and private.owns_bot_build(name))
  with check (bucket_id = 'bot-builds' and private.owns_bot_build(name));

create policy bot_builds_select on storage.objects for select to authenticated
  using (bucket_id = 'bot-builds' and private.owns_bot_build(name));

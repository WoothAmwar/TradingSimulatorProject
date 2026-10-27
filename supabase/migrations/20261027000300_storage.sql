-- Private bucket for lobby datasets (<lobby_id>/events.jsonl.gz, prices.csv, trades.csv,
-- manifest.json). The engine uploads with the service key; signed-in users may download files
-- of any lobby they can see (i.e. not a draft).

insert into storage.buckets (id, name, public)
values ('datasets', 'datasets', false)
on conflict (id) do nothing;

create policy datasets_download on storage.objects for select to authenticated
  using (
    bucket_id = 'datasets'
    and exists (
      select 1 from public.lobbies l
      where l.id::text = (storage.foldername(name))[1]
    )
  );

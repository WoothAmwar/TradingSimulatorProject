-- The original policy wrote storage.foldername(name) inside a subquery over public.lobbies, so
-- `name` resolved to lobbies.name instead of the object's path and no download ever matched.
-- Qualify the column so it refers to storage.objects.

alter policy datasets_download on storage.objects
  using (
    bucket_id = 'datasets'
    and exists (
      select 1 from public.lobbies l
      where l.id::text = (storage.foldername(objects.name))[1]
    )
  );

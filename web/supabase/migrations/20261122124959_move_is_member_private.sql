create schema if not exists private;
grant usage on schema private to authenticated;
alter function public.is_member(uuid) set schema private;

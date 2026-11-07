-- Rename a Claude Code machine everywhere in one call (the Worker's free tier allows only a few DB round trips per request).
create or replace function hq_rename_machine(old_name text, new_name text) returns int language plpgsql security definer as $$
declare moved int;
begin
  if old_name is null or new_name is null or length(trim(new_name)) = 0 or old_name = new_name then return 0; end if;
  -- usage: merge into existing rows for the new name, move the rest
  insert into usage_daily (day, machine, folder_key, folder_name, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, messages, sessions, updated_at)
    select day, new_name, folder_key, folder_name, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, messages, sessions, now()
    from usage_daily where machine = old_name
  on conflict (day, machine, folder_key, model) do update set
    input_tokens = usage_daily.input_tokens + excluded.input_tokens,
    output_tokens = usage_daily.output_tokens + excluded.output_tokens,
    cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens,
    messages = usage_daily.messages + excluded.messages,
    sessions = greatest(usage_daily.sessions, excluded.sessions),
    updated_at = now();
  get diagnostics moved = row_count;
  delete from usage_daily where machine = old_name;
  update history set machine = new_name where machine = old_name;
  update tasks set machine = new_name where machine = old_name;
  update folder_map set machine = new_name where machine = old_name;
  insert into agent_heartbeats (machine, last_seen, agent_version, files_tracked)
    select new_name, last_seen, agent_version, files_tracked from agent_heartbeats where machine = old_name
  on conflict (machine) do update set last_seen = greatest(agent_heartbeats.last_seen, excluded.last_seen), agent_version = excluded.agent_version, files_tracked = excluded.files_tracked;
  delete from agent_heartbeats where machine = old_name;
  return moved;
end $$;
revoke all on function hq_rename_machine(text, text) from public, anon, authenticated;

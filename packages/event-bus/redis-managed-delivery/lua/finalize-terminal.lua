if not type_is(KEYS[1], "stream", false) then return {"panic", "source-type"} end
if not type_is(KEYS[2], "hash", true) then return {"panic", "state-type"} end
if not type_is(KEYS[3], "zset", true) or not type_is(KEYS[4], "zset", true) or not type_is(KEYS[5], "zset", true) then
  return {"panic", "index-type"}
end
if redis.call("EXISTS", KEYS[2]) == 0 then return {"stale"} end
local deadline = valid_deadline(redis.call("HGET", KEYS[2], "lease_deadline"))
if not deadline then return {"panic", "state-malformed"} end
local now = now_ms()
if not valid_state_identity(KEYS[2], ARGV[1], ARGV[3]) then return {"panic", "state-malformed"} end
if redis.call("HGET", KEYS[2], "state") ~= "dead-letter-pending" or redis.call("HGET", KEYS[2], "token") ~= ARGV[2]
  or deadline <= now then return {"stale"} end
if tonumber(redis.call("ZSCORE", KEYS[5], ARGV[1])) ~= deadline or redis.call("ZSCORE", KEYS[3], ARGV[1])
  or redis.call("ZSCORE", KEYS[4], ARGV[1]) then return {"panic", "index-mismatch"} end
if not source_exists(KEYS[1], ARGV[1]) then return {"panic", "source-missing"} end
local owner = pending_owner(KEYS[1], ARGV[4], ARGV[1])
if owner == nil then return {"panic", "pending-missing"} end
if owner == false then return {"panic", "pending-malformed"} end
if owner ~= ARGV[5] then return {"stale"} end

local record_key = redis.call("HGET", KEYS[2], "terminal_record_key")
local record_value = redis.call("HGET", KEYS[2], "terminal_record_value")
local terminal_id = redis.call("HGET", KEYS[2], "terminal_id")
local has_evidence = redis.call("HGET", KEYS[2], "terminal_has_evidence")
local evidence_key = redis.call("HGET", KEYS[2], "terminal_evidence_key")
local evidence_value = redis.call("HGET", KEYS[2], "terminal_evidence_value")
local index_key = redis.call("HGET", KEYS[2], "terminal_index_key")
local fields_json = redis.call("HGET", KEYS[2], "terminal_index_fields")
local index_score = valid_deadline(redis.call("HGET", KEYS[2], "terminal_index_score"))
local max_len = tonumber(redis.call("HGET", KEYS[2], "terminal_index_max_len"))
local ttl = tonumber(redis.call("HGET", KEYS[2], "terminal_ttl_seconds"))
local ok, fields = pcall(cjson.decode, fields_json or "")
if not terminal_id or terminal_id == "" or not record_key or record_key == "" or not record_value or record_value == ""
  or not index_key or index_key == "" or (has_evidence ~= "0" and has_evidence ~= "1")
  or not index_score
  or not max_len or max_len < 1 or max_len ~= math.floor(max_len) or not ttl or ttl < 1 or ttl ~= math.floor(ttl)
  or not ok or type(fields) ~= "table" or #fields == 0 or #fields > 32 or #fields % 2 ~= 0 then return {"panic", "terminal-malformed"} end
for field_index, value in ipairs(fields) do
  if type(value) ~= "string" or string.len(value) > 1024 or (field_index % 2 == 1 and value == "") then
    return {"panic", "terminal-malformed"}
  end
end
if has_evidence == "1" and (not evidence_key or not evidence_value) then return {"panic", "terminal-malformed"} end

for _, managed_key in ipairs(KEYS) do
  if record_key == managed_key or index_key == managed_key or (has_evidence == "1" and evidence_key == managed_key) then
    return {"panic", "terminal-key-alias"}
  end
end
if record_key == index_key or (has_evidence == "1" and (evidence_key == record_key or evidence_key == index_key)) then
  return {"panic", "terminal-key-alias"}
end
if not type_is(record_key, "string", true) or not type_is(index_key, "zset", true) then return {"panic", "terminal-key-type"} end
if has_evidence == "1" and not type_is(evidence_key, "string", true) then return {"panic", "terminal-key-type"} end

if has_evidence == "1" then redis.call("SET", evidence_key, evidence_value, "EX", ttl) end
redis.call("SET", record_key, record_value, "EX", ttl)
redis.call("ZADD", index_key, index_score, fields_json)
redis.call("ZREMRANGEBYRANK", index_key, 0, -max_len - 1)
if redis.call("XACK", KEYS[1], ARGV[4], ARGV[1]) ~= 1 then return {"panic", "ack-failed"} end
redis.call("DEL", KEYS[2])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
return {"finalized", terminal_id}

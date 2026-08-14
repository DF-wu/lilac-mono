if not type_is(KEYS[1], "stream", false) then return {"panic", "source-type"} end
if not type_is(KEYS[2], "hash", true) then return {"panic", "state-type"} end
if not type_is(KEYS[3], "zset", true) or not type_is(KEYS[4], "zset", true) or not type_is(KEYS[5], "zset", true) then
  return {"panic", "index-type"}
end
if redis.call("EXISTS", KEYS[2]) == 0 then return {"stale"} end
local deadline = valid_deadline(redis.call("HGET", KEYS[2], "lease_deadline"))
local attempt = valid_attempt(redis.call("HGET", KEYS[2], "attempt"))
if not deadline or not attempt then return {"panic", "state-malformed"} end
local now = now_ms()
if not valid_state_identity(KEYS[2], ARGV[1], ARGV[3]) then return {"panic", "state-malformed"} end
local state = redis.call("HGET", KEYS[2], "state")
if (state ~= "in-flight" and state ~= "claimed") or redis.call("HGET", KEYS[2], "token") ~= ARGV[2]
  or deadline <= now then return {"stale"} end
if state == "claimed" and attempt ~= 5 then return {"panic", "terminal-before-exhaustion"} end
if tonumber(redis.call("ZSCORE", KEYS[4], ARGV[1])) ~= deadline or redis.call("ZSCORE", KEYS[3], ARGV[1])
  or redis.call("ZSCORE", KEYS[5], ARGV[1]) then return {"panic", "index-mismatch"} end
if not source_exists(KEYS[1], ARGV[1]) then return {"panic", "source-missing"} end
local owner = pending_owner(KEYS[1], ARGV[4], ARGV[1])
if owner == nil then return {"panic", "pending-missing"} end
if owner == false then return {"panic", "pending-malformed"} end
if owner ~= ARGV[5] then return {"stale"} end
redis.call("HSET", KEYS[2], "state", "terminal-preparing", "terminal_reason", ARGV[6])
redis.call("HDEL", KEYS[2], "terminal_id", "terminal_record_key", "terminal_record_value",
  "terminal_has_evidence", "terminal_evidence_key", "terminal_evidence_value", "terminal_index_key",
  "terminal_index_fields", "terminal_index_score", "terminal_index_max_len", "terminal_ttl_seconds",
  "failure_kind", "failure_tag", "failure_message")
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
redis.call("ZADD", KEYS[5], deadline, ARGV[1])
return {"preparing", tostring(attempt), ARGV[2], ARGV[3], tostring(deadline), ARGV[6]}

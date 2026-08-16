if not type_is(KEYS[1], "stream", false) then return {"panic", "source-type"} end
if not type_is(KEYS[2], "hash", true) then return {"panic", "state-type"} end
if not type_is(KEYS[3], "zset", true) or not type_is(KEYS[4], "zset", true) or not type_is(KEYS[5], "zset", true) then
  return {"panic", "index-type"}
end
if redis.call("EXISTS", KEYS[2]) == 0 then return {"stale"} end
local now = now_ms()
local deadline = valid_deadline(redis.call("HGET", KEYS[2], "lease_deadline"))
if not deadline then return {"panic", "state-malformed"} end
if not valid_state_identity(KEYS[2], ARGV[1], ARGV[3]) then return {"panic", "state-malformed"} end
if redis.call("HGET", KEYS[2], "state") ~= "in-flight" or redis.call("HGET", KEYS[2], "token") ~= ARGV[2]
  or deadline <= now then return {"stale"} end
if tonumber(redis.call("ZSCORE", KEYS[4], ARGV[1])) ~= deadline or redis.call("ZSCORE", KEYS[3], ARGV[1])
  or redis.call("ZSCORE", KEYS[5], ARGV[1]) then return {"panic", "index-mismatch"} end
if not source_exists(KEYS[1], ARGV[1]) then return {"panic", "source-missing"} end
local owner = pending_owner(KEYS[1], ARGV[4], ARGV[1])
if owner == nil then return {"panic", "pending-missing"} end
if owner == false then return {"panic", "pending-malformed"} end
if owner ~= ARGV[5] then return {"stale"} end
if redis.call("XACK", KEYS[1], ARGV[4], ARGV[1]) ~= 1 then return {"panic", "ack-failed"} end
redis.call("DEL", KEYS[2])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
return {"committed"}

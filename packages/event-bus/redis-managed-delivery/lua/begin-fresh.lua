if not type_is(KEYS[1], "stream", false) then return {"panic", "source-type"} end
if not type_is(KEYS[2], "hash", true) then return {"panic", "state-type"} end
if not type_is(KEYS[3], "zset", true) or not type_is(KEYS[4], "zset", true) or not type_is(KEYS[5], "zset", true) then
  return {"panic", "index-type"}
end
if not source_exists(KEYS[1], ARGV[1]) then return {"panic", "source-missing"} end
local owner = pending_owner(KEYS[1], ARGV[2], ARGV[1])
if owner == nil then return {"panic", "pending-missing"} end
if owner == false then return {"panic", "pending-malformed"} end
if owner ~= ARGV[3] or redis.call("EXISTS", KEYS[2]) ~= 0 then return {"stale"} end
if redis.call("ZSCORE", KEYS[3], ARGV[1]) or redis.call("ZSCORE", KEYS[4], ARGV[1])
  or redis.call("ZSCORE", KEYS[5], ARGV[1]) then return {"panic", "index-orphan"} end
local deadline = now_ms() + tonumber(ARGV[7])
redis.call("HSET", KEYS[2],
  "version", "2", "id", ARGV[1], "delivery_id", ARGV[4], "state", "claimed",
  "attempt", "0", "token", ARGV[5], "owner_id", ARGV[6], "consumer_id", ARGV[3],
  "lease_deadline", tostring(deadline))
redis.call("ZADD", KEYS[4], deadline, ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
return {"claimed", "0", ARGV[5], ARGV[4], tostring(deadline)}

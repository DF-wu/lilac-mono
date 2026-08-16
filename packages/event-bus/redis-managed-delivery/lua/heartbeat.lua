if not type_is(KEYS[1], "stream", false) then return {"panic", "source-type"} end
if not type_is(KEYS[2], "hash", true) then return {"panic", "state-type"} end
if not type_is(KEYS[3], "zset", true) or not type_is(KEYS[4], "zset", true) or not type_is(KEYS[5], "zset", true) then
  return {"panic", "index-type"}
end
if redis.call("EXISTS", KEYS[2]) == 0 then return {"stale"} end
local state = redis.call("HGET", KEYS[2], "state")
local token = redis.call("HGET", KEYS[2], "token")
local attempt = valid_attempt(redis.call("HGET", KEYS[2], "attempt"))
local deadline = valid_deadline(redis.call("HGET", KEYS[2], "lease_deadline"))
local delivery_id = redis.call("HGET", KEYS[2], "delivery_id")
if not attempt or not deadline or not delivery_id then return {"panic", "state-malformed"} end
local now = now_ms()
if not valid_state_identity(KEYS[2], ARGV[1], ARGV[3]) then return {"panic", "state-malformed"} end
if token ~= ARGV[2] or deadline <= now or (state ~= "in-flight" and state ~= "terminal-preparing"
  and state ~= "dead-letter-pending") then
  return {"stale"}
end
if not source_exists(KEYS[1], ARGV[1]) then return {"panic", "source-missing"} end
local owner = pending_owner(KEYS[1], ARGV[4], ARGV[1])
if owner == nil then return {"panic", "pending-missing"} end
if owner == false then return {"panic", "pending-malformed"} end
if owner ~= ARGV[5] then return {"stale"} end
local next_deadline = now + tonumber(ARGV[6])
if state == "in-flight" then
  if tonumber(redis.call("ZSCORE", KEYS[4], ARGV[1])) ~= deadline or redis.call("ZSCORE", KEYS[3], ARGV[1])
    or redis.call("ZSCORE", KEYS[5], ARGV[1]) then return {"panic", "index-mismatch"} end
  redis.call("HSET", KEYS[2], "lease_deadline", tostring(next_deadline))
  redis.call("ZADD", KEYS[4], next_deadline, ARGV[1])
else
  if tonumber(redis.call("ZSCORE", KEYS[5], ARGV[1])) ~= deadline or redis.call("ZSCORE", KEYS[3], ARGV[1])
    or redis.call("ZSCORE", KEYS[4], ARGV[1]) then return {"panic", "index-mismatch"} end
  redis.call("HSET", KEYS[2], "lease_deadline", tostring(next_deadline))
  redis.call("ZADD", KEYS[5], next_deadline, ARGV[1])
end
return {"extended", tostring(attempt), ARGV[2], delivery_id, tostring(next_deadline)}

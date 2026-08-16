
local function now_ms()
  local time = redis.call("TIME")
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end

local function type_is(key, expected, allow_none)
  local actual = redis.call("TYPE", key).ok
  return actual == expected or (allow_none and actual == "none")
end

local function source_exists(stream, id)
  local entries = redis.call("XRANGE", stream, id, id, "COUNT", 1)
  return #entries == 1 and entries[1][1] == id
end

local function pending_owner(stream, group, id)
  local pending = redis.call("XPENDING", stream, group, id, id, 1)
  if #pending == 0 then return nil end
  if #pending ~= 1 or pending[1][1] ~= id or type(pending[1][2]) ~= "string" then
    return false
  end
  return pending[1][2]
end

local function valid_attempt(raw)
  local attempt = tonumber(raw)
  if not attempt or attempt ~= math.floor(attempt) or attempt < 1 or attempt > 5 then return nil end
  return attempt
end

local function valid_completed_attempts(raw)
  local attempt = tonumber(raw)
  if not attempt or attempt ~= math.floor(attempt) or attempt < 0 or attempt > 5 then return nil end
  return attempt
end

local function valid_stream_id(raw)
  return type(raw) == "string" and string.match(raw, "^%d+%-%d+$") ~= nil
end

local function valid_deadline(raw)
  local deadline = tonumber(raw)
  if not deadline or deadline ~= math.floor(deadline) or deadline < 0 then return nil end
  return deadline
end

local function valid_state_identity(key, id, delivery_id)
  return redis.call("HGET", key, "version") == "2" and redis.call("HGET", key, "id") == id
    and redis.call("HGET", key, "delivery_id") == delivery_id
end

local function claim_source(stream, group, consumer, id)
  local claimed = redis.call("XCLAIM", stream, group, consumer, 0, id)
  return #claimed == 1 and claimed[1][1] == id
end

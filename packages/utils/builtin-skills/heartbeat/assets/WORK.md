# Heartbeat working notes

## Wake and discovery progress

No checks yet. Record the last wake, inspected activity references, coverage gaps, and blocked work.

## Active watches

None yet. Use this shape when adding a watch; omit fields that do not apply:

```markdown
### <Responsibility or event>

Origin: user requested | discovered
Source: <surface, conversation/thread, message reference>
Purpose: <why this matters to the user>
State: watching | blocked | complete | stopped
Delivery: default | <client and concrete session/channel ID>
Delivery instructions: <for example, keep meaningful updates in this thread>
Known: <facts, uncertainties, relevant dates and timezone>
Last check: <time, evidence links, result>
Next check: <time and rationale>
Notify when: <material change or decision worth bringing to the user>
Last communicated: <finding, time, actual target, returned message reference>
Delivery problem: <failed or uncertain attempt, if any>
Finish when: <completion, expiry, or cancellation condition>
Lessons: <task-specific observations that improve the next check>
```

## Completed watches

Keep brief outcomes and source references to avoid reopening finished work.

## Lessons

Record preferences supported by user feedback and lessons supported by observed outcomes.

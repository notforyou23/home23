# Channels, Bots, and joined work

Jerry administers topic channels and persistent Bots through `channel_manage`, using his signed resident identity and current Work fence. Routine channel creation, membership, purpose, responder policy, pinning, archival, restoration, and helper lifecycle actions use his standing household mandate. They do not borrow owner tokens. Permanent resident protections and configured capabilities remain authoritative.

`bot_invoke` admits an exact assignment to another member of an active topic channel. Its canonical journal record binds the parent Work and tool call to one origin Message. The helper answers as itself. Its child Work is visible and controllable by the channel owner. The product DTO uses the existing resident_work_thread presentation kind, while canonical Round Work retains channel.bot_turn; existing iPhone thread filtering therefore remains compatible. Replayed admission uses the same Message and idempotency key. The parent waits for canonical terminal Work and its committed result Message, then enters the existing resident follow-through queue. An accepted abort is not a stopped receipt.

Cancellation waits for in-flight admission. Queued work is cancelled, offered or accepted work is returned from its lease before cancellation, and running work receives exact lease revocation and runtime stop. Pending joins and terminal evidence survive Core restart. An unavailable runtime or uncertain external effect remains unresolved rather than receiving a fabricated success or cancellation receipt.

## Tool lifecycle

The foreground policy promotes these operations into canonical Working Threads:

- coding_run, coding_continue, spawn_agent, brain_query_export
- worker_run, generate_image, generate_music, tts
- skills_run, cron_run, bot_invoke
- research_launch, research_continue, research_compile_brain, research_compile_section, brain_synthesize

Configuration and provider authorization are separate from lifecycle support. Workers use the trusted in-process ToolContext, including cancellation, lineage, Activity, and returned media. Their local receipt records failure or cancellation as well as success. Media fetches and TTS combine provider deadlines with the parent signal. Shared skill actions receive the same join and signal, and their actual promise must settle before the tool returns; cooperative cancellation depends on the action honoring the signal.

Manual cron invocation retains the parent Work and joins agent, exec, and brain-query payloads. It does not duplicate legacy delivery into a second destination. The scheduler rejects overlap for the same job.

Research operations derive their remote request identity from the exact Work/tool invocation. Lost admission responses retry that identity; lost observation remains a live join. Stop requests wait for a confirmed remote terminal operation. These idempotent roots may reattach to the existing remote operation after resident recovery. Other tools are not blindly replayed after execution began. Arbitrary shell, publishing, media, and skill effects cannot be made transactional by a timeout or a new model turn.

## Scheduled topic work

`cron_schedule` and `cron_update` accept `channel_id` for an agentTurn. Updating an existing job preserves its history and any active run snapshot; clearing the binding changes future routing only. The channel must be an active group/topic channel containing Jerry. Ordinary legacy delivery configuration alone does not establish this binding.

The scheduler persists a full run ID before dispatch, and persists the resolved prompt, channel, model, and effort before its first signed Core request. Core journals admission before submitting one canonical channel Message. The scheduler observes the corresponding Work; it does not run a fallback local agent turn. Pending runs reattach with the original resolved prompt after scheduler restart, including disabled one-shot jobs. Core repairs admission gaps from its journal and uses existing group Work recovery for execution/result delivery. Canonical observers do not block unrelated scheduler ticks, and active jobs still count against concurrency limits.

A terminal scheduled Work enters Jerry's durable outcome inbox. Follow-through reviews saved state and the latest channel context. Interrupted work can be inspected and continued under the original authorization; side effects must not be blindly repeated. Recovery of a recorded result is different from safely replaying an unfinished external action.

## Activation and verification

This change is prepared against the exact selected managed package. Do not build or activate from a dirty working checkout as though it were the deployed baseline. Run source/type checks, targeted channel and Bot lifecycle tests, worker/media/skills/cron tests, Work-control tests, resident outcome tests, UDS detachment tests, and operation-client tests in the isolated candidate. Record existing baseline failures separately.

Release preparation does not change live job configuration. Bind selected editorial jobs to their canonical channel only during an explicitly authorized activation, preserving existing prompts, delivery intent, and active run state. Physical iPhone checks must confirm thread listing, Stop, notification routing, and unread/badge updates; a successful backend build is not that acceptance.


Scheduled channel admission preserves the job's configured execution timeout as an absolute deadline in the durable admission record. Reattachment cannot extend it. Core requests cancellation through the existing Work control and exact runtime stop reconciliation; the scheduler waits for terminal confirmation. A deadline does not establish that external side effects stopped. Each invocation retains its own Work and resident chat; the topic channel supplies shared project history.

Helper completion includes canonical result Message, author and channel evidence. The durable resident outcome inbox reads this evidence directly from Core alongside the parent summary, so review does not lose helper provenance or depend on a worker repeating its own claim. A mismatched result author or channel fails the invocation.

Scheduled child accounting includes only canonical channel.bot_turn Work. Resident reviews share the original request but never count as scheduled children or trigger another scheduled review. Busy admission retains its journaled identity for retry; transient UDS observation deadlines do not fail the helper parent.

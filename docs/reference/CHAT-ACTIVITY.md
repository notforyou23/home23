# Conversation activity

The current dashboard is `engine/src/dashboard/home23-dashboard.html`; its chat implementation is `home23-chat.js` and `home23-chat-transcript.mjs`. Keep activity in that conversation rather than adding a separate working or thinking panel.

Response segments, thoughts, tools and subagents retain their event order. Each tool uses its exact call ID, scoped to its turn; legacy records without IDs may match only an unambiguous pending call. A lifecycle update changes its existing entry. Disclosure choices survive live updates and history refresh. Reopening a pending turn resumes after the retained event sequence; it does not replay the already-rendered prefix. Completed history suppresses only the final response segment whose exact content matches the canonical answer, preserving earlier commentary.

Readable content comes from actual provider or runtime content fields. Empty provider completion events and heartbeat status codes are not narrative text. Render Markdown as Markdown. Tool labels describe their action; structured results show factual summaries, with raw arguments and results under Technical details. An explicit failure takes precedence over a transport success flag. A completion without success evidence is Finished, not Complete.

Child loops emit `subagent_progress` with their exact nested `activity`, task, label and subagent ID. Child response chunks never enter the resident's answer. The parent stream and canonical adapter retain the child's identity and reasoning provenance. The runtime observation does not claim the parent's model/provider is the child's. Nested media and artifact events retain the same private-path policy as top-level activity.

Work is an index into the owning conversation. Keep task controls secondary, link results to their actual conversation, and retain explicit assignment assessments separately from execution status. See [resident outcome follow-through](../design/RESIDENT-OUTCOME-FOLLOW-THROUGH.md) for recovery and status semantics. The Apple repository documents its shared native counterpart in `docs/reference/SHARED-CHAT.md`.

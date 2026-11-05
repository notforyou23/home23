# Channel participant model selection

The phone shows each eligible participant's selected model and reasoning beside the channel composer. Tapping the summary opens the same model catalog and reasoning choices used by direct conversations. Preferences are saved on the phone by channel ID and bot ID; they do not change the bot's home default or another conversation. No selection means the current bot default. Changing the model clears an incompatible reasoning override.

`GET /api/v1/channels/:channelId/execution-options?botId=...` returns that active channel member's authenticated execution catalog. Channel membership is required. The existing request without botId continues to serve direct conversations.

Channel message submission may include `botSelections`, a bounded map from bot ID to `{modelAlias, reasoningEffort}`. Default/null fields retain existing behavior. Each selected responder's pair is checked against its catalog and copied into the durable Round admission target before Work creation. Every Work receives only its own pair. A restart or sequentially delayed responder uses the recorded admission choice, never current phone settings. Canonical message idempotency includes the map with stable key ordering. Direct submissions reject this group-only field.

The phone retains the exact map in its durable outgoing message body. An uncertain retry reuses that body. New messages with a saved but unavailable model/effort are refused visibly; default messages remain available when catalog loading fails. Existing pending messages without this field remain readable. No database or persistence-contract migration is required.

Deployment requires the compatible backend before installing the new phone build. Source verification does not establish live deployment or physical visual acceptance.

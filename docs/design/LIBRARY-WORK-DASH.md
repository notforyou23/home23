# Library, Work, and Dash

Library reads the dashboard Briefs catalog independently of House's small summary. The default `type=all_reports` excludes conversation notes; Notes remains a separate filter. The endpoint supports `offset`, `q` (titles and previews), `total`, and `nextOffset`. Files are discovered before paging, compact pages avoid reading full bodies, and scanning yields between batches. Detail lookup is not restricted to the first page. Existing supported file formats/size rules and the latest scheduled-run summary remain in effect. Worker receipt discovery no longer truncates to eighty runs per worker.

The phone lists sixty Briefs per page, offers older reports, and reads full formatted bodies on demand. Its host-scoped default report cache retains up to 240 loaded summaries. Search is submitted explicitly, not on each keystroke. Report failures preserve already loaded content and remain visible.

Work represents execution and assignment status. Current queued/running/stopping/follow-up work, pending review/blocked work, completed/delivered work, and unsuccessful/cancelled history are separate. Old failure alone is not a current owner obligation and is not relabeled completed. Resident assignment conclusions retain precedence over execution state. Work links readers to Library; reading a result never retries its work.

The owner-scoped Work endpoint now supports bounded offset cursors while retaining all membership checks. Library traverses those pages, rejects repeated cursors, and deduplicates IDs to retain older result discovery beyond the latest hundred assignments. Work itself retains its bounded current slice. Offset pages are a changing live view, not a point-in-time snapshot; refreshing restarts traversal.

Dash opens configured resident dashboards and existing Agency/Brain map/Cosmo web sections. Additional named HTTP(S) links can be saved on the phone and removed with the context menu. It does not operate dashboard controls automatically.

Activation requires the compatible managed Core and dashboard Briefs update before the phone build. Source/build verification is separate from installed-device and visual acceptance.

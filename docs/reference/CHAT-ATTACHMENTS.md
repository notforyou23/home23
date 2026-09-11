# Chat attachment transport

Chat input accepts general files. Storage does not require an image decoder, a particular PDF structure, or a small raster dimension. A valid phone JPEG, including progressive encoding and EXIF orientation, is stored byte for byte.

The canonical attachment path retains the 25 MiB per-file limit, ten files per message, bounded upload concurrency, SHA-256 verification, ownership checks, immutable message links, and durable idempotency. Migration 16 broadens MIME metadata constraints without changing existing artifact IDs or links. Deploy the backend before distributing clients that send general files.

Detection identifies common preview types from signatures or valid text; other formats remain opaque downloads. Declared MIME and detected MIME may differ. Upload receipts must match the selected name, declared type, byte count and digest. A detected type does not certify that a preview decoder can open the content. Downloads use attachment disposition, nosniff and a restrictive sandbox policy.

Agents receive verified local references. Supported vision formats are supplied as images; other files remain available to file tools through the attachment manifest. The legacy chat route also accepts an `attachments` array with base64 data, filename and MIME metadata, with a 25 MiB combined limit. Its existing `images` contract remains supported. Non-image references persist into subsequent turns without inserting internal filesystem paths into the visible user message.

The dashboard keeps its existing tabs, layout and inspector. Its canonical proxy streams bounded multipart uploads and forwards authenticated downloads. Conversation refreshes preserve drafts, and pending sends retain their original channel, message identity, model/effort selection and idempotency key for retry.

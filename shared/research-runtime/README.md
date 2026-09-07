# Home23 research support

Home23 owns these inherited provider, model-catalog, research metadata and local
PGS modules. They were extracted from Cosmo while separating the research
application. Home23 cognition continues to execute locally; no module in this
library imports a Cosmo checkout. The local `package.json` preserves CommonJS
semantics inside Home23's ESM repository.

Source lineage is preserved in the parent repository's Cosmo preparation and
separation commits. Keep changes here independently reviewed and covered by
Home23 tests; remote Cosmo communication uses its configured HTTP service.

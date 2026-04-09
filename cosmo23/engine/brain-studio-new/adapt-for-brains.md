# Adapting COSMO IDE v2 for Brain Studio

## Changes Needed:

1. **Add tabs to header**
   - Query tab (Intelligence Dashboard)
   - Files tab (existing IDE - rename)
   - Explore tab (graph viz)

2. **Copy modules**
   - public/js/query-tab.js (from brain-studio)
   - public/js/explore-tab.js (from brain-studio)
   - lib/ folder (query-engine, GPT5, etc.)

3. **Add backend routes**
   - /api/query (QueryEngine)
   - /api/graph, /api/nodes, /api/tags (Explore)
   - /api/manifest, /api/stats (Brain metadata)

4. **Update server.js**
   - Accept brain path as argument
   - Set rootPath to brain directory
   - Load brain metadata

5. **Test**
   - All three tabs work
   - IDE functions normally
   - Query uses QueryEngine
   - Explore shows graph

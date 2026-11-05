# Main history reconciliation — September 2026

The maintained backend history and GitHub main contained independent changes. The reconciliation merges both histories, retaining current backend behavior and integrating main's dashboard cleanup, fonts, glyphs and surface tiers.

## Resolution decisions

- Retain current chat transcript/markdown behavior, Home chat preview, 44px composer controls, focus affordances and viewport-safe desktop shell.
- Keep the shared persistent appearance toggle. Use one Paper/Midnight palette in the dashboard stylesheet rather than letting the older theme stylesheet override only part of it. Compatibility RGB channels derive from the same palette; the browser theme-color follows it. Adjust muted text and green slightly to retain normal-text contrast requirements.
- Incorporate main's unused-rule removal. Preserve the newer Home chat preview and restore Query palette aliases because its renderer is injected dynamically. Removed resident-command/health selectors have no remaining renderer references; their old style assertions are retired.
- Preserve the maintained active-navigation feedback and full-width mobile navigation/runtime rows.
- Update the stale COSMO offline test to verify the existing connection-check behavior and absence of restart POSTs. The implementation was already changed when COSMO became standalone.

## Verification

All 128 dashboard tests pass, including chat reconstruction/state, transcript/markdown, Briefs, Connected Agents and interaction contracts. Existing contrast tests retain their 4.5:1 threshold for normal text in both themes and now read each explicit palette scope. Whitespace checks pass.

Isolated browser checks at 1440px and 390px confirm theme switching and viewport containment for Home and Chat, including desktop chat shell insets and mobile navigation. The preview uses an unavailable test upstream, so it demonstrates layout and unavailable states, not live service health. Settings onboarding has a narrow-screen overflow reproduced in the pre-merge baseline; it remains a separate repair. No activation, installation or publication is implied by this merge.

Apple's maintained committed history already descends from origin/main. Its local main baseline can be created without a content merge, while existing working edits remain in their original checkout. No app rebuild is needed for an unchanged source tree.

/**
 * Which JSONL domain readers to run, from osEngine.channels.domain.readers in
 * home.yaml or an instance config.yaml. A reader runs when it names a path
 * and is not disabled (the template ships each with enabled: false). '~' is
 * the owner's home (shared/owner-home.cjs); under the Host, HOME is Home23's
 * private runtime home and holds none of these logs.
 */

'use strict';

import ownerHomeRule from '../../../../shared/owner-home.cjs';

const TAIL_READERS = ['pressure', 'health', 'sauna'];

export function domainReaderSpecs(domainCfg, env = process.env) {
  const readers = domainCfg?.readers || {};
  return TAIL_READERS
    .filter((kind) => typeof readers[kind]?.path === 'string' && readers[kind].path.trim() && readers[kind].enabled !== false)
    .map((kind) => ({ kind, path: ownerHomeRule.expandOwnerPath(readers[kind].path.trim(), env) }));
}

'use strict';

const express = require('express');

const CANONICAL_QUERY_PAGE = '/home23#query';
const CANONICAL_QUERY_API = Object.freeze({
  catalog: '/home23/api/query/catalog',
  run: '/home23/api/query/run',
  stream: '/home23/api/query/stream',
  export: '/home23/api/query/export',
});

function createLegacyQueryRetirementRouter() {
  const router = express.Router();
  const redirectToCanonicalQuery = (_req, res) => {
    res.redirect(308, CANONICAL_QUERY_PAGE);
  };
  const retiredApi = (_req, res) => {
    res.status(410).json({
      error: 'legacy_query_api_retired',
      message: 'Use the durable Home23 Query API with exact provider/model pairs.',
      canonicalPage: CANONICAL_QUERY_PAGE,
      ...CANONICAL_QUERY_API,
    });
  };

  router.get(['/query', '/query.html'], redirectToCanonicalQuery);
  router.use('/api/query', retiredApi);
  router.all('/api/pgs', retiredApi);
  return router;
}

module.exports = {
  CANONICAL_QUERY_API,
  CANONICAL_QUERY_PAGE,
  createLegacyQueryRetirementRouter,
};

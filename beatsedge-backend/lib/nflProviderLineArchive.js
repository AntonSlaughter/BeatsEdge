// Market Archive Hardening (Gap 2/5) -- NFL provider-line archive, thin
// wrapper over lib/marketArchive/providerLineArchiveFactory.js. See
// lib/mlbProviderLineArchive.js for the full rationale/precedent.

const { createProviderLineArchive } = require('./marketArchive/providerLineArchiveFactory');

const NFL_PROPS_PATH_RE = /(^|\/)v1\/sports\/americanfootball_nfl\/props(?:$|[/?])/i;

const archive = createProviderLineArchive({ sport: 'nfl', propsPathRegex: NFL_PROPS_PATH_RE, tableName: 'nfl_provider_line_archive' });

module.exports = { ...archive, isNflPropsPath: archive.isPropsPath };

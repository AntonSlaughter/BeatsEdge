// Market Archive Hardening (Gap 2/5) -- NCAAF provider-line archive, thin
// wrapper over lib/marketArchive/providerLineArchiveFactory.js. See
// lib/mlbProviderLineArchive.js for the full rationale/precedent.

const { createProviderLineArchive } = require('./marketArchive/providerLineArchiveFactory');

const NCAAF_PROPS_PATH_RE = /(^|\/)v1\/sports\/americanfootball_ncaaf\/props(?:$|[/?])/i;

const archive = createProviderLineArchive({ sport: 'ncaaf', propsPathRegex: NCAAF_PROPS_PATH_RE, tableName: 'ncaaf_provider_line_archive' });

module.exports = { ...archive, isNcaafPropsPath: archive.isPropsPath };

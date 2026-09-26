// Market Archive Hardening (Gap 2/5) -- MLB provider-line archive, thin
// wrapper over lib/marketArchive/providerLineArchiveFactory.js. Same
// identity/dedup/append-only discipline as lib/nbaProviderLineArchive.js
// and lib/wnbaProviderLineArchive.js (which this module does NOT modify),
// just extended to a third sport that previously had no equivalent
// archive at all.

const { createProviderLineArchive } = require('./marketArchive/providerLineArchiveFactory');

const MLB_PROPS_PATH_RE = /(^|\/)v1\/sports\/baseball_mlb\/props(?:$|[/?])/i;

const archive = createProviderLineArchive({ sport: 'mlb', propsPathRegex: MLB_PROPS_PATH_RE, tableName: 'mlb_provider_line_archive' });

module.exports = { ...archive, isMlbPropsPath: archive.isPropsPath };

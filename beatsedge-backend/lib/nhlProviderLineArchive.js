// NHL unlock project -- provider-line archive, thin wrapper over
// lib/marketArchive/providerLineArchiveFactory.js. See
// lib/mlbProviderLineArchive.js for the full rationale/precedent.
// Dormant capture only: NHL stays locked, no grade/Edge/probability is
// computed from this, it only lets real lines start accumulating for the
// real-line validation phase this project is currently blocked on.

const { createProviderLineArchive } = require('./marketArchive/providerLineArchiveFactory');

const NHL_PROPS_PATH_RE = /(^|\/)v1\/sports\/icehockey_nhl\/props(?:$|[/?])/i;

const archive = createProviderLineArchive({ sport: 'nhl', propsPathRegex: NHL_PROPS_PATH_RE, tableName: 'nhl_provider_line_archive' });

module.exports = { ...archive, isNhlPropsPath: archive.isPropsPath };

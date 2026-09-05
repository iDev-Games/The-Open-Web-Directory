/**
 * Simple search engine for the local index
 * Searches title, description, and URL
 * Returns results with basic relevance scoring
 */

/**
 * Normalize a search query
 */
function normalizeQuery(query) {
  return query
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Extract search terms from query
 */
function extractTerms(query) {
  const normalized = normalizeQuery(query);

  // Split on spaces
  const terms = normalized.split(' ').filter(t => t.length > 0);

  return terms;
}

/**
 * Tokenize text into words, removing punctuation
 */
function tokenize(text) {
  // Split on whitespace and punctuation, keep only alphanumeric words
  return text
    .toLowerCase()
    .split(/[\s.,;:!?()[\]{}'"]+/)
    .filter(word => word.length > 0);
}

/**
 * Calculate relevance score for a record
 * Higher scores are better
 */
function scoreRecord(record, terms) {
  let score = 0;

  const title = (record.title || '').toLowerCase();
  const description = (record.description || '').toLowerCase();
  const url = (record.url || '').toLowerCase();

  const titleWords = tokenize(title);
  const descWords = tokenize(description);

  for (const term of terms) {
    // Title matches are worth the most
    if (title.includes(term)) {
      score += 10;

      // Boost if term is at the start
      if (title.startsWith(term)) {
        score += 5;
      }

      // Boost for exact word match
      if (titleWords.includes(term)) {
        score += 3;
      }
    }

    // Description matches
    if (description.includes(term)) {
      score += 3;

      if (descWords.includes(term)) {
        score += 1;
      }
    }

    // URL matches (domain, path)
    if (url.includes(term)) {
      score += 1;
    }
  }

  // Penalize old records slightly
  const ageInDays = (Date.now() - (record.lastChecked || record.addedAt)) / (1000 * 60 * 60 * 24);
  if (ageInDays > 365) {
    score *= 0.8;
  }

  // Penalize non-200 status codes
  if (record.status && record.status !== 200) {
    score *= 0.5;
  }

  return score;
}

/**
 * Search the store for matching records using inverted index
 * @param {Store} store - The data store to search
 * @param {string} query - The search query
 * @param {object} options - Search options
 * @param {number} options.limit - Maximum results to return (default: 20)
 * @param {number} options.offset - Number of results to skip (default: 0)
 * @param {number} options.minScore - Minimum score threshold (default: 0)
 * @returns {object} Search results with metadata
 */
export async function search(store, query, options = {}) {
  const {
    limit = 20,
    offset = 0,
    minScore = 0
  } = options;

  // Validate
  if (!query || typeof query !== 'string') {
    return {
      query: '',
      results: [],
      total: 0,
      offset: 0,
      limit
    };
  }

  const terms = extractTerms(query);

  if (terms.length === 0) {
    return {
      query,
      results: [],
      total: 0,
      offset: 0,
      limit
    };
  }

  // Use inverted index to get candidate URLs
  const candidateUrls = store.index.search(terms);

  if (candidateUrls.size === 0) {
    return {
      query,
      results: [],
      total: 0,
      offset: 0,
      limit
    };
  }

  // Load records from disk for candidate domains
  const records = await store.getByDomains(Array.from(candidateUrls));

  // Score the loaded records
  const scored = [];

  for (const record of records) {
    const score = scoreRecord(record, terms);

    if (score > minScore) {
      scored.push({
        ...record,
        score
      });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply pagination
  const total = scored.length;
  const results = scored.slice(offset, offset + limit);

  return {
    query,
    results,
    total,
    offset,
    limit
  };
}

/**
 * Get search statistics
 */
export function getSearchStats(store) {
  const total = store.domains.size;

  // Get index statistics
  const indexStats = store.index.stats();

  return {
    totalRecords: total,
    indexWords: indexStats.words,
    indexMappings: indexStats.mappings,
    avgUrlsPerWord: indexStats.avgUrlsPerWord
  };
}

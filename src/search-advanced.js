/**
 * Advanced search with Google-like operators
 *
 * Supported operators:
 * - site:domain.com - search within specific domain
 * - "exact phrase" - exact phrase matching
 * - -term - exclude term
 * - filetype:ext - filter by file extension
 */

/**
 * Parse search query and extract operators
 */
function parseQuery(query) {
  const filters = {
    site: null,
    filetype: null,
    exactPhrases: [],
    excludeTerms: [],
    includeTerms: []
  };

  let remaining = query;

  // Extract site: operator
  const siteMatch = remaining.match(/site:(\S+)/i);
  if (siteMatch) {
    filters.site = siteMatch[1].toLowerCase();
    remaining = remaining.replace(siteMatch[0], '');
  }

  // Extract filetype: operator
  const filetypeMatch = remaining.match(/filetype:(\S+)/i);
  if (filetypeMatch) {
    filters.filetype = filetypeMatch[1].toLowerCase();
    remaining = remaining.replace(filetypeMatch[0], '');
  }

  // Extract exact phrases (quoted strings)
  const phraseMatches = remaining.match(/"([^"]+)"/g);
  if (phraseMatches) {
    filters.exactPhrases = phraseMatches.map(p => p.slice(1, -1).toLowerCase());
    remaining = remaining.replace(/"[^"]+"/g, '');
  }

  // Extract exclude terms (-term)
  const excludeMatches = remaining.match(/-(\S+)/g);
  if (excludeMatches) {
    filters.excludeTerms = excludeMatches.map(t => t.slice(1).toLowerCase());
    remaining = remaining.replace(/-\S+/g, '');
  }

  // Remaining terms are include terms
  filters.includeTerms = remaining
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);

  return filters;
}

/**
 * Check if record matches filters
 */
function matchesFilters(record, filters) {
  const title = (record.title || '').toLowerCase();
  const description = (record.description || '').toLowerCase();
  const url = (record.url || '').toLowerCase();
  const combined = `${title} ${description} ${url}`;

  // Site filter
  if (filters.site) {
    try {
      const recordUrl = new URL(record.url);
      const hostname = recordUrl.hostname.toLowerCase();
      const site = filters.site.toLowerCase();

      // Match exact domain only (not subdomains)
      // e.g., site:idevgames.co.uk should match only idevgames.co.uk, not www.idevgames.co.uk
      if (hostname !== site) {
        return false;
      }
    } catch (err) {
      return false;
    }
  }

  // Filetype filter
  if (filters.filetype) {
    if (!url.endsWith(`.${filters.filetype}`)) {
      return false;
    }
  }

  // Exact phrases must all be present
  for (const phrase of filters.exactPhrases) {
    if (!combined.includes(phrase)) {
      return false;
    }
  }

  // Exclude terms must NOT be present
  for (const term of filters.excludeTerms) {
    if (combined.includes(term)) {
      return false;
    }
  }

  return true;
}

/**
 * Score a record based on search terms
 */
function scoreRecord(record, filters) {
  let score = 0;

  const title = (record.title || '').toLowerCase();
  const description = (record.description || '').toLowerCase();
  const url = (record.url || '').toLowerCase();

  // Base score for filter-only queries (no search terms)
  const hasSearchTerms = filters.includeTerms.length > 0 || filters.exactPhrases.length > 0;
  if (!hasSearchTerms && (filters.site || filters.filetype)) {
    score = 1; // Minimum score to ensure results appear
  }

  // Score exact phrases highly
  for (const phrase of filters.exactPhrases) {
    if (title.includes(phrase)) {
      score += 20;
      if (title.startsWith(phrase)) {
        score += 10;
      }
    }
    if (description.includes(phrase)) {
      score += 10;
    }
    if (url.includes(phrase)) {
      score += 5;
    }
  }

  // Score include terms
  for (const term of filters.includeTerms) {
    // Title matches
    if (title.includes(term)) {
      score += 10;

      if (title.startsWith(term)) {
        score += 5;
      }

      const titleWords = title.split(/\s+/);
      if (titleWords.includes(term)) {
        score += 3;
      }
    }

    // Description matches
    if (description.includes(term)) {
      score += 3;

      const descWords = description.split(/\s+/);
      if (descWords.includes(term)) {
        score += 1;
      }
    }

    // URL matches
    if (url.includes(term)) {
      score += 1;
    }
  }

  // Bonus for site: operator matches (user is specifically looking here)
  if (filters.site) {
    score += 5;
  }

  // Penalize old records
  const ageInDays = (Date.now() - (record.lastChecked || record.addedAt)) / (1000 * 60 * 60 * 24);
  if (ageInDays > 365) {
    score *= 0.8;
  }

  // Penalize non-200 status
  if (record.status && record.status !== 200) {
    score *= 0.5;
  }

  return score;
}

/**
 * Advanced search with operators
 * Uses inverted index for term lookup, then applies filters and scoring
 */
export async function search(store, query, options = {}) {
  const { limit = 20, offset = 0, minScore = 0 } = options;

  // Parse query for operators
  const filters = parseQuery(query);

  // If no search terms at all (and no filters), return empty
  const hasSearchTerms = filters.includeTerms.length > 0 || filters.exactPhrases.length > 0;
  const hasFilters = filters.site || filters.filetype;

  if (!hasSearchTerms && !hasFilters) {
    return {
      query,
      filters,
      results: [],
      total: 0,
      offset,
      limit
    };
  }

  // Check if all search terms are too short (single characters)
  // The inverted index filters out single-character words to reduce index size
  if (hasSearchTerms && !hasFilters) {
    const allTermsTooShort = filters.includeTerms.every(term => term.length < 2) &&
                             filters.exactPhrases.every(phrase => phrase.split(/\s+/).every(word => word.length < 2));

    if (allTermsTooShort) {
      return {
        query,
        filters,
        results: [],
        total: 0,
        offset,
        limit,
        message: 'Search terms must be at least 2 characters long'
      };
    }
  }

  let candidateIds;

  if (hasSearchTerms) {
    // Use inverted index to get candidate IDs from search terms
    // Combine all terms (include terms + words from exact phrases)
    const allTerms = [...filters.includeTerms];

    // Extract individual words from exact phrases for index lookup
    for (const phrase of filters.exactPhrases) {
      const words = phrase.toLowerCase().split(/\s+/).filter(w => w.length > 0);
      allTerms.push(...words);
    }

    // Get candidate IDs from index (intersection of all terms)
    candidateIds = store.index.search(allTerms);

    if (candidateIds.size === 0) {
      return {
        query,
        filters,
        results: [],
        total: 0,
        offset,
        limit
      };
    }
  } else {
    // Filter-only query (e.g., site:github.com with no search terms)
    // Must scan all records, but this is a rare case
    // Get all IDs from the store
    candidateIds = new Set(store.idToDomain.keys());
  }

  // Load candidate records from disk
  const candidateRecords = await store.getByIds(Array.from(candidateIds));

  const scored = [];

  // Apply filters and scoring to candidates only
  for (const record of candidateRecords) {
    // Check if record passes filters
    if (!matchesFilters(record, filters)) {
      continue;
    }

    // Score the record
    const score = scoreRecord(record, filters);

    if (score > minScore) {
      scored.push({
        ...record,
        score
      });
    }
  }

  // Sort by score (highest first)
  scored.sort((a, b) => b.score - a.score);

  // Paginate
  const results = scored.slice(offset, offset + limit);

  return {
    query,
    filters,
    results,
    total: scored.length,
    offset,
    limit
  };
}

/**
 * Get statistics about the search index
 */
export function getSearchStats(store) {
  const total = store.domains.size;

  // Get index statistics
  const indexStats = store.index.stats();

  return {
    totalRecords: total,
    indexWords: indexStats.words,
    indexMappings: indexStats.mappings,
    avgIdsPerWord: indexStats.avgIdsPerWord
  };
}

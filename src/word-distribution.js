import fs from 'node:fs';
import path from 'node:path';

/**
 * Word Distribution Manager
 *
 * Manages word distribution data for intelligent distributed search routing.
 * Each node shares its top-N words (by domain count) with other nodes, enabling
 * smart query routing to peers most likely to have relevant results.
 */

const PERSISTENCE_FILE = 'data/word-distribution.json';
const PEER_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Common stopwords that provide no routing value (appear in most indexes)
const STOPWORDS = new Set([
  // Common English words
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'can', 'from', 'by', 'about', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'now', 'also', 'get', 'make', 'go',
  'know', 'take', 'see', 'come', 'think', 'look', 'want', 'give',
  'use', 'find', 'tell', 'ask', 'work', 'seem', 'feel', 'try', 'leave',
  'call', 'good', 'new', 'first', 'last', 'long', 'great', 'little',
  'own', 'old', 'right', 'big', 'high', 'different', 'small', 'large',
  'next', 'early', 'young', 'important', 'few', 'public', 'bad', 'same',
  'able', 'our', 'your', 'my', 'their', 'its', 'his', 'her', 'us', 'them',
  'this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'we', 'you',

  // Protocols and URL parts
  'http', 'https', 'ftp', 'ftps', 'www', 'ww2', 'ww3',

  // Common TLDs and country codes
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'co', 'uk', 'us',
  'ca', 'au', 'de', 'fr', 'it', 'es', 'nl', 'be', 'ch', 'at', 'se',
  'no', 'dk', 'fi', 'ie', 'pt', 'gr', 'pl', 'cz', 'hu', 'ro', 'bg',
  'hr', 'si', 'sk', 'lt', 'lv', 'ee', 'ru', 'ua', 'by', 'md', 'rs',
  'ba', 'me', 'mk', 'al', 'tr', 'il', 'sa', 'ae', 'kw', 'qa', 'om',
  'bh', 'jo', 'lb', 'sy', 'iq', 'ir', 'af', 'pk', 'in', 'bd', 'lk',
  'np', 'bt', 'mv', 'cn', 'jp', 'kr', 'kp', 'tw', 'hk', 'mo', 'mn',
  'th', 'vn', 'la', 'kh', 'mm', 'my', 'sg', 'bn', 'ph', 'id', 'tl',
  'pg', 'sb', 'vu', 'fj', 'nc', 'nz', 'br', 'mx', 'ar', 'cl', 'co',
  've', 'pe', 'ec', 'bo', 'py', 'uy', 'gf', 'sr', 'gy', 'fk', 'gl',
  'za', 'ke', 'tz', 'ug', 'rw', 'bi', 'et', 'so', 'dj', 'er', 'sd',
  'ss', 'eg', 'ly', 'tn', 'dz', 'ma', 'mr', 'ml', 'ne', 'td', 'ng',
  'bj', 'tg', 'gh', 'ci', 'bf', 'sn', 'gm', 'gw', 'sl', 'lr', 'io',
  'dev', 'app', 'ai', 'tech', 'online', 'site', 'website', 'web',

  // Generic URL/web terminology
  'page', 'pages', 'home', 'index', 'main', 'default', 'welcome',
  'about', 'contact', 'privacy', 'terms', 'login', 'register', 'signup',
  'blog', 'news', 'article', 'post', 'posts', 'category', 'categories',
  'tag', 'tags', 'archive', 'archives', 'search', 'results', 'page',
  'read', 'view', 'more', 'latest', 'recent', 'popular', 'trending',
  'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'ja', 'zh', 'ko',
  'ar', 'hi', 'bn', 'pa', 'te', 'mr', 'ta', 'ur', 'gu', 'kn', 'or',
  'ml', 'si', 'ne', 'my', 'km', 'lo', 'th', 'vi', 'id', 'ms', 'tl',
  'brought', 'experts', 'powered', 'built', 'designed', 'created',
  'copyright', 'reserved', 'rights', 'trademarks', 'policy', 'cookies'
]);

export class WordDistribution {
  constructor(topWordsCount = 20) {
    this.topWordsCount = topWordsCount;

    // Local top words: Map<word, domainCount>
    this.localTopWords = new Map();

    // Peer word distributions: Map<peerId, Map<word, domainCount>>
    this.peerDistributions = new Map();

    // Peer last update timestamps: Map<peerId, timestamp>
    this.peerUpdates = new Map();
  }

  /**
   * Extract top-N words from inverted index
   * Filters out stopwords and returns words with highest domain counts
   */
  extractTopWords(invertedIndex, limit = this.topWordsCount) {
    // Get all words with their domain counts
    const wordCounts = [];

    for (const [word, domains] of invertedIndex.index.entries()) {
      // Skip stopwords - they provide no routing value
      if (STOPWORDS.has(word.toLowerCase())) {
        continue;
      }

      // Skip very short words (should already be filtered in index, but double-check)
      if (word.length < 2) {
        continue;
      }

      wordCounts.push({
        word: word,
        count: domains.size
      });
    }

    // Sort by count (descending) and take top N
    wordCounts.sort((a, b) => b.count - a.count);

    return wordCounts.slice(0, limit);
  }

  /**
   * Update local top words from inverted index
   * Returns true if there were significant changes (>10% change in words)
   */
  updateLocalTopWords(invertedIndex) {
    const newTopWords = this.extractTopWords(invertedIndex);

    // Calculate change percentage
    let changes = 0;
    const oldWords = new Set(this.localTopWords.keys());
    const newWords = new Set(newTopWords.map(w => w.word));

    // Count words added or removed
    for (const word of oldWords) {
      if (!newWords.has(word)) changes++;
    }
    for (const word of newWords) {
      if (!oldWords.has(word)) changes++;
    }

    const changePercent = oldWords.size > 0 ? (changes / oldWords.size) : 1.0;

    // Update local top words
    this.localTopWords.clear();
    for (const {word, count} of newTopWords) {
      this.localTopWords.set(word, count);
    }

    // Return true if significant change (>10%)
    return changePercent > 0.1;
  }

  /**
   * Get local top words for sharing with peers
   * Returns array of {word, count} objects
   */
  getLocalTopWords() {
    return Array.from(this.localTopWords.entries()).map(([word, count]) => ({
      word,
      count
    }));
  }

  /**
   * Update peer's word distribution from announcement
   */
  updatePeerDistribution(peerId, topWords) {
    if (!Array.isArray(topWords) || topWords.length === 0) {
      return;
    }

    // Convert to Map for faster lookup
    const distribution = new Map();
    for (const {word, count} of topWords) {
      if (typeof word === 'string' && typeof count === 'number') {
        distribution.set(word.toLowerCase(), count);
      }
    }

    this.peerDistributions.set(peerId, distribution);
    this.peerUpdates.set(peerId, Date.now());
  }

  /**
   * Remove peer's word distribution (when peer goes offline permanently)
   */
  removePeerDistribution(peerId) {
    this.peerDistributions.delete(peerId);
    this.peerUpdates.delete(peerId);
  }

  /**
   * Find best peers for query terms
   * Returns array of {peerId, score} sorted by relevance
   */
  findBestPeersForQuery(terms, peers) {
    // Normalize and filter terms
    const queryWords = terms
      .map(t => t.toLowerCase())
      .filter(t => t.length >= 2 && !STOPWORDS.has(t));

    if (queryWords.length === 0) {
      return []; // No valid query terms, use fallback
    }

    // Score each peer based on their word distributions
    const peerScores = new Map();

    for (const peer of peers) {
      const distribution = this.peerDistributions.get(peer.nodeId);
      if (!distribution) {
        continue; // Peer doesn't have word distribution yet
      }

      let score = 0;
      let matchedWords = 0;

      // Sum domain counts for all query words
      for (const word of queryWords) {
        const count = distribution.get(word) || 0;
        if (count > 0) {
          score += count;
          matchedWords++;
        }
      }

      // Only include peers that match at least one query word
      if (matchedWords > 0) {
        peerScores.set(peer.nodeId, {
          peer,
          score,
          matchedWords
        });
      }
    }

    // Sort by score (descending)
    const sorted = Array.from(peerScores.values())
      .sort((a, b) => {
        // First sort by matched words (more matches = better)
        if (b.matchedWords !== a.matchedWords) {
          return b.matchedWords - a.matchedWords;
        }
        // Then by total score
        return b.score - a.score;
      });

    return sorted;
  }

  /**
   * Clean up stale peer distributions (not updated in 24 hours)
   */
  cleanupStalePeers() {
    const now = Date.now();
    const stale = [];

    for (const [peerId, lastUpdate] of this.peerUpdates.entries()) {
      if (now - lastUpdate > PEER_EXPIRY_MS) {
        stale.push(peerId);
      }
    }

    for (const peerId of stale) {
      this.removePeerDistribution(peerId);
    }

    return stale.length;
  }

  /**
   * Get statistics about word distributions
   */
  getStats() {
    return {
      localTopWordsCount: this.localTopWords.size,
      knownPeerDistributions: this.peerDistributions.size,
      totalKnownWords: new Set(
        Array.from(this.peerDistributions.values())
          .flatMap(dist => Array.from(dist.keys()))
      ).size
    };
  }

  /**
   * Serialize for persistence
   */
  serialize() {
    return {
      localTopWords: Array.from(this.localTopWords.entries()),
      peerDistributions: Array.from(this.peerDistributions.entries()).map(([peerId, dist]) => ({
        peerId,
        words: Array.from(dist.entries()).map(([word, count]) => ({word, count})),
        lastUpdate: this.peerUpdates.get(peerId)
      }))
    };
  }

  /**
   * Deserialize from persistence
   */
  deserialize(data) {
    if (!data) return;

    // Restore local top words
    if (Array.isArray(data.localTopWords)) {
      this.localTopWords = new Map(data.localTopWords);
    }

    // Restore peer distributions
    if (Array.isArray(data.peerDistributions)) {
      for (const {peerId, words, lastUpdate} of data.peerDistributions) {
        const dist = new Map(words.map(({word, count}) => [word, count]));
        this.peerDistributions.set(peerId, dist);
        if (lastUpdate) {
          this.peerUpdates.set(peerId, lastUpdate);
        }
      }
    }

    // Clean up stale entries
    this.cleanupStalePeers();
  }

  /**
   * Save to disk
   */
  async save() {
    try {
      const data = this.serialize();
      const json = JSON.stringify(data, null, 2);

      const dir = path.dirname(PERSISTENCE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      await fs.promises.writeFile(PERSISTENCE_FILE, json, 'utf-8');
    } catch (err) {
      console.error('[WordDistribution] Failed to save:', err.message);
    }
  }

  /**
   * Load from disk
   */
  async load() {
    try {
      if (!fs.existsSync(PERSISTENCE_FILE)) {
        return;
      }

      const json = await fs.promises.readFile(PERSISTENCE_FILE, 'utf-8');
      const data = JSON.parse(json);
      this.deserialize(data);

      const cleaned = this.cleanupStalePeers();
      if (cleaned > 0) {
        console.log(`[WordDistribution] Cleaned up ${cleaned} stale peer distributions`);
      }
    } catch (err) {
      console.error('[WordDistribution] Failed to load:', err.message);
    }
  }
}

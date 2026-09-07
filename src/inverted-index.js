import fs from 'node:fs';
import path from 'node:path';

// Common English stop-words to discard
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren\'t',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can\'t', 'cannot', 'could', 'couldn\'t', 'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'hadn\'t', 'has', 'hasn\'t', 'have',
  'haven\'t', 'having', 'he', 'he\'d', 'he\'ll', 'he\'s', 'her', 'here', 'here\'s', 'hers', 'herself',
  'him', 'himself', 'his', 'how', 'how\'s', 'i', 'i\'d', 'i\'ll', 'i\'m', 'i\'ve', 'if', 'in', 'into',
  'is', 'isn\'t', 'it', 'it\'s', 'its', 'itself', 'let\'s', 'me', 'more', 'most', 'mustn\'t', 'my',
  'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shan\'t', 'she', 'she\'d', 'she\'ll', 'she\'s',
  'should', 'shouldn\'t', 'so', 'some', 'such', 'than', 'that', 'that\'s', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'there\'s', 'these', 'they', 'they\'d', 'they\'ll', 'they\'re',
  'they\'ve', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn\'t',
  'we', 'we\'d', 'we\'ll', 'we\'re', 'we\'ve', 'were', 'weren\'t', 'what', 'what\'s', 'when', 'when\'s',
  'where', 'where\'s', 'which', 'while', 'who', 'who\'s', 'whom', 'why', 'why\'s', 'with', 'won\'t',
  'would', 'wouldn\'t', 'you', 'you\'d', 'you\'ll', 'you\'re', 'you\'ve', 'your', 'yours', 'yourself', 'yourselves'
]);

// Protocol/web noise to strip out from URLs
const PROTOCOL_WORDS = new Set(['http', 'https', 'www', 'com', 'org', 'net', 'io', 'co', 'html', 'php']);

/**
 * Tokenize text into searchable words with strict stop-word and protocol filtering
 */
function tokenize(text) {
  if (!text) return [];

  return text
    .toLowerCase()
    .split(/[\s.,;:!?()[\]{}'"\/\\-]+/)
    .filter(word => {
      if (word.length <= 1 || word.length >= 50) return false;
      if (STOP_WORDS.has(word)) return false;
      if (PROTOCOL_WORDS.has(word)) return false;
      return true;
    });
}

export class InvertedIndex {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.indexFile = path.join(dataDirectory, 'index.json');

    // word -> Set of record IDs (from Store)
    this.index = new Map();

    // Stats tracking
    this.wordCount = 0;
    this.totalMappings = 0;

    // Save tracking
    this.dirty = false;
    this.lastSaveTime = Date.now();
    this.SAVE_INTERVAL = 60000;
  }

  /**
   * Load index from disk
   */
  async load() {
    try {
      if (!fs.existsSync(this.indexFile)) {
        return;
      }

      const data = await fs.promises.readFile(this.indexFile, 'utf8');
      const serialized = JSON.parse(data);

      this.clear();

      // Hydrate Inverted Index (word -> Set of IDs)
      if (serialized.index) {
        for (const [word, ids] of Object.entries(serialized.index)) {
          this.index.set(word, new Set(ids));
        }
      }

      this.updateStats();
      console.log(`Loaded inverted index: ${this.wordCount} words, ${this.totalMappings} mappings`);
    } catch (err) {
      console.error('Error loading index:', err.message);
    }
  }

  /**
   * Save index to disk
   */
  async save(force = false) {
    if (!this.dirty && !force) return;

    const timeSinceLastSave = Date.now() - this.lastSaveTime;
    if (!force && timeSinceLastSave < this.SAVE_INTERVAL) return;

    try {
      const serializedIndex = {};
      for (const [word, ids] of this.index.entries()) {
        serializedIndex[word] = Array.from(ids);
      }

      const payload = {
        index: serializedIndex
      };

      const tempFile = `${this.indexFile}.tmp`;
      await fs.promises.writeFile(tempFile, JSON.stringify(payload), 'utf8');
      await fs.promises.rename(tempFile, this.indexFile);

      this.dirty = false;
      this.lastSaveTime = Date.now();
    } catch (err) {
      console.error('Error saving index:', err.message);
    }
  }

  /**
   * Add a record to the index using Store ID
   */
  add(id, title, description, url) {
    const words = new Set([
      ...tokenize(title),
      ...tokenize(description),
      ...tokenize(url)
    ]);

    for (const word of words) {
      if (!this.index.has(word)) {
        this.index.set(word, new Set());
      }
      this.index.get(word).add(id);
    }

    this.dirty = true;
    this.updateStats();
  }

  /**
   * Remove a record from the index by ID
   */
  remove(id) {
    // Clean up from word mapping
    for (const [word, ids] of this.index.entries()) {
      ids.delete(id);
      if (ids.size === 0) {
        this.index.delete(word);
      }
    }

    this.dirty = true;
    this.updateStats();
  }

  /**
   * Update index for a changed record
   */
  update(id, newTitle, newDescription, newUrl) {
    this.remove(id);
    this.add(id, newTitle, newDescription, newUrl);
  }

  /**
   * Search for IDs matching all terms (AND search)
   */
  search(terms) {
    if (!terms || terms.length === 0) return new Set();

    // Clean query terms using tokenizer rules
    const cleanTerms = terms.flatMap(tokenize);
    if (cleanTerms.length === 0) return new Set();

    const firstTerm = cleanTerms[0];
    let matchingIds = this.index.get(firstTerm);

    if (!matchingIds || matchingIds.size === 0) {
      return new Set();
    }

    matchingIds = new Set(matchingIds);

    for (let i = 1; i < cleanTerms.length; i++) {
      const term = cleanTerms[i];
      const ids = this.index.get(term);

      if (!ids || ids.size === 0) {
        return new Set();
      }

      for (const id of matchingIds) {
        if (!ids.has(id)) {
          matchingIds.delete(id);
        }
      }

      if (matchingIds.size === 0) {
        return new Set();
      }
    }

    return matchingIds;
  }

  /**
   * Search for IDs matching any term (OR search)
   */
  searchOr(terms) {
    const cleanTerms = terms.flatMap(tokenize);
    const matchingIds = new Set();

    for (const term of cleanTerms) {
      const ids = this.index.get(term);
      if (ids) {
        for (const id of ids) {
          matchingIds.add(id);
        }
      }
    }

    return matchingIds;
  }

  /**
   * Get IDs containing a specific word
   */
  getIds(word) {
    const tokens = tokenize(word);
    if (tokens.length === 0) return new Set();

    return this.index.get(tokens[0]) || new Set();
  }

  updateStats() {
    this.wordCount = this.index.size;
    this.totalMappings = 0;

    for (const ids of this.index.values()) {
      this.totalMappings += ids.size;
    }
  }

  stats() {
    return {
      words: this.wordCount,
      mappings: this.totalMappings,
      avgIdsPerWord: this.wordCount > 0
        ? (this.totalMappings / this.wordCount).toFixed(1)
        : 0
    };
  }

  clear() {
    this.index.clear();
    this.wordCount = 0;
    this.totalMappings = 0;
  }
}
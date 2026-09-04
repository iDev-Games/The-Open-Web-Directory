import fs from 'node:fs';
import path from 'node:path';

/**
 * Inverted Index
 * Maps words to URLs that contain them
 * Enables fast search without loading all records into memory
 */

/**
 * Tokenize text into searchable words
 */
function tokenize(text) {
  if (!text) return [];

  return text
    .toLowerCase()
    .split(/[\s.,;:!?()[\]{}'"\/\\-]+/)
    .filter(word => word.length > 1) // Skip single chars
    .filter(word => word.length < 50); // Skip huge words (likely garbage)
}

export class InvertedIndex {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.indexFile = path.join(dataDirectory, 'index.json');

    // word -> Set of URLs
    this.index = new Map();

    // Track index size for memory management
    this.wordCount = 0;
    this.totalMappings = 0;

    // Track changes for batched saves
    this.dirty = false;
    this.lastSaveTime = Date.now();
    this.SAVE_INTERVAL = 60000; // Save every minute if dirty
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

      // Convert arrays back to Sets
      for (const [word, urls] of Object.entries(serialized)) {
        this.index.set(word, new Set(urls));
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
    // Skip if not dirty and not forced
    if (!this.dirty && !force) {
      return;
    }

    // Skip if saved recently (unless forced)
    const timeSinceLastSave = Date.now() - this.lastSaveTime;
    if (!force && timeSinceLastSave < this.SAVE_INTERVAL) {
      return;
    }

    try {
      // Convert Sets to arrays for JSON serialization
      const serialized = {};
      for (const [word, urls] of this.index.entries()) {
        serialized[word] = Array.from(urls);
      }

      const tempFile = `${this.indexFile}.tmp`;

      await fs.promises.writeFile(
        tempFile,
        JSON.stringify(serialized),
        'utf8'
      );

      await fs.promises.rename(tempFile, this.indexFile);

      this.dirty = false;
      this.lastSaveTime = Date.now();
    } catch (err) {
      console.error('Error saving index:', err.message);
    }
  }

  /**
   * Add a record to the index
   */
  add(url, title, description) {
    const words = new Set([
      ...tokenize(title),
      ...tokenize(description),
      ...tokenize(url)
    ]);

    for (const word of words) {
      if (!this.index.has(word)) {
        this.index.set(word, new Set());
      }
      this.index.get(word).add(url);
    }

    this.dirty = true;
    this.updateStats();
  }

  /**
   * Remove a URL from the index
   */
  remove(url) {
    for (const [word, urls] of this.index.entries()) {
      urls.delete(url);

      // Clean up empty word entries
      if (urls.size === 0) {
        this.index.delete(word);
      }
    }

    this.dirty = true;
    this.updateStats();
  }

  /**
   * Update index for a changed record
   */
  update(url, newTitle, newDescription) {
    // Simple approach: remove and re-add
    this.remove(url);
    this.add(url, newTitle, newDescription);
  }

  /**
   * Search for URLs matching all terms
   */
  search(terms) {
    if (!terms || terms.length === 0) {
      return new Set();
    }

    // Get URLs for first term
    const firstTerm = terms[0].toLowerCase();
    let results = this.index.get(firstTerm);

    if (!results || results.size === 0) {
      return new Set();
    }

    // Make a copy so we don't modify the index
    results = new Set(results);

    // Intersect with URLs for remaining terms
    for (let i = 1; i < terms.length; i++) {
      const term = terms[i].toLowerCase();
      const urls = this.index.get(term);

      if (!urls || urls.size === 0) {
        return new Set(); // No results if any term has no matches
      }

      // Keep only URLs that appear in both sets
      for (const url of results) {
        if (!urls.has(url)) {
          results.delete(url);
        }
      }

      // Early exit if no results left
      if (results.size === 0) {
        return new Set();
      }
    }

    return results;
  }

  /**
   * Search for URLs matching any term (OR search)
   */
  searchOr(terms) {
    const results = new Set();

    for (const term of terms) {
      const urls = this.index.get(term.toLowerCase());
      if (urls) {
        for (const url of urls) {
          results.add(url);
        }
      }
    }

    return results;
  }

  /**
   * Get URLs containing a specific word
   */
  getUrls(word) {
    return this.index.get(word.toLowerCase()) || new Set();
  }

  /**
   * Update stats
   */
  updateStats() {
    this.wordCount = this.index.size;
    this.totalMappings = 0;

    for (const urls of this.index.values()) {
      this.totalMappings += urls.size;
    }
  }

  /**
   * Get index statistics
   */
  stats() {
    return {
      words: this.wordCount,
      mappings: this.totalMappings,
      avgUrlsPerWord: this.wordCount > 0
        ? (this.totalMappings / this.wordCount).toFixed(1)
        : 0
    };
  }

  /**
   * Clear the index
   */
  clear() {
    this.index.clear();
    this.wordCount = 0;
    this.totalMappings = 0;
  }
}

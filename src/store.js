import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { InvertedIndex } from './inverted-index.js';
import { LRUCache } from './lru-cache.js';

const RECORD_SEPARATOR = '\n';
const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB

export class Store {
  constructor(dataDirectory, storageLimitBytes, options = {}) {
    this.dataDirectory = dataDirectory;
    this.storageLimitBytes = storageLimitBytes;

    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

    this.recordsDirectory = path.join(dataDirectory, 'records');
    this.metadataFile = path.join(dataDirectory, 'metadata.json');

    // Inverted index for fast searching
    this.index = new InvertedIndex(dataDirectory);

    // LRU cache for hot records (keeps ~1000 recent records in RAM)
    this.recordCache = new LRUCache(1000);

    // Just track which URLs exist (for deduplication)
    this.urls = new Set();

    // URL -> chunk filename (for disk lookups)
    this.recordLocations = new Map();

    this.currentChunk = null;
    this.currentChunkBytes = 0;

    this.bytesUsed = 0;
    this.loaded = false;
  }

  async init() {
    await fs.promises.mkdir(this.recordsDirectory, {
      recursive: true,
    });

    await this.loadMetadata();
    await this.index.load();
    await this.loadChunks();

    this.loaded = true;
  }

  async loadMetadata() {
    try {
      const text = await fs.promises.readFile(
        this.metadataFile,
        'utf8'
      );

      const metadata = JSON.parse(text);

      if (typeof metadata.bytesUsed === 'number') {
        this.bytesUsed = metadata.bytesUsed;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      await this.saveMetadata();
    }
  }

  async saveMetadata() {
    const metadata = {
      version: 1,
      bytesUsed: this.bytesUsed,
      recordCount: this.urls.size,
      updatedAt: Date.now(),
    };

    const temporaryFile = `${this.metadataFile}.tmp`;

    await fs.promises.writeFile(
      temporaryFile,
      JSON.stringify(metadata, null, 2),
      'utf8'
    );

    await fs.promises.rename(
      temporaryFile,
      this.metadataFile
    );
  }

  async loadChunks() {
    const entries = await fs.promises.readdir(
      this.recordsDirectory,
      { withFileTypes: true }
    );

    const chunks = entries
      .filter(entry =>
        entry.isFile() &&
        /^chunk-\d+\.jsonl$/.test(entry.name)
      )
      .map(entry => entry.name)
      .sort();

    if (chunks.length === 0) {
      await this.createChunk(1);
      return;
    }

    /*
     * We stream each chunk instead of reading the whole directory
     * into memory at once.
     *
     * IMPORTANT: We recalculate bytesUsed from actual files
     * rather than trusting metadata, in case of crashes.
     */
    this.bytesUsed = 0;

    for (const chunk of chunks) {
      await this.loadChunk(chunk);
    }

    const lastChunk = chunks[chunks.length - 1];

    const lastChunkPath = path.join(
      this.recordsDirectory,
      lastChunk
    );

    const stats = await fs.promises.stat(lastChunkPath);

    this.currentChunk = lastChunk;
    this.currentChunkBytes = stats.size;
  }

  async loadChunk(filename) {
    const filePath = path.join(
      this.recordsDirectory,
      filename
    );

    // Get actual file size for bytesUsed calculation
    const stats = await fs.promises.stat(filePath);
    this.bytesUsed += stats.size;

    const stream = fs.createReadStream(filePath, {
      encoding: 'utf8',
    });

    let buffer = '';

    for await (const data of stream) {
      buffer += data;

      let newlineIndex;

      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);

        buffer = buffer.slice(newlineIndex + 1);

        this.loadRecordLine(line, filename);
      }
    }

    // Handle a final line without a newline.
    if (buffer.trim()) {
      this.loadRecordLine(buffer, filename);
    }
  }

  loadRecordLine(line, filename) {
    if (!line.trim()) {
      return;
    }

    try {
      const record = JSON.parse(line);

      if (!record.url) {
        return;
      }

      /*
       * The latest record for a URL wins.
       */
      this.urls.add(record.url);
      this.recordLocations.set(record.url, filename);

      // Add to inverted index
      this.index.add(record.url, record.title, record.description);
    } catch {
      /*
       * Ignore malformed individual records.
       * A future integrity/repair system can deal with these.
       */
    }
  }

  async createChunk(number) {
    const filename =
      `chunk-${String(number).padStart(8, '0')}.jsonl`;

    const filePath = path.join(
      this.recordsDirectory,
      filename
    );

    await fs.promises.writeFile(filePath, '');

    this.currentChunk = filename;
    this.currentChunkBytes = 0;
  }

  async rotateChunk() {
    const match = this.currentChunk?.match(
      /chunk-(\d+)\.jsonl/
    );

    const currentNumber = match
      ? Number(match[1])
      : 0;

    await this.createChunk(currentNumber + 1);
  }

  get size() {
    return this.urls.size;
  }

  get storageUsed() {
    return this.bytesUsed;
  }

  get storageAvailable() {
    return Math.max(
      0,
      this.storageLimitBytes - this.bytesUsed
    );
  }

  has(url) {
    return this.urls.has(url);
  }

  /**
   * Load a specific record from disk by URL
   */
  async getByUrl(url) {
    if (!this.urls.has(url)) {
      return null;
    }

    // Check cache first
    const cached = this.recordCache.get(url);
    if (cached) {
      return cached;
    }

    const chunkFilename = this.recordLocations.get(url);
    if (!chunkFilename) {
      return null;
    }

    const filePath = path.join(this.recordsDirectory, chunkFilename);

    // Read the chunk and find the record
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buffer = '';
    let foundRecord = null;

    for await (const data of stream) {
      buffer += data;

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.trim()) continue;

        try {
          const record = JSON.parse(line);
          if (record.url === url) {
            foundRecord = record;
            break;
          }
        } catch {
          // Skip malformed records
        }
      }

      if (foundRecord) break;
    }

    stream.destroy();

    // Add to cache before returning
    if (foundRecord) {
      this.recordCache.set(url, foundRecord);
    }

    return foundRecord;
  }

  /**
   * Load multiple records by URLs from disk
   */
  async getByUrls(urls) {
    const records = [];
    const urlsToLoad = [];

    // Check cache first for each URL
    for (const url of urls) {
      const cached = this.recordCache.get(url);
      if (cached) {
        records.push(cached);
      } else {
        urlsToLoad.push(url);
      }
    }

    // If all URLs were cached, return early
    if (urlsToLoad.length === 0) {
      return records;
    }

    // Group URLs by chunk for efficient loading
    const urlsByChunk = new Map();

    for (const url of urlsToLoad) {
      const chunkFilename = this.recordLocations.get(url);
      if (chunkFilename) {
        if (!urlsByChunk.has(chunkFilename)) {
          urlsByChunk.set(chunkFilename, new Set());
        }
        urlsByChunk.get(chunkFilename).add(url);
      }
    }

    // Load records from each chunk
    for (const [chunkFilename, urlsInChunk] of urlsByChunk.entries()) {
      const filePath = path.join(this.recordsDirectory, chunkFilename);
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

      let buffer = '';
      const remainingUrls = new Set(urlsInChunk);

      for await (const data of stream) {
        buffer += data;

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (!line.trim()) continue;

          try {
            const record = JSON.parse(line);
            if (remainingUrls.has(record.url)) {
              records.push(record);
              remainingUrls.delete(record.url);

              // Add to cache
              this.recordCache.set(record.url, record);

              // Early exit if we found all records in this chunk
              if (remainingUrls.size === 0) {
                break;
              }
            }
          } catch {
            // Skip malformed records
          }
        }

        if (remainingUrls.size === 0) {
          break;
        }
      }

      stream.destroy();
    }

    return records;
  }

  async add(record) {
    if (!record?.url) {
      throw new Error('Record must contain a URL');
    }

    if (this.urls.has(record.url)) {
      return {
        added: false,
        updated: false,
        record: null,
      };
    }

    const now = Date.now();

    const storedRecord = {
      url: record.url,
      title: record.title || '',
      description: record.description || '',
      status: record.status ?? 200,
      addedAt: now,
      lastChecked: now,
    };

    return this.appendRecord(storedRecord, true);
  }

  async update(url, changes) {
    if (!this.urls.has(url)) {
      return null;
    }

    // Load existing record from disk
    const existing = await this.getByUrl(url);

    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      ...changes,
      url: existing.url,
      updatedAt: Date.now(),
    };

    const result = await this.appendRecord(
      updated,
      false
    );

    return result.record;
  }

  async appendRecord(record, isNew) {
    const line =
      JSON.stringify(record) + RECORD_SEPARATOR;

    const bytes = Buffer.byteLength(line, 'utf8');

    if (this.bytesUsed + bytes > this.storageLimitBytes) {
      return {
        added: false,
        updated: false,
        full: true,
        record: null,
      };
    }

    if (
      this.currentChunkBytes > 0 &&
      this.currentChunkBytes + bytes > this.chunkSize
    ) {
      await this.rotateChunk();
    }

    const filePath = path.join(
      this.recordsDirectory,
      this.currentChunk
    );

    await fs.promises.appendFile(
      filePath,
      line,
      'utf8'
    );

    // Update index and URL tracking
    if (isNew) {
      this.urls.add(record.url);
      this.index.add(record.url, record.title, record.description);
    } else {
      // Update existing entry in index
      this.index.update(record.url, record.title, record.description);
    }

    this.recordLocations.set(
      record.url,
      this.currentChunk
    );

    this.currentChunkBytes += bytes;
    this.bytesUsed += bytes;

    return {
      added: isNew,
      updated: !isNew,
      full: false,
      record,
    };
  }

  async flush() {
    await this.saveMetadata();
    // Periodic save (batched)
    await this.index.save();
  }

  async shutdown() {
    await this.saveMetadata();
    // Force save on shutdown
    await this.index.save(true);
  }
}
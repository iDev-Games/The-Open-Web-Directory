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

    // Track which domains exist (for deduplication)
    this.domains = new Set();

    // ID assignment (starts at 1, determined from last record on load)
    this.nextId = 1;

    // Bidirectional mappings for ID<->domain lookup
    this.domainToId = new Map();  // domain -> id
    this.idToDomain = new Map();  // id -> domain

    // ID -> chunk filename (for disk lookups)
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
      domainCount: this.domains.size,
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

      if (!record.domain) {
        return;
      }

      // Assign ID if record doesn't have one (migration from old format)
      if (!record.id) {
        record.id = this.nextId++;
      } else {
        // Update nextId to be one past the highest seen ID
        if (record.id >= this.nextId) {
          this.nextId = record.id + 1;
        }
      }

      /*
       * The latest record for a domain wins.
       */
      this.domains.add(record.domain);
      this.domainToId.set(record.domain, record.id);
      this.idToDomain.set(record.id, record.domain);
      this.recordLocations.set(record.id, filename);

      // Add to inverted index using ID instead of domain
      this.index.add(record.id, record.title, record.description, record.url);
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
    return this.domains.size;
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

  has(domain) {
    return this.domains.has(domain);
  }

  /**
   * Load a specific record from disk by domain
   */
  async getByDomain(domain) {
    if (!this.domains.has(domain)) {
      return null;
    }

    // Check cache first
    const cached = this.recordCache.get(domain);
    if (cached) {
      return cached;
    }

    // Get ID for domain
    const id = this.domainToId.get(domain);
    if (!id) {
      return null;
    }

    return this.getById(id);
  }

  /**
   * Load a specific record from disk by ID
   */
  async getById(id) {
    const chunkFilename = this.recordLocations.get(id);
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
          if (record.id === id) {
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
      this.recordCache.set(domain, foundRecord);
    }

    return foundRecord;
  }

  /**
   * Load multiple records by domains from disk
   */
  /**
   * Load records by IDs (used by search)
   */
  async getByIds(ids) {
    const records = [];
    const idsToLoad = new Set(ids);

    // Group IDs by chunk for efficient loading
    const idsByChunk = new Map();

    for (const id of idsToLoad) {
      const chunkFilename = this.recordLocations.get(id);
      if (chunkFilename) {
        if (!idsByChunk.has(chunkFilename)) {
          idsByChunk.set(chunkFilename, new Set());
        }
        idsByChunk.get(chunkFilename).add(id);
      }
    }

    // Load records from each chunk
    for (const [chunkFilename, idsInChunk] of idsByChunk.entries()) {
      const filePath = path.join(this.recordsDirectory, chunkFilename);
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

      let buffer = '';
      const remainingIds = new Set(idsInChunk);

      for await (const data of stream) {
        buffer += data;

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (!line.trim()) continue;

          try {
            const record = JSON.parse(line);
            if (remainingIds.has(record.id)) {
              records.push(record);
              remainingIds.delete(record.id);

              // Add to cache by domain for future lookups
              this.recordCache.set(record.domain, record);

              // Early exit if we found all records in this chunk
              if (remainingIds.size === 0) {
                break;
              }
            }
          } catch {
            // Skip malformed records
          }
        }

        if (remainingIds.size === 0) {
          break;
        }
      }

      stream.destroy();
    }

    return records;
  }

  /**
   * Load records by domains (backward compatibility)
   */
  async getByDomains(domains) {
    // Convert domains to IDs
    const ids = [];
    for (const domain of domains) {
      const id = this.domainToId.get(domain);
      if (id !== undefined) {
        ids.push(id);
      }
    }

    return this.getByIds(ids);
  }

  async add(record) {
    if (!record?.domain) {
      throw new Error('Record must contain a domain');
    }

    if (this.domains.has(record.domain)) {
      return {
        added: false,
        updated: false,
        record: null,
      };
    }

    const now = Date.now();
    const id = this.nextId++;

    const storedRecord = {
      id,
      domain: record.domain,
      url: record.url || '',
      title: record.title || '',
      description: record.description || '',
      sitemap: record.sitemap || null,
      status: record.status ?? 200,
      addedAt: now,
      lastChecked: now,
    };

    return this.appendRecord(storedRecord, true);
  }

  async update(domain, changes) {
    if (!this.domains.has(domain)) {
      return null;
    }

    // Load existing record from disk
    const existing = await this.getByDomain(domain);

    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      ...changes,
      id: existing.id,  // Preserve ID
      domain: existing.domain,  // Preserve domain
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

    // Update index and tracking
    if (isNew) {
      this.domains.add(record.domain);
      this.domainToId.set(record.domain, record.id);
      this.idToDomain.set(record.id, record.domain);
      this.index.add(record.id, record.title, record.description, record.url);
    } else {
      // Update existing entry in index
      this.index.update(record.id, record.title, record.description, record.url);
    }

    this.recordLocations.set(
      record.id,
      this.currentChunk
    );

    // Also cache by domain for lookups
    this.recordCache.set(record.domain, record);

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
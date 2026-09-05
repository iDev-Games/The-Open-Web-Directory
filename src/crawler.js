import http from 'node:http';
import https from 'node:https';

import { parsePage } from './parser.js';
import { Robots } from './robots.js';
import { prepareUrl } from './url.js';

export class Crawler {
  constructor(options = {}) {
    this.queue = options.queue;
    this.store = options.store;
    this.seedUrls = options.seedUrls || []; // Store seed URLs for queue refill

    this.userAgent =
      options.userAgent || 'OpenWebDirectory/0.1';

    this.maxConcurrentRequests =
      options.maxConcurrentRequests || 2;

    this.maxResponseBytes =
      options.maxResponseBytes || 2 * 1024 * 1024;

    this.requestTimeoutMs =
      options.requestTimeoutMs || 15000;

    this.errorBackoffMs =
      options.errorBackoffMs || 30000;

    this.robots = options.robots || new Robots({
      userAgent: this.userAgent,
      timeoutMs: this.requestTimeoutMs,
    });

    this.running = false;
    this.activeRequests = 0;
    this.lastQueueRefill = 0; // Track last time we refilled the queue

    this.domainState = new Map();

    this.stats = {
        attempted: 0,
        successful: 0,
        failed: 0,
        blocked: 0,
        discovered: 0,

        status: {},
        errors: {},
    };
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;

    while (this.running) {
      const started = await this.processAvailable();

      if (!started) {
        // Check if queue is empty and refill for maintenance crawling
        if (this.queue.size === 0) {
          const now = Date.now();
          // Only refill every 60 seconds to avoid spam, and only if we've waited since startup
          if (this.lastQueueRefill > 0 && now - this.lastQueueRefill > 60000) {
            console.log('Queue empty, entering maintenance mode...');
            let added = 0;

            // First, try to add seed URLs (always good to recrawl these)
            if (this.seedUrls.length > 0) {
              for (const seedUrl of this.seedUrls) {
                if (this.queue.add(seedUrl)) {
                  added++;
                }
              }
            }

            // If we still need more URLs, sample random domains from the existing index
            // This maintains the index by re-crawling old homepages
            if (added < 10 && this.store.domains.size > 0) {
              const domainArray = Array.from(this.store.domains);
              // Sample 50 random domains to try adding
              const sampleSize = Math.min(50, domainArray.length);
              for (let i = 0; i < sampleSize && added < 10; i++) {
                const randomIndex = Math.floor(Math.random() * domainArray.length);
                const randomDomain = domainArray[randomIndex];
                const homepageUrl = this.getHomepageUrl(randomDomain);
                if (this.queue.add(homepageUrl)) {
                  added++;
                }
              }
            }

            if (added > 0) {
              console.log(`Maintenance mode: added ${added} URLs for recrawling`);
            }
            this.lastQueueRefill = now;
          } else if (this.lastQueueRefill === 0) {
            // Set initial timestamp to prevent immediate refill on startup
            this.lastQueueRefill = now;
          }
        }
        await this.sleep(250);
      }
    }
  }

  stop() {
    this.running = false;
  }

  async processAvailable() {
    if (
      this.activeRequests >=
      this.maxConcurrentRequests
    ) {
      return false;
    }

    const url = this.getNextAvailableUrl();

    if (!url) {
      return false;
    }

    this.activeRequests++;

    this.processUrl(url)
      .catch(() => {
        // processUrl handles individual errors.
      })
      .finally(() => {
        this.activeRequests--;
      });

    return true;
  }

  getNextAvailableUrl() {
    const checked = [];

    while (!this.queue.isEmpty) {
      const url = this.queue.next();

      if (!url) {
        break;
      }

      // Allow recrawling of existing URLs (for maintenance)
      // Just skip domain delay check - the URL will be processed
      const domain = this.getDomain(url);

      const state = this.domainState.get(domain);

      if (
        state &&
        state.nextAllowedAt > Date.now()
      ) {
        checked.push(url);
        this.queue.complete(url);
        continue;
      }

      for (const deferredUrl of checked) {
        this.queue.add(deferredUrl);
      }

      return url;
    }

    for (const deferredUrl of checked) {
      this.queue.add(deferredUrl);
    }

    return null;
  }

  async processUrl(url) {
    this.stats.attempted++;

    try {
      // Extract domain from URL
      const domain = this.extractDomain(url);
      if (!domain) {
        this.stats.failed++;
        return;
      }

      // Only crawl homepages (domain-only directory)
      if (!this.isHomepage(url)) {
        console.log(`Skipping non-homepage: ${url}`);
        this.stats.blocked++;
        return;
      }

      const permission =
        await this.robots.allowed(url);

      if (!permission.allowed) {
        this.stats.blocked++;
        return;
      }

      this.setDomainDelay(
        url,
        permission.crawlDelayMs
      );

      const response =
        await this.fetch(url);

        this.recordStatus(response.statusCode);

      /*
       * Only index successful responses (200-399)
       * Failed responses (404, 403, etc.) are not stored
       */
      if (
        response.statusCode < 200 ||
        response.statusCode >= 400
      ) {
        this.stats.failed++;
        return;
      }

      const contentType =
        response.headers['content-type'] || '';

      if (
        !contentType.toLowerCase().includes('text/html')
      ) {
        this.stats.failed++;
        return;
      }

      const page =
        parsePage(response.body, url);

      // Only index pages with proper metadata (quality requirement)
      // This ensures sites have made an effort to provide good SEO metadata

      // Title must exist and not be generic placeholder
      const hasValidTitle = page.title &&
        page.title.length > 0 &&
        page.title.toLowerCase() !== 'untitled' &&
        !page.title.match(/^untitled\s*-?\s*\d*$/i);

      // Description MUST come from <meta name="description"> tag
      // Not from extracted paragraph text (shows intent/effort)
      const hasValidDescription = page.hasMetaDescription &&
        page.description &&
        page.description.length >= 30;

      if (hasValidTitle && hasValidDescription) {
        // Detect sitemap (best effort, don't block)
        const sitemap = await this.detectSitemap(domain);

        // Check if domain already exists - if so, update it; otherwise add new
        if (this.store.has(domain)) {
          await this.store.update(domain, {
            title: page.title,
            description: page.description,
            sitemap: sitemap,
            status: response.statusCode,
            lastChecked: Date.now(),
          });
        } else {
          await this.store.add({
            domain: domain,
            url: page.url,  // Store the homepage URL
            title: page.title,
            description: page.description,
            sitemap: sitemap,
            status: response.statusCode,
            lastChecked: Date.now(),
          });
        }
        this.stats.successful++;
      } else {
        // Page lacks proper metadata, skip indexing but still discover links
        this.stats.blocked++;

        // Log why it was blocked (helpful for submitted URLs)
        const reasons = [];
        if (!hasValidTitle) reasons.push('invalid/missing title');
        if (!hasValidDescription) reasons.push('missing meta description');
        console.log(`Blocked: ${url} (${reasons.join(', ')})`);
      }

      const discovered =
        this.addDiscoveredLinks(page.links);

      this.stats.discovered += discovered;
    } catch (error) {
        this.stats.failed++;

        this.recordError(error);

        this.setDomainDelay(
            url,
            this.errorBackoffMs
        );
    } finally {
      this.queue.complete(url);
    }
  }

    async storeStatus(url, statusCode) {
        const existing = this.store.getByUrl(url);

        if (existing) {
            await this.store.update(url, {
            status: statusCode,
            lastChecked: Date.now(),
            });

            return;
        }

        await this.store.add({
            url,
            title: '',
            description: '',
            status: statusCode,
        });
    }

    addDiscoveredLinks(links) {
    // Extract unique domains from discovered links
    const discoveredDomains = new Set();

    for (const link of links) {
        const url = prepareUrl(link);
        if (!url) continue;

        const domain = this.extractDomain(url);
        if (!domain) continue;

        // Skip if domain already indexed
        if (this.store.has(domain)) continue;

        discoveredDomains.add(domain);
    }

    // Add homepage URLs for discovered domains to queue
    let added = 0;
    for (const domain of discoveredDomains) {
        const homepageUrl = this.getHomepageUrl(domain);
        const url = prepareUrl(homepageUrl);

        if (!url) continue;

        if (this.queue.add(url)) {
            added++;
        }
    }

    return added;
    }

  setDomainDelay(url, delayMs) {
    const domain = this.getDomain(url);

    this.domainState.set(domain, {
      nextAllowedAt: Date.now() + delayMs,
    });
  }

  getDomain(url) {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  /**
   * Extract domain (hostname) from URL
   * @param {string} url - Full URL
   * @returns {string|null} - Domain (hostname) or null if invalid
   * @example extractDomain('https://www.example.com/page') => 'www.example.com'
   */
  extractDomain(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Detect sitemap URL for a domain
   * @param {string} domain - Domain (hostname)
   * @returns {Promise<string|null>} - Sitemap URL or null
   */
  async detectSitemap(domain) {
    const TIMEOUT_MS = 2000; // Don't block crawling for sitemap detection

    try {
      // Try common sitemap locations
      const candidates = [
        `https://${domain}/sitemap.xml`,
        `https://${domain}/sitemap_index.xml`,
      ];

      for (const url of candidates) {
        try {
          const response = await Promise.race([
            this.fetch(url),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
            )
          ]);

          if (response.statusCode === 200) {
            const contentType = response.headers['content-type'] || '';
            if (contentType.includes('xml') || contentType.includes('text')) {
              return url;
            }
          }
        } catch {
          // Try next candidate
        }
      }
    } catch (err) {
      // Sitemap detection failed, not critical
    }

    return null;
  }

  /**
   * Get homepage URL for a domain
   * @param {string} domain - Domain (hostname)
   * @returns {string} - Homepage URL
   * @example getHomepageUrl('example.com') => 'https://example.com/'
   */
  getHomepageUrl(domain) {
    // Modern web is HTTPS-first
    return `https://${domain}/`;
  }

  /**
   * Check if URL is a homepage (root path)
   * @param {string} url - Full URL
   * @returns {boolean} - True if homepage
   */
  isHomepage(url) {
    try {
      const parsed = new URL(url);
      return parsed.pathname === '/' || parsed.pathname === '';
    } catch {
      return false;
    }
  }

    recordStatus(statusCode) {
        const key = String(statusCode);

        this.stats.status[key] =
            (this.stats.status[key] || 0) + 1;
    }

    recordError(error) {
        const message =
            error?.message || 'Unknown error';

        this.stats.errors[message] =
            (this.stats.errors[message] || 0) + 1;
    }

  fetch(url) {
    return new Promise((resolve, reject) => {
      let parsedUrl;

      try {
        parsedUrl = new URL(url);
      } catch {
        reject(new Error('Invalid URL'));
        return;
      }

      const client =
        parsedUrl.protocol === 'https:'
          ? https
          : http;

      const request = client.get(
        parsedUrl,
        {
          headers: {
            'User-Agent': this.userAgent,
            'Accept':
              'text/html,application/xhtml+xml',
          },
        },
        response => {
          const chunks = [];
          let bytes = 0;

          response.setEncoding('utf8');

          response.on('data', chunk => {
            bytes += Buffer.byteLength(chunk, 'utf8');

            if (bytes > this.maxResponseBytes) {
              request.destroy(
                new Error('Response too large')
              );

              return;
            }

            chunks.push(chunk);
          });

          response.on('end', () => {
            resolve({
              statusCode:
                response.statusCode || 0,
              headers: response.headers,
              body: chunks.join(''),
            });
          });
        }
      );

      request.setTimeout(
        this.requestTimeoutMs,
        () => {
          request.destroy(
            new Error('Request timed out')
          );
        }
      );

      request.on('error', reject);
    });
  }

  sleep(ms) {
    return new Promise(resolve =>
      setTimeout(resolve, ms)
    );
  }

  getStats() {
    return {
      ...this.stats,
      queued: this.queue.size,
      active: this.activeRequests,
    };
  }
}
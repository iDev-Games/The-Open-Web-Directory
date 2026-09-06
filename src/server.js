import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { search as basicSearch, getSearchStats as basicSearchStats } from './search.js';
import { search as advancedSearch, getSearchStats as advancedSearchStats } from './search-advanced.js';
import { getIdentity } from './identity.js';
import { distributedSearch } from './distributed-search.js';
import { getSeedsForPeer } from './seed-pool.js';

/**
 * HTTP server for the OWD node
 * Provides REST API for search, node info, peer management, etc.
 */

const STATIC_DIR = 'public';

export class Server {
  constructor(config, store, crawler, peerManager, wordDistribution = null) {
    this.config = config;
    this.store = store;
    this.crawler = crawler;
    this.peerManager = peerManager;
    this.wordDistribution = wordDistribution;
    this.server = null;
    this.startTime = Date.now();

    // Rate limiting for search endpoint
    // Track searches per IP: Map<ip, Array<timestamp>>
    this.searchRateLimit = new Map();
    this.SEARCH_RATE_WINDOW = 60000; // 1 minute window
    this.SEARCH_RATE_LIMIT = 30; // Max 30 searches per minute per IP
  }

  /**
   * Start the HTTP server
   */
  start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        console.error('Request handler error:', err);
        if (!res.headersSent) {
          this.sendJSON(res, 500, { error: 'Internal server error' });
        }
      });
    });

    const { host, port } = this.config.server;

    this.server.listen(port, host, () => {
      console.log(`HTTP server listening on ${host}:${port}`);
    });

    this.server.on('error', (err) => {
      console.error('Server error:', err.message);
    });

    // Clean up rate limit map every 5 minutes to prevent memory leak
    this.rateLimitCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, timestamps] of this.searchRateLimit.entries()) {
        const valid = timestamps.filter(t => now - t < this.SEARCH_RATE_WINDOW);
        if (valid.length === 0) {
          this.searchRateLimit.delete(ip);
        } else {
          this.searchRateLimit.set(ip, valid);
        }
      }
    }, 300000); // 5 minutes
  }

  /**
   * Stop the HTTP server
   */
  stop() {
    if (this.rateLimitCleanupTimer) {
      clearInterval(this.rateLimitCleanupTimer);
      this.rateLimitCleanupTimer = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Handle incoming HTTP request
   */
  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Add CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Route handling
    if (pathname === '/') {
      this.handleRoot(req, res);
    } else if (pathname === '/node') {
      this.handleNode(req, res);
    } else if (pathname === '/peers') {
      this.handlePeers(req, res);
    } else if (pathname === '/announce') {
      await this.handleAnnounce(req, res);
    } else if (pathname === '/submit') {
      await this.handleSubmit(req, res);
    } else if (pathname === '/search') {
      await this.handleSearch(req, res, url);
    } else if (pathname === '/network') {
      this.handleNetwork(req, res);
    } else if (pathname === '/health') {
      this.handleHealth(req, res);
    } else if (pathname.startsWith('/static/')) {
      this.handleStatic(req, res, pathname);
    } else {
      // Default to serving frontend HTML
      this.handleFrontend(req, res, pathname);
    }
  }

  /**
   * GET / - Root endpoint with node info
   */
  handleRoot(req, res) {
    const identity = getIdentity();
    const uptime = Date.now() - this.startTime;

    const info = {
      name: this.config.node.name,
      version: this.config.node.version,
      nodeId: identity.nodeId,
      uptime: Math.floor(uptime / 1000),
      message: 'The Open Web Directory Node',
      endpoints: {
        node: '/node',
        search: '/search?q=query',
        peers: '/peers',
        network: '/network',
        health: '/health'
      }
    };

    this.sendJSON(res, 200, info);
  }

  /**
   * GET /node - Detailed node information
   */
  handleNode(req, res) {
    const identity = getIdentity();
    const uptime = Date.now() - this.startTime;

    const stats = this.crawler ? {
      attempted: this.crawler.stats.attempted,
      successful: this.crawler.stats.successful,
      failed: this.crawler.stats.failed,
      blocked: this.crawler.stats.blocked,
      discovered: this.crawler.stats.discovered,
      queueSize: this.crawler.queue.size
    } : null;

    const searchStats = this.store ? basicSearchStats(this.store) : null;

    // Word distribution stats for intelligent query routing
    const wordDistStats = this.wordDistribution ? this.wordDistribution.getStats() : null;

    const nodeInfo = {
      nodeId: identity.nodeId,
      networkName: this.config.network.name,
      name: this.config.node.name,
      version: this.config.node.version,
      createdAt: identity.createdAt,
      uptime: Math.floor(uptime / 1000),
      ready: this.store ? this.store.loaded : false, // Ready when store is loaded
      sitesIndexed: this.store ? this.store.domains.size : 0,
      storageUsed: this.store ? this.store.bytesUsed : 0,
      storageLimit: this.config.storage.limitBytes,
      crawlerStatus: this.crawler ? 'running' : 'stopped',
      crawlerStats: stats,
      searchStats,
      wordDistribution: wordDistStats,
      peerCount: this.peerManager ? this.peerManager.getPeerCount() : 0
    };

    this.sendJSON(res, 200, nodeInfo);
  }

  /**
   * GET /peers - List of known peers
   * GET /peers?stable=true - Get stable/reliable peers
   * GET /peers?introduce=nodeId - Get peers for introduction
   */
  handlePeers(req, res) {
    if (!this.peerManager) {
      this.sendJSON(res, 200, { peers: [] });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const stableOnly = url.searchParams.get('stable') === 'true';
    const introduceFor = url.searchParams.get('introduce');
    const excludeNodeId = url.searchParams.get('exclude'); // Allow excluding specific nodeId

    let peers;

    if (stableOnly) {
      // Return stable peers (good seeds for new nodes)
      peers = this.peerManager.getStablePeers(20);
    } else if (introduceFor) {
      // Return peers for introduction
      peers = this.peerManager.getPeersForIntroduction(introduceFor, 10);
    } else {
      // Return all peers
      peers = this.peerManager.getPeers();
    }

    // Filter out the excluded nodeId if provided (prevent sending peer list back to themselves)
    if (excludeNodeId) {
      peers = peers.filter(p => p.nodeId !== excludeNodeId);
    }

    this.sendJSON(res, 200, {
      count: peers.length,
      peers,
      stable: stableOnly,
      introduction: !!introduceFor
    });
  }

  /**
   * POST /announce - Allow a peer to announce itself to this node
   */
  async handleAnnounce(req, res) {
    if (req.method !== 'POST') {
      this.sendJSON(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!this.peerManager) {
      this.sendJSON(res, 503, { error: 'Peer manager not available' });
      return;
    }

    try {
      // Read POST body
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        // Prevent huge payloads
        if (body.length > 10240) {
          this.sendJSON(res, 413, { error: 'Payload too large' });
          return;
        }
      }

      const peerInfo = JSON.parse(body);

      // Validate peer info
      if (!peerInfo.nodeId || !peerInfo.port) {
        this.sendJSON(res, 400, { error: 'Missing required fields: nodeId, port' });
        return;
      }

      // Get the real IP address from the connection
      // Strategy:
      // 1. If trustProxy is explicitly true, always use X-Forwarded-For
      // 2. If socket address is loopback (127.0.0.1/::1), we're behind a proxy - use X-Forwarded-For
      // 3. Otherwise use direct socket address to prevent IP spoofing
      const trustProxy = this.config.server?.trustProxy || false;
      const forwardedFor = req.headers['x-forwarded-for'];
      const socketAddr = req.socket.remoteAddress;

      // Clean up IPv6-mapped IPv4 addresses first (::ffff:192.168.1.1 -> 192.168.1.1)
      const cleanSocketAddr = socketAddr ? socketAddr.replace(/^::ffff:/, '') : '';
      const isLoopback = cleanSocketAddr === '127.0.0.1' || cleanSocketAddr === '::1' || cleanSocketAddr === 'localhost';

      let clientHost;
      if ((trustProxy || isLoopback) && forwardedFor) {
        // Behind proxy: use X-Forwarded-For (first IP in comma-separated list)
        clientHost = forwardedFor.split(',')[0].trim();
        console.log(`[Announce] Behind proxy detected. Socket: ${cleanSocketAddr}, X-Forwarded-For: ${forwardedFor}, Using: ${clientHost}`);
      } else {
        // Direct connection: use socket address
        clientHost = cleanSocketAddr;
        console.log(`[Announce] Direct connection. Using socket address: ${clientHost}`);
      }

      const host = clientHost.replace(/^::ffff:/, '');

      // Add the announcing peer with their real IP
      // Mark them as online immediately since they just announced
      const peerData = {
        nodeId: peerInfo.nodeId,
        host: host,  // Use detected IP, not what they claim
        port: peerInfo.port,
        name: peerInfo.name || 'Unknown Node',
        version: peerInfo.version || '0.1.0',
        stats: peerInfo.stats || null  // Include stats for network leaderboard
      };

      const added = this.peerManager.addPeer(peerData);

      // Mark peer as online since they just successfully announced
      const peer = this.peerManager.peers.get(peerInfo.nodeId);
      if (peer) {
        peer.online = true;
        peer.lastSeen = Date.now();
        // Update stats from announcement
        if (peerInfo.stats) {
          peer.stats = peerInfo.stats;
        }
        // Update word distribution for intelligent query routing
        if (peerInfo.topWords && this.wordDistribution) {
          this.wordDistribution.updatePeerDistribution(peerInfo.nodeId, peerInfo.topWords);
        }
      }

      // Only log new peers to reduce noise
      if (added) {
        console.log(`New peer: ${peerInfo.name} (${peerInfo.nodeId.substring(0, 16)}...)`);
      }

      // Assign seed URLs to this peer for diversity
      const assignedSeeds = getSeedsForPeer(peerInfo.nodeId);

      this.sendJSON(res, 200, {
        success: added,
        message: added ? 'Peer registered' : 'Peer already known or rejected',
        seeds: assignedSeeds  // Gateway assigns seeds for network diversity
      });
    } catch (err) {
      console.error('Error handling peer announcement:', err);
      this.sendJSON(res, 400, { error: 'Invalid request' });
    }
  }

  /**
   * POST /submit - Submit a URL for crawling
   */
  async handleSubmit(req, res) {
    if (req.method !== 'POST') {
      this.sendJSON(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!this.crawler || !this.crawler.queue) {
      this.sendJSON(res, 503, { error: 'Crawler not available' });
      return;
    }

    try {
      // Read POST body
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 10240) {
          this.sendJSON(res, 413, { error: 'Payload too large' });
          return;
        }
      }

      const data = JSON.parse(body);

      // Validate URL
      if (!data.url) {
        this.sendJSON(res, 400, { error: 'URL is required' });
        return;
      }

      // Validate URL format and extract domain
      let domain, homepageUrl;
      try {
        const parsedUrl = new URL(data.url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          this.sendJSON(res, 400, { error: 'Only HTTP and HTTPS URLs are allowed' });
          return;
        }

        // Extract domain from submitted URL
        domain = parsedUrl.hostname.toLowerCase();
        homepageUrl = `https://${domain}/`;
      } catch (err) {
        this.sendJSON(res, 400, { error: 'Invalid URL format' });
        return;
      }

      // Add homepage URL to crawl queue with priority (goes to front of queue)
      const added = this.crawler.queue.add(homepageUrl, true);

      if (!added) {
        this.sendJSON(res, 409, { error: 'Domain already in queue or already indexed' });
        return;
      }

      console.log(`Domain ${domain} submitted for crawling (priority): ${homepageUrl}`);

      this.sendJSON(res, 200, {
        success: true,
        message: `Domain ${domain} submitted for indexing`,
        domain: domain,
        url: homepageUrl
      });
    } catch (err) {
      console.error('Error handling URL submission:', err);
      this.sendJSON(res, 400, { error: 'Invalid request' });
    }
  }

  /**
   * Check rate limit for search endpoint
   */
  checkSearchRateLimit(req) {
    // Get client IP - only trust X-Forwarded-For if configured
    const trustProxy = this.config.server?.trustProxy || false;
    const forwardedFor = req.headers['x-forwarded-for'];

    let clientIp;
    if (trustProxy && forwardedFor) {
      clientIp = forwardedFor.split(',')[0].trim();
    } else {
      clientIp = req.socket.remoteAddress;
    }

    const ip = clientIp.replace(/^::ffff:/, '');

    const now = Date.now();

    // Get or create rate limit entry for this IP
    if (!this.searchRateLimit.has(ip)) {
      this.searchRateLimit.set(ip, []);
    }

    const timestamps = this.searchRateLimit.get(ip);

    // Remove timestamps outside the window
    const validTimestamps = timestamps.filter(t => now - t < this.SEARCH_RATE_WINDOW);
    this.searchRateLimit.set(ip, validTimestamps);

    // Check if limit exceeded
    if (validTimestamps.length >= this.SEARCH_RATE_LIMIT) {
      return false; // Rate limit exceeded
    }

    // Add current timestamp
    validTimestamps.push(now);
    return true; // Allowed
  }

  /**
   * GET /search?q=query - Search the local index
   */
  /**
   * Detect if query contains advanced search operators
   */
  hasAdvancedOperators(query) {
    if (!query) return false;
    // Check for advanced operators: site:, filetype:, "exact phrase", -exclude
    return /site:|filetype:|"[^"]+"|-\S+/.test(query);
  }

  async handleSearch(req, res, url) {
    // Check rate limit
    if (!this.checkSearchRateLimit(req)) {
      this.sendJSON(res, 429, {
        error: 'Rate limit exceeded. Maximum 30 searches per minute.'
      });
      return;
    }

    const query = url.searchParams.get('q');

    // Validate and clamp parameters to prevent abuse
    const MAX_LIMIT = 100;
    const MAX_OFFSET = 10000;
    const MAX_QUERY_LENGTH = 500;

    if (query && query.length > MAX_QUERY_LENGTH) {
      this.sendJSON(res, 400, {
        error: `Query too long. Maximum ${MAX_QUERY_LENGTH} characters.`
      });
      return;
    }

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), MAX_LIMIT);
    const offset = Math.min(parseInt(url.searchParams.get('offset') || '0', 10), MAX_OFFSET);

    // Distributed is now default (disable with distributed=false)
    const distributedParam = url.searchParams.get('distributed');
    const distributed = distributedParam === null || distributedParam === 'true';

    if (!this.store) {
      this.sendJSON(res, 503, { error: 'Store not available' });
      return;
    }

    // Choose search implementation based on query
    const useAdvanced = this.hasAdvancedOperators(query);
    const search = useAdvanced ? advancedSearch : basicSearch;

    // Distributed search by default if we have peers
    if (distributed && this.peerManager) {
      try {
        // For distributed search, fetch 2x results per page from local
        // This accounts for deduplication and ensures we have enough unique results
        // Fetch enough to cover the requested page: (offset + limit) * 2
        // Cap at reasonable maximum to prevent excessive memory/bandwidth
        const fetchLimit = Math.min((offset + limit) * 2, 400);
        const localResults = await search(this.store, query, { limit: fetchLimit, offset: 0 });

        const results = await distributedSearch(
          this.peerManager,
          this.wordDistribution,
          localResults,
          query,
          limit,
          offset,
          this.config
        );

        // Add node name for attribution
        results.indexedBy = this.config.node.name;

        this.sendJSON(res, 200, results);
      } catch (err) {
        console.error('Distributed search error:', err.message);
        // Fallback to local-only search with proper pagination
        const localResults = await search(this.store, query, { limit, offset });
        localResults.indexedBy = this.config.node.name;
        this.sendJSON(res, 200, localResults);
      }
    } else {
      // Local-only search with normal pagination
      const localResults = await search(this.store, query, { limit, offset });
      localResults.indexedBy = this.config.node.name;
      this.sendJSON(res, 200, localResults);
    }
  }

  /**
   * GET /network - Network information
   */
  handleNetwork(req, res) {
    const identity = getIdentity();

    // Calculate network-wide totals by summing all peers
    let totalIndexedSites = this.store ? this.store.domains.size : 0;
    let storageContributed = this.store ? this.store.bytesUsed : 0;

    if (this.peerManager) {
      const peers = this.peerManager.getPeers();
      for (const peer of peers) {
        if (peer.online && peer.stats) {
          totalIndexedSites += peer.stats.domainCount || peer.stats.recordCount || 0;
          storageContributed += peer.stats.bytesUsed || 0;
        }
      }
    }

    const network = {
      nodeId: identity.nodeId,
      knownPeers: this.peerManager ? this.peerManager.getPeerCount() : 0,
      onlinePeers: this.peerManager ? this.peerManager.getOnlinePeerCount() : 0,
      totalIndexedSites,
      storageContributed,
      crawlerActive: this.crawler ? true : false
    };

    if (this.peerManager) {
      // Get all peers and inject current node's stats where needed
      const peers = this.peerManager.getPeers();

      // Sort peers by lastSeen (most recent first)
      network.peers = peers.map(peer => {
        // If this peer is the current node, always inject fresh stats
        if (peer.nodeId === identity.nodeId && this.store) {
          return {
            ...peer,
            stats: {
              domainCount: this.store.domains.size,
              bytesUsed: this.store.bytesUsed
            },
            online: true,
            lastSeen: Date.now()
          };
        }

        // Ensure stats object exists (backward compatibility)
        if (peer.online && !peer.stats) {
          return {
            ...peer,
            stats: {
              domainCount: 0,
              bytesUsed: 0
            }
          };
        }

        return peer;
      }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    }

    this.sendJSON(res, 200, network);
  }

  /**
   * GET /health - Health check
   */
  handleHealth(req, res) {
    const healthy = this.store && this.store.loaded;

    this.sendJSON(res, healthy ? 200 : 503, {
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: Date.now()
    });
  }

  /**
   * Serve static files
   */
  handleStatic(req, res, pathname) {
    const filePath = path.join(STATIC_DIR, pathname.replace('/static/', ''));

    fs.readFile(filePath, (err, data) => {
      if (err) {
        this.sendJSON(res, 404, { error: 'File not found' });
        return;
      }

      const ext = path.extname(filePath);
      const contentType = this.getContentType(ext);

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  /**
   * Serve frontend HTML files
   */
  handleFrontend(req, res, pathname) {
    let filePath;

    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(STATIC_DIR, 'index.html');
    } else if (pathname === '/network.html') {
      filePath = path.join(STATIC_DIR, 'network.html');
    } else if (pathname === '/contribute.html') {
      filePath = path.join(STATIC_DIR, 'contribute.html');
    } else {
      this.sendJSON(res, 404, { error: 'Not found' });
      return;
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        this.sendJSON(res, 404, { error: 'Page not found' });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }

  /**
   * Send JSON response
   */
  sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Get content type from file extension
   */
  getContentType(ext) {
    const types = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    return types[ext] || 'application/octet-stream';
  }
}

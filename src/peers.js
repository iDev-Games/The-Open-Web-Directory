import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

/**
 * Peer Manager
 * Manages peer discovery, storage, and communication
 */

const PEERS_FILE = 'data/peers.json';
const PEER_TIMEOUT = 30000; // 30 seconds
const HEARTBEAT_INTERVAL = 60000; // 1 minute
const MAX_PEERS = 100;
const PEER_EXCHANGE_COUNT = 10;

export class PeerManager {
  constructor(nodeId, config) {
    this.nodeId = nodeId;
    this.config = config;

    // Map of peerId -> peer object
    this.peers = new Map();

    // Track last announcement time per peer to prevent spam
    this.lastAnnouncement = new Map();

    this.heartbeatTimer = null;
  }

  /**
   * Initialize peer manager
   */
  async init() {
    await this.loadPeers();
    this.startHeartbeat();
  }

  /**
   * Shutdown peer manager
   */
  shutdown() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.savePeers();
  }

  /**
   * Load peers from disk
   */
  async loadPeers() {
    try {
      if (!fs.existsSync(PEERS_FILE)) {
        return;
      }

      const data = await fs.promises.readFile(PEERS_FILE, 'utf8');
      const stored = JSON.parse(data);

      const PEER_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
      const now = Date.now();

      if (Array.isArray(stored.peers)) {
        let prunedCount = 0;

        for (const peer of stored.peers) {
          // Skip if this is our own nodeId (in case we restarted with new identity)
          if (peer.nodeId === this.nodeId) {
            console.log('Skipping own old nodeId from peer list');
            prunedCount++;
            continue;
          }

          // Skip peers that haven't been seen in 24 hours (auto-prune stale peers)
          if (peer.lastSeen && (now - peer.lastSeen) > PEER_EXPIRY_MS) {
            const hoursAgo = Math.floor((now - peer.lastSeen) / (60 * 60 * 1000));
            prunedCount++;
            continue;
          }

          this.peers.set(peer.nodeId, {
            ...peer,
            online: false,
            lastSeen: peer.lastSeen || 0
          });
        }

        if (prunedCount > 0) {
          console.log(`Pruned ${prunedCount} stale peer(s) from peer list`);
        }
      }
    } catch (err) {
      console.error('Error loading peers:', err.message);
    }
  }

  /**
   * Save peers to disk
   */
  async savePeers() {
    try {
      const dir = path.dirname(PEERS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const peers = Array.from(this.peers.values()).map(peer => ({
        nodeId: peer.nodeId,
        host: peer.host,
        port: peer.port,
        name: peer.name,
        lastSeen: peer.lastSeen,
        version: peer.version
      }));

      const data = {
        peers,
        lastUpdated: Date.now()
      };

      await fs.promises.writeFile(PEERS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error saving peers:', err.message);
    }
  }

  /**
   * Add a peer
   */
  addPeer(peer) {
    // Don't add ourselves
    if (peer.nodeId === this.nodeId) {
      return false;
    }

    // Validate peer
    if (!peer.nodeId || !peer.host || !peer.port) {
      return false;
    }

    // Check if we're at capacity
    if (this.peers.size >= MAX_PEERS && !this.peers.has(peer.nodeId)) {
      // Remove oldest peer
      this.removeOldestPeer();
    }

    const existing = this.peers.get(peer.nodeId);

    this.peers.set(peer.nodeId, {
      nodeId: peer.nodeId,
      host: peer.host,
      port: peer.port,
      name: peer.name || 'Unknown',
      version: peer.version || '0.1.0',
      online: existing ? existing.online : false,
      lastSeen: existing ? existing.lastSeen : Date.now(),
      addedAt: existing ? existing.addedAt : Date.now()
    });

    return true;
  }

  /**
   * Remove oldest peer
   */
  removeOldestPeer() {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.lastSeen < oldestTime) {
        oldestTime = peer.lastSeen;
        oldest = peerId;
      }
    }

    if (oldest) {
      this.peers.delete(oldest);
    }
  }

  /**
   * Remove a peer
   */
  removePeer(nodeId) {
    return this.peers.delete(nodeId);
  }

  /**
   * Get all peers
   */
  getPeers() {
    return Array.from(this.peers.values());
  }

  /**
   * Get peer count
   */
  getPeerCount() {
    return this.peers.size;
  }

  /**
   * Get online peer count
   */
  getOnlinePeerCount() {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.online) count++;
    }
    return count;
  }

  /**
   * Get a random subset of peers for exchange
   */
  getPeersForExchange() {
    const allPeers = this.getPeers();

    if (allPeers.length <= PEER_EXCHANGE_COUNT) {
      return allPeers;
    }

    // Shuffle and take first N
    const shuffled = [...allPeers].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, PEER_EXCHANGE_COUNT);
  }

  /**
   * Query a peer's /node endpoint
   */
  async queryPeer(peer) {
    return new Promise((resolve, reject) => {
      const protocol = peer.port === 443 ? https : http;

      const options = {
        hostname: peer.host,
        port: peer.port,
        path: '/node',
        method: 'GET',
        timeout: PEER_TIMEOUT,
        headers: {
          'User-Agent': `OpenWebDirectory/${this.config.node.version}`
        }
      };

      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
          // Prevent huge responses
          if (data.length > 1024 * 1024) {
            req.destroy();
            reject(new Error('Response too large'));
          }
        });

        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.end();
    });
  }

  /**
   * Query a peer's /peers endpoint
   */
  async queryPeerList(peer) {
    return new Promise((resolve, reject) => {
      const protocol = peer.port === 443 ? https : http;

      const options = {
        hostname: peer.host,
        port: peer.port,
        path: `/peers?exclude=${encodeURIComponent(this.nodeId)}`,  // Exclude ourselves from the response
        method: 'GET',
        timeout: PEER_TIMEOUT,
        headers: {
          'User-Agent': `OpenWebDirectory/${this.config.node.version}`
        }
      };

      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
          if (data.length > 1024 * 1024) {
            req.destroy();
            reject(new Error('Response too large'));
          }
        });

        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.peers || []);
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.end();
    });
  }

  /**
   * Start heartbeat to check peer health
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.checkPeerHealth();
    }, HEARTBEAT_INTERVAL);

    // Also run immediately
    this.checkPeerHealth();
  }

  /**
   * Check health of all peers and announce ourselves
   */
  async checkPeerHealth() {
    const peers = this.getPeers();

    for (const peer of peers) {
      try {
        // Query peer to check if online
        const info = await this.queryPeer(peer);

        // Peer is online
        const peerData = this.peers.get(peer.nodeId);
        if (peerData) {
          peerData.online = true;
          peerData.ready = info.ready !== undefined ? info.ready : true; // Track ready state
          peerData.lastSeen = Date.now();
          peerData.name = info.name || peerData.name;
          peerData.version = info.version || peerData.version;

          // Also record stats for network aggregation
          if (info.pagesIndexed !== undefined) {
            peerData.stats = {
              recordCount: info.pagesIndexed,
              bytesUsed: info.storageUsed || 0
            };
          }
        }

        // Announce ourselves to this peer so they know we're online
        // Only announce if we haven't announced to them in the last 30 seconds (prevent spam)
        const lastAnnounce = this.lastAnnouncement.get(peer.nodeId) || 0;
        const now = Date.now();
        if (now - lastAnnounce > 30000) {
          try {
            await this.announceToPeer(peer);
            this.lastAnnouncement.set(peer.nodeId, now);
          } catch (announceErr) {
            // Announcement failed, but peer might still be online (maybe just rejecting announces)
          }
        }
      } catch (err) {
        // Peer is offline
        const peerData = this.peers.get(peer.nodeId);
        if (peerData) {
          peerData.online = false;
          peerData.ready = false;
        }
      }
    }

    // Save updated peer states
    this.savePeers();
  }

  /**
   * Discover peers from known peers
   */
  async discoverPeers() {
    const peers = this.getPeers().filter(p => p.online);

    for (const peer of peers) {
      try {
        const remotePeers = await this.queryPeerList(peer);

        for (const remotePeer of remotePeers) {
          this.addPeer(remotePeer);
        }
      } catch (err) {
        // Ignore errors
      }
    }

    this.savePeers();
  }

  /**
   * Announce this node to a peer
   */
  async announceToPeer(peer) {
    return new Promise((resolve, reject) => {
      const protocol = peer.port === 443 ? https : http;

      const announcement = JSON.stringify({
        nodeId: this.nodeId,
        port: this.config.server.port,
        name: this.config.node.name,
        version: this.config.node.version
      });

      const options = {
        hostname: peer.host,
        port: peer.port,
        path: '/announce',
        method: 'POST',
        timeout: PEER_TIMEOUT,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(announcement),
          'User-Agent': `OpenWebDirectory/${this.config.node.version}`
        }
      };

      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
          if (data.length > 10240) {
            req.destroy();
            reject(new Error('Response too large'));
          }
        });

        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.write(announcement);
      req.end();
    });
  }

  /**
   * Bootstrap from a list of seed peers
   */
  async bootstrap(seedPeers) {
    // For each seed, query them first to discover their nodeId if not provided
    for (const seed of seedPeers) {
      if (!seed.nodeId) {
        // Gateway or bootstrap node - discover nodeId by querying
        try {
          const info = await this.queryPeer(seed);
          if (info && info.nodeId) {
            this.addPeer({
              ...seed,
              nodeId: info.nodeId,
              name: info.name || seed.name || 'Unknown',
              version: info.version || '0.1.0'
            });
            console.log(`Discovered gateway: ${info.name} (${info.nodeId.substring(0, 16)}...)`);
          }
        } catch (err) {
          console.error(`Failed to discover nodeId for ${seed.host}:${seed.port}:`, err.message);
        }
      } else {
        // Already has nodeId (from saved peers)
        this.addPeer(seed);
      }
    }

    // Check their health
    await this.checkPeerHealth();

    // Announce ourselves to online peers and get assigned seeds
    for (const peer of this.getPeers().filter(p => p.online)) {
      try {
        const response = await this.announceToPeer(peer);
        console.log(`Announced to ${peer.name}`);

        // If gateway assigned us seeds, store them
        if (response && response.seeds && Array.isArray(response.seeds)) {
          this.assignedSeeds = response.seeds;
          console.log(`Gateway assigned ${response.seeds.length} seed URLs for diversity`);
        }
      } catch (err) {
        // Ignore announcement failures
      }
    }

    // Discover more peers from them
    await this.discoverPeers();

    // Return assigned seeds so node can use them
    return this.assignedSeeds;
  }

  /**
   * Get online peers for distributed search
   */
  getOnlinePeers(limit = 10) {
    const online = this.getPeers().filter(p => p.online);

    if (online.length <= limit) {
      return online;
    }

    // Return random subset
    return online.sort(() => Math.random() - 0.5).slice(0, limit);
  }

  /**
   * Get ready peers (online AND ready to serve search requests)
   * @param {number} limit - Maximum number of peers to return
   * @returns {Array} Array of ready peer objects
   */
  getReadyPeers(limit = 10) {
    const ready = this.getPeers().filter(p => p.online && p.ready);

    if (ready.length <= limit) {
      return ready;
    }

    // Return random subset
    return ready.sort(() => Math.random() - 0.5).slice(0, limit);
  }

  /**
   * Calculate stability score for a peer
   * Higher score = more stable/reliable peer
   */
  scorePeerStability(peer) {
    const now = Date.now();
    const uptimeMs = now - (peer.addedAt || now);
    const uptimeDays = uptimeMs / (1000 * 60 * 60 * 24);

    let score = 0;

    // Uptime scoring
    if (uptimeDays > 1) score += 5;
    if (uptimeDays > 7) score += 10;
    if (uptimeDays > 30) score += 20;
    if (uptimeDays > 90) score += 30;

    // Currently online bonus
    if (peer.online) score += 50;

    // Recently seen bonus
    const hoursSinceLastSeen = (now - (peer.lastSeen || 0)) / (1000 * 60 * 60);
    if (hoursSinceLastSeen < 1) score += 10;
    if (hoursSinceLastSeen < 24) score += 5;

    return score;
  }

  /**
   * Get stable peers (high uptime, reliable)
   * These can be shared as "seed peers" with new nodes
   */
  getStablePeers(count = 10) {
    const peers = this.getPeers().map(peer => ({
      ...peer,
      stability: this.scorePeerStability(peer)
    }));

    // Sort by stability score descending
    peers.sort((a, b) => b.stability - a.stability);

    return peers.slice(0, count);
  }

  /**
   * Get peers for introduction to a requesting peer
   * Returns a diverse set of stable, online peers
   */
  getPeersForIntroduction(requestingNodeId, count = 5) {
    const candidates = this.getPeers()
      .filter(p => p.online && p.nodeId !== requestingNodeId)
      .map(p => ({ ...p, stability: this.scorePeerStability(p) }))
      .sort((a, b) => b.stability - a.stability);

    // Take top stable peers, then shuffle for diversity
    const topStable = candidates.slice(0, count * 2);
    const shuffled = topStable.sort(() => Math.random() - 0.5);

    return shuffled.slice(0, count);
  }
}

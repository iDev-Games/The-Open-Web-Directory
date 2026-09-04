import http from 'node:http';
import https from 'node:https';

/**
 * Distributed Search
 * Queries multiple peers and combines results
 */

const SEARCH_TIMEOUT = 5000; // 5 seconds per peer
const MAX_PEER_QUERIES = 5; // Query up to 5 peers

/**
 * Query a peer's search endpoint
 */
async function queryPeerSearch(peer, query, limit, config) {
  return new Promise((resolve, reject) => {
    const protocol = peer.port === 443 ? https : http;

    const params = new URLSearchParams({
      q: query,
      limit: limit.toString(),
      distributed: 'false' // Don't cascade
    });

    const options = {
      hostname: peer.host,
      port: peer.port,
      path: `/search?${params}`,
      method: 'GET',
      timeout: SEARCH_TIMEOUT,
      headers: {
        'User-Agent': `OpenWebDirectory/${config.node.version}`
      }
    };

    const req = protocol.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
        // Prevent huge responses
        if (data.length > 2 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Response too large'));
        }
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            peerId: peer.nodeId,
            peerName: peer.name,
            results: json.results || [],
            total: json.total || 0
          });
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
 * Perform distributed search across peers
 * @param {PeerManager} peerManager
 * @param {object} localResults - Results from local search
 * @param {string} query
 * @param {number} limit
 * @param {number} offset
 * @param {object} config
 */
export async function distributedSearch(peerManager, localResults, query, limit, offset, config) {
  const peers = peerManager.getReadyPeers(MAX_PEER_QUERIES);

  // Debug: Log local results count
  console.log(`[Distributed Search] Local results: ${localResults.results.length}, Ready peers to query: ${peers.length}`);

  if (peers.length === 0) {
    // No peers available, return local results with proper pagination
    return {
      ...localResults,
      results: localResults.results.slice(offset, offset + limit),
      offset,
      limit
    };
  }

  // For distributed search, fetch 2x results per page from each peer
  // This accounts for deduplication and ensures we have enough unique results
  // Match what the server does: (offset + limit) * 2
  const fetchLimit = Math.min((offset + limit) * 2, 400);

  // Query peers in parallel
  const promises = peers.map(peer =>
    queryPeerSearch(peer, query, fetchLimit, config)
      .catch(err => ({
        peerId: peer.nodeId,
        peerName: peer.name,
        error: err.message,
        results: [],
        total: 0
      }))
  );

  const peerResults = await Promise.all(promises);

  // Combine results
  const allResults = [...localResults.results];
  const seenUrls = new Set(allResults.map(r => r.url));

  // Calculate total across all sources (before deduplication)
  let totalAcrossNetwork = localResults.total || 0;

  for (const peerResult of peerResults) {
    // Add peer's total to network total
    if (peerResult.total) {
      totalAcrossNetwork += peerResult.total;
    }

    if (peerResult.results) {
      for (const result of peerResult.results) {
        // Deduplicate by URL
        if (!seenUrls.has(result.url)) {
          seenUrls.add(result.url);
          allResults.push({
            ...result,
            source: peerResult.peerName || peerResult.peerId
          });
        }
      }
    }
  }

  // Re-sort by score
  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Apply offset and limit for pagination
  const finalResults = allResults.slice(offset, offset + limit);

  // Debug: Log final counts
  console.log(`[Distributed Search] Local: ${localResults.results.length}/${localResults.total}, Unique combined: ${allResults.length}, After limit: ${finalResults.length}, Network total: ${totalAcrossNetwork}`);

  return {
    ...localResults,
    results: finalResults,
    total: totalAcrossNetwork,  // Total across all nodes (with duplicates counted separately per node)
    uniqueResults: allResults.length,  // Unique URLs after deduplication
    offset,  // Current page offset
    limit,  // Results per page
    distributed: true,
    peerResults: peerResults.map(pr => ({
      peerId: pr.peerId,
      peerName: pr.peerName,
      count: pr.results ? pr.results.length : 0,
      total: pr.total,
      error: pr.error
    }))
  };
}

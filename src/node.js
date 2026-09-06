console.log('Starting Open Web Directory...');
console.log('Loading modules...');

import { Store } from './store.js';
import { CrawlQueue } from './queue.js';
import { Crawler } from './crawler.js';
import { config } from './config.js';
import { loadIdentity } from './identity.js';
import { Server } from './server.js';
import { PeerManager } from './peers.js';
import { WordDistribution } from './word-distribution.js';
import { normaliseUrl } from './url.js';

console.log('Modules loaded successfully');

const SEED_URLS = config.seeds;

async function main() {
  console.log('');
  console.log(config.node.name);
  console.log('────────────────────────────');
  console.log('');

  // Load node identity
  const identity = loadIdentity();
  console.log(`Node ID: ${identity.nodeId.substring(0, 16)}...`);
  console.log('');

  const store = new Store(
    config.storage.dataDirectory,
    config.storage.limitBytes
  );

  await store.init();

  // Initialize word distribution manager for intelligent query routing
  const wordDistribution = new WordDistribution(config.distributedSearch?.topWordsCount || 20);
  await wordDistribution.load();
  console.log(`Word distribution loaded: ${wordDistribution.peerDistributions.size} peers`);

  const queue = new CrawlQueue(
    config.crawler.maxQueueSize
  );

  // Initialize peer manager with store and word distribution for announcements
  const peerManager = new PeerManager(identity.nodeId, config, store, wordDistribution);
  await peerManager.init();

  console.log(`Known peers: ${peerManager.getPeerCount()}`);

  // Bootstrap from gateway + configured peers
  const gatewayPeers = config.gateway?.peers || [];
  const bootstrapPeers = config.bootstrap || [];
  const allBootstrap = [...gatewayPeers, ...bootstrapPeers];

  let assignedSeeds = null;
  if (allBootstrap.length > 0) {
    console.log('Bootstrapping from network gateway...');
    assignedSeeds = await peerManager.bootstrap(allBootstrap);
    console.log(`Online peers: ${peerManager.getOnlinePeerCount()}`);
  } else {
    console.log('No bootstrap configured - operating independently');
  }

  // Start HTTP server with word distribution for intelligent routing
  const server = new Server(config, store, null, peerManager, wordDistribution);
  server.start();

  console.log('');

  // Start crawler if enabled
  let crawler = null;
  let crawlerPromise = null;
  let seedInfo = '';

  if (config.crawler.enabled) {
    // Use assigned seeds from gateway if provided, otherwise use config seeds
    const seedsToUse = assignedSeeds || SEED_URLS;
    console.log(`Using ${seedsToUse.length} seed URLs${assignedSeeds ? ' (assigned by gateway)' : ''}`);

    crawler = new Crawler({
      queue,
      store,
      seedUrls: seedsToUse, // Pass seeds for auto-refill

      userAgent:
        config.crawler.userAgent,

      maxConcurrentRequests:
        config.resources.maxConcurrentRequests,

      maxResponseBytes:
        config.crawler.maxResponseBytes,

      requestTimeoutMs:
        config.crawler.requestTimeoutMs,

      errorBackoffMs:
        config.crawler.errorBackoffMs,
    });

    // Update server with crawler reference
    server.crawler = crawler;

    // Only add seeds if they haven't been crawled yet (avoid re-crawling on restart)
    // IMPORTANT: Normalize URLs before checking, as store contains normalized versions
    let seedsAdded = 0;
    let seedsSkipped = 0;
    for (const url of seedsToUse) {
      const normalized = normaliseUrl(url);
      if (!normalized) {
        continue; // Invalid URL, skip it
      }

      // Check if normalized version exists in store
      if (!store.has(normalized)) {
        if (queue.add(url)) {
          seedsAdded++;
        }
      } else {
        seedsSkipped++;
      }
    }

    seedInfo = `Seeds: ${seedsAdded} added, ${seedsSkipped} skipped`;
    console.log(seedInfo);

    console.log(
      `Storage: ${formatBytes(config.storage.limitBytes)}`
    );

    console.log(`Pages:   ${store.size}`);
    console.log(`Queued:  ${queue.size}`);

    console.log('');
    console.log('Crawler: STARTING');
    console.log('');

    crawlerPromise = crawler.start();
  } else {
    console.log('Crawler: DISABLED');
    console.log('');
  }

  // Periodic word distribution updates for intelligent query routing
  if (config.distributedSearch?.intelligentRouting && store.index) {
    const wordUpdateInterval = config.distributedSearch?.wordUpdateInterval || 300000; // 5 minutes

    const updateWordDistribution = () => {
      try {
        const hasSignificantChanges = wordDistribution.updateLocalTopWords(store.index);
        const topWordsCount = wordDistribution.localTopWords.size;

        console.log(`[Word Distribution] Updated: ${topWordsCount} top words${hasSignificantChanges ? ' (significant changes)' : ''}`);

        if (hasSignificantChanges || topWordsCount > 0) {
          // Save to disk
          wordDistribution.save().catch(err => {
            console.error('[Word Distribution] Failed to save:', err.message);
          });
        }
      } catch (err) {
        console.error('[Word Distribution] Update failed:', err.message);
      }
    };

    // Initial update - run quickly if index already has data
    const initialDelay = store.index.index.size > 0 ? 5000 : 30000;
    setTimeout(() => {
      updateWordDistribution();
    }, initialDelay); // 5s if index exists, 30s otherwise

    // Periodic updates
    setInterval(updateWordDistribution, wordUpdateInterval);
  }

  // Delay first status print to allow startup messages to be visible
  setTimeout(() => {
    const statsInterval = setInterval(() => {
      printStatus(store, crawler, peerManager, seedInfo);
      // Periodically flush to persist data and trigger batched index saves
      store.flush().catch(err => {
        console.error('Failed to flush store:', err.message);
      });
    }, 5000);

    // Store interval ID for cleanup
    if (!isShuttingDown) {
      global.statsIntervalId = statsInterval;
    }
  }, 10000); // Wait 10 seconds before first status print

  let isShuttingDown = false;

  const shutdown = async signal => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    console.log('');
    console.log(`${signal} received.`);

    if (crawler) {
      console.log('Stopping crawler...');
      crawler.stop();
    }

    console.log('Stopping server...');
    server.stop();

    console.log('Shutting down peer manager...');
    peerManager.shutdown();

    if (global.statsIntervalId) {
      clearInterval(global.statsIntervalId);
    }

    if (crawlerPromise) {
      await crawlerPromise;
    }

    console.log('Saving data...');
    await store.shutdown();

    console.log('Node stopped cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(error => {
      console.error(error);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(error => {
      console.error(error);
      process.exit(1);
    });
  });

  if (crawlerPromise) {
    await crawlerPromise;
  } else {
    // Keep running if crawler is disabled
    await new Promise(() => {});
  }
}

function printStatus(store, crawler, peerManager, seedInfo = '') {
  console.clear();

  console.log(config.node.name);
  console.log('────────────────────────────');
  console.log('');

  console.log(
    `Storage: ${formatBytes(store.bytesUsed)} / ${formatBytes(config.storage.limitBytes)}`
  );

  console.log(`Pages:   ${store.size}`);

  if (crawler) {
    const stats = crawler.getStats();
    console.log(`Queued:  ${stats.queued}`);
    console.log(`Active:  ${stats.active}`);
  }

  console.log('');

  console.log('Network');
  console.log(`  Known peers:  ${peerManager.getPeerCount()}`);
  console.log(`  Online peers: ${peerManager.getOnlinePeerCount()}`);

  console.log('');

  if (crawler) {
    const stats = crawler.getStats();

    console.log('Crawler');
    console.log(`  Checked:     ${stats.attempted}`);
    console.log(`  Successful:  ${stats.successful}`);
    console.log(`  Failed:      ${stats.failed}`);
    console.log(`  Blocked:     ${stats.blocked}`);
    console.log(`  Discovered:  ${stats.discovered}`);

    // Show seed info if available
    if (seedInfo) {
      console.log('');
      console.log(`  ${seedInfo}`);
    }

  }

  console.log('Status: RUNNING');
  console.log(`HTTP Server: http://localhost:${config.server.port}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  return `${(
    bytes /
    1024 /
    1024 /
    1024
  ).toFixed(2)} GB`;
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('');
  console.error('UNHANDLED PROMISE REJECTION');
  console.error('─────────────────────────────');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('');
  console.error('UNCAUGHT EXCEPTION');
  console.error('──────────────────');
  console.error(error);
  process.exit(1);
});

main().catch(error => {
  console.error('');
  console.error('NODE FAILED');
  console.error('────────────');
  console.error(error);
  console.error('');
  console.error('Stack trace:');
  console.error(error.stack);

  process.exit(1);
});
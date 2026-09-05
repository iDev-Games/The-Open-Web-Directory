#!/usr/bin/env node

/**
 * Diagnostic script for production issues
 * Run this before starting the main application
 */

console.log('='.repeat(50));
console.log('OWD DIAGNOSTIC CHECK');
console.log('='.repeat(50));
console.log('');

// 1. Node.js version
console.log('1. Node.js Version');
console.log('   Version:', process.version);
console.log('   Required: v18.0.0 or higher');
const major = parseInt(process.version.slice(1).split('.')[0]);
if (major < 18) {
  console.log('   ❌ FAIL: Node.js version too old');
  console.log('   Please upgrade to Node.js 18 or later');
  process.exit(1);
} else {
  console.log('   ✅ PASS');
}
console.log('');

// 2. Platform info
console.log('2. Platform Information');
console.log('   OS:', process.platform);
console.log('   Arch:', process.arch);
console.log('   Memory:', (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2), 'MB');
console.log('   ✅ PASS');
console.log('');

// 3. File system permissions
console.log('3. File System Permissions');
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
try {
  if (!fs.existsSync(dataDir)) {
    console.log('   Creating data directory...');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Test write
  const testFile = path.join(dataDir, '.test-write');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);

  console.log('   Data directory:', dataDir);
  console.log('   ✅ PASS: Can read/write to data directory');
} catch (err) {
  console.log('   ❌ FAIL: Cannot write to data directory');
  console.log('   Error:', err.message);
  process.exit(1);
}
console.log('');

// 4. Module loading
console.log('4. Module Loading Test');
try {
  console.log('   Loading config...');
  const { config } = await import('./src/config.js');
  console.log('   ✅ config.js loaded');

  console.log('   Loading identity...');
  const { loadIdentity } = await import('./src/identity.js');
  console.log('   ✅ identity.js loaded');

  console.log('   Loading store...');
  const { Store } = await import('./src/store.js');
  console.log('   ✅ store.js loaded');

  console.log('   Loading queue...');
  const { CrawlQueue } = await import('./src/queue.js');
  console.log('   ✅ queue.js loaded');

  console.log('   Loading crawler...');
  const { Crawler } = await import('./src/crawler.js');
  console.log('   ✅ crawler.js loaded');

  console.log('   Loading server...');
  const { Server } = await import('./src/server.js');
  console.log('   ✅ server.js loaded');

  console.log('   Loading peers...');
  const { PeerManager } = await import('./src/peers.js');
  console.log('   ✅ peers.js loaded');

  console.log('   ✅ PASS: All modules loaded successfully');
} catch (err) {
  console.log('   ❌ FAIL: Module loading error');
  console.log('   Error:', err.message);
  console.log('   Stack:', err.stack);
  process.exit(1);
}
console.log('');

// 5. Identity test
console.log('5. Identity System Test');
try {
  const { loadIdentity } = await import('./src/identity.js');
  const identity = loadIdentity();
  console.log('   Node ID:', identity.nodeId.substring(0, 16) + '...');
  console.log('   ✅ PASS: Identity system working');
} catch (err) {
  console.log('   ❌ FAIL: Identity system error');
  console.log('   Error:', err.message);
  process.exit(1);
}
console.log('');

// 6. Store initialization test
console.log('6. Store Initialization Test');
try {
  const { Store } = await import('./src/store.js');
  const { config } = await import('./src/config.js');

  const store = new Store(
    config.storage.dataDirectory,
    config.storage.limitBytes
  );

  await store.init();
  console.log('   Pages indexed:', store.size);
  console.log('   Storage used:', (store.bytesUsed / 1024 / 1024).toFixed(2), 'MB');
  console.log('   ✅ PASS: Store initialized successfully');
} catch (err) {
  console.log('   ❌ FAIL: Store initialization error');
  console.log('   Error:', err.message);
  console.log('   Stack:', err.stack);
  process.exit(1);
}
console.log('');

// 7. Network binding test
console.log('7. Network Port Test');
try {
  const { config } = await import('./src/config.js');
  const http = await import('node:http');

  const testServer = http.createServer();
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(config.server.port, config.server.host, () => {
      resolve();
    });
  });

  testServer.close();

  console.log('   Port:', config.server.port);
  console.log('   Host:', config.server.host);
  console.log('   ✅ PASS: Can bind to network port');
} catch (err) {
  console.log('   ❌ FAIL: Cannot bind to network port');
  console.log('   Error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.log('   Port is already in use. Stop other instances or change port in config.');
  } else if (err.code === 'EACCES') {
    console.log('   Permission denied. Ports < 1024 require root/admin privileges.');
  }
  process.exit(1);
}
console.log('');

console.log('='.repeat(50));
console.log('✅ ALL DIAGNOSTIC CHECKS PASSED');
console.log('='.repeat(50));
console.log('');
console.log('The system appears healthy. You can now run:');
console.log('  npm start');
console.log('');

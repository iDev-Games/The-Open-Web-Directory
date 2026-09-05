import os from 'node:os';
import path from 'node:path';

const GB = 1024 * 1024 * 1024;

export const config = {
    // Network identity
    network: {
        name: 'The Open Web Directory Network',
    },

    // Node
    node: {
        name: 'The Open Web Directory',
        version: '1.0.0',
    },

    // HTTP server
    // Port 80 is recommended for maximum compatibility
    // Note: Requires administrator/root privileges on most systems
    // Windows: Run PowerShell/CMD as Administrator
    // Linux/Mac: Run with sudo
    server: {
        host: '0.0.0.0',
        port: 80,
        // Set to true if behind a trusted reverse proxy (nginx, Cloudflare, etc.)
        // This allows the server to trust X-Forwarded-For headers for client IP detection
        // WARNING: Only enable if you have a trusted proxy in front of this node
        trustProxy: false,
    },

    // Storage
    storage: {
        dataDirectory: path.resolve('data'),
        limitBytes: 1 * GB,
    },

    // Seed URLs for crawler
    seeds: ["https://idev.games"],

    // Network gateway (main entry point for new nodes)
    // NodeId is discovered automatically by querying the gateway
    gateway: {
        peers: [
            {
                host: 'owd.idevgames.co.uk',
                port: 443,
                name: 'OWD Gateway'
            }
        ]
    },

    // Additional bootstrap peers (optional, for redundancy)
    bootstrap: [],

    // Crawler
    crawler: {
        enabled: true,

        // Homepage-only crawling hits different domains, so we can be faster.
        requestsPerSecond: 5,

        // Maximum number of URLs waiting to be crawled.
        maxQueueSize: 10000,

        // Don't download enormous HTML documents.
        maxResponseBytes: 2 * 1024 * 1024,

        // Request timeout.
        requestTimeoutMs: 15000,

        // Only crawl HTTP(S).
        allowedProtocols: ['http:', 'https:'],

        // Identify ourselves honestly.
        userAgent:
        'OpenWebDirectory/0.1 (+https://github.com/idev-games/the-open-web-directory)',

        // Don't hammer a domain after errors.
        errorBackoffMs: 30000,
    },

    // Resource limits
    resources: {
        // Maximum simultaneous HTTP requests.
        maxConcurrentRequests: 1,

        // Leave room for other applications.
        maxMemoryUsageMB: Math.max(128, Math.floor(os.totalmem() / GB * 64)),
    },
};
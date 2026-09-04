/**
 * Seed URL Pool
 * Distributes different seed URLs to connecting peers for diversity
 */

// Pool of quality seed URLs across different topics/domains
const SEED_POOL = [
  // Tech & Programming
  'https://github.com',
  'https://stackoverflow.com',
  'https://news.ycombinator.com',
  'https://dev.to',
  'https://medium.com',

  // Education & Learning
  'https://www.wikipedia.org',
  'https://www.khanacademy.org',
  'https://www.coursera.org',
  'https://www.edx.org',

  // News & Information
  'https://www.bbc.com',
  'https://www.reuters.com',
  'https://www.theguardian.com',

  // Science & Research
  'https://www.nature.com',
  'https://www.sciencedirect.com',
  'https://arxiv.org',

  // Arts & Culture
  'https://www.metmuseum.org',
  'https://www.gutenberg.org',
  'https://archive.org',

  // Community & Forums
  'https://www.reddit.com',
  'https://lobste.rs',
  'https://www.discourse.org',

  // Games
  'https://idev.games',
  'https://itch.io',
  'https://store.steampowered.com',

  // General purpose starting points
  'https://www.dmoz-odp.org',
  'https://curlie.org',
];

// Track which nodes got which seeds
const assignments = new Map();

/**
 * Get seed URLs for a connecting peer
 * Returns 3-5 diverse URLs to maximize network coverage
 *
 * IMPORTANT: Seeds are assigned deterministically based on nodeId hash
 * to ensure the same node always gets the same seeds across restarts.
 * This prevents re-crawling seeds on every restart.
 */
export function getSeedsForPeer(nodeId) {
  // Check if we've already assigned seeds to this node in this session
  if (assignments.has(nodeId)) {
    return assignments.get(nodeId);
  }

  // Generate a deterministic seed based on nodeId
  // This ensures the same node always gets the same seeds
  let hash = 0;
  for (let i = 0; i < nodeId.length; i++) {
    hash = ((hash << 5) - hash) + nodeId.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Use hash to deterministically select count (3-5 seeds)
  const count = 3 + (Math.abs(hash) % 3);

  // Use hash as seed for deterministic random selection
  const seeds = [];
  const available = [...SEED_POOL];
  let currentHash = hash;

  for (let i = 0; i < count && available.length > 0; i++) {
    // Generate deterministic pseudo-random index
    currentHash = ((currentHash * 1103515245) + 12345) & 0x7fffffff;
    const index = currentHash % available.length;

    seeds.push(available[index]);
    available.splice(index, 1); // Remove so we don't duplicate
  }

  // Store assignment for this session
  assignments.set(nodeId, seeds);

  return seeds;
}

/**
 * Add custom seed to the pool (for network operators)
 */
export function addSeedToPool(url) {
  if (!SEED_POOL.includes(url)) {
    SEED_POOL.push(url);
  }
}

/**
 * Get all seeds in the pool
 */
export function getAllSeeds() {
  return [...SEED_POOL];
}

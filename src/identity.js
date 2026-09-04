import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Manages persistent node identity
 * Generates a unique node ID on first run and persists it
 */

const IDENTITY_FILE = 'data/identity.json';

let nodeIdentity = null;

/**
 * Generate a new node identity
 */
function generateIdentity() {
  const id = crypto.randomBytes(32).toString('hex');
  const createdAt = Date.now();

  return {
    nodeId: id,
    createdAt,
    version: '0.1.0'
  };
}

/**
 * Load or create node identity
 */
export function loadIdentity() {
  if (nodeIdentity) {
    return nodeIdentity;
  }

  try {
    // Try to load existing identity
    if (fs.existsSync(IDENTITY_FILE)) {
      const data = fs.readFileSync(IDENTITY_FILE, 'utf8');
      nodeIdentity = JSON.parse(data);
      return nodeIdentity;
    }
  } catch (err) {
    console.error('Error loading identity:', err.message);
  }

  // Generate new identity
  nodeIdentity = generateIdentity();

  // Persist it
  try {
    const dir = path.dirname(IDENTITY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(nodeIdentity, null, 2));
  } catch (err) {
    console.error('Error saving identity:', err.message);
  }

  return nodeIdentity;
}

/**
 * Get the current node ID
 */
export function getNodeId() {
  const identity = loadIdentity();
  return identity.nodeId;
}

/**
 * Get full identity information
 */
export function getIdentity() {
  return loadIdentity();
}

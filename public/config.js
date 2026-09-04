// Frontend Bootstrap Configuration
// This file is loaded by index.html, network.html, etc.
// Configure which nodes the frontend should try to connect to

window.OWD_CONFIG = {
  // Bootstrap nodes - the frontend will try these in order
  bootstrapNodes: [
    // Network gateway (production)
    { host: 'owd.idevgames.co.uk', port: 443, protocol: 'https' },

    // Localhost (for development)
    { host: 'localhost', port: 8471, protocol: 'http' },
  ],

  // Search settings
  resultsPerPage: 20,
  defaultDistributed: true,  // Enable distributed search by default

  // UI settings
  refreshInterval: 10000,  // Network page refresh interval (ms)
};

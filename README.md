# The Open Web Directory

<p align="center">
  <img src="https://github.com/iDev-Games/The-Open-Web-Directory/blob/master/public/logo.png"> 
</p>

**A lightweight, distributed web directory network. Discover sites by querying raw indexed data.**

The Open Web Directory (OWD) is a distributed directory of the open web, a programmatic data source providing searchable metadata about websites. It's designed for developers, AI systems, and researchers who need raw website data without the noise of ranking algorithms.

OWD indexes **one entry per domain** (homepages only), making it a true directory of websites rather than a page-level search engine.

OWD is designed to be run by anyone, on modest hardware, with minimal configuration. Clone the repo, run `npm start`, and you're live.

---

## 🌟 What is OWD?

### A Directory, Not a Search Engine

OWD is a **distributed directory** providing:

- **Raw indexed data**: Domain homepages with titles, descriptions, sitemaps, and basic metadata
- **One entry per domain**: Homepage-only indexing for true directory functionality
- **Programmatic API**: JSON endpoints for automated systems
- **Run your own node**: Your infrastructure, your data
- **Distributed network**: Multiple independent nodes working together
- **Zero dependencies**: Uses only Node.js built-ins
- **Open data**: All indexed information is openly queryable

### Primary Purpose: Developer Data Source

The main purpose of OWD is to provide a **programmatic directory of websites** that developers can:

- **Query via API** for applications and automated systems
- **Use as training data** for AI/ML models and research
- **Build discovery features** without relying on commercial APIs
- **Study web structure** and link graphs

**Why run your own node instead of using a central API?**

- ✅ **No congestion** - dedicated infrastructure
- ✅ **Network resilience** - keep the directory distributed
- ✅ **Data control** - contribute to a network of web data

### What OWD is NOT

- ❌ A Google competitor (no sophisticated ranking)
- ❌ A search engine (it's a directory with query capability)
- ❌ A web archive (doesn't store page content)
- ❌ Centrally controlled (anyone can run a network or join an existing one)

---

## 🚀 Quick Start

### Requirements

- **Node.js 18 or later**
- **1 GB disk space** (default, configurable)
- **Internet connection**

### Installation

```bash
git clone https://github.com/idev-games/the-open-web-directory.git
cd the-open-web-directory
npm start
```

That's it! Your node will:

1. Generate a unique node ID (stored in `data/identity.json`)
2. Connect to the OWD network
3. Start the HTTP server on port 80
4. Begin crawling and indexing website homepages
5. Participate in distributed search

### Access the Interface

Open public/index.html directly in a browser to start searching

---

## 🏗️ Architecture

### Network Model

OWD uses a **distributed gateway architecture**:

```
     Gateway (owd.idevgames.co.uk)
              ↓
    ┌─────────┼─────────┐
    │         │         │
  Node A    Node B    Node C
    │         │         │
    └─────────┼─────────┘
         (peer mesh)
```

#### How It Works

1. **Gateway Entry**: New nodes connect to `https://owd.idevgames.co.uk` to join the network
2. **Peer Discovery**: Gateway shares a list of active nodes
3. **Distributed Search**: Queries fan out to multiple peers and merge results
4. **Network Resilience**: Once connected, nodes cache peers and continue operating even if the gateway goes offline

#### Decentralized by Nature

While OWD uses a gateway for ease of onboarding, the network is **decentralized in nature**:

- No single entity controls the index
- Nodes operate independently
- Gateway failure doesn't kill the network (only pauses new member onboarding)
- Anyone can run their own independent network or gateway

---

## 🌐 Running Your Own Network

### Option 1: Join the Main Network (Default)

Simply run `npm start` and you'll automatically connect to the main OWD network at `owd.idevgames.co.uk`.

### Option 2: Create Your Own Private Network

Want to run OWD for your organization, research project, or private web crawling?

**1. Edit `src/config.js` on your gateway server:**

```javascript
gateway: {
    peers: []  // Empty - this node IS the gateway
},

seeds: ["https://your-seed-urls.com"]  // Your starting URLs
```

**2. Start your gateway:**

```bash
npm start
```
Then close it back down, this is to generate a new nodeId.

**3. Configure other nodes to point to your gateway:**

Edit `src/config.js` on client nodes:

```javascript
gateway: {
    peers: [
        {
            nodeId: '', // You will find this in data/identity.json
            host: 'your-gateway-domain.com',
            port: 443,  // or 80 for HTTP
            name: 'Your Private Gateway'
        }
    ]
}
```

**4. Start client nodes:**

```bash
npm start
```

That's it! You now have your own independent OWD network. Then just update "bootstrapNodes" within public/config.js to point your frontend towards your node.

### Option 3: Become an Additional Gateway

Want to provide redundancy or regional access to the main network?

**1. Run a publicly accessible node** (VPS with domain name)

**2. Configure as gateway** (empty gateway peers)

**3. Share your gateway address** with the community

**4. Users can add multiple gateways** for redundancy:

```javascript
gateway: {
    peers: [
        {
            nodeId: '',
            host: 'owd.idevgames.co.uk',
            port: 443,
            name: 'OWD Main Gateway'
        },
        {
            nodeId: '',
            host: 'your-gateway.com',
            port: 443,
            name: 'Regional Gateway'
        }
    ]
}
```

Nodes will try gateways in order until one succeeds.

---

## 🔧 Configuration

Edit `src/config.js` to customize your node:

### Node Identity

```javascript
node: {
  name: 'The Open Web Directory',  // Your node's display name
  version: '0.1.0',
}
```

### HTTP Server

```javascript
server: {
  host: '0.0.0.0',  // Listen on all interfaces
  port: 80,       // HTTP port
}
```

### Storage

```javascript
storage: {
  dataDirectory: path.resolve('data'),
  limitBytes: 1 * GB,  // How much disk space to use (1 GB default)
}
```

### Crawler

```javascript
crawler: {
  enabled: true,              // Enable/disable crawling
  requestsPerSecond: 5,       // Homepage-only hits different domains
  maxQueueSize: 10000,        // URLs to queue
  maxResponseBytes: 2 * MB,   // Max page size to download
  requestTimeoutMs: 15000,    // Request timeout
  errorBackoffMs: 30000,      // Back off after errors
}
```

### Seed URLs

```javascript
seeds: ["https://idev.games"]  // Starting points for crawler
```

Add your favorite websites to bootstrap the crawler!

---

## 📡 API Endpoints

Your node exposes a simple REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Node information and API overview |
| `/node` | GET | Detailed node statistics |
| `/search?q=query` | GET | Search the index |
| `/peers` | GET | List known peers |
| `/network` | GET | Network statistics |
| `/health` | GET | Health check |
| `/announce` | POST | Peer announcement (used by nodes) |

### Examples

**Search:**
```bash
curl "http://localhost/search?q=javascript&limit=10"
```

**Distributed search:**
```bash
curl "http://localhost/search?q=javascript&distributed=true"
```

**Node stats:**
```bash
curl http://localhost/node
```

**Network status:**
```bash
curl http://localhost/network
```

---

## 🔍 How Search Works

### Local Search

1. User submits query
2. Keywords extracted and normalized
3. Records scored by relevance:
   - **Title matches**: 10-18 points
   - **Description matches**: 3-4 points
   - **URL matches**: 1 point
   - **Age penalty**: Older records scored lower
   - **Status penalty**: Non-200 responses scored lower
4. Results sorted by score and returned

### Distributed Search

1. User enables "distributed search"
2. Query sent to local index
3. Query also sent to up to 5 online peers
4. Results merged and deduplicated by URL
5. Combined results re-sorted by relevance
6. Returned to user with source metadata

**Distributed search is slower but more comprehensive.**

---

## 🗂️ Data Storage

### Format

Indexed records stored in **JSONL** (JSON Lines) format:

```json
{
  "domain": "example.com",
  "url": "https://example.com/",
  "title": "Example Site",
  "description": "An example website",
  "sitemap": "https://example.com/sitemap.xml",
  "status": 200,
  "addedAt": 1788384455685,
  "lastChecked": 1788384455685
}
```

**Note**: OWD indexes **one entry per domain** (homepage only). Each domain has a single record with the homepage URL, title, description, and detected sitemap.

### Storage Structure

```
data/
├── identity.json       # Node ID (persistent)
├── peers.json          # Cached peer list
├── metadata.json       # Storage metadata
├── index.json          # Search index
└── records/
    ├── chunk-00000001.jsonl  # 16 MB chunks
    ├── chunk-00000002.jsonl
    └── ...
```

Storage automatically chunks into 16 MB files for manageability.

---

## 🌍 Network Participation

### As a Participant Node (Default)

Simply run `npm start`. Your node will:

- Index website homepages (one per domain) up to your storage limit
- Contribute to distributed search
- Share peer information
- Help build the open web directory

### As a Gateway Node

Run on a **publicly accessible server** with a domain name:

1. Get a VPS (DigitalOcean, Linode, etc.)
2. Point your domain to the server
3. Set up HTTPS (Let's Encrypt recommended)
4. Configure gateway with empty peers:
   ```javascript
   gateway: { peers: [] }
   ```
5. Set up reverse proxy (nginx/Apache) for HTTPS on port 443
6. Share your gateway address with the community

### As a Search-Only Node

Disable the crawler to only search, not index:

```javascript
crawler: {
  enabled: false
}
```

Your node will still:
- Participate in distributed search
- Discover peers
- Serve search queries
- Contribute to network resilience

---

## 🛡️ Privacy & Ethics

### Respecting Websites

OWD follows ethical crawling practices:

- ✅ Respects `robots.txt`
- ✅ Identifies itself honestly via User-Agent
- ✅ Limits request rate (default: 5 requests/second across different domains)
- ✅ Times out on slow responses
- ✅ Only crawls homepages (one per domain)
- ✅ Doesn't store page content, only metadata
- ✅ Backs off after errors

### Privacy

- OWD doesn't track users
- No cookies, no analytics, no surveillance
- All indexed data is public web data
- Nodes share public IP addresses for network connectivity

### Data Collection

What OWD indexes:
- ✅ Domain homepages (one per domain)
- ✅ Homepage titles
- ✅ Meta descriptions
- ✅ Sitemap URLs (automatically detected)
- ✅ HTTP status codes
- ✅ Links to discover new domains

What OWD **doesn't** index:
- ❌ Individual pages (only homepages)
- ❌ Page content/body text
- ❌ User data or personal information
- ❌ Content behind authentication
- ❌ Pages blocked by robots.txt

---

## 🚧 Port Forwarding for Full Participation

Most home internet connections are behind **NAT** (Network Address Translation), which prevents incoming connections. This is fine for basic participation, but for full peer-to-peer functionality:

### Why Port Forward?

Without port forwarding:
- ✅ You can connect TO other nodes
- ✅ You can search and participate
- ❌ Other nodes can't connect TO you
- ❌ Your node shows as "offline" on the gateway

With port forwarding:
- ✅ Full bidirectional connectivity
- ✅ Other nodes can query your index
- ✅ Shows as "online" on gateway
- ✅ Truly peer-to-peer

### How to Port Forward

**On your router:**

1. Log into router admin (usually http://192.168.1.1)
2. Find "Port Forwarding" or "Virtual Server"
3. Forward **TCP port 80** to your computer's local IP
4. Save and restart router

**Alternative**: Deploy on a VPS with a public IP (no NAT)

---

## 🔬 Technical Details

### Stack

- **Language**: JavaScript (ES Modules)
- **Runtime**: Node.js 18+
- **Dependencies**: **Zero** (only Node.js built-ins)
- **Database**: JSONL files (no external DB)
- **HTTP**: Native `node:http` and `node:https`
- **Storage**: Native `node:fs`

### Why Zero Dependencies?

- **Security**: No supply chain attacks
- **Simplicity**: Easy to audit and understand
- **Longevity**: No dependency rot
- **Lightweight**: Minimal installation size
- **Trust**: You can read every line of code

### Performance

On modest hardware (2 CPU, 2 GB RAM):
- Indexes **~5,000 sites/day** (5 req/sec, homepage-only)
- Search queries: **<100ms** (local), **<5s** (distributed)
- Storage: **~600 bytes per indexed site** (30-50x more efficient than page-level indexing)
- Memory: **~128 MB** during operation

### Safety & Security

**Is it safe to run OWD?** Yes, absolutely.

- **No executable downloads**: OWD only fetches HTML text from homepages, never executables, scripts, or binaries
- **No virus risk**: Homepage HTML is parsed as plain text and never executed
- **No malicious code**: HTML is analyzed for metadata only, JavaScript is never run
- **Zero dependencies**: No third-party packages that could contain malware
- **Open source**: All code is auditable on GitHub
- **Safe by design**: The crawler cannot download or execute harmful files
- **Homepage-only**: Only crawls domain root paths (/) for maximum safety

When OWD crawls a homepage, it downloads the HTML source (text), extracts title/description/sitemap/links, and discards everything else. It's like reading a phone book — just copying text, nothing more.

---

---

## 🧪 Development

### Running Tests

```bash
npm test
```

### Diagnostics

```bash
npm run diagnose
```

Checks:
- Node.js version
- File system permissions
- Module loading
- Store initialization
- Network connectivity

---

## 🤝 Contributing

OWD is open source and welcomes contributions!

### Ways to Contribute

- 🐛 **Report bugs**: Open an issue on GitHub
- 💡 **Suggest features**: Share your ideas
- 🔧 **Submit pull requests**: Improve the code
- 📖 **Improve documentation**: Help others understand OWD
- 🌐 **Run a node**: Grow the network
- 🚪 **Run a gateway**: Provide regional access

### Guidelines

- Keep dependencies at zero
- Maintain the lightweight philosophy
- Follow existing code style
- Test your changes
- Update documentation

---

## 📜 License

MIT License - see [LICENSE](LICENSE) file

---

## 🎯 Philosophy

### Why OWD Exists

Modern web search is dominated by a handful of companies with opaque algorithms and centralized control. OWD provides:

1. **Independence**: Run your own search infrastructure
2. **Transparency**: Open source, open data, open network
3. **Discovery**: Find websites, not just popular pages
4. **Research**: Structured data for AI agents and researchers
5. **Resilience**: No single point of failure

### Design Principles

- **Simplicity over complexity**: Easy to understand and run
- **Zero dependencies**: No external packages
- **Lightweight**: Runs on modest hardware
- **Distributed**: Power spread across the network
- **Ethical**: Respects websites and users
- **Open**: Anyone can participate

### What OWD is NOT

OWD is intentionally **not**:

- A Google competitor (we're a directory, not a ranking engine)
- A blockchain/crypto project (no tokens, no mining)
- Centrally controlled (anyone can run a network)
- Heavyweight infrastructure (runs on a Raspberry Pi)

---

## 🌟 Use Cases

### Developers & Automation

**Primary use case**: Programmatic access to website directory data

- **Application backends**: Power website discovery features
- **Data pipelines**: Feed raw website metadata into your systems
- **API integration**: Query your local node instead of external APIs
- **Custom search tools**: Build specialized discovery interfaces
- **Web monitoring**: Track website changes and new discoveries

**Example workflow:**
```bash
# Run your node
npm start

# Query from your application
curl "http://localhost/search?q=javascript+libraries&limit=50"

# Get JSON response
{
  "results": [
    {"url": "...", "title": "...", "description": "...", "score": 15},
    ...
  ]
}
```

### AI & Machine Learning

- Train models on web structure and metadata
- Generate datasets of website information
- Research web graph topology
- Build recommendation systems
- Create web discovery agents

### Research & Academia

- Study web crawler behavior
- Analyze link structures
- Archive website metadata
- Research distributed systems
- Academic web studies

### Organizations

- Internal website directory
- Private knowledge base indexing
- Team resource discovery
- Intranet cataloging

### Community & Privacy

- Alternative to centralized web directories
- No tracking, no surveillance
- Community-run infrastructure
- Open data initiatives


---

## 📞 Community

- **GitHub**: https://github.com/idev-games/open-web-directory
- **Issues**: https://github.com/idev-games/open-web-directory/issues
- **Discussions**: https://github.com/idev-games/open-web-directory/discussions

---

## ⚡ Quick Reference

### Start a Node
```bash
npm start
```

### Join Main Network
Default - just run `npm start`

### Create Private Network
Edit `src/config.js`:
```javascript
gateway: { peers: [] }
seeds: ["https://your-sites.com"]
```

### Search from CLI
```bash
curl "http://localhost/search?q=javascript"
```

### Check Network Status
```bash
curl http://localhost/network
```

### Diagnose Issues
```bash
npm run diagnose
```

---

**Built with ❤️ for the open web**

*The Open Web Directory - Making the web discoverable, one node at a time.*

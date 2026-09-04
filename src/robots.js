import http from 'node:http';
import https from 'node:https';

export class Robots {
  constructor(options = {}) {
    this.userAgent =
      options.userAgent || 'OpenWebDirectory/0.1';

    this.timeoutMs =
      options.timeoutMs || 10000;

    this.cache = new Map();

    this.defaultCrawlDelayMs =
      options.defaultCrawlDelayMs || 1000;
  }

  async allowed(url) {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;

    const rules = await this.getRules(origin);

    if (!rules) {
      // If robots.txt cannot be retrieved, remain conservative.
      return {
        allowed: true,
        crawlDelayMs: this.defaultCrawlDelayMs,
      };
    }

    return {
      allowed: this.isAllowed(parsedUrl.pathname, rules),
      crawlDelayMs: rules.crawlDelayMs ?? this.defaultCrawlDelayMs,
    };
  }

  async getRules(origin) {
    const cached = this.cache.get(origin);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.rules;
    }

    const robotsUrl = `${origin}/robots.txt`;

    let rules;

    try {
      const response = await this.fetchRobots(robotsUrl);

      if (response.statusCode === 404) {
        // No robots.txt means there are no robots rules.
        rules = {
          groups: [],
          crawlDelayMs: this.defaultCrawlDelayMs,
        };
      } else if (
        response.statusCode >= 200 &&
        response.statusCode < 300
      ) {
        rules = this.parse(response.body);
      } else {
        // Treat inaccessible robots.txt conservatively.
        rules = null;
      }
    } catch {
      rules = null;
    }

    this.cache.set(origin, {
      rules,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    return rules;
  }

  fetchRobots(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      const client =
        parsedUrl.protocol === 'https:'
          ? https
          : http;

      const request = client.get(
        parsedUrl,
        {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'text/plain',
          },
        },
        response => {
          const chunks = [];
          let size = 0;

          response.setEncoding('utf8');

          response.on('data', chunk => {
            size += Buffer.byteLength(chunk);

            // robots.txt should be tiny.
            if (size > 1024 * 1024) {
              request.destroy(
                new Error('robots.txt too large')
              );
              return;
            }

            chunks.push(chunk);
          });

          response.on('end', () => {
            resolve({
              statusCode: response.statusCode || 0,
              body: chunks.join(''),
            });
          });
        }
      );

      request.setTimeout(this.timeoutMs, () => {
        request.destroy(
          new Error('robots.txt request timed out')
        );
      });

      request.on('error', reject);
    });
  }

  parse(text) {
    const groups = [];

    let currentAgents = [];
    let currentRules = [];

    let crawlDelayMs = null;

    const lines = text.split(/\r?\n/);

    const finishGroup = () => {
      if (currentAgents.length === 0) {
        return;
      }

      groups.push({
        agents: currentAgents.map(agent =>
          agent.toLowerCase()
        ),
        rules: currentRules,
      });

      currentAgents = [];
      currentRules = [];
    };

    for (let line of lines) {
      // Remove comments.
      const commentIndex = line.indexOf('#');

      if (commentIndex !== -1) {
        line = line.slice(0, commentIndex);
      }

      line = line.trim();

      if (!line) {
        continue;
      }

      const separator = line.indexOf(':');

      if (separator === -1) {
        continue;
      }

      const directive = line
        .slice(0, separator)
        .trim()
        .toLowerCase();

      const value = line
        .slice(separator + 1)
        .trim();

      if (directive === 'user-agent') {
        /*
         * A new User-agent after rules means a new group.
         */
        if (currentRules.length > 0) {
          finishGroup();
        }

        if (value) {
          currentAgents.push(value);
        }

        continue;
      }

      if (
        directive === 'allow' ||
        directive === 'disallow'
      ) {
        currentRules.push({
          type: directive,
          path: value,
        });

        continue;
      }

      if (directive === 'crawl-delay') {
        const seconds = Number(value);

        if (
          Number.isFinite(seconds) &&
          seconds >= 0
        ) {
          crawlDelayMs = Math.min(
            seconds * 1000,
            24 * 60 * 60 * 1000
          );
        }
      }
    }

    finishGroup();

    return {
      groups,
      crawlDelayMs,
    };
  }

  isAllowed(pathname, robots) {
    const matchingGroups = robots.groups.filter(group =>
      group.agents.includes('*') ||
      group.agents.some(agent =>
        this.userAgent
          .toLowerCase()
          .includes(agent)
      )
    );

    if (matchingGroups.length === 0) {
      return true;
    }

    /*
     * Combine rules from all matching groups.
     */
    const rules = matchingGroups.flatMap(
      group => group.rules
    );

    let matchedRule = null;

    for (const rule of rules) {
      if (!rule.path) {
        continue;
      }

      if (!this.matchesPath(pathname, rule.path)) {
        continue;
      }

      /*
       * The longest matching rule wins.
       * If equally specific, Allow wins.
       */
      if (
        !matchedRule ||
        rule.path.length > matchedRule.path.length ||
        (
          rule.path.length === matchedRule.path.length &&
          rule.type === 'allow'
        )
      ) {
        matchedRule = rule;
      }
    }

    if (!matchedRule) {
      return true;
    }

    return matchedRule.type === 'allow';
  }

  matchesPath(pathname, pattern) {
    if (pattern === '/') {
      return true;
    }

    /*
     * Support the common robots.txt wildcards:
     *
     * * = anything
     * $ = end of URL
     */

    let regex = pattern
      .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');

    if (regex.endsWith('\\$')) {
      regex =
        regex.slice(0, -2) + '$';
    } else {
      regex = '^' + regex;
    }

    try {
      return new RegExp(regex).test(pathname);
    } catch {
      return false;
    }
  }

  clearCache() {
    this.cache.clear();
  }
}
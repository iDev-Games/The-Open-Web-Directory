export class CrawlQueue {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;

    // URLs waiting to be crawled.
    this.queue = [];

    // URLs currently waiting in the queue.
    this.queued = new Set();

    // URLs currently being crawled.
    this.active = new Set();
  }

  get size() {
    return this.queue.length;
  }

  get activeCount() {
    return this.active.size;
  }

  get isEmpty() {
    return this.queue.length === 0;
  }

  has(url) {
    return (
      this.queued.has(url) ||
      this.active.has(url)
    );
  }

  add(url, priority = false) {
    if (!url || typeof url !== 'string') {
      return false;
    }

    // Already queued or currently being processed.
    if (this.has(url)) {
      return false;
    }

    // If queue is full and this is a priority URL, drop from the end
    if (this.queue.length >= this.maxSize) {
      if (priority && this.queue.length > 0) {
        // Remove last item to make room
        const dropped = this.queue.pop();
        this.queued.delete(dropped);
      } else {
        return false;
      }
    }

    // Priority URLs go to front, normal URLs to back
    if (priority) {
      this.queue.unshift(url);
    } else {
      this.queue.push(url);
    }

    this.queued.add(url);

    return true;
  }

  addMany(urls) {
    let added = 0;

    for (const url of urls) {
      if (this.add(url)) {
        added++;
      }
    }

    return added;
  }

  next() {
    if (this.queue.length === 0) {
      return null;
    }

    const url = this.queue.shift();

    this.queued.delete(url);
    this.active.add(url);

    return url;
  }

  complete(url) {
    this.active.delete(url);
  }

  requeue(url) {
    if (!url || this.has(url)) {
      return false;
    }

    if (this.queue.length >= this.maxSize) {
      return false;
    }

    this.queue.push(url);
    this.queued.add(url);

    return true;
  }

  clear() {
    this.queue.length = 0;
    this.queued.clear();
    this.active.clear();
  }

  stats() {
    return {
      queued: this.queue.length,
      active: this.active.size,
      capacity: this.maxSize,
      available: Math.max(
        0,
        this.maxSize - this.queue.length
      ),
    };
  }
}
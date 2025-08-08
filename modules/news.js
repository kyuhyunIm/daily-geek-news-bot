const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 120000,
  maxRedirects: 5,
  headers: {
    "User-Agent":
      "daily-geek-news-bot/1.0 (+https://github.com/kyuhyunIm/daily-geek-news-bot)",
  },
});

const RSS_FEEDS = [
  {name: "GeekNewsFeed", url: "https://news.hada.io/rss/news"},
  {
    name: "LineTechNews",
    url: "https://techblog.lycorp.co.jp/ko/feed/index.xml",
  },
  {name: "CoupangNewsFeed", url: "https://medium.com/feed/coupang-engineering"},
  {name: "Toss Tech", url: "https://toss.tech/rss.xml"},
  {name: "DaangnNewsFeed", url: "https://medium.com/feed/daangn"},
];

let newsCache = {
  items: [],
  timestamp: null,
  isUpdating: false,
  initialized: false,
  TTL: 30 * 60 * 1000, // 30 minute TTL (milliseconds)
};

function isCacheExpired() {
  if (!newsCache.timestamp) {
    console.log("🕐 캐시 타임스탬프가 없습니다. 초기 로드가 필요합니다.");
    return true;
  }

  const now = Date.now();
  const elapsed = now - newsCache.timestamp;
  const isExpired = elapsed > newsCache.TTL;

  if (isExpired) {
    console.log(
      `🕐 캐시가 만료되었습니다. (${Math.round(
        elapsed / 1000
      )}초 경과, TTL: ${Math.round(newsCache.TTL / 1000)}초)`
    );
  }

  return isExpired;
}

async function updateNewsCache() {
  if (newsCache.isUpdating) {
    console.log("🔄 이미 뉴스 캐시 업데이트가 진행 중입니다.");
    return;
  }

  console.log("🚀 뉴스 캐시 업데이트를 시작합니다...");
  newsCache.isUpdating = true;

  try {
    const promises = RSS_FEEDS.map((feed) =>
      parser
        .parseURL(feed.url)
        .then((parsedFeed) =>
          parsedFeed.items.map((item) => ({...item, source: feed.name}))
        )
        .catch((error) => {
          console.error(`[${feed.name}] RSS 피드 파싱 오류:`, error.message);
          return [];
        })
    );

    const results = await Promise.all(promises);
    const allItems = results.flat();

    // Sort by latest date
    allItems.sort(
      (a, b) =>
        new Date(b.isoDate || b.pubDate) - new Date(a.isoDate || a.pubDate)
    );

    // Cache update
    newsCache.items = allItems;
    newsCache.timestamp = new Date();
    newsCache.initialized = true;
    console.log(
      `✅ 뉴스 캐시가 업데이트되었습니다. (총 ${allItems.length}개 항목)`
    );
  } catch (error) {
    console.error("❌ 뉴스 캐시 업데이트 중 심각한 오류 발생:", error);
  } finally {
    newsCache.isUpdating = false;
  }
}

function getNewsFromCache(count = 5, offset = 0) {
  if (isCacheExpired() && !newsCache.isUpdating) {
    console.log("🔄 캐시 갱신을 시작합니다...");
    updateNewsCache();
  }

  if (newsCache.items.length === 0) {
    console.log("📭 캐시가 비어있습니다. 업데이트 완료를 기다려주세요.");
    return [];
  }

  const result = newsCache.items.slice(offset, offset + count);
  console.log(
    `📰 캐시에서 뉴스 ${result.length}개를 반환합니다. (offset: ${offset})`
  );

  return result;
}

console.log("📚 News 모듈이 로드되었습니다. TTL 기반 캐시가 활성화되었습니다.");

module.exports = {
  getNewsFromCache,
  isCacheReady: () => newsCache.items.length > 0 && newsCache.initialized,
};

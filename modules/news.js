// modules/news.js
const Parser = require("rss-parser");
const parser = new Parser();

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
};

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
  if (newsCache.items.length === 0) {
    if (!newsCache.isUpdating && !newsCache.initialized) {
      updateNewsCache();
    }
    return [];
  }
  return newsCache.items.slice(offset, offset + count);
}

updateNewsCache();

setInterval(updateNewsCache, 15 * 60 * 1000);

module.exports = {
  getNewsFromCache,
  isCacheReady: () => newsCache.items.length > 0 && newsCache.initialized,
  getCacheStats: () => ({
    itemCount: newsCache.items.length,
    lastUpdate: newsCache.timestamp,
    isUpdating: newsCache.isUpdating,
    initialized: newsCache.initialized,
  }),
};

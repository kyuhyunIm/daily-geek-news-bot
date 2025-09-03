const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 10000, // 10초로 단축 (빠른 응답 우선)
  maxRedirects: 2,
  headers: {
    "User-Agent": "daily-geek-news-bot/2.0",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
    "Accept-Encoding": "gzip, deflate",
    Connection: "keep-alive",
  },
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "creator"],
    ],
  },
  // XML 파싱 에러 처리를 위한 옵션
  xml2js: {
    strict: false, // 엄격한 XML 검증 비활성화
    normalize: true,
    normalizeTags: true,
    explicitArray: false,
  },
});

// 간단한 인메모리 캐시 (Cloud Run 인스턴스 생존 시간 동안만 유효)
class SimpleCache {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 10 * 60 * 1000; // 10분 (Cloud Run 인스턴스 유지 시간 고려)
  }

  get(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  set(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  getAll() {
    const items = [];
    const now = Date.now();

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp <= this.CACHE_TTL) {
        items.push(...value.data);
      } else {
        this.cache.delete(key);
      }
    }

    return items;
  }
}

const cache = new SimpleCache();

// 로딩 상태 관리 (Cloud Run에서도 필요)
let isCurrentlyLoading = false;
let loadingStartTime = null;

// 개선된 RSS 파싱 (에러 처리 강화)
async function parseRSSFeedSafe(feed, itemsPerFeed) {
  const startTime = Date.now();

  // 캐시 확인
  const cached = cache.get(feed.url);
  if (cached) {
    console.log(`📦 [${feed.name}] 캐시 히트 (${cached.length}개)`);
    return cached;
  }

  try {
    // fetch로 먼저 응답 확인 (옵션)
    const testResponse = await fetch(feed.url, {
      method: "HEAD",
      timeout: 3000,
    }).catch(() => null);

    if (testResponse && !testResponse.ok) {
      console.warn(`⚠️ [${feed.name}] HTTP ${testResponse.status}`);
      return [];
    }

    // RSS 파싱 시도
    const parsedFeed = await parser.parseURL(feed.url);

    // 아이템이 없으면 빈 배열 반환
    if (!parsedFeed.items || parsedFeed.items.length === 0) {
      console.warn(`⚠️ [${feed.name}] 아이템 없음`);
      return [];
    }

    const items = parsedFeed.items
      .slice(0, itemsPerFeed)
      .map((item) => ({
        title: item.title || "No title",
        link: item.link || item.guid || "",
        pubDate: item.pubDate || item.isoDate,
        isoDate: item.isoDate || item.pubDate,
        source: feed.name,
        contentSnippet: item.contentSnippet || "",
      }))
      .filter((item) => item.link); // 링크가 없는 아이템 필터링

    // 캐시에 저장
    cache.set(feed.url, items);

    const duration = Date.now() - startTime;
    console.log(`✅ [${feed.name}] 성공 (${duration}ms, ${items.length}개)`);

    return items;
  } catch (error) {
    const duration = Date.now() - startTime;

    // 구체적인 에러 로깅
    if (error.message.includes("Non-whitespace before first tag")) {
      console.error(`❌ [${feed.name}] HTML/잘못된 형식 응답 (${duration}ms)`);
    } else if (error.message.includes("Unable to parse XML")) {
      console.error(`❌ [${feed.name}] XML 파싱 실패 (${duration}ms)`);
    } else if (error.message.includes("timeout")) {
      console.error(`❌ [${feed.name}] 타임아웃 (${duration}ms)`);
    } else {
      console.error(`❌ [${feed.name}] ${error.message} (${duration}ms)`);
    }

    return []; // 실패해도 빈 배열 반환 (다른 피드 처리 계속)
  }
}

// RSS 피드 목록 (안정성 순으로 정렬)
const RSS_FEEDS = [
  {name: "Toss Tech", url: "https://toss.tech/rss.xml"},
  {name: "GeekNewsFeed", url: "https://news.hada.io/rss/news"},
  {
    name: "LineTechNews",
    url: "https://techblog.lycorp.co.jp/ko/feed/index.xml",
  },
  {
    name: "CoupangNewsFeed",
    url: "https://medium.com/feed/coupang-engineering",
  },
  {name: "DaangnNewsFeed", url: "https://medium.com/feed/daangn"},
];

// 병렬 처리 with 빠른 실패
async function fetchWithFastFail(feeds, itemsPerFeed) {
  // Promise.allSettled로 모든 피드 시도
  const promises = feeds.map((feed) =>
    Promise.race([
      parseRSSFeedSafe(feed, itemsPerFeed),
      new Promise(
        (resolve) => setTimeout(() => resolve([]), 8000) // 8초 타임아웃
      ),
    ])
  );

  const results = await Promise.allSettled(promises);

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    } else {
      console.error(`❌ [${feeds[index].name}] 처리 실패`);
      return [];
    }
  });
}

// Cloud Run 최적화된 뉴스 가져오기
async function fetchAllNewsCloudRun(limit = null) {
  const startTime = Date.now();

  try {
    // 1. 캐시 확인 (인스턴스가 살아있는 경우)
    const cachedItems = cache.getAll();
    if (cachedItems.length > 0) {
      console.log(`⚡ 캐시 히트! ${cachedItems.length}개 아이템`);

      // 정렬 및 필터링
      const sortedItems = cachedItems
        .filter((item) => item.pubDate || item.isoDate)
        .sort((a, b) => {
          const dateA = new Date(a.isoDate || a.pubDate);
          const dateB = new Date(b.isoDate || b.pubDate);
          return dateB - dateA;
        });

      const duration = Date.now() - startTime;
      console.log(`✅ 캐시 응답 시간: ${duration}ms`);

      return limit ? sortedItems.slice(0, limit) : sortedItems;
    }

    // 2. 캐시 미스 - 새로 가져오기
    if (isCurrentlyLoading) {
      const loadingTime = Math.floor((Date.now() - loadingStartTime) / 1000);
      console.log(`⏳ 이미 로딩 중 (${loadingTime}초 경과)`);
      return [];
    }

    isCurrentlyLoading = true;
    loadingStartTime = Date.now();
    console.log("🔄 캐시 미스, 새로 가져오는 중...");

    const TOTAL_TARGET = 100;
    const itemsPerFeed = Math.ceil(TOTAL_TARGET / RSS_FEEDS.length);

    // 두 그룹으로 나누어 처리 (빠른 응답)
    const fastFeeds = RSS_FEEDS.slice(0, 2); // 안정적인 피드 먼저
    const slowFeeds = RSS_FEEDS.slice(2);

    // 빠른 피드 먼저 처리
    const fastResults = await fetchWithFastFail(fastFeeds, itemsPerFeed);
    const fastItems = fastResults.flat();

    // 빠른 결과가 있으면 먼저 반환하고 나머지는 백그라운드
    if (fastItems.length > 0) {
      console.log(
        `⚡ 빠른 응답: ${fastItems.length}개 (나머지 백그라운드 처리)`
      );

      // 백그라운드로 나머지 처리 (await 없이)
      fetchWithFastFail(slowFeeds, itemsPerFeed)
        .then((slowResults) => {
          const slowItems = slowResults.flat();
          console.log(`📦 백그라운드 완료: ${slowItems.length}개 추가`);
        })
        .catch((err) => {
          console.error("백그라운드 처리 실패:", err);
        });

      // 정렬 및 필터링
      const sortedItems = fastItems
        .filter((item) => item.pubDate || item.isoDate)
        .sort((a, b) => {
          const dateA = new Date(a.isoDate || a.pubDate);
          const dateB = new Date(b.isoDate || b.pubDate);
          return dateB - dateA;
        });

      const duration = Date.now() - startTime;
      console.log(`✅ 빠른 응답 시간: ${duration}ms`);

      return limit ? sortedItems.slice(0, limit) : sortedItems;
    }

    // 모든 피드 처리
    const allResults = await fetchWithFastFail(RSS_FEEDS, itemsPerFeed);
    const allItems = allResults.flat();

    // 정렬 및 필터링
    const sortedItems = allItems
      .filter((item) => item.pubDate || item.isoDate)
      .sort((a, b) => {
        const dateA = new Date(a.isoDate || a.pubDate);
        const dateB = new Date(b.isoDate || b.pubDate);
        return dateB - dateA;
      });

    const duration = Date.now() - startTime;
    console.log(`✅ 전체 처리 시간: ${duration}ms (${sortedItems.length}개)`);

    return limit ? sortedItems.slice(0, limit) : sortedItems;
  } catch (error) {
    console.error("❌ 뉴스 가져오기 실패:", error);
    return [];
  } finally {
    isCurrentlyLoading = false;
    loadingStartTime = null;
  }
}

// 캐시 상태 확인
function getCacheStatus() {
  const allCached = cache.getAll();
  const feedStatus = {};

  for (const feed of RSS_FEEDS) {
    const items = cache.get(feed.url);
    feedStatus[feed.name] = items ? items.length : 0;
  }

  return {
    totalCached: allCached.length,
    feeds: feedStatus,
    isLoading: isCurrentlyLoading,
    loadingTime:
      isCurrentlyLoading && loadingStartTime
        ? Math.floor((Date.now() - loadingStartTime) / 1000)
        : 0,
    cacheAge:
      cache.cache.size > 0
        ? Math.floor(
            (Date.now() -
              Math.min(
                ...Array.from(cache.cache.values()).map((v) => v.timestamp)
              )) /
              1000
          )
        : 0,
  };
}

// 로딩 상태 확인
function isLoadingNews() {
  return isCurrentlyLoading;
}

module.exports = {
  fetchAllNews: fetchAllNewsCloudRun,
  getCacheStatus,
  isLoadingNews,
};

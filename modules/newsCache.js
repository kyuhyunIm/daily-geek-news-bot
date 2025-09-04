const Parser = require("rss-parser");
const axios = require("axios");

const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "creator"],
    ],
  },
});

// Axios 인스턴스 생성 (Cloud Run 최적화)
const httpClient = axios.create({
  timeout: 12000, // 12초 타임아웃 (빠른 응답 우선)
  maxRedirects: 3,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; daily-geek-news-bot/2.0; +https://daily-geek-news-bot.com)",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
  },
  validateStatus: function (status) {
    return status >= 200 && status < 300; // default
  },
});

// 간단한 인메모리 캐시 (Cloud Run 인스턴스 생존 시간 동안만 유효)
class SimpleCache {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 10 * 60 * 1000; // 10분 (Cloud Run 인스턴스 유지 시간 고려)
    this.feedStats = new Map(); // 피드별 통계 저장
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

// 개선된 RSS 파싱 (axios 사용)
async function parseRSSFeedSafe(feed, itemsPerFeed) {
  const startTime = Date.now();

  // 캐시 확인
  const cached = cache.get(feed.url);
  if (cached) {
    console.log(`📦 [${feed.name}] 캐시 히트 (${cached.length}개)`);
    return cached;
  }

  try {
    console.log(`🔄 [${feed.name}] RSS 파싱 시작...`);

    // axios로 XML 데이터 먼저 가져오기 (재시도 로직 포함)
    let xmlData;
    let lastError;

    // 최대 3번 시도 (각 시도마다 확실한 완료 대기)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 [${feed.name}] 시도 ${attempt}/3 (XML 다운로드 시작)`);

        const response = await httpClient.get(feed.url, {
          responseType: "text", // XML을 text로 받음
        });

        if (!response.data || response.data.trim().length === 0) {
          throw new Error("Empty response data");
        }

        xmlData = response.data;
        console.log(
          `📥 [${feed.name}] XML 다운로드 완료 (${Math.floor(
            xmlData.length / 1024
          )}KB)`
        );
        break; // 성공하면 루프 종료
      } catch (err) {
        lastError = err;
        const errorMsg = err.code === "ECONNABORTED" ? "타임아웃" : err.message;

        if (attempt < 3) {
          const waitTime = attempt * 1000; // 점진적 백오프 (1초, 2초)
          console.warn(
            `⚠️ [${feed.name}] 시도 ${attempt} 실패 (${errorMsg}), ${waitTime}ms 후 재시도...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        } else {
          console.error(`❌ [${feed.name}] 모든 시도 실패 (${errorMsg})`);
        }
      }
    }

    if (!xmlData) {
      throw lastError || new Error("Failed to fetch XML data");
    }

    // RSS-parser로 XML 파싱
    const parsedFeed = await parser.parseString(xmlData);

    // 아이템이 없으면 빈 배열 반환
    if (!parsedFeed.items || parsedFeed.items.length === 0) {
      console.warn(`⚠️ [${feed.name}] 아이템 없음`);
      return [];
    }

    // 원본 피드의 아이템 수 로깅
    console.log(
      `📊 [${feed.name}] 원본 피드: ${parsedFeed.items.length}개 아이템`
    );

    // 먼저 필터링을 수행 (link가 있는 아이템만)
    const validItems = parsedFeed.items.filter(
      (item) => item.link || item.guid
    );
    console.log(
      `🔗 [${feed.name}] 유효한 아이템: ${validItems.length}개 (link 있음)`
    );

    // 필요한 수만큼 가져오기
    const items = validItems.slice(0, itemsPerFeed).map((item) => ({
      title: item.title || "No title",
      link: item.link || item.guid || "",
      pubDate: item.pubDate || item.isoDate,
      isoDate: item.isoDate || item.pubDate,
      source: feed.name,
      contentSnippet: item.contentSnippet || "",
    }));

    // 캐시에 저장
    cache.set(feed.url, items);

    // 피드 통계 저장
    cache.feedStats.set(feed.name, {
      original: parsedFeed.items.length,
      valid: validItems.length,
      returned: items.length,
      requested: itemsPerFeed,
    });

    const duration = Date.now() - startTime;
    console.log(
      `✅ [${feed.name}] 성공 (${duration}ms, 최종: ${items.length}/${itemsPerFeed}개)`
    );

    return items;
  } catch (error) {
    const duration = Date.now() - startTime;

    // 구체적인 에러 로깅
    if (error.response?.status) {
      console.error(
        `❌ [${feed.name}] HTTP ${error.response.status} (${duration}ms)`
      );
    } else if (error.message.includes("Non-whitespace before first tag")) {
      console.error(`❌ [${feed.name}] HTML/잘못된 형식 응답 (${duration}ms)`);
    } else if (
      error.message.includes("Unable to parse XML") ||
      error.message.includes("Unexpected end")
    ) {
      console.error(
        `❌ [${feed.name}] XML 파싱 실패 (${duration}ms) - 데이터 잘림 가능`
      );
    } else if (
      error.code === "ECONNABORTED" ||
      error.message.includes("timeout")
    ) {
      console.error(`❌ [${feed.name}] 타임아웃 (${duration}ms)`);
    } else if (error.code === "ENOTFOUND" || error.code === "ECONNRESET") {
      console.error(`❌ [${feed.name}] 네트워크 연결 오류 (${duration}ms)`);
    } else {
      console.error(`❌ [${feed.name}] ${error.message} (${duration}ms)`);
    }

    return []; // 실패해도 빈 배열 반환 (다른 피드 처리 계속)
  }
}

// RSS 피드 목록 (안정성 순으로 정렬)
const RSS_FEEDS = [
  {name: "Toss Tech", url: "https://toss.tech/rss.xml"},
  {name: "Hacker News", url: "https://hnrss.org/frontpage"},
  {name: "Dev.to", url: "https://dev.to/feed"},
  {name: "GitHub Blog", url: "https://github.blog/feed/"},
  {name: "CSS Tricks", url: "https://css-tricks.com/feed/"},
  {name: "Smashing Magazine", url: "https://www.smashingmagazine.com/feed/"},
  {name: "A List Apart", url: "https://alistapart.com/main/feed/"},
  {name: "SitePoint", url: "https://www.sitepoint.com/feed/"},
];

// 병렬 처리 - 모든 피드 완료까지 대기 (개별 타임아웃 제거)
async function fetchWithFastFail(feeds, itemsPerFeed) {
  console.log(`🔄 ${feeds.length}개 피드 병렬 파싱 시작 (개별 완료까지 대기)`);

  // Promise.allSettled로 모든 피드가 완전히 완료될 때까지 대기
  const promises = feeds.map((feed) => parseRSSFeedSafe(feed, itemsPerFeed));
  const results = await Promise.allSettled(promises);

  let successCount = 0;
  let totalItems = 0;

  const processedResults = results.map((result, index) => {
    if (result.status === "fulfilled") {
      successCount++;
      totalItems += result.value.length;
      return result.value;
    } else {
      console.error(
        `❌ [${feeds[index].name}] Promise 처리 실패: ${result.reason}`
      );
      return [];
    }
  });

  console.log(
    `📊 피드 파싱 완료: ${successCount}/${feeds.length} 성공, 총 ${totalItems}개 아이템`
  );
  return processedResults;
}

// Cloud Run 최적화된 뉴스 가져오기
async function fetchAllNewsCloudRun(limit = null) {
  const startTime = Date.now();

  try {
    // 1. 로딩 상태 우선 확인 (캐시 확인 전에)
    if (isCurrentlyLoading) {
      const loadingTime = Math.floor((Date.now() - loadingStartTime) / 1000);
      console.log(`⏳ 이미 로딩 중 (${loadingTime}초 경과)`);
      return [];
    }

    // 2. 캐시 확인 (인스턴스가 살아있는 경우)
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

    // 3. 캐시 미스 - 새로 가져오기 (로딩 상태 설정)
    isCurrentlyLoading = true;
    loadingStartTime = Date.now();
    console.log("🔄 캐시 미스, RSS 피드 파싱 시작...");

    const TOTAL_TARGET = 100;

    // 첫 번째 시도: 각 피드당 목표 개수 가져오기
    const itemsPerFeed = Math.ceil(TOTAL_TARGET / RSS_FEEDS.length);
    console.log(`🎯 목표: 각 피드에서 ${itemsPerFeed}개 수집`);

    // 모든 피드 한번에 처리
    const allResults = await fetchWithFastFail(RSS_FEEDS, itemsPerFeed);
    let allItems = allResults.flat();

    // 피드별 수집 현황 확인
    if (cache.feedStats.size > 0) {
      console.log("📊 피드별 수집 결과:");
      let totalCollected = 0;
      const underperformingFeeds = [];
      const wellPerformingFeeds = [];

      for (const [name, stats] of cache.feedStats) {
        totalCollected += stats.returned;
        console.log(
          `${name}: ${stats.returned}/${itemsPerFeed}개 (원본: ${stats.original}개)`
        );

        if (stats.returned < itemsPerFeed && stats.original < itemsPerFeed) {
          underperformingFeeds.push(name);
        } else if (stats.original >= itemsPerFeed * 2) {
          wellPerformingFeeds.push({
            name,
            available: stats.original - stats.returned,
          });
        }
      }

      // 부족한 피드가 있고 충분한 데이터를 가진 피드가 있으면 보충
      if (underperformingFeeds.length > 0 && wellPerformingFeeds.length > 0) {
        const shortfall = underperformingFeeds.length * (itemsPerFeed - 10); // 각 부족 피드당 약 10개 부족
        const extraPerFeed = Math.ceil(shortfall / wellPerformingFeeds.length);

        console.log(
          `🔄 ${wellPerformingFeeds
            .map((f) => f.name)
            .join(", ")}에서 추가 ${extraPerFeed}개씩 수집 시도`
        );

        // 충분한 아이템이 있는 피드들에서 추가로 가져오기
        const feedsToReparse = RSS_FEEDS.filter((f) =>
          wellPerformingFeeds.some((wf) => wf.name === f.name)
        );
        const extraResults = await fetchWithFastFail(
          feedsToReparse,
          itemsPerFeed + extraPerFeed
        );

        // 중복 제거하며 병합
        const existingLinks = new Set(allItems.map((item) => item.link));
        const newItems = extraResults
          .flat()
          .filter((item) => !existingLinks.has(item.link));

        if (newItems.length > 0) {
          allItems = [...allItems, ...newItems];
          console.log(
            `✅ ${newItems.length}개 추가 아이템 수집 완료 (총 ${allItems.length}개)`
          );
        }
      }

      console.log(`📈 최종 수집: ${allItems.length}개 아이템`);
    }

    // 정렬 및 필터링
    const sortedItems = allItems
      .filter((item) => item.pubDate || item.isoDate)
      .sort((a, b) => {
        const dateA = new Date(a.isoDate || a.pubDate);
        const dateB = new Date(b.isoDate || b.pubDate);
        return dateB - dateA;
      });

    const duration = Date.now() - startTime;
    console.log(`✅ RSS 파싱 완료: ${duration}ms (${sortedItems.length}개)`);

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

// 뉴스 검색 함수
async function searchNews(keyword, limit = null) {
  const allNews = await fetchAllNewsCloudRun();

  if (!keyword || keyword.trim().length === 0) {
    return limit ? allNews.slice(0, limit) : allNews;
  }

  const searchTerm = keyword.toLowerCase().trim();
  const filteredNews = allNews.filter((item) => {
    const titleMatch = item.title.toLowerCase().includes(searchTerm);
    const contentMatch =
      item.contentSnippet &&
      item.contentSnippet.toLowerCase().includes(searchTerm);
    const sourceMatch = item.source.toLowerCase().includes(searchTerm);

    return titleMatch || contentMatch || sourceMatch;
  });

  console.log(`🔍 검색어 "${keyword}": ${filteredNews.length}개 결과`);

  return limit ? filteredNews.slice(0, limit) : filteredNews;
}

// 로딩 상태 확인
function isLoadingNews() {
  return isCurrentlyLoading;
}

module.exports = {
  fetchAllNews: fetchAllNewsCloudRun,
  searchNews,
  getCacheStatus,
  isLoadingNews,
};

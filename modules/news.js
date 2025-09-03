const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 120000,
  maxRedirects: 5,
  headers: {
    "User-Agent":
      "daily-geek-news-bot/1.0 (+https://github.com/kyuhyunIm/daily-geek-news-bot)",
    Accept: "application/rss+xml, application/xml, text/xml",
    Connection: "close",
  },
});

async function parseRSSWithRetry(feed, maxRetries = 3) {
  const startTime = Date.now();
  console.log(`🌐 [${feed.name}] RSS 피드 파싱을 시작합니다...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      const duration = Date.now() - startTime;
      console.log(
        `✅ [${feed.name}] RSS 피드 파싱 완료 (${duration}ms, ${parsedFeed.items.length}개 아이템, 시도: ${attempt}/${maxRetries})`
      );

      return parsedFeed.items.map((item) => ({...item, source: feed.name}));
    } catch (error) {
      const duration = Date.now() - startTime;
      const isLastAttempt = attempt === maxRetries;

      const retryableErrors = [
        "socket hang up",
        "ECONNRESET",
        "ETIMEDOUT",
        "ENOTFOUND",
        "ECONNREFUSED",
        "timeout",
      ];

      const shouldRetry = retryableErrors.some((err) =>
        error.message.toLowerCase().includes(err.toLowerCase())
      );

      if (shouldRetry && !isLastAttempt) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.warn(
          `⚠️ [${feed.name}] 파싱 실패 (${duration}ms, 시도: ${attempt}/${maxRetries}): ${error.message}`
        );
        console.log(`🔄 [${feed.name}] ${delay}ms 후 재시도합니다...`);

        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      console.error(
        `❌ [${feed.name}] RSS 피드 파싱 최종 실패 (${duration}ms, 시도: ${attempt}/${maxRetries}): ${error.message}`
      );

      if (error.message.includes("socket hang up")) {
        console.error(
          `🔌 [${feed.name}] Socket hang up - 서버 연결이 예기치 않게 종료됨`
        );
      } else if (error.message.includes("timeout")) {
        console.error(`⏱️ [${feed.name}] 타임아웃 발생 - 120초 초과`);
      }

      return [];
    }
  }
}

const RSS_FEEDS = [
  {name: "GeekNewsFeed", url: "https://news.hada.io/rss/news"},
  {
    name: "LineTechNews",
    url: "https://techblog.lycorp.co.jp/ko/feed/index.xml",
  },
  {
    name: "CoupangNewsFeed",
    url: "https://medium.com/feed/coupang-engineering",
  },
  {name: "Toss Tech", url: "https://toss.tech/rss.xml"},
  {name: "DaangnNewsFeed", url: "https://medium.com/feed/daangn"},
];

let isLoadingNews = false;

async function fetchAllNews(limit = null) {
  if (isLoadingNews) {
    console.log("🔄 이미 뉴스를 불러오는 중입니다.");
    return [];
  }

  console.log("🚀 전체 뉴스를 불러옵니다...");
  isLoadingNews = true;

  try {
    const promises = RSS_FEEDS.map((feed) => parseRSSWithRetry(feed));
    const results = await Promise.all(promises);
    const allItems = results.flat();

    // 유효한 날짜를 가진 아이템만 필터링
    const validItems = allItems.filter((item) => {
      if (!item.isoDate && !item.pubDate) return false;
      const date = new Date(item.isoDate || item.pubDate);
      return !isNaN(date.getTime());
    });

    // 날짜순 정렬 (최신순)
    validItems.sort(
      (a, b) =>
        new Date(b.isoDate || b.pubDate) - new Date(a.isoDate || a.pubDate)
    );

    const resultItems = limit ? validItems.slice(0, limit) : validItems;

    console.log(
      `✅ 전체 뉴스 ${resultItems.length}개를 불러왔습니다. (유효한 아이템: ${validItems.length}개)`
    );
    return resultItems;
  } catch (error) {
    console.error("❌ 전체 뉴스를 불러오는 중 오류 발생:", error);
    return [];
  } finally {
    isLoadingNews = false;
  }
}

console.log("📚 News 모듈이 로드되었습니다. 실시간 뉴스 가져오기 모드입니다.");

module.exports = {
  fetchAllNews,
  isLoadingNews: () => isLoadingNews,
};

// modules/news.js
const Parser = require("rss-parser");
const parser = new Parser();

const RSS_FEEDS = [
  {name: "GeekNewsFeed", url: "https://news.hada.io/rss/news"},
  {
    name: "LineTechNews",
    url: "https://techblog.lycorp.co.jp/ko/feed/index.xml",
  },
  {name: "D2", url: "https://d2.naver.com/d2.atom"},
  {name: "CoupangNewsFeed", url: "https://medium.com/feed/coupang-engineering"},
  {name: "WoowahanTechBlog", url: "https://techblog.woowahan.com/feed/"},
  {name: "Toss Tech", url: "https://toss.tech/rss.xml"},
  {name: "DaangnNewsFeed", url: "https://medium.com/feed/daangn"},
];

/**
 * Function to retrieve news from RSS feeds
 * @param {number} count - Number of news items to fetch
 * @param {number} offset - Number of news items to skip (pagination)
 * @returns {Promise<Array>} News item arrangement
 */
async function getNews(count = 3, offset = 0) {
  const allItems = [];

  // Improve speed by processing all feeds asynchronously at once.
  const promises = RSS_FEEDS.map(async (feed) => {
    try {
      // To ensure sufficient news items, we take 20 items from each feed.
      const parsedFeed = await parser.parseURL(feed.url);
      const items = parsedFeed.items
        .slice(0, 20) // Get enough posts from each feed
        .map((item) => ({...item, source: feed.name}));
      return items;
    } catch (error) {
      console.error(
        `[${feed.name}] RSS 피드를 가져오는 중 오류 발생:`,
        error.message
      );
      return []; // Returns an empty array when an error occurs.
    }
  });

  const results = await Promise.all(promises);
  results.forEach((items) => allItems.push(...items));

  // Sort all items by latest date
  allItems.sort(
    (a, b) =>
      new Date(b.isoDate || b.pubDate) - new Date(a.isoDate || a.pubDate)
  );

  // Return the final result by applying offset and count.
  return allItems.slice(offset, offset + count);
}

module.exports = {getNews};

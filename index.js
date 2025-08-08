require("dotenv").config();
const {App} = require("@slack/bolt");
const http = require("http");
const {getNewsFromCache, isCacheReady} = require("./modules/news");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: process.env.NODE_ENV === "development" ? "DEBUG" : "INFO",
});

app.client.on("socket_mode_disconnect", () => {
  console.log("🔌 Socket Mode 연결이 끊어졌습니다.");
});

app.client.on("socket_mode_connect", () => {
  console.log("✅ Socket Mode 연결이 복구되었습니다.");
});

/**
 * Function that formats news items to Slack-compatible text block
 * @param {Object} item - News item
 * @returns {Object} Formatted block
 */
function formatNewsItem(item) {
  const {title, link, isoDate, pubDate, source} = item;
  const date = isoDate || pubDate;
  const formattedDate = new Date(date).toLocaleDateString("ko-KR");

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*<${link}|${title.trim()}>*\n_${source} | ${formattedDate}_`,
    },
  };
}

/**
 * Function that generates Slack message blocks based on the news list and current offset
 * @param {Array} newsItems - Arrangement of news items to be displayed
 * @param {number} currentOffset - Current news start position
 * @returns {Array} Slack message block
 */
function formatNewsToBlocks(newsItems, currentOffset = 0) {
  const isInitial = currentOffset === 0;
  const headerText = isInitial
    ? `📰 오늘의 최신 기술 뉴스`
    : `📰 이전 기술 뉴스 (결과 ${currentOffset + 1} - ${
        currentOffset + newsItems.length
      })`;

  const blocks = [
    {
      type: "header",
      text: {type: "plain_text", text: headerText, emoji: true},
    },
    {type: "divider"},
  ];

  if (newsItems.length === 0) {
    blocks.push({
      type: "section",
      text: {type: "mrkdwn", text: "🔍 더 이상 표시할 뉴스가 없습니다."},
    });
  }

  newsItems.forEach((item) => {
    blocks.push(formatNewsItem(item));
  });

  blocks.push({type: "divider"});

  const actions = [];
  if (newsItems.length > 0) {
    actions.push({
      type: "button",
      text: {type: "plain_text", text: "더 이전 뉴스 보기 ➡️", emoji: true},
      value: `load_news_${currentOffset + 5}`,
      action_id: "load_older_news",
    });
  }

  actions.push({
    type: "button",
    text: {type: "plain_text", text: "처음으로 🏠", emoji: true},
    value: "load_news_0",
    action_id: "load_first_news",
  });

  blocks.push({
    type: "actions",
    elements: actions,
  });

  return blocks;
}

app.command("/뉴스", async ({ack, respond}) => {
  const startTime = Date.now();

  await ack();

  try {
    if (!isCacheReady()) {
      await respond({
        response_type: "ephemeral",
        text: "⏳ 뉴스를 처음으로 불러오는 중입니다... 잠시만 기다려주세요. (최대 1분 소요)",
      });

      const waitForCache = () =>
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (isCacheReady()) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 1000);

          setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
          }, 60000);
        });

      await waitForCache();
    }

    const newsItems = getNewsFromCache(5, 0);
    if (newsItems.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: "😭 뉴스를 불러오는 데 실패했습니다. 잠시 후 다시 시도해주세요.",
      });
      return;
    }

    const messageBlocks = formatNewsToBlocks(newsItems, 0);

    const duration = Date.now() - startTime;
    console.log(`📊 /뉴스 명령어 처리 완료 (처리시간: ${duration}ms)`);

    await respond({
      response_type: "in_channel",
      text: "최신 테크 뉴스입니다!",
      blocks: messageBlocks,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(
      `❌ /뉴스 명령어 처리 중 오류 발생 (처리시간: ${duration}ms):`,
      error
    );
    await respond({
      response_type: "ephemeral",
      text: "😭 오류가 발생하여 뉴스를 가져올 수 없습니다.",
    });
  }
});

app.event("app_mention", async ({event, client}) => {
  const startTime = Date.now();

  try {
    console.log(
      `🏷️ 봇 멘션 이벤트: 채널 ${event.channel}, 사용자 ${event.user}`
    );

    const mentionText = event.text.toLowerCase();

    let responseBlocks;
    let responseText;

    if (mentionText.includes("뉴스") || mentionText.includes("news")) {
      if (!isCacheReady()) {
        responseText =
          "⏳ 뉴스 데이터를 불러오는 중입니다... 잠시만 기다려주세요.";
        responseBlocks = [
          {
            type: "section",
            text: {type: "mrkdwn", text: responseText},
          },
        ];
      } else {
        const newsItems = getNewsFromCache(5, 0);
        if (newsItems.length > 0) {
          responseText = "📰 최신 기술 뉴스를 가져왔습니다!";
          responseBlocks = formatNewsToBlocks(newsItems, 0);
        } else {
          responseText = "😭 현재 불러올 뉴스가 없습니다.";
          responseBlocks = [
            {
              type: "section",
              text: {type: "mrkdwn", text: responseText},
            },
          ];
        }
      }
    } else if (mentionText.includes("도움") || mentionText.includes("help")) {
      responseText = "🤖 Daily Geek News Bot 사용법";
      responseBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*🤖 Daily Geek News Bot 사용법*\n\n" +
              "• `/뉴스` - 최신 기술 뉴스 5개 조회\n" +
              "• `@봇이름 뉴스` - 멘션으로 뉴스 요청\n" +
              "• `@봇이름 도움` - 사용법 안내",
          },
        },
        {type: "divider"},
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*📊 뉴스 소스*\n" +
              "GeekNewsFeed, LINE Tech, Coupang Engineering, Toss Tech, 당근 Tech",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "매주 월~금 오전 9시에 자동으로 뉴스를 전송합니다 ⏰",
            },
          ],
        },
      ];
    } else {
      // 일반 멘션 - 기본 인사 메시지
      responseText = "👋 안녕하세요! Daily Geek News Bot입니다.";
      responseBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*👋 안녕하세요! Daily Geek News Bot입니다.*\n\n" +
              "최신 기술 뉴스를 전달해드립니다! 🚀\n\n" +
              "`@봇이름 도움말`을 입력하시면 사용법을 안내해드릴게요.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🆕 최신 뉴스 보기",
                emoji: true,
              },
              value: "load_news_0",
              action_id: "load_first_news",
            },
          ],
        },
      ];
    }

    await client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: event.channel,
      text: responseText,
      blocks: responseBlocks,
    });

    const duration = Date.now() - startTime;
    console.log(`✅ 봇 멘션 응답 완료 (처리시간: ${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(
      `❌ 봇 멘션 처리 중 오류 발생 (처리시간: ${duration}ms):`,
      error
    );

    try {
      await client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: event.channel,
        text: "😭 죄송합니다. 요청을 처리하는 중 오류가 발생했습니다.",
      });
    } catch (fallbackError) {
      console.error(`❌ 폴백 메시지 전송 실패:`, fallbackError);
    }
  }
});

app.action("load_older_news", async ({action, ack, respond}) => {
  await ack();

  console.log(`🔧 [load_older_news] 버튼 클릭됨, value: ${action.value}`);
  const offset = parseInt(action.value.replace("load_news_", ""), 10);

  try {
    const newsItems = getNewsFromCache(5, offset);

    if (newsItems.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: "📰 더 이상 표시할 뉴스가 없습니다.",
      });
      return;
    }

    const newBlocks = formatNewsToBlocks(newsItems, offset);

    await respond({
      replace_original: true,
      text: `이전 테크 뉴스입니다! (${offset + 1}-${
        offset + newsItems.length
      })`,
      blocks: newBlocks,
    });

    console.log(`✅ [load_older_news] 처리 완료 (offset: ${offset})`);
  } catch (error) {
    console.error(`❌ [load_older_news] 처리 중 오류:`, error);

    try {
      await respond({
        response_type: "ephemeral",
        text: "😭 뉴스를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      });
    } catch (respondError) {
      console.error(`❌ 에러 응답 전송 실패:`, respondError);
    }
  }
});

app.action("load_first_news", async ({action, ack, respond}) => {
  await ack();

  console.log(`🔧 [load_first_news] 버튼 클릭됨, value: ${action.value}`);
  const offset = 0; // 항상 첫 페이지

  try {
    const newsItems = getNewsFromCache(5, offset);

    if (newsItems.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: "😭 뉴스를 불러오는 데 실패했습니다. 잠시 후 다시 시도해주세요.",
      });
      return;
    }

    const newBlocks = formatNewsToBlocks(newsItems, offset);

    await respond({
      replace_original: true,
      text: "최신 테크 뉴스입니다!",
      blocks: newBlocks,
    });

    console.log(`✅ [load_first_news] 처리 완료`);
  } catch (error) {
    console.error(`❌ [load_first_news] 처리 중 오류:`, error);

    try {
      await respond({
        response_type: "ephemeral",
        text: "😭 뉴스를 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      });
    } catch (respondError) {
      console.error(`❌ 에러 응답 전송 실패:`, respondError);
    }
  }
});

// Creating a simple web server to respond to health checks
const server = http.createServer(async (req, res) => {
  // 모든 요청 로깅 추가
  console.log(`📥 Incoming request: ${req.method} ${req.url}`);
  console.log(`📋 Headers:`, req.headers);

  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, {"Content-Type": "text/plain"});
    res.end("OK");
    return;
  }

  if (req.url.includes("/daily-geek-news-bot") && req.method === "POST") {
    console.log("🚀 Cloud Scheduler로부터 데일리 뉴스 전송 요청을 받았습니다.");

    try {
      const newsItems = getNewsFromCache(5, 0);

      const simpleBlocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `📰 Daily Tech News - ${new Date().toLocaleDateString(
              "ko-KR"
            )}`,
            emoji: true,
          },
        },
        {type: "divider"},
      ];

      newsItems.forEach((item) => {
        simpleBlocks.push(formatNewsItem(item));
      });

      simpleBlocks.push(
        {type: "divider"},
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "`daily-geek-news-bot`이 전해드렸습니다. ✨",
            },
          ],
        }
      );

      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: process.env.SLACK_TARGET_CHANNEL,
        text: "오늘의 데일리 테크 뉴스입니다!",
        blocks: simpleBlocks,
      });

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(
        JSON.stringify({
          success: true,
          message: "뉴스가 성공적으로 전송되었습니다.",
        })
      );
      console.log("✅ 뉴스가 성공적으로 전송되었습니다.");
    } catch (error) {
      console.error("❌ 뉴스 전송 중 오류가 발생했습니다:", error);
      res.writeHead(500, {"Content-Type": "application/json"});
      res.end(JSON.stringify({success: false, error: error.message}));
    }
    return;
  }

  // 404 처리
  res.writeHead(404, {"Content-Type": "text/plain"});
  res.end("Not Found");
});

async function startApp() {
  try {
    await app.start();
    console.log("⚡️ Daily Geek News Bot이 소켓 모드로 실행 중입니다!");

    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("🔗 Socket Mode 연결이 안정화되었습니다.");

    const port = process.env.PORT || 8080;
    server.listen(port, () => {
      console.log(`🏥 헬스 체크 서버가 포트 ${port}에서 실행 중입니다.`);
    });
  } catch (error) {
    console.error("❌ 앱 시작 중 오류 발생:", error);
    process.exit(1);
  }
}

(async () => {
  await startApp();
})();

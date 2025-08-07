// index.js
require("dotenv").config();
const {App} = require("@slack/bolt");
const cron = require("node-cron");
const {getNews} = require("./modules/news"); // 수정한 함수를 가져옴

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

/**
 * 뉴스 목록과 현재 offset을 기반으로 Slack 메시지 블록을 생성하는 함수
 * @param {Array} newsItems - 표시할 뉴스 아이템 배열
 * @param {number} currentOffset - 현재 뉴스의 시작 위치
 * @returns {Array} Slack 메시지 블록
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
    const {title, link, isoDate, pubDate, source} = item;
    const date = isoDate || pubDate;
    const formattedDate = new Date(date).toLocaleDateString("ko-KR");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${link}|${title.trim()}>*\n_${source} | ${formattedDate}_`,
      },
    });
  });

  blocks.push({type: "divider"});

  // 액션 버튼 추가
  const actions = [];
  if (newsItems.length > 0) {
    actions.push({
      type: "button",
      text: {type: "plain_text", text: "더 이전 뉴스 보기 ➡️", emoji: true},
      value: `load_news_${currentOffset + 5}`, // 다음 offset 값을 value에 저장
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

// --- 데일리 뉴스 전송 스케줄러 (변경 없음) ---
cron.schedule(
  "0 9 * * 1-5",
  async () => {
    console.log("🚀 데일리 뉴스 전송 작업을 시작합니다.");
    try {
      const newsItems = await getNews(3, 0); // 항상 최신 뉴스를 가져옴

      // 데일리 뉴스는 버튼 없이 심플하게 구성
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
        const {title, link, isoDate, pubDate, source} = item;
        const date = isoDate || pubDate;
        const formattedDate = new Date(date).toLocaleDateString("ko-KR");
        simpleBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*<${link}|${title.trim()}>*\n_${source} | ${formattedDate}_`,
          },
        });
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
      console.log("✅ 뉴스가 성공적으로 전송되었습니다.");
    } catch (error) {
      console.error("❌ 뉴스 전송 중 오류가 발생했습니다:", error);
    }
  },
  {
    scheduled: true,
    timezone: "Asia/Seoul",
  }
);

// --- /뉴스 명령어 처리 로직 (수정) ---
app.command("/뉴스", async ({command, ack, say}) => {
  await ack();

  try {
    const newsItems = await getNews(3, 0); // 처음에는 offset 0으로 시작
    const messageBlocks = formatNewsToBlocks(newsItems, 0);

    await say({
      text: "최신 테크 뉴스입니다!",
      blocks: messageBlocks,
    });
  } catch (error) {
    console.error("❌ /뉴스 명령어 처리 중 오류 발생:", error);
    await say("뉴스를 가져오는 데 실패했습니다. 😭");
  }
});

// --- 버튼 클릭 이벤트 핸들러 (신규 추가) ---
async function handleNewsButtonClick(body, ack, respond) {
  await ack();
  const actionValue = body.actions[0].value;
  const offset = parseInt(actionValue.replace("load_news_", ""), 10);

  try {
    const newsItems = await getNews(3, offset);
    const newBlocks = formatNewsToBlocks(newsItems, offset);

    // respond()를 사용하여 기존 메시지를 업데이트
    await respond({
      replace_original: true,
      blocks: newBlocks,
    });
  } catch (error) {
    console.error("❌ 뉴스 업데이트 중 오류:", error);
    await respond({
      replace_original: false,
      text: "오류가 발생하여 뉴스를 가져올 수 없습니다.",
    });
  }
}

app.action("load_older_news", async ({body, ack, respond}) => {
  await handleNewsButtonClick(body, ack, respond);
});

app.action("load_first_news", async ({body, ack, respond}) => {
  await handleNewsButtonClick(body, ack, respond);
});

(async () => {
  await app.start();
  console.log("⚡️ Daily Geek News Bot이 소켓 모드로 실행 중입니다!");
})();

require("dotenv").config();
const {App} = require("@slack/bolt");
const http = require("http");
const {
  fetchAllNews,
  searchNews,
  isLoadingNews,
  getCacheStatus,
} = require("./modules/newsCache");

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

// 세션별 뉴스 저장 (페이지네이션용)
const newsSessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30분

// 검색 세션 저장
const searchSessions = new Map();

// 세션 정리 함수
function cleanupSessions() {
  const now = Date.now();
  for (const [key, session] of newsSessions.entries()) {
    if (now - session.timestamp > SESSION_TTL) {
      newsSessions.delete(key);
    }
  }
  for (const [key, session] of searchSessions.entries()) {
    if (now - session.timestamp > SESSION_TTL) {
      searchSessions.delete(key);
    }
  }
}

// 5분마다 오래된 세션 정리
setInterval(cleanupSessions, 5 * 60 * 1000);

/**
 * 새로운 세션 ID 생성
 * @param {string} prefix - 세션 ID 접두사
 * @returns {string} 생성된 세션 ID
 */
function generateSessionId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 11)}`;
}

/**
 * 세션 생성 및 저장
 * @param {Array} items - 뉴스 아이템 배열
 * @param {string} type - 세션 타입 ('news', 'search', 'extended')
 * @param {Object} extraData - 추가 데이터
 * @returns {string} 생성된 세션 ID
 */
function createSession(items, type = "news", extraData = {}) {
  const sessionId = generateSessionId(type);
  const sessionData = {
    items,
    timestamp: Date.now(),
    ...extraData,
  };

  if (type === "search") {
    searchSessions.set(sessionId, sessionData);
  } else {
    newsSessions.set(sessionId, sessionData);
  }

  return sessionId;
}

/**
 * 세션 가져오기
 * @param {string} sessionId - 세션 ID
 * @returns {Object|null} 세션 데이터
 */
function getSession(sessionId) {
  return newsSessions.get(sessionId) || searchSessions.get(sessionId) || null;
}

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
 * @param {string} sessionId - Session ID for pagination
 * @returns {Array} Slack message block
 */
/**
 * 뉴스 블록 생성 함수 - 통합 버전
 * @param {Object} options - 블록 생성 옵션
 * @returns {Array} Slack message blocks
 */
function createNewsBlocks(options) {
  const {
    items,
    offset = 0,
    sessionId = null,
    headerText = null,
    showLoadMore = false,
    totalItems = null,
    keyword = null,
  } = options;

  // 헤더 텍스트 결정
  let header;
  if (headerText) {
    header = headerText;
  } else if (keyword) {
    header = `🔍 검색 결과: "${keyword}" (${totalItems || items.length}개)`;
  } else if (offset === 0) {
    header = `📰 최신 기술 뉴스`;
  } else {
    header = `📰 이전 기술 뉴스 (${offset + 1} - ${offset + items.length})`;
  }

  const blocks = [
    {
      type: "header",
      text: {type: "plain_text", text: header, emoji: true},
    },
    {type: "divider"},
  ];

  // 뉴스 아이템 추가
  if (items.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: keyword
          ? `😭 "${keyword}"에 대한 검색 결과가 없습니다.`
          : "🔍 더 이상 표시할 뉴스가 없습니다.",
      },
    });
  } else {
    items.forEach((item) => {
      blocks.push(formatNewsItem(item));
    });
  }

  blocks.push({type: "divider"});

  // 액션 버튼들
  const actions = [];

  if (sessionId) {
    const session = getSession(sessionId);

    if (session) {
      // 더 보기 버튼 (일반 페이지네이션)
      if (items.length > 0 && offset + items.length < session.items.length) {
        actions.push({
          type: "button",
          text: {
            type: "plain_text",
            text: showLoadMore ? "다음 10개 ➡️" : "더 이전 뉴스 보기 ➡️",
            emoji: true,
          },
          value: `${sessionId}_${offset + (showLoadMore ? 10 : 5)}`,
          action_id: showLoadMore ? "load_more_extended" : "load_older_news",
        });
      }

      // 이전 버튼 (확장 모드에서만)
      if (showLoadMore && offset > 0) {
        actions.push({
          type: "button",
          text: {type: "plain_text", text: "⬅️ 이전 10개", emoji: true},
          value: `${sessionId}_${offset - 10}`,
          action_id: "load_more_extended",
        });
      }

      // 처음으로 버튼
      if (offset > 0) {
        actions.push({
          type: "button",
          text: {type: "plain_text", text: "처음으로 🏠", emoji: true},
          value: `${sessionId}_0`,
          action_id: showLoadMore ? "load_more_extended" : "load_first_news",
        });
      }
    }
  }

  if (actions.length > 0) {
    blocks.push({
      type: "actions",
      elements: actions,
    });
  }

  // 추가 정보 (확장 모드)
  if (showLoadMore && totalItems) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `💡 총 ${totalItems}개 아이템 로드됨`,
        },
      ],
    });
  }

  return blocks;
}

function formatNewsToBlocks(newsItems, currentOffset = 0, sessionId = null) {
  return createNewsBlocks({
    items: newsItems,
    offset: currentOffset,
    sessionId,
  });
}

// 뉴스 검색 명령어
app.command("/뉴스검색", async ({ack, respond, command}) => {
  const startTime = Date.now();
  await ack();

  try {
    const keyword = command.text.trim();

    if (!keyword) {
      await respond({
        response_type: "ephemeral",
        text: "🔍 검색어를 입력해주세요. 예: `/뉴스검색 AI`",
      });
      return;
    }

    console.log(`🔍 검색 요청: "${keyword}"`);

    // 검색 실행
    const searchResults = await searchNews(keyword);

    if (searchResults.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: `😭 "${keyword}"에 대한 검색 결과가 없습니다.`,
      });
      return;
    }

    // 검색 세션 생성
    const sessionId = createSession(searchResults, "search", {keyword});

    const newsItems = searchResults.slice(0, 5);
    const blocks = createNewsBlocks({
      items: newsItems,
      sessionId,
      keyword,
      totalItems: searchResults.length,
    });

    const duration = Date.now() - startTime;
    console.log(
      `✅ 검색 완료: "${keyword}" - ${searchResults.length}개 결과 (${duration}ms)`
    );

    await respond({
      response_type: "in_channel",
      text: `검색 결과: "${keyword}"`,
      blocks: blocks,
    });
  } catch (error) {
    console.error("❌ 검색 중 오류:", error);
    await respond({
      response_type: "ephemeral",
      text: "😭 검색 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    });
  }
});

// 캐시 상태 확인 커맨드
app.command("/캐시상태", async ({ack, respond}) => {
  await ack();

  const status = getCacheStatus();
  const feedList = Object.entries(status.feeds || {})
    .map(([name, count]) => `  • ${name}: ${count}개`)
    .join("\n");

  const loadingStatus = status.isLoading
    ? `• 현재 상태: 로딩 중 ⏳ (${status.loadingTime}초 경과)`
    : `• 현재 상태: 대기 중 ✅`;

  await respond({
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*📊 Cloud Run 캐시 상태*\n\n` +
            `• 총 캐시 아이템: ${status.totalCached}개\n` +
            `• 캐시 연령: ${status.cacheAge}초\n` +
            `${loadingStatus}\n\n` +
            `*피드별 상태:*\n${feedList || "  (캐시 비어있음)"}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "☁️ Cloud Run 환경 - 인스턴스 유지 시간 동안만 캐시 유효",
          },
        ],
      },
    ],
  });
});

app.command("/뉴스", async ({ack, respond}) => {
  const startTime = Date.now();

  await ack();

  try {
    // 캐시 상태 확인 (디버깅용)
    const cacheStatus = getCacheStatus();
    console.log(`📊 캐시 상태: ${JSON.stringify(cacheStatus)}`);

    // 이미 로딩 중인 경우 로딩 메시지 표시
    if (isLoadingNews()) {
      const status = getCacheStatus();
      await respond({
        response_type: "ephemeral",
        text: `⏳ 뉴스를 불러오는 중입니다... (경과 시간: ${status.loadingTime}초)\n잠시만 기다려주세요. ☀️`,
      });
      return;
    }

    // 캐시가 비어있고 로딩이 필요한 경우 즉시 로딩 메시지 표시
    if (cacheStatus.totalCached === 0) {
      console.log(`⚡ 캐시 없음 - 즉시 로딩 메시지 표시 후 RSS 파싱 시작`);

      await respond({
        response_type: "ephemeral",
        text: `⏳ 뉴스를 불러오는 중입니다...\n처음 로딩이라 시간이 조금 걸릴 수 있습니다. 잠시만 기다려주세요 ☀️`,
      });

      // 비동기로 RSS 파싱 시작하고 완료되면 새로운 메시지 전송
      fetchAllNews()
        .then(async (allNews) => {
          if (allNews.length === 0) {
            await respond({
              response_type: "ephemeral",
              text: "😭 뉴스를 불러오는 데 실패했습니다. 잠시 후 다시 시도해주세요.",
            });
            return;
          }

          // 새로운 세션 생성
          const sessionId = createSession(allNews, "news");

          const newsItems = allNews.slice(0, 5);
          const messageBlocks = formatNewsToBlocks(newsItems, 0, sessionId);

          const duration = Date.now() - startTime;
          console.log(`📊 /뉴스 명령어 처리 완료 (처리시간: ${duration}ms)`);

          await respond({
            response_type: "in_channel",
            text: "✅ 최신 테크 뉴스를 불러왔습니다!",
            blocks: messageBlocks,
          });
        })
        .catch(async (error) => {
          const duration = Date.now() - startTime;
          console.error(
            `❌ /뉴스 백그라운드 처리 중 오류 발생 (처리시간: ${duration}ms):`,
            error
          );
          await respond({
            response_type: "ephemeral",
            text: "😭 오류가 발생하여 뉴스를 가져올 수 없습니다.",
          });
        });

      return; // 백그라운드 처리로 전환했으므로 여기서 종료
    }

    // 캐시가 있는 경우 일반 처리
    const allNews = await fetchAllNews();

    if (allNews.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: "😭 뉴스를 불러오는 데 실패했습니다. 잠시 후 다시 시도해주세요.",
      });
      return;
    }

    // 새로운 세션 생성
    const sessionId = createSession(allNews, "news");

    const newsItems = allNews.slice(0, 5);
    const messageBlocks = formatNewsToBlocks(newsItems, 0, sessionId);

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
      // 캐시 상태 확인
      const cacheStatus = getCacheStatus();

      if (isLoadingNews()) {
        const status = getCacheStatus();
        responseText = `⏳ 뉴스 데이터를 불러오는 중입니다... (경과 시간: ${status.loadingTime}초)\n잠시만 기다려주세요. ☀️`;
        responseBlocks = [
          {
            type: "section",
            text: {type: "mrkdwn", text: responseText},
          },
        ];
      } else if (cacheStatus.totalCached === 0) {
        // 캐시가 비어있는 경우 즉시 로딩 메시지 표시
        console.log(
          `⚡ 멘션: 캐시 없음 - 즉시 로딩 메시지 표시 후 RSS 파싱 시작`
        );

        responseText = `⏳ 뉴스를 불러오는 중입니다...\n처음 로딩이라 시간이 조금 걸릴 수 있습니다. 잠시만 기다려주세요 ☀️`;
        responseBlocks = [
          {
            type: "section",
            text: {type: "mrkdwn", text: responseText},
          },
        ];

        // 백그라운드에서 RSS 파싱 후 새로운 메시지 전송
        fetchAllNews()
          .then(async (allNews) => {
            if (allNews.length > 0) {
              const sessionId = createSession(allNews, "news");

              const newsItems = allNews.slice(0, 5);
              const newBlocks = formatNewsToBlocks(newsItems, 0, sessionId);

              await client.chat.postMessage({
                token: process.env.SLACK_BOT_TOKEN,
                channel: event.channel,
                text: "✅ 최신 기술 뉴스를 불러왔습니다!",
                blocks: newBlocks,
                unfurl_links: false,
                unfurl_media: false,
              });
            } else {
              await client.chat.postMessage({
                token: process.env.SLACK_BOT_TOKEN,
                channel: event.channel,
                text: "😭 현재 불러올 뉴스가 없습니다.",
                unfurl_links: false,
                unfurl_media: false,
              });
            }
          })
          .catch(async (error) => {
            console.error(`❌ 멘션 백그라운드 처리 중 오류:`, error);
            await client.chat.postMessage({
              token: process.env.SLACK_BOT_TOKEN,
              channel: event.channel,
              text: "😭 오류가 발생하여 뉴스를 가져올 수 없습니다.",
              unfurl_links: false,
              unfurl_media: false,
            });
          });
      } else {
        // 캐시가 있는 경우 일반 처리
        const allNews = await fetchAllNews();

        if (allNews.length > 0) {
          const sessionId = createSession(allNews, "news");

          const newsItems = allNews.slice(0, 5);
          responseText = "📰 최신 기술 뉴스를 가져왔습니다!";
          responseBlocks = formatNewsToBlocks(newsItems, 0, sessionId);
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
              value: "show_latest_news",
              action_id: "show_latest_news",
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
      unfurl_links: false,
      unfurl_media: false,
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
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (fallbackError) {
      console.error(`❌ 폴백 메시지 전송 실패:`, fallbackError);
    }
  }
});

app.action("load_more_extended", async ({action, ack, respond}) => {
  await ack();

  console.log(`🔧 [load_more_extended] 버튼 클릭됨, value: ${action.value}`);

  try {
    const parts = action.value.split("_");
    const offset = parseInt(parts[parts.length - 1], 10);
    const sessionId = parts.slice(0, -1).join("_");

    const session = newsSessions.get(sessionId);
    if (!session) {
      await respond({
        response_type: "ephemeral",
        text: "😭 세션이 만료되었습니다. 다시 시도해주세요.",
      });
      return;
    }

    const newsItems = session.items.slice(offset, offset + 10);
    const blocks = createNewsBlocks({
      items: newsItems,
      offset,
      sessionId,
      headerText: `📰 확장된 뉴스 목록 (${offset + 1}-${
        offset + newsItems.length
      }/${session.items.length})`,
      showLoadMore: true,
      totalItems: session.items.length,
    });

    await respond({
      replace_original: true,
      text: "확장된 뉴스 목록",
      blocks: blocks,
    });

    console.log(`✅ [load_more_extended] 처리 완료 (offset: ${offset})`);
  } catch (error) {
    console.error(`❌ [load_more_extended] 처리 중 오류:`, error);
    await respond({
      response_type: "ephemeral",
      text: "😭 오류가 발생했습니다.",
    });
  }
});

app.action("load_older_news", async ({action, ack, respond}) => {
  await ack();

  console.log(`🔧 [load_older_news] 버튼 클릭됨, value: ${action.value}`);

  try {
    // value 형식: sessionId_offset
    const parts = action.value.split("_");
    const offset = parseInt(parts[parts.length - 1], 10);
    const sessionId = parts.slice(0, -1).join("_");

    // 세션 가져오기
    let session = getSession(sessionId);

    // 세션이 없으면 다시 로드
    if (!session) {
      const allNews = await fetchAllNews();
      const newSessionId = createSession(allNews, "news");
      session = getSession(newSessionId);

      const newsItems = allNews.slice(offset, offset + 5);
      const newBlocks = formatNewsToBlocks(newsItems, offset, newSessionId);

      await respond({
        replace_original: true,
        text: `이전 테크 뉴스입니다! (${offset + 1}-${
          offset + newsItems.length
        })`,
        blocks: newBlocks,
      });
    } else {
      const newsItems = session.items.slice(offset, offset + 5);

      if (newsItems.length === 0) {
        await respond({
          response_type: "ephemeral",
          text: "📰 더 이상 표시할 뉴스가 없습니다.",
        });
        return;
      }

      const newBlocks = formatNewsToBlocks(newsItems, offset, sessionId);

      await respond({
        replace_original: true,
        text: `이전 테크 뉴스입니다! (${offset + 1}-${
          offset + newsItems.length
        })`,
        blocks: newBlocks,
      });
    }

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
    // value 형식: sessionId_0
    const parts = action.value.split("_");
    const sessionId = parts.slice(0, -1).join("_");

    // 세션 가져오기
    let session = getSession(sessionId);

    // 세션이 없으면 다시 로드
    if (!session) {
      const allNews = await fetchAllNews();
      const newSessionId = createSession(allNews, "news");
      session = getSession(newSessionId);

      const newsItems = allNews.slice(0, 5);
      const newBlocks = formatNewsToBlocks(newsItems, offset, newSessionId);

      await respond({
        replace_original: true,
        text: "최신 테크 뉴스입니다!",
        blocks: newBlocks,
      });
    } else {
      const newsItems = session.items.slice(0, 5);

      if (newsItems.length === 0) {
        await respond({
          response_type: "ephemeral",
          text: "😭 뉴스를 불러오는 데 실패했습니다. 잠시 후 다시 시도해주세요.",
        });
        return;
      }

      const newBlocks = formatNewsToBlocks(newsItems, offset, sessionId);

      await respond({
        replace_original: true,
        text: "최신 테크 뉴스입니다!",
        blocks: newBlocks,
      });
    }

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

app.action("show_latest_news", async ({action, ack, respond}) => {
  console.log(`🔧 [show_latest_news] 버튼 클릭됨, value: ${action.value}`);

  await ack();

  try {
    const allNews = await fetchAllNews();

    if (allNews.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: "😭 뉴스를 불러오는 데 실패했습니다. 잠시 후 다시 시도해주세요.",
      });
      return;
    }

    const sessionId = createSession(allNews, "news");

    const newsItems = allNews.slice(0, 5);
    const messageBlocks = formatNewsToBlocks(newsItems, 0, sessionId);

    await respond({
      replace_original: true,
      text: "최신 테크 뉴스입니다!",
      blocks: messageBlocks,
    });
  } catch (error) {
    console.error(`❌ [show_latest_news] 처리 중 오류:`, error);
    await respond({
      response_type: "ephemeral",
      text: "😭 뉴스를 불러오는 중 오류가 발생했습니다.",
    });
  }
});

// Creating a simple web server to respond to health checks
const server = http.createServer(async (req, res) => {
  if (
    req.method === "POST" &&
    req.headers.host &&
    req.headers.host.includes("daily-geek-news-bot")
  ) {
    console.log("🚀 Cloud Scheduler로부터 데일리 뉴스 전송 요청을 받았습니다.");

    try {
      let newsItems = await fetchAllNews(5);

      if (newsItems.length === 0) {
        console.log("⚠️ 표시할 뉴스가 없습니다.");
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(
          JSON.stringify({
            success: true,
            message: "표시할 뉴스가 없습니다.",
          })
        );
        return;
      }

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

      const countText = `최신 뉴스: ${newsItems.length}개`;

      simpleBlocks.push(
        {type: "divider"},
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `\`daily-geek-news-bot\`이 전해드렸습니다. ✨ (${countText})`,
            },
          ],
        }
      );

      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: process.env.SLACK_TARGET_CHANNEL,
        text: "오늘의 데일리 테크 뉴스입니다!",
        blocks: simpleBlocks,
        unfurl_links: false,
        unfurl_media: false,
      });

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(
        JSON.stringify({
          success: true,
          message: `뉴스가 성공적으로 전송되었습니다. (${newsItems.length}개)`,
        })
      );
      console.log(
        `✅ 뉴스가 성공적으로 전송되었습니다. (${newsItems.length}개)`
      );
    } catch (error) {
      console.error("❌ 뉴스 전송 중 오류가 발생했습니다:", error);
      res.writeHead(500, {"Content-Type": "application/json"});
      res.end(JSON.stringify({success: false, error: error.message}));
    }
    return;
  }

  // Health check endpoint
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, {"Content-Type": "text/plain"});
    res.end("OK");
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
    console.log("☁️ Cloud Run 환경에서 실행 중 - 온디맨드 캐싱 활성화");

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

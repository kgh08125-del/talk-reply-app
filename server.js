const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const SESSIONS = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const USAGE_STATS = {
  analyzeStyle: 0,
  generateReplies: 0,
  analyzeFeelings: 0,
  logins: 0,
  startedAt: new Date().toISOString()
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/login") {
      return handleLogin(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      return handleSession(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      return handleLogout(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/status") {
      return handleAdminStatus(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/analyze-style") {
      if (!requireAuth(req, res)) return;
      USAGE_STATS.analyzeStyle += 1;
      return handleAnalyze(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/generate-replies") {
      if (!requireAuth(req, res)) return;
      USAGE_STATS.generateReplies += 1;
      return handleReplies(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/analyze-feelings") {
      if (!requireAuth(req, res)) return;
      USAGE_STATS.analyzeFeelings += 1;
      return handleFeelings(req, res);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, {
      error: { type: "method_error", message: "지원하지 않는 요청 방식입니다." }
    });
  } catch (error) {
    sendJson(res, 500, {
      error: { type: "server_error", message: "서버 처리 중 오류가 발생했습니다." }
    });
  }
});

server.listen(PORT, () => {
  console.log(`Kakao tone reply app is running at http://localhost:${PORT}`);
});

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const mode = String(body.mode || "admin").trim();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const accessCode = String(body.accessCode || "").trim();

  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  const appAccessCode = process.env.APP_ACCESS_CODE || "";

  let role = "";
  if (mode === "admin") {
    if (!adminPassword) {
      return sendJson(res, 500, {
        error: {
          type: "auth_config_error",
          message: "관리자 비밀번호가 아직 설정되지 않았습니다. ADMIN_PASSWORD를 환경변수에 넣어주세요."
        }
      });
    }

    if (username === adminUsername && safeEqual(password, adminPassword)) {
      role = "admin";
    }
  } else if (mode === "code") {
    if (!appAccessCode) {
      return sendJson(res, 500, {
        error: {
          type: "auth_config_error",
          message: "이용코드가 아직 설정되지 않았습니다. APP_ACCESS_CODE를 환경변수에 넣어주세요."
        }
      });
    }

    if (safeEqual(accessCode, appAccessCode)) {
      role = "user";
    }
  }

  if (!role) {
    return sendJson(res, 401, {
      error: {
        type: "auth_error",
        message: "로그인 정보가 맞지 않습니다. 아이디, 비밀번호 또는 이용코드를 다시 확인해주세요."
      }
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  SESSIONS.set(token, {
    role,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  USAGE_STATS.logins += 1;

  sendJson(res, 200, { token, role });
}

function handleAdminStatus(req, res) {
  const session = getSession(req);
  if (!session) {
    return sendJson(res, 401, {
      error: { type: "auth_error", message: "로그인이 필요합니다." }
    });
  }

  if (session.role !== "admin") {
    return sendJson(res, 403, {
      error: { type: "auth_error", message: "관리자만 볼 수 있는 페이지입니다." }
    });
  }

  cleanupExpiredSessions();
  const provider = String(process.env.LLM_PROVIDER || "gemini").toLowerCase();
  sendJson(res, 200, {
    provider,
    model: provider === "openai"
      ? process.env.OPENAI_MODEL || "gpt-4.1-mini"
      : process.env.GEMINI_MODEL || "gemini-2.5-flash",
    hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD),
    hasAccessCode: Boolean(process.env.APP_ACCESS_CODE),
    activeSessions: SESSIONS.size,
    usage: USAGE_STATS
  });
}

function handleSession(req, res) {
  const session = getSession(req);
  if (!session) {
    return sendJson(res, 401, {
      error: { type: "auth_error", message: "로그인이 필요합니다." }
    });
  }

  sendJson(res, 200, { role: session.role });
}

function handleLogout(req, res) {
  const token = getAuthToken(req);
  if (token) SESSIONS.delete(token);
  sendJson(res, 200, { ok: true });
}

async function handleAnalyze(req, res) {
  const body = await readJsonBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (messages.length < 5) {
    return sendJson(res, 400, {
      error: {
        type: "validation_error",
        message: "말투를 분석하려면 내가 보낸 메시지가 최소 5개 이상 필요합니다."
      }
    });
  }

  const compactMessages = messages
    .map((message) => String(message || "").trim())
    .filter(Boolean)
    .slice(-150);

  const prompt = [
    "너는 카카오톡 대화 말투를 분석하는 한국어 스타일 분석가다.",
    "반드시 순수 JSON만 응답한다. 코드블록, 설명, 마크다운, 앞뒤 문장을 절대 붙이지 않는다.",
    '응답 형식은 {"style_summary":"...","traits":["...","...","..."]} 이다.',
    "style_summary는 1~2문장으로 자연스럽게 쓴다.",
    "traits는 3~4개의 짧은 한국어 태그로 쓴다.",
    "민감한 개인정보를 추론하거나 저장하지 말고, 문체 특징만 요약한다.",
    "",
    "아래는 사용자가 실제로 보낸 카카오톡 메시지들이다.",
    "이 메시지들에서 말투만 분석해 JSON으로 답해줘.",
    "",
    compactMessages.map((message, index) => `${index + 1}. ${message}`).join("\n")
  ].join("\n");

  const result = await callLlmJson({
    prompt,
    schema: {
      type: "object",
      properties: {
        style_summary: { type: "string" },
        traits: { type: "array", items: { type: "string" } }
      },
      required: ["style_summary", "traits"]
    }
  });

  if (result.error) {
    return sendJson(res, result.status, { error: result.error });
  }

  const parsed = result.data;
  if (
    !parsed ||
    typeof parsed.style_summary !== "string" ||
    !Array.isArray(parsed.traits)
  ) {
    return sendJson(res, 502, {
      error: {
        type: "json_parse_error",
        message: "AI 응답 형식이 예상과 달라 분석 결과를 읽지 못했습니다."
      }
    });
  }

  sendJson(res, 200, {
    style_summary: parsed.style_summary.trim(),
    traits: parsed.traits.map((trait) => String(trait).trim()).filter(Boolean).slice(0, 4)
  });
}

async function handleReplies(req, res) {
  const body = await readJsonBody(req);
  const styleProfile = body.styleProfile || {};
  const incomingMessage = String(body.incomingMessage || "").trim();
  const mood = String(body.mood || "평소 그대로").trim();
  const customMood = String(body.customMood || "").trim();
  const situationGuide = getSituationGuide(mood);
  const conversationContext = Array.isArray(body.conversationContext)
    ? body.conversationContext
        .filter((turn) => turn && typeof turn.text === "string")
        .slice(-6)
        .map((turn) => ({
          role: turn.role === "me" ? "나" : "상대",
          text: turn.text.trim()
        }))
        .filter((turn) => turn.text)
    : [];

  if (!styleProfile.style_summary || !Array.isArray(styleProfile.traits)) {
    return sendJson(res, 400, {
      error: {
        type: "validation_error",
        message: "먼저 말투 분석을 완료해야 답장을 추천받을 수 있습니다."
      }
    });
  }

  if (!incomingMessage) {
    return sendJson(res, 400, {
      error: {
        type: "validation_error",
        message: "답장을 추천받을 새 메시지를 입력해주세요."
      }
    });
  }

  const prompt = [
    "너는 한국어 카카오톡 답장을 제안하는 작가다.",
    "반드시 순수 JSON만 응답한다. 코드블록, 설명, 마크다운, 앞뒤 문장을 절대 붙이지 않는다.",
    '응답 형식은 {"replies":["...","...","..."]} 이다.',
    "답장은 정확히 3개만 만든다.",
    "각 답장은 짧고 자연스러운 카톡 문장으로 만든다.",
    "서로 다른 뉘앙스나 강도를 갖게 하되, 사용자의 말투 프로필을 유지한다.",
    "상대에게 보낼 수 없는 과격한 표현, 개인정보 추론, 허위 사실은 피한다.",
    "",
    "사용자의 말투 프로필:",
    `요약: ${styleProfile.style_summary}`,
    `특징 태그: ${styleProfile.traits.join(", ")}`,
    "",
    `선택한 분위기: ${mood}`,
    customMood ? `추가 뉘앙스: ${customMood}` : "추가 뉘앙스: 없음",
    "",
    "최근 이어진 대화 흐름:",
    conversationContext.length
      ? conversationContext.map((turn) => `${turn.role}: ${turn.text}`).join("\n")
      : "아직 이어진 대화 없음",
    "",
    "상대방의 새 메시지:",
    incomingMessage,
    "",
    `상황 모드: ${mood}`,
    `상황별 판단 기준: ${situationGuide}`,
    '최종 응답은 반드시 {"strategy_summary":"...","replies":["...","...","..."]} 순수 JSON만 사용한다.',
    "strategy_summary는 지금 보내야 할 방향을 1문장으로 요약한다.",
    "",
    "위 정보를 반영해 답장 후보 3개를 JSON으로만 제안해줘.",
    "앞서 선택한 내 답장과 같은 말을 반복하지 말고, 대화가 자연스럽게 이어지도록 만들어줘."
  ].join("\n");

  const result = await callLlmJson({
    prompt,
    schema: {
      type: "object",
      properties: {
        strategy_summary: { type: "string" },
        replies: { type: "array", items: { type: "string" } }
      },
      required: ["strategy_summary", "replies"]
    }
  });

  if (result.error) {
    return sendJson(res, result.status, { error: result.error });
  }

  const parsed = result.data;
  if (!parsed || !Array.isArray(parsed.replies)) {
    return sendJson(res, 502, {
      error: {
        type: "json_parse_error",
        message: "AI 응답 형식이 예상과 달라 답장 후보를 읽지 못했습니다."
      }
    });
  }

  const replies = parsed.replies
    .map((reply) => String(reply).trim())
    .filter(Boolean)
    .slice(0, 3);

  if (replies.length !== 3) {
    return sendJson(res, 502, {
      error: {
        type: "json_parse_error",
        message: "AI가 답장 3개를 정확히 반환하지 않았습니다. 다시 시도해주세요."
      }
    });
  }

  sendJson(res, 200, {
    strategy_summary: String(parsed.strategy_summary || "").trim(),
    replies
  });
}

function getSituationGuide(mood) {
  if (mood.includes("재회")) {
    return [
      "예전 대화 흐름을 보고 상대가 부담을 느끼지 않으면서 다시 이어갈 수 있는 루트를 제안한다.",
      "가능성이 낮아 보이면 무리한 재회 멘트 대신 가볍게 관계를 회복하는 대화 방안을 제안한다.",
      "집착, 장문 사과, 감정 압박, 갑작스러운 고백은 피한다."
    ].join(" ");
  }

  if (mood.includes("썸") || mood.includes("소개팅")) {
    return [
      "상대의 반응 온도와 질문 여부를 보고 너무 들이대지 않으면서 호감도를 높이는 답장을 만든다.",
      "상대 관심사에 맞춘 질문, 가벼운 설렘, 약속 제안 타이밍을 상황에 맞게 판단한다."
    ].join(" ");
  }

  if (mood.includes("손절")) {
    return [
      "상대에게 상처를 최소화하면서 선을 긋거나 대화를 정리하는 방향으로 답한다.",
      "상대가 무례하거나 반복적으로 부담을 주는 흐름이면 더 단호하게, 단순 거리두기면 부드럽게 제안한다."
    ].join(" ");
  }

  return "사용자의 말투를 유지하면서 선택한 분위기에 맞는 자연스러운 카카오톡 답장을 만든다.";
}

async function handleFeelings(req, res) {
  const body = await readJsonBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const me = String(body.me || "").trim();
  const mode = String(body.mode || "interest").trim();

  if (!me) {
    return sendJson(res, 400, {
      error: {
        type: "validation_error",
        message: "먼저 대화 참여자 중 내 이름을 선택해주세요."
      }
    });
  }

  if (messages.length < 4) {
    return sendJson(res, 400, {
      error: {
        type: "validation_error",
        message: "마음 분석을 하려면 실제 대화가 최소 4개 이상 필요합니다."
      }
    });
  }

  const modeLabel =
    mode === "other"
      ? "상대 마음 분석기"
      : mode === "mine"
        ? "내 마음 분석기"
        : "호감도 체크";

  const compactMessages = messages
    .filter((message) => message && message.sender && message.text)
    .slice(-150)
    .map((message) => `${message.sender === me ? "나" : message.sender}: ${String(message.text).trim()}`);

  const prompt = [
    "너는 카카오톡 대화에서 감정 신호를 조심스럽게 읽어주는 한국어 대화 분석가다.",
    "상대의 마음을 확정하거나 단정하지 않는다. 반드시 '대화에 드러난 신호 기준의 추정'으로 표현한다.",
    "반드시 순수 JSON만 응답한다. 코드블록, 설명, 마크다운, 앞뒤 문장을 절대 붙이지 않는다.",
    '응답 형식은 {"title":"...","score":0,"summary":"...","signals":["..."],"cautions":["..."],"next_tip":"..."} 이다.',
    "score는 0부터 100 사이 정수다. 확실하지 않으면 중간 점수로 둔다.",
    "summary는 1~2문장, signals는 3~4개, cautions는 1~2개, next_tip은 짧은 조언 1문장으로 쓴다.",
    "",
    `분석 모드: ${modeLabel}`,
    `내 이름: ${me}`,
    "",
    "분석 기준:",
    mode === "other"
      ? "상대가 나에게 보이는 관심, 편안함, 거리감, 답장 태도, 질문 여부를 중심으로 본다."
      : mode === "mine"
        ? "내가 상대에게 보이는 관심, 기대감, 조심스러움, 표현 강도를 중심으로 본다."
        : "서로의 호감 신호와 대화 온도를 균형 있게 본다.",
    "",
    "최근 대화:",
    "엄격한 점수 기준:",
    "score는 0부터 100 사이 정수다. 매우 보수적으로 매긴다.",
    "기본 점수는 40점에서 시작한다. 애매하거나 근거가 부족하면 35~45점으로 둔다.",
    "단순한 ㅋㅋ, 이모티콘, 맞장구, 예의상 답장만으로는 55점 이상 주지 않는다.",
    "상대가 먼저 질문하거나 대화를 이어가려는 행동이 없으면 60점 이상 주지 않는다.",
    "70점 이상은 명확한 호감 신호가 최소 3개 이상 있을 때만 가능하다.",
    "85점 이상은 상대가 먼저 만나자, 보고 싶다, 궁금하다, 계속 대화하고 싶다는 식의 강한 신호가 있을 때만 가능하다.",
    "단답, 질문 없음, 회피, 늦은 답장, 부담스러워하는 표현, 예의상 리액션은 감점한다.",
    "점수 구간: 0~20 관심 낮음, 21~40 예의상/애매함, 41~55 중립/판단보류, 56~70 약한 호감 가능성, 71~85 꽤 강한 호감, 86~100 매우 강한 호감.",
    "",
    compactMessages.join("\n")
  ].join("\n");

  const result = await callLlmJson({
    prompt,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        score: { type: "number" },
        summary: { type: "string" },
        signals: { type: "array", items: { type: "string" } },
        cautions: { type: "array", items: { type: "string" } },
        next_tip: { type: "string" }
      },
      required: ["title", "score", "summary", "signals", "cautions", "next_tip"]
    }
  });

  if (result.error) {
    return sendJson(res, result.status, { error: result.error });
  }

  const parsed = result.data;
  if (!parsed || typeof parsed.summary !== "string" || !Array.isArray(parsed.signals)) {
    return sendJson(res, 502, {
      error: {
        type: "json_parse_error",
        message: "AI 응답 형식이 예상과 달라 마음 분석 결과를 읽지 못했습니다."
      }
    });
  }

  sendJson(res, 200, {
    title: String(parsed.title || modeLabel).trim(),
    score: Math.max(0, Math.min(100, Number.parseInt(parsed.score, 10) || 0)),
    summary: parsed.summary.trim(),
    signals: parsed.signals.map((signal) => String(signal).trim()).filter(Boolean).slice(0, 4),
    cautions: Array.isArray(parsed.cautions)
      ? parsed.cautions.map((caution) => String(caution).trim()).filter(Boolean).slice(0, 2)
      : [],
    next_tip: String(parsed.next_tip || "").trim()
  });
}

async function callLlmJson({ prompt, schema }) {
  const provider = String(process.env.LLM_PROVIDER || "gemini").toLowerCase();

  if (provider === "openai") {
    return callOpenAIJson({ prompt });
  }

  return callGeminiJson({ prompt, schema });
}

async function callOpenAIJson({ prompt }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  if (!apiKey || apiKey.includes("your-api-key-here")) {
    return {
      status: 500,
      error: {
        type: "api_key_error",
        message: "OPENAI_API_KEY가 설정되어 있지 않습니다. Render 환경변수에 OpenAI API 키를 넣어주세요."
      }
    };
  }

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "너는 한국어 카카오톡 대화 분석과 답장 생성을 돕는 assistant다. 반드시 순수 JSON만 응답한다."
          },
          { role: "user", content: prompt }
        ]
      })
    });
  } catch (error) {
    return {
      status: 503,
      error: {
        type: "network_error",
        message: "OpenAI API에 연결하지 못했습니다. 인터넷 연결이나 방화벽 설정을 확인해주세요."
      }
    };
  }

  const rawText = await response.text();

  if (!response.ok) {
    let apiMessage = "OpenAI API 요청이 실패했습니다.";
    try {
      const errorBody = JSON.parse(rawText);
      apiMessage = errorBody.error?.message || apiMessage;
    } catch (_) {
      if (rawText) apiMessage = rawText.slice(0, 300);
    }

    return {
      status: response.status === 429 ? 429 : 502,
      error: {
        type: "api_error",
        message:
          response.status === 429
            ? "OpenAI API 사용량 한도 또는 속도 제한에 걸렸습니다. 잠시 후 다시 시도해주세요."
            : apiMessage
      }
    };
  }

  let completion;
  try {
    completion = JSON.parse(rawText);
  } catch (_) {
    return {
      status: 502,
      error: {
        type: "json_parse_error",
        message: "OpenAI API 응답을 읽는 중 JSON 파싱에 실패했습니다."
      }
    };
  }

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    return {
      status: 502,
      error: {
        type: "api_error",
        message: "OpenAI API 응답에 결과 내용이 없습니다."
      }
    };
  }

  try {
    return { status: 200, data: JSON.parse(content) };
  } catch (_) {
    return {
      status: 502,
      error: {
        type: "json_parse_error",
        message: "AI가 순수 JSON이 아닌 응답을 반환했습니다. 다시 시도해주세요."
      }
    };
  }
}

async function callGeminiJson({ prompt, schema }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  if (!apiKey || apiKey.includes("your-api-key-here")) {
    return {
      status: 500,
      error: {
        type: "api_key_error",
        message: ".env 파일에 GEMINI_API_KEY가 설정되어 있지 않습니다. Google AI Studio에서 만든 API 키를 넣어주세요."
      }
    };
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
          responseSchema: schema
        }
      })
    });
  } catch (error) {
    return {
      status: 503,
      error: {
        type: "network_error",
        message: "Gemini API에 연결하지 못했습니다. 인터넷 연결이나 방화벽 설정을 확인해주세요."
      }
    };
  }

  const rawText = await response.text();

  if (!response.ok) {
    let apiMessage = "Gemini API 요청이 실패했습니다.";
    try {
      const errorBody = JSON.parse(rawText);
      apiMessage = errorBody.error?.message || apiMessage;
    } catch (_) {
      if (rawText) apiMessage = rawText.slice(0, 300);
    }

    return {
      status: response.status === 429 ? 429 : 502,
      error: {
        type: "api_error",
        message:
          response.status === 429
            ? "Gemini API 무료 사용량 또는 속도 제한에 걸렸습니다. 잠시 후 다시 시도해주세요."
            : apiMessage
      }
    };
  }

  let completion;
  try {
    completion = JSON.parse(rawText);
  } catch (_) {
    return {
      status: 502,
      error: {
        type: "json_parse_error",
        message: "Gemini API 응답을 읽는 중 JSON 파싱에 실패했습니다."
      }
    };
  }

  const content = completion.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!content) {
    return {
      status: 502,
      error: {
        type: "api_error",
        message: "Gemini API 응답에 결과 내용이 없습니다."
      }
    };
  }

  try {
    return { status: 200, data: JSON.parse(content) };
  } catch (_) {
    return {
      status: 502,
      error: {
        type: "json_parse_error",
        message: "AI가 순수 JSON이 아닌 응답을 반환했습니다. 다시 시도해주세요."
      }
    };
  }
}

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(ROOT, safePath));

  if (!filePath.startsWith(ROOT)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendText(res, 404, "Not found");
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
    });
    res.end(content);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_500_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (session) return true;

  sendJson(res, 401, {
    error: {
      type: "auth_error",
      message: "로그인이 필요합니다. 관리자 계정이나 이용코드로 먼저 로그인해주세요."
    }
  });
  return false;
}

function getSession(req) {
  cleanupExpiredSessions();
  const token = getAuthToken(req);
  if (!token) return null;

  const session = SESSIONS.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    SESSIONS.delete(token);
    return null;
  }

  return session;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of SESSIONS.entries()) {
    if (session.expiresAt < now) SESSIONS.delete(token);
  }
}

function getAuthToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice("Bearer ".length).trim();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

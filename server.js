const http = require("http");
const fs = require("fs");
const path = require("path");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

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

    if (req.method === "POST" && url.pathname === "/api/analyze-style") {
      return handleAnalyze(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/generate-replies") {
      return handleReplies(req, res);
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
    .slice(-160);

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

  const result = await callGeminiJson({
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
  const conversationContext = Array.isArray(body.conversationContext)
    ? body.conversationContext
        .filter((turn) => turn && typeof turn.text === "string")
        .slice(-8)
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
    "위 정보를 반영해 답장 후보 3개를 JSON으로만 제안해줘.",
    "앞서 선택한 내 답장과 같은 말을 반복하지 말고, 대화가 자연스럽게 이어지도록 만들어줘."
  ].join("\n");

  const result = await callGeminiJson({
    prompt,
    schema: {
      type: "object",
      properties: {
        replies: { type: "array", items: { type: "string" } }
      },
      required: ["replies"]
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

  sendJson(res, 200, { replies });
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

  if (!apiKey.startsWith("AIza")) {
    return {
      status: 500,
      error: {
        type: "api_key_error",
        message: "GEMINI_API_KEY 모양이 올바르지 않습니다. Gemini API 키는 보통 AIza로 시작합니다."
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

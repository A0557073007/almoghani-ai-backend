const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(express.json({ limit: "20kb" }));

const corsOptions = {
  origin: [
    "https://almoghani.net",
    "https://www.almoghani.net"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.get("/", (req, res) => {
  res.json({
    name: "ALMOGHANI AI",
    status: "running"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({
        error: "اكتب سؤالك أولاً."
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        error: "السؤال طويل جدًا."
      });
    }

    const response = await openai.responses.create({
      model: "gpt-5-mini",

      instructions: `
أنت ALMOGHANI AI، مساعد عربي لموقع ALMOGHANI.

أجب باللغة العربية الواضحة والمختصرة ما لم يطلب المستخدم غير ذلك.

الموقع يهتم بالمحتوى الإسلامي مثل:
القرآن الكريم، السيرة النبوية، الأحاديث، الحج،
الأذكار، الفقه، العقيدة، الصحابة، العبادات،
الأسرة والأخلاق الإسلامية.

في المسائل الدينية:
- لا تختلق آية أو حديثًا أو مصدرًا.
- ميّز بين الأحكام المتفق عليها والمسائل التي فيها خلاف معتبر.
- لا تقدم نفسك كمفتٍ.
- إذا كان السؤال يحتاج فتوى شخصية، وضح أن الإجابة معلومات عامة وأن الأفضل الرجوع إلى عالم أو جهة إفتاء موثوقة.

يمكنك أيضًا الإجابة عن الأسئلة العامة المفيدة للزائر.
`,

      input: message
    });

    res.json({
      reply: response.output_text || "تعذر الحصول على إجابة."
    });

  } catch (error) {

    console.error(
      "CHAT_ERROR:",
      error?.status,
      error?.message
    );

    res.status(500).json({
      error: "تعذر الاتصال بـ ALMOGHANI AI حاليًا."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ALMOGHANI AI running on port ${PORT}`);
});

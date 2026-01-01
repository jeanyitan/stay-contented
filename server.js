import express from "express";
import cors from "cors";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory job store (MVP only)
const jobs = new Map();

// Utility: ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Utility: write JSON and text files
function writeFileSafe(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

// ---- PROMPTS (use the ones we designed) ----
function promptPlan(brandContext) {
  return `
Create a monthly Instagram content plan.

Constraints:
- Exactly ${brandContext.campaign.posts_count} posts for month ${brandContext.campaign.month}
- Mix:
  - 6 Educational
  - 4 Authority/Positioning
  - 4 Relatable/Trust-building
  - 2 Soft Promotional
- No emojis, no hashtags, no exaggerated claims.
- Return JSON only with schema:
{
  "plan": {
    "month": "YYYY-MM",
    "posts_count": ${brandContext.campaign.posts_count},
    "posts": [
      {
        "id": "P01",
        "post_type": "educational|authority|relatable|promotional",
        "topic": "short topic",
        "angle": "specific angle",
        "hook_idea": "1 sentence",
        "value_points": ["p1","p2","p3"],
        "cta_type": "save|comment|learn_more|shop",
        "recommended_format": "single|carousel|reel_script|story_set",
        "visual_mode": "editorial|product_model"
      }
    ]
  }
}

Brand context JSON:
${JSON.stringify(brandContext)}
`.trim();
}

function promptCaptions(brandContext, planJson) {
  return `
Write captions for each post in the content plan below.

Rules:
- Match brand voice and banned words
- No emojis, no hashtags
- Structure:
  1) Hook (1 sentence)
  2) Value (2–5 short sentences or bullets)
  3) CTA (1 sentence aligned with cta_type)
- 60–140 words per caption
Return JSON only:
{
  "captions": [
    {
      "id": "P01",
      "caption": "string",
      "hook": "string",
      "cta": "string",
      "alt_text": "1 sentence",
      "internal_notes": {
        "target_intent": "awareness|consideration|conversion",
        "keywords": ["k1","k2"]
      }
    }
  ]
}

Brand context JSON:
${JSON.stringify(brandContext)}

Content plan JSON:
${JSON.stringify(planJson)}
`.trim();
}

function promptEditorialVisuals(brandContext, planJson, captionsJson) {
  return `
Create editorial visual briefs for each post.

Style rules:
- Clean professional
- Neutral background (white/light beige/soft gray)
- Modern sans-serif typography
- Lots of whitespace
- 1 minimal monochrome line icon max
- No photos, no people, no gradients, no decorative fonts

Return JSON only:
{
  "editorial_visuals": [
    {
      "id": "P01",
      "headline": "max 7 words",
      "subtext": "max 10 words or empty",
      "icon_hint": "one icon idea",
      "layout": "headline_top|headline_center|split_headline_subtext",
      "image_prompt": "string",
      "negative_prompt": "string"
    }
  ]
}

Brand context JSON:
${JSON.stringify(brandContext)}

Content plan JSON:
${JSON.stringify(planJson)}

Captions JSON:
${JSON.stringify(captionsJson)}
`.trim();
}

// Call OpenAI with JSON-only response (best effort)
async function callOpenAIJson(prompt) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No markdown. No extra text." },
      { role: "user", content: prompt }
    ]
  });

  const text = resp.choices?.[0]?.message?.content ?? "";
  // Basic parse; for MVP you can add a "JSON fixer" fallback.
  return JSON.parse(text);
}

// Background job runner
async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = "running";
    job.progress = 10;

    const brandContext = job.input;

    // 1) Plan
    const planJson = await callOpenAIJson(promptPlan(brandContext));
    job.progress = 35;

    // 2) Captions
    const captionsJson = await callOpenAIJson(promptCaptions(brandContext, planJson));
    job.progress = 55;

    // 3) Editorial visuals (for MVP)
    const visualsJson = await callOpenAIJson(
      promptEditorialVisuals(brandContext, planJson, captionsJson)
    );
    job.progress = 70;

    // 4) Save outputs (MVP: no image generation yet)
    const outDir = path.join("outputs", jobId);
    ensureDir(outDir);

    writeFileSafe(path.join(outDir, "content_plan.json"), JSON.stringify(planJson, null, 2));
    writeFileSafe(path.join(outDir, "captions.json"), JSON.stringify(captionsJson, null, 2));
    writeFileSafe(path.join(outDir, "editorial_visuals.json"), JSON.stringify(visualsJson, null, 2));

    // Simple download URL (serving static outputs)
    job.progress = 100;
    job.status = "done";
    job.downloadUrl = `/downloads/${jobId}/`;


  } catch (err) {
    job.status = "error";
    job.error = err?.message || "Unknown error";
  } finally {
    jobs.set(jobId, job);
  }
}

// Create job (inputs from your HTML form)
app.post("/api/jobs", upload.array("product_images", 3), (req, res) => {
  const jobId = uuidv4();

  // Parse input JSON fields
  const input = JSON.parse(req.body.input_json || "{}");

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    progress: 0,
    input,
    createdAt: Date.now()
  });

  // Kick off async work
  runJob(jobId);

  res.json({ jobId });
});

// Check job status
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

// Serve outputs (MVP local)
app.use("/downloads", express.static("outputs"));

app.listen(3000, () => console.log("Server running on http://localhost:3000"));


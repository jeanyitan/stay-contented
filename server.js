/**
 * server.js — Stay Contented MVP (clean version)
 *
 * What it does:
 * - Serves /public as the frontend
 * - Accepts POST /api/jobs with input_json
 * - Runs: plan -> applyMixedMode (12 editorial / 4 product_model) -> captions -> editorial briefs
 * - Compiles:
 *    - editorial_visuals_compiled.json (with image_prompt + negative_prompt)
 *    - product_model_briefs.json (4 posts x 2 variants)
 * - Generates editorial images (12) using OpenAI Images (gpt-image-1)
 * - Saves everything into outputs/<jobId>/
 * - Serves outputs via /downloads/<jobId>/...
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

// ---------------------- App setup ----------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory job store (MVP only)
const jobs = new Map();

// ---------------------- Utilities ----------------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFileSafe(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function slugify(str) {
  return (str || "brand")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ---------------------- Brand Style (MVP default) ----------------------
function makeDefaultBrandStyle(input) {
  const tone = input?.brand?.brand_voice?.tone || "professional";
  const brandName = input?.brand?.name || "brand";

  return {
    brand_id: slugify(brandName),
    style: {
      palette:
        tone === "bold"
          ? ["#111111", "#FFFFFF", "#E6E6E6"]
          : ["#111111", "#F5F2ED", "#D7D7D7"],
      background: "warm off-white",
      typography: "modern sans-serif",
      mood:
        tone === "friendly"
          ? "clean, friendly, confident"
          : "clean, calm, premium",
      composition: "lots of whitespace, clear hierarchy, minimal elements",
      do_not: [
        "busy layout",
        "neon colors",
        "photorealistic people",
        "clutter",
        "decorative fonts"
      ]
    },
    editorial: {
      layout_templates: ["headline_center", "headline_top", "split_headline_subtext"],
      icon_style: "monochrome line icon, single icon max"
    },
    product_model: {
      style_preset: "lifestyle_clean",
      lighting: "soft natural",
      background: "neutral",
      camera: "editorial product photography",
      model_notes: "commercial, tasteful, clean styling"
    }
  };
}

// ---------------------- Mixed mode allocation (12 editorial / 4 product_model) ----------------------
function applyMixedMode(planJson) {
  const posts = planJson?.plan?.posts || [];
  if (!posts.length) return planJson;

  const promo = posts.filter((p) => p.post_type === "promotional");
  const remaining = posts.filter((p) => p.post_type !== "promotional");

  const productish = remaining.filter((p) => {
    const t = (p.topic + " " + (p.angle || "")).toLowerCase();
    return (
      t.includes("product") ||
      t.includes("offer") ||
      t.includes("pricing") ||
      t.includes("launch") ||
      t.includes("features")
    );
  });

  const chosen = [];
  for (const p of promo) chosen.push(p);
  for (const p of productish) if (chosen.length < 4) chosen.push(p);
  for (const p of remaining) if (chosen.length < 4) chosen.push(p);

  const chosenIds = new Set(chosen.slice(0, 4).map((p) => p.id));

  for (const p of posts) {
    p.visual_mode = chosenIds.has(p.id) ? "product_model" : "editorial";
  }

  return planJson;
}

// ---------------------- Prompt compilers ----------------------
function compileEditorialPrompt(brandStyle, v) {
  const bg = brandStyle.style.background;
  const mood = brandStyle.style.mood;
  const icon = v.icon_hint || "simple icon";

  const image_prompt =
    `Minimal editorial Instagram post design. ` +
    `Background: ${bg}. Mood: ${mood}. ` +
    `Modern sans-serif typography, high legibility, lots of whitespace. ` +
    `Headline: "${v.headline}". ` +
    (v.subtext ? `Subtext: "${v.subtext}". ` : "") +
    `One monochrome line icon: ${icon}. ` +
    `Layout: ${v.layout}. No photos, no people.`;

  const negative_prompt =
    `photorealistic people, faces, clutter, gradients, decorative fonts, ` +
    `busy patterns, neon colors, low contrast text, illegible text, watermark, blurry`;

  return { image_prompt, negative_prompt };
}

function compileProductModelBrief(brandStyle, post, brandContext) {
  const preset = brandStyle.product_model.style_preset || "lifestyle_clean";
  const productName =
    brandContext?.product_mode?.product_names?.[0] ||
    brandContext?.brand?.offer_summary ||
    "the product";

  const base =
    `Commercial product imagery. Style preset: ${preset}. ` +
    `Lighting: ${brandStyle.product_model.lighting}. Background: ${brandStyle.product_model.background}. ` +
    `Camera: ${brandStyle.product_model.camera}. Brand mood: ${brandStyle.style.mood}.`;

  const variants = [
    {
      variant: "A",
      prompt: `${base} Feature ${productName} in a clean lifestyle scene. Minimal props. Natural premium feel.`,
      negative_prompt:
        "blurry, clutter, weird hands, extra fingers, distorted text, low quality, watermark"
    },
    {
      variant: "B",
      prompt: `${base} Studio-clean shot of ${productName}. Neutral background. Crisp premium product focus.`,
      negative_prompt:
        "blurry, clutter, warped label, distorted logo, low quality, watermark"
    }
  ];

  return { id: post.id, product_focus: productName, style_preset: preset, variants };
}

// ---------------------- OpenAI calls ----------------------
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
  try {
    return JSON.parse(text);
  } catch (e) {
    // Helpful debug if JSON breaks
    throw new Error(`JSON parse failed. First 200 chars:\n${text.slice(0, 200)}`);
  }
}

async function generateEditorialImage(prompt, outPath) {
  const result = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024"
  });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image returned from image API");

  const buffer = Buffer.from(b64, "base64");
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, buffer);
}

// ---------------------- Prompts (Text) ----------------------
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

// ---------------------- Job runner ----------------------
async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = "running";
    job.progress = 10;

    const brandContext = job.input;

    // 1) Plan
    let planJson = await callOpenAIJson(promptPlan(brandContext));
    planJson = applyMixedMode(planJson);
    job.progress = 35;

    // 2) Captions
    const captionsJson = await callOpenAIJson(promptCaptions(brandContext, planJson));
    job.progress = 55;

    // 3) Editorial briefs (still generated for all posts; we filter later)
    const visualsJson = await callOpenAIJson(
      promptEditorialVisuals(brandContext, planJson, captionsJson)
    );
    job.progress = 65;

    // Brand style + compiled prompts
    const brandStyle = makeDefaultBrandStyle(brandContext);

    const editorialVisualsCompiled = (visualsJson.editorial_visuals || []).map((v) => {
      const compiled = compileEditorialPrompt(brandStyle, v);
      return { ...v, ...compiled };
    });

    const posts = planJson?.plan?.posts || [];
    const productPosts = posts.filter((p) => p.visual_mode === "product_model");
    const productBriefs = productPosts.map((p) =>
      compileProductModelBrief(brandStyle, p, brandContext)
    );

    // 4) Save outputs
    const outDir = path.join("outputs", jobId);
    ensureDir(outDir);

    writeFileSafe(path.join(outDir, "content_plan.json"), JSON.stringify(planJson, null, 2));
    writeFileSafe(path.join(outDir, "captions.json"), JSON.stringify(captionsJson, null, 2));
    writeFileSafe(path.join(outDir, "editorial_visuals.json"), JSON.stringify(visualsJson, null, 2));
    writeFileSafe(path.join(outDir, "brand_style.json"), JSON.stringify(brandStyle, null, 2));
    writeFileSafe(
      path.join(outDir, "editorial_visuals_compiled.json"),
      JSON.stringify({ editorial_visuals: editorialVisualsCompiled }, null, 2)
    );
    writeFileSafe(
      path.join(outDir, "product_model_briefs.json"),
      JSON.stringify({ product_visuals: productBriefs }, null, 2)
    );

    // 5) Generate 12 editorial images
    const editorialDir = path.join(outDir, "Editorial_Posts");
    ensureDir(editorialDir);

    const editorialIds = new Set(
      posts.filter((p) => p.visual_mode === "editorial").map((p) => p.id)
    );

    const editorialOnly = editorialVisualsCompiled.filter((v) => editorialIds.has(v.id));

    job.progress = 75;

    for (const v of editorialOnly) {
      const outPath = path.join(editorialDir, `${v.id}.png`);
      await generateEditorialImage(v.image_prompt, outPath);
    }

    // Done
    job.progress = 100;
    job.status = "done";
    job.downloadUrl = `/downloads/${jobId}/content_plan.json`;
  } catch (err) {
    job.status = "error";
    job.error = err?.message || "Unknown error";
  } finally {
    jobs.set(jobId, job);
  }
}

// ---------------------- Routes ----------------------
app.post("/api/jobs", upload.array("product_images", 3), (req, res) => {
  const jobId = uuidv4();
  const input = JSON.parse(req.body.input_json || "{}");

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    progress: 0,
    input,
    createdAt: Date.now()
  });

  runJob(jobId);

  res.json({ jobId });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

// Serve outputs
app.use("/downloads", express.static("outputs"));

// ---------------------- Start ----------------------
app.listen(3000, () => console.log("Server running on http://localhost:3000"));

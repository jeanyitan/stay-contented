const form = document.getElementById("contentForm");
const statusEl = document.getElementById("status");

function showStatus(html) {
  statusEl.innerHTML = html;
  statusEl.classList.remove("hidden");
}

async function pollJob(jobId) {
  while (true) {
    const res = await fetch(`http://localhost:3000/api/jobs/${jobId}`);
    const job = await res.json();

    if (job.status === "error") {
      showStatus(`<strong>Error:</strong> ${job.error}`);
      return;
    }

    if (job.status === "done") {
      showStatus(`
        <strong>Done.</strong><br/>
        <a href="${job.downloadUrl}" target="_blank">Download outputs</a>
      `);
      return;
    }

    showStatus(`<strong>Status:</strong> ${job.status} — ${job.progress}%`);
    await new Promise(r => setTimeout(r, 1500));
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const data = new FormData(form);
  const input = {
    brand: {
      name: data.get("brandName"),
      website: data.get("website") || "",
      industry: data.get("industry"),
      offer_summary: data.get("offerSummary"),
      target_customer: "",
      brand_voice: {
        tone: data.get("tone"),
        style_notes: "clear, calm, no hype, no slang, no emojis",
        words_to_use: [],
        words_to_avoid: ["guaranteed", "instant", "miracle", "viral"]
      }
    },
    campaign: {
      month: data.get("month"),
      posts_count: Number(data.get("postsCount")),
      primary_platform: "instagram",
      primary_goal: "increase awareness and consideration",
      cta_preference: ["save", "learn_more", "comment", "shop"],
      compliance: { no_income_claims: true, no_medical_claims: true }
    },
    content_mode: data.get("mode"),
    product_mode: {
      enabled: data.get("mode") === "product_model",
      product_names: [],
      product_descriptions: [],
      image_style_preset: "lifestyle_clean"
    }
  };

  showStatus("Creating job…");

  const payload = new FormData();
  payload.append("input_json", JSON.stringify(input));

  const res = await fetch("http://localhost:3000/api/jobs", {
    method: "POST",
    body: payload
  });

  const { jobId } = await res.json();
  showStatus(`Job started: ${jobId}`);
  pollJob(jobId);
});

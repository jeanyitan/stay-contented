const form = document.getElementById("contentForm");
const statusEl = document.getElementById("status");

function showStatus(html) {
  statusEl.innerHTML = html;
  statusEl.classList.remove("hidden");
}

// Handle industry dropdown "Other" option
const industrySelect = document.querySelector('select[name="industry"]');
const industryOtherGroup = document.getElementById("industryOtherGroup");

industrySelect.addEventListener("change", function() {
  if (this.value === "other") {
    industryOtherGroup.style.display = "flex";
    industryOtherGroup.querySelector('input[name="industryOther"]').required = true;
  } else {
    industryOtherGroup.style.display = "none";
    industryOtherGroup.querySelector('input[name="industryOther"]').required = false;
  }
});

async function pollJob(jobId) {
  while (true) {
    let res;
    try {
      res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
    } catch (err) {
      showStatus(
        `<strong>Network error:</strong> Could not reach backend. Check Netlify _redirects and backend URL.`
      );
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      showStatus(
        `<strong>Error:</strong> Job lookup failed (${res.status}).<br/><pre style="white-space:pre-wrap">${text}</pre>`
      );
      return;
    }

    const job = await res.json();

    if (job.status === "error") {
      showStatus(`<strong>Error:</strong> ${job.error}`);
      return;
    }

    if (job.status === "done") {
      showStatus(`
        <strong>Done.</strong><br/>
        <ul>
          <li><a href="/downloads/${jobId}.zip" target="_blank" rel="noopener"><strong>Download everything (.zip)</strong></a></li>
          <li><a href="/downloads/${jobId}/content_plan.json" target="_blank" rel="noopener">content_plan.json</a></li>
          <li><a href="/downloads/${jobId}/captions.json" target="_blank" rel="noopener">captions.json</a></li>
          <li><a href="/downloads/${jobId}/editorial_visuals.json" target="_blank" rel="noopener">editorial_visuals.json</a></li>
          <li><a href="/downloads/${jobId}/editorial_visuals_compiled.json" target="_blank" rel="noopener">editorial_visuals_compiled.json</a></li>
          <li><a href="/downloads/${jobId}/product_model_briefs.json" target="_blank" rel="noopener">product_model_briefs.json</a></li>
        </ul>
        <p style="margin-top:10px;">
          <a href="/downloads/${jobId}/Editorial_Posts/" target="_blank" rel="noopener">Open Editorial_Posts folder</a>
        </p>
      `);
      return;
    }

    showStatus(`<strong>Status:</strong> ${job.status} — ${job.progress}%`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const data = new FormData(form);

  // Handle industry field - use "other" text if "other" is selected
  let industry = data.get("industry");
  if (industry === "other") {
    industry = data.get("industryOther") || "other";
  }

  const input = {
    brand: {
      name: data.get("brandName"),
      website: data.get("website") || "",
      industry: industry,
      offer_summary: data.get("offerSummary"),
      target_customer: "",
      brand_voice: {
        tone: data.get("tone"),
        style_notes: "clear, calm, no hype, no slang, no emojis",
        words_to_use: [],
        words_to_avoid: ["guaranteed", "instant", "miracle", "viral"],
      },
    },
    campaign: {
      month: data.get("month"),
      posts_count: Number(data.get("postsCount")),
      primary_platform: "instagram",
      primary_goal: "increase awareness and consideration",
      cta_preference: ["save", "learn_more", "comment", "shop"],
      compliance: { no_income_claims: true, no_medical_claims: true },
    },
    content_mode: data.get("mode"),
    product_mode: {
      enabled: data.get("mode") === "product_model",
      product_names: [],
      product_descriptions: [],
      image_style_preset: "lifestyle_clean",
    },
  };

  showStatus("Creating job…");

  const payload = new FormData();
  payload.append("input_json", JSON.stringify(input));

  let res;
  try {
    res = await fetch("/api/jobs", {
      method: "POST",
      body: payload,
    });
  } catch (err) {
    showStatus(
      `<strong>Network error:</strong> Could not reach backend. Check Netlify _redirects and backend URL.`
    );
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    showStatus(
      `<strong>Error:</strong> Job creation failed (${res.status}).<br/><pre style="white-space:pre-wrap">${text}</pre>`
    );
    return;
  }

  const { jobId } = await res.json();
  showStatus(`Job started: ${jobId}`);
  pollJob(jobId);
});

import { useState, useRef } from "react";

async function extractTextFromPDF(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const base64 = e.target.result.split(",")[1];
        resolve({ name: file.name, base64 });
      } catch (err) { reject(err); }
    };
    reader.readAsDataURL(file);
  });
}

async function searchRelatedPapers(title) {
  try {
    const query = encodeURIComponent(title.replace(/[^a-zA-Z0-9 ]/g, "").substring(0, 100));
    const res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&limit=3&fields=title,abstract`);
    if (!res.ok) return "";
    const data = await res.json();
    return (data.data || []).filter(p => p.abstract).map(p => `Title: ${p.title}\nAbstract: ${p.abstract}`).join("\n\n");
  } catch { return ""; }
}







async function callAI(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, max_tokens: 2000, temperature: 0.3 })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model. Try again.");
  return content.trim();
}

async function detectAndClusterGaps(papers, useRAG) {
  const apiKey = "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";

  // RAG
  let ragContext = "";
  if (useRAG) {
    const related = await Promise.all(papers.map(p => searchRelatedPapers(p.name.replace(".pdf", ""))));
    ragContext = related.filter(Boolean).join("\n\n");
  }

  const paperList = papers.map((p, i) => `Paper ${i + 1}: ${p.name}`).join("\n");
  const ragSection = ragContext ? `\n\nRelated literature (use to ground gaps):\n${ragContext.substring(0, 2000)}` : "";

  // METHOD 1: Taxonomy-guided prompting — 4 categories separately
  const taxonomyPrompt = `You are an expert research analyst performing a systematic literature review.

Uploaded papers:
${paperList}
${ragSection}

Analyze ALL ${papers.length} paper(s) together. Find research gaps across ALL papers in these 4 specific categories:

1. METHODOLOGY — inappropriate methods, data quality issues, unstated assumptions
2. EXPERIMENTAL DESIGN — insufficient baselines, limited datasets, lack of ablation studies
3. RESULT ANALYSIS — insufficient metrics, limited error analysis, missing statistical tests
4. LITERATURE REVIEW — missing citations, limited scope, inaccurate descriptions

For each gap also provide:
- confidence: 0.0 to 1.0 (1.0 = strongly evidenced, 0.0 = inferred)
- evidence: brief reference to which paper and what section supports this gap

Return ONLY valid JSON (no markdown):
{
  "titles": ["paper title 1"],
  "gaps_by_category": {
    "Methodology": [{"gap": "gap description", "confidence": 0.8, "evidence": "Paper 1, Section 3"}],
    "Experimental Design": [{"gap": "gap description", "confidence": 0.9, "evidence": "Paper 2, Table 2"}],
    "Result Analysis": [{"gap": "gap description", "confidence": 0.7, "evidence": "Paper 1, Section 5"}],
    "Literature Review": [{"gap": "gap description", "confidence": 0.6, "evidence": "Paper 1, Related Work"}]
  }
}`;

  const rawGaps = await callAI([{ role: "user", content: taxonomyPrompt }], apiKey);
  const parsed = JSON.parse(rawGaps.replace(/```json|```/g, "").trim());
  const { titles, gaps_by_category } = parsed;

  // Flatten all gaps with category and confidence
  const allGaps = Object.entries(gaps_by_category).flatMap(([cat, items]) =>
    items.map(item => ({ ...item, category: cat }))
  );

  // METHOD 2: Self-refinement — critique and improve gaps
  const critiquePrompt = `You are a strict peer reviewer. Evaluate these research gaps and improve them.

Papers analyzed: ${paperList}

Current gaps:
${allGaps.map((g, i) => `${i + 1}. [${g.category}] ${g.gap} (confidence: ${g.confidence}, evidence: ${g.evidence})`).join("\n")}

For each gap:
1. Is it specific enough? (not vague like "needs more research")
2. Is it grounded in the papers? (not hallucinated)
3. Is it a real research gap? (not a minor issue)

Improve vague gaps to be specific. Remove hallucinated gaps. Keep only real gaps.
Also detect any CONTRADICTIONS between papers where one paper claims X but another claims opposite.

Return ONLY valid JSON (no markdown):
{
  "refined_gaps": [
    {"gap": "improved specific gap", "category": "Methodology", "confidence": 0.9, "evidence": "Paper 1, Section 3"}
  ],
  "contradictions": [
    {"description": "Paper 1 claims X while Paper 2 claims Y", "significance": "high"}
  ]
}`;

  const rawRefined = await callAI([{ role: "user", content: critiquePrompt }], apiKey);
  const refined = JSON.parse(rawRefined.replace(/```json|```/g, "").trim());
  const { refined_gaps, contradictions } = refined;

  // Sort by confidence descending
  const rankedGaps = refined_gaps.sort((a, b) => b.confidence - a.confidence);

  // METHOD 5: Cluster with confidence scores
  const clusterPrompt = `Group these research gaps into thematic clusters using the LIMITGEN taxonomy.

Gaps:
${rankedGaps.map((g, i) => `${i + 1}. [${g.category}] ${g.gap} (confidence: ${g.confidence})`).join("\n")}

Return ONLY valid JSON (no markdown):
{
  "clusters": [
    {
      "theme": "Theme Name",
      "category": "Methodology",
      "avg_confidence": 0.85,
      "gaps": ["gap 1", "gap 2"]
    }
  ]
}`;

  const rawClusters = await callAI([{ role: "user", content: clusterPrompt }], apiKey);
  const { clusters } = JSON.parse(rawClusters.replace(/```json|```/g, "").trim());

  return {
    titles,
    gaps: rankedGaps,
    clusters,
    contradictions: contradictions || [],
    ragUsed: useRAG && !!ragContext
  };
}

export default function App() {
  const [stage, setStage] = useState("upload");
  const [dragOver, setDragOver] = useState(false);
  const [files, setFiles] = useState([]);
  const [loadingStep, setLoadingStep] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [activeCluster, setActiveCluster] = useState(0);
  const [useRAG, setUseRAG] = useState(false);
  const [activeTab, setActiveTab] = useState("gaps");
  const fileInputRef = useRef();

  const loadingSteps = [
    "Reading PDFs...",
    "Extracting research content...",
    useRAG ? "Fetching related literature (RAG)..." : "Comparing papers...",
    "Taxonomy-guided gap extraction...",
    "Self-refinement & contradiction detection...",
    "Clustering with confidence scores..."
  ];

  const handleFiles = (newFiles) => {
    const pdfs = Array.from(newFiles).filter(f => f.type === "application/pdf");
    if (pdfs.length === 0) { setError("Please upload valid PDF files."); return; }
    if (files.length >= 5) { setError("Maximum 5 papers allowed."); return; }
    setError("");
    setFiles(prev => {
      const existing = prev.map(f => f.name);
      const unique = pdfs.filter(f => !existing.includes(f.name));
      return [...prev, ...unique].slice(0, 5);
    });
  };

  const removeFile = (name) => setFiles(prev => prev.filter(f => f.name !== name));

  const handleAnalyze = async () => {
    if (files.length < 1) { setError("Please upload at least 1 PDF."); return; }
    setError(""); setStage("loading"); setLoadingStep(0);
    let step = 0;
    const interval = setInterval(() => { step++; if (step < loadingSteps.length) setLoadingStep(step); }, 3000);
    try {
      const papers = await Promise.all(files.map(extractTextFromPDF));
      const data = await detectAndClusterGaps(papers, useRAG);
      clearInterval(interval);
      setResult(data); setStage("results");
    } catch (err) {
      clearInterval(interval);
      setError(`Error: ${err.message}`);
      setStage("upload");
      console.error(err);
    }
  };

  const reset = () => { setStage("upload"); setResult(null); setFiles([]); setLoadingStep(0); setActiveCluster(0); setActiveTab("gaps"); setError(""); };

  const confidenceColor = (c) => c >= 0.8 ? "#64c4a0" : c >= 0.6 ? "#c4a464" : "#e07070";
  const confidenceLabel = (c) => c >= 0.8 ? "High" : c >= 0.6 ? "Medium" : "Low";

  return (
    <div style={{ minHeight: "100vh", width: "100vw", background: "#0a0a0f", fontFamily: "'Georgia', serif", color: "#e8e4d9", overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Source+Sans+3:wght@300;400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { width: 100%; min-height: 100vh; background: #0a0a0f; }
        .upload-zone { border: 1.5px dashed rgba(196,164,100,0.4); border-radius: 8px; padding: 60px 40px; text-align: center; cursor: pointer; transition: all 0.3s ease; background: rgba(196,164,100,0.02); position: relative; overflow: hidden; }
        .upload-zone:hover, .upload-zone.dragover { border-color: rgba(196,164,100,0.8); background: rgba(196,164,100,0.05); }
        .file-chip { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: rgba(196,164,100,0.08); border: 1px solid rgba(196,164,100,0.2); border-radius: 4px; font-family: 'Source Sans 3', sans-serif; font-size: 13px; color: #e8e4d9; animation: fadeSlide 0.3s ease both; }
        .remove-btn { background: none; border: none; color: rgba(196,164,100,0.5); cursor: pointer; font-size: 16px; padding: 0 2px; margin-left: auto; transition: color 0.2s; }
        .remove-btn:hover { color: #e07070; }
        .analyze-btn { width: 100%; padding: 16px; background: rgba(196,164,100,0.12); border: 1px solid rgba(196,164,100,0.5); color: #c4a464; font-family: 'Source Sans 3', sans-serif; font-size: 15px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; border-radius: 4px; transition: all 0.2s ease; }
        .analyze-btn:hover { background: rgba(196,164,100,0.2); border-color: #c4a464; }
        .rag-toggle { display: flex; align-items: center; gap: 12px; padding: 14px 18px; background: rgba(100,196,160,0.06); border: 1px solid rgba(100,196,160,0.25); border-radius: 6px; cursor: pointer; margin-bottom: 16px; transition: all 0.2s ease; }
        .rag-toggle:hover { background: rgba(100,196,160,0.1); }
        .rag-toggle.active { background: rgba(100,196,160,0.12); border-color: rgba(100,196,160,0.6); }
        .toggle-dot { width: 40px; height: 22px; border-radius: 11px; background: rgba(100,196,160,0.2); border: 1px solid rgba(100,196,160,0.4); position: relative; flex-shrink: 0; }
        .toggle-dot.on { background: rgba(100,196,160,0.5); border-color: rgba(100,196,160,0.8); }
        .toggle-dot::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: rgba(100,196,160,0.6); transition: left 0.2s ease; }
        .toggle-dot.on::after { left: 21px; background: #64c4a0; }
        .gap-item { padding: 14px 0; border-bottom: 1px solid rgba(196,164,100,0.1); display: flex; gap: 12px; align-items: flex-start; animation: fadeSlide 0.4s ease both; }
        .gap-item:last-child { border-bottom: none; }
        @keyframes fadeSlide { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: translateX(0); } }
        .cluster-tab { padding: 9px 16px; background: transparent; border: 1px solid rgba(196,164,100,0.25); color: rgba(232,228,217,0.6); cursor: pointer; font-family: 'Source Sans 3', sans-serif; font-size: 12px; border-radius: 2px; transition: all 0.2s ease; white-space: nowrap; }
        .cluster-tab:hover { border-color: rgba(196,164,100,0.6); color: rgba(232,228,217,0.9); }
        .cluster-tab.active { background: rgba(196,164,100,0.12); border-color: rgba(196,164,100,0.7); color: #c4a464; }
        .result-tab { padding: 10px 20px; background: transparent; border: none; border-bottom: 2px solid transparent; color: rgba(232,228,217,0.5); cursor: pointer; font-family: 'Source Sans 3', sans-serif; font-size: 13px; transition: all 0.2s ease; }
        .result-tab.active { color: #c4a464; border-bottom-color: #c4a464; }
        @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
        .reset-btn { background: transparent; border: 1px solid rgba(196,164,100,0.4); color: #c4a464; padding: 10px 28px; font-family: 'Source Sans 3', sans-serif; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; border-radius: 2px; transition: all 0.2s ease; }
        .reset-btn:hover { background: rgba(196,164,100,0.1); }
        .rank-badge { min-width: 28px; height: 28px; border-radius: 50%; background: rgba(196,164,100,0.12); border: 1px solid rgba(196,164,100,0.3); display: flex; align-items: center; justify-content: center; font-family: 'Source Sans 3', sans-serif; font-size: 11px; color: #c4a464; flex-shrink: 0; margin-top: 2px; }
        .rank-badge.top { background: rgba(196,164,100,0.2); border-color: #c4a464; }
        .scroll-container { overflow-y: auto; max-height: 480px; padding-right: 8px; scrollbar-width: thin; scrollbar-color: rgba(196,164,100,0.3) transparent; }
        .scroll-container::-webkit-scrollbar { width: 4px; }
        .scroll-container::-webkit-scrollbar-thumb { background: rgba(196,164,100,0.3); border-radius: 2px; }
        .results-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
        @media (max-width: 900px) { .results-grid { grid-template-columns: 1fr; } }
        .paper-tag { display: inline-block; padding: 3px 10px; background: rgba(196,164,100,0.08); border: 1px solid rgba(196,164,100,0.2); border-radius: 2px; font-size: 11px; font-family: 'Source Sans 3', sans-serif; color: rgba(196,164,100,0.7); margin: 3px; }
        .conf-badge { display: inline-block; padding: 1px 7px; border-radius: 2px; font-size: 10px; font-family: 'Source Sans 3', sans-serif; margin-left: 6px; }
        .cat-badge { display: inline-block; padding: 2px 8px; background: rgba(100,164,196,0.1); border: 1px solid rgba(100,164,196,0.2); border-radius: 2px; font-size: 10px; font-family: 'Source Sans 3', sans-serif; color: rgba(100,164,196,0.8); margin-left: 4px; }
        .contradiction-item { padding: 12px 16px; background: rgba(224,112,112,0.06); border: 1px solid rgba(224,112,112,0.2); border-radius: 6px; margin-bottom: 10px; }
        .free-badge { display: inline-block; padding: 2px 8px; background: rgba(100,196,120,0.1); border: 1px solid rgba(100,196,120,0.3); border-radius: 2px; font-size: 11px; font-family: 'Source Sans 3', sans-serif; color: rgba(100,196,120,0.8); margin-left: 8px; }
        .rag-badge { display: inline-block; padding: 2px 8px; background: rgba(100,196,160,0.1); border: 1px solid rgba(100,196,160,0.3); border-radius: 2px; font-size: 11px; font-family: 'Source Sans 3', sans-serif; color: rgba(100,196,160,0.8); margin-left: 8px; }
        .evidence-text { font-size: 11px; color: rgba(196,164,100,0.5); margin-top: 4px; font-style: italic; }
      `}</style>

      <header style={{ borderBottom: "1px solid rgba(196,164,100,0.15)", padding: "24px 64px", display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", fontWeight: 600, color: "#e8e4d9" }}>
            Research Gap Identifier
            <span className="free-badge">FREE</span>
            {result?.ragUsed && <span className="rag-badge">RAG Enhanced</span>}
          </div>
          <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "12px", color: "rgba(196,164,100,0.7)", letterSpacing: "0.1em", textTransform: "uppercase", marginTop: "3px" }}>
            MDGE · Taxonomy-Guided · Self-Refinement · Confidence Scoring
          </div>
        </div>
        {stage === "results" && <button className="reset-btn" onClick={reset}>← New Analysis</button>}
      </header>

      <main style={{ width: "100%", padding: "60px 64px" }}>

        {stage === "upload" && (
          <div style={{ maxWidth: "860px", margin: "0 auto" }}>
            <div style={{ textAlign: "center", marginBottom: "52px" }}>
              <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: "clamp(32px, 4vw, 52px)", fontWeight: 700, lineHeight: 1.15, marginBottom: "18px" }}>
                Uncover what<br /><span style={{ color: "#c4a464" }}>science has yet to answer</span>
              </h1>
              <p style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "16px", fontWeight: 300, color: "rgba(232,228,217,0.6)", lineHeight: 1.7, maxWidth: "520px", margin: "0 auto" }}>
                Upload <strong style={{ color: "rgba(196,164,100,0.8)" }}>multiple research papers</strong> and MDGE will identify, refine, and rank gaps across all of them using taxonomy-guided analysis.
              </p>
            </div>

            <div className={`upload-zone ${dragOver ? "dragover" : ""}`} onClick={() => fileInputRef.current.click()} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}>
              <div style={{ fontSize: "40px", opacity: 0.4, marginBottom: "16px" }}>📄</div>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", marginBottom: "10px", color: "#e8e4d9" }}>Drop your PDFs here</div>
              <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "13px", color: "rgba(196,164,100,0.6)" }}>or click to browse — max 5 papers</div>
              <input ref={fileInputRef} type="file" accept=".pdf" multiple style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
            </div>

            {files.length > 0 && (
              <div style={{ marginTop: "24px" }}>
                <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(196,164,100,0.6)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "12px" }}>{files.length} / 5 papers selected</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "20px" }}>
                  {files.map((f, i) => (
                    <div key={i} className="file-chip">
                      <span style={{ color: "#c4a464", fontSize: "12px" }}>📄</span>
                      <span style={{ flex: 1 }}>{f.name}</span>
                      <span style={{ fontSize: "11px", color: "rgba(232,228,217,0.3)" }}>{(f.size / 1024).toFixed(0)} KB</span>
                      <button className="remove-btn" onClick={(e) => { e.stopPropagation(); removeFile(f.name); }}>×</button>
                    </div>
                  ))}
                </div>

                <div className={`rag-toggle ${useRAG ? "active" : ""}`} onClick={() => setUseRAG(!useRAG)}>
                  <div className={`toggle-dot ${useRAG ? "on" : ""}`} />
                  <div>
                    <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "13px", fontWeight: 500, color: useRAG ? "rgba(100,196,160,0.9)" : "rgba(232,228,217,0.6)" }}>RAG Enhancement {useRAG ? "ON" : "OFF"}</div>
                    <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(232,228,217,0.4)", marginTop: "2px" }}>{useRAG ? "Fetching related papers from Semantic Scholar" : "Enable to retrieve related literature"}</div>
                  </div>
                </div>

                <button className="analyze-btn" onClick={handleAnalyze}>
                  Analyze {files.length} Paper{files.length > 1 ? "s" : ""} with MDGE {useRAG ? "+ RAG" : ""} →
                </button>
              </div>
            )}

            {error && <div style={{ marginTop: "16px", fontFamily: "'Source Sans 3', sans-serif", fontSize: "13px", color: "#e07070", textAlign: "center" }}>{error}</div>}

            <div style={{ display: "flex", justifyContent: "center", gap: "32px", marginTop: "48px", borderTop: "1px solid rgba(196,164,100,0.1)", paddingTop: "32px", flexWrap: "wrap" }}>
              {["Taxonomy-guided", "Self-refinement", "Contradiction detection", "Confidence scoring", "RAG enhanced"].map((item, i) => (
                <div key={i} style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(196,164,100,0.5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{item}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {stage === "loading" && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "13px", color: "rgba(196,164,100,0.5)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "12px" }}>MDGE analyzing {files.length} paper{files.length > 1 ? "s" : ""}</div>
            <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "8px", marginBottom: "48px" }}>
              {files.map((f, i) => <span key={i} className="paper-tag">{f.name}</span>)}
            </div>
            <div style={{ display: "inline-block", textAlign: "left", minWidth: "380px" }}>
              {loadingSteps.map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "14px", padding: "12px 0", opacity: i <= loadingStep ? 1 : 0.25, transition: "opacity 0.3s ease" }}>
                  <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: i <= loadingStep ? "#c4a464" : "rgba(196,164,100,0.3)", animation: i === loadingStep ? "pulse 1.2s ease-in-out infinite" : "none", flexShrink: 0 }} />
                  <span style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "15px", color: i <= loadingStep ? "#e8e4d9" : "rgba(232,228,217,0.3)" }}>{step}</span>
                  {i < loadingStep && <span style={{ color: "#c4a464" }}>✓</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {stage === "results" && result && (
          <div>
            <div style={{ marginBottom: "28px" }}>
              <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(196,164,100,0.6)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "10px" }}>Papers Analyzed</div>
              <div style={{ display: "flex", flexWrap: "wrap", marginBottom: "16px" }}>
                {result.titles.map((t, i) => <span key={i} className="paper-tag">{t}</span>)}
              </div>
              <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "14px", color: "#c4a464" }}>{result.gaps.length} gaps identified</span>
                <span style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "14px", color: "rgba(232,228,217,0.4)" }}>{result.clusters.length} clusters</span>
                {result.contradictions.length > 0 && <span style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "14px", color: "#e07070" }}>{result.contradictions.length} contradiction{result.contradictions.length > 1 ? "s" : ""} detected</span>}
                {result.ragUsed && <span style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "14px", color: "rgba(100,196,160,0.7)" }}>✓ RAG Enhanced</span>}
              </div>
            </div>

            {/* Result tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid rgba(196,164,100,0.15)", marginBottom: "24px", gap: "4px" }}>
              <button className={`result-tab ${activeTab === "gaps" ? "active" : ""}`} onClick={() => setActiveTab("gaps")}>Ranked Gaps</button>
              <button className={`result-tab ${activeTab === "clusters" ? "active" : ""}`} onClick={() => setActiveTab("clusters")}>Themes</button>
              {result.contradictions.length > 0 && <button className={`result-tab ${activeTab === "contradictions" ? "active" : ""}`} onClick={() => setActiveTab("contradictions")}>Contradictions ({result.contradictions.length})</button>}
            </div>

            {activeTab === "gaps" && (
              <div className="results-grid">
                <div style={{ padding: "28px", background: "rgba(196,164,100,0.04)", border: "1px solid rgba(196,164,100,0.15)", borderRadius: "6px" }}>
                  <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(196,164,100,0.7)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "16px" }}>Research Gaps · Ranked by Confidence</div>
                  <div className="scroll-container">
                    {result.gaps.map((gap, i) => (
                      <div key={i} className="gap-item" style={{ animationDelay: `${i * 0.05}s` }}>
                        <div className={`rank-badge ${i < 3 ? "top" : ""}`}>{i + 1}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px", marginBottom: "4px" }}>
                            <span className="cat-badge">{gap.category}</span>
                            <span className="conf-badge" style={{ background: `${confidenceColor(gap.confidence)}18`, border: `1px solid ${confidenceColor(gap.confidence)}40`, color: confidenceColor(gap.confidence) }}>
                              {confidenceLabel(gap.confidence)} · {Math.round(gap.confidence * 100)}%
                            </span>
                          </div>
                          <p style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "13px", lineHeight: 1.65, color: i < 3 ? "#e8e4d9" : "rgba(232,228,217,0.75)", fontWeight: i < 3 ? 400 : 300 }}>{gap.gap}</p>
                          {gap.evidence && <p className="evidence-text">Evidence: {gap.evidence}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ padding: "28px", background: "rgba(196,164,100,0.04)", border: "1px solid rgba(196,164,100,0.15)", borderRadius: "6px" }}>
                  <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(196,164,100,0.7)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "16px" }}>Gaps by Category</div>
                  {["Methodology", "Experimental Design", "Result Analysis", "Literature Review"].map(cat => {
                    const catGaps = result.gaps.filter(g => g.category === cat);
                    if (catGaps.length === 0) return null;
                    return (
                      <div key={cat} style={{ marginBottom: "20px" }}>
                        <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "12px", color: "#c4a464", marginBottom: "8px", fontWeight: 500 }}>{cat} ({catGaps.length})</div>
                        {catGaps.map((g, i) => (
                          <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid rgba(196,164,100,0.08)", fontSize: "12px", color: "rgba(232,228,217,0.7)", lineHeight: 1.5, fontFamily: "'Source Sans 3', sans-serif" }}>
                            {g.gap}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === "clusters" && (
              <div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}>
                  {result.clusters.map((cluster, i) => (
                    <button key={i} className={`cluster-tab ${activeCluster === i ? "active" : ""}`} onClick={() => setActiveCluster(i)}>
                      {cluster.theme}
                      <span style={{ marginLeft: "6px", opacity: 0.6, fontSize: "10px" }}>({cluster.gaps.length})</span>
                    </button>
                  ))}
                </div>
                <div style={{ padding: "28px", border: "1px solid rgba(196,164,100,0.15)", borderRadius: "6px", background: "rgba(196,164,100,0.02)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
                    <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "18px", color: "#c4a464", fontWeight: 600 }}>{result.clusters[activeCluster].theme}</div>
                    {result.clusters[activeCluster].avg_confidence && (
                      <span className="conf-badge" style={{ background: `${confidenceColor(result.clusters[activeCluster].avg_confidence)}18`, border: `1px solid ${confidenceColor(result.clusters[activeCluster].avg_confidence)}40`, color: confidenceColor(result.clusters[activeCluster].avg_confidence) }}>
                        Avg confidence: {Math.round(result.clusters[activeCluster].avg_confidence * 100)}%
                      </span>
                    )}
                  </div>
                  {result.clusters[activeCluster].gaps.map((gap, i) => (
                    <div key={i} className="gap-item" style={{ animationDelay: `${i * 0.07}s` }}>
                      <div style={{ width: "6px", height: "6px", background: "rgba(196,164,100,0.6)", borderRadius: "50%", flexShrink: 0, marginTop: "8px" }} />
                      <p style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "13px", lineHeight: 1.65, color: "rgba(232,228,217,0.8)", fontWeight: 300 }}>{gap}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "contradictions" && result.contradictions.length > 0 && (
              <div>
                <div style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(224,112,112,0.7)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "16px" }}>
                  Cross-Paper Contradictions Detected
                </div>
                {result.contradictions.map((c, i) => (
                  <div key={i} className="contradiction-item">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                      <span style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "#e07070", fontWeight: 500 }}>Contradiction {i + 1}</span>
                      {c.significance && <span style={{ fontSize: "10px", padding: "1px 6px", background: "rgba(224,112,112,0.1)", border: "1px solid rgba(224,112,112,0.2)", borderRadius: "2px", color: "#e07070" }}>{c.significance}</span>}
                    </div>
                    <p style={{ fontFamily: "'Source Sans 3', sans-serif", fontSize: "13px", color: "rgba(232,228,217,0.8)", lineHeight: 1.6 }}>{c.description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      <footer style={{ borderTop: "1px solid rgba(196,164,100,0.1)", padding: "20px 64px", textAlign: "center", fontFamily: "'Source Sans 3', sans-serif", fontSize: "11px", color: "rgba(232,228,217,0.25)", letterSpacing: "0.06em" }}>
        MDGE · Multi-Document Gap Extraction · Taxonomy-Guided · Self-Refinement · Confidence Scoring · RAG
      </footer>
    </div>
  );
}

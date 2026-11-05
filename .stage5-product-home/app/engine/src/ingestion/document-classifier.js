'use strict';

class DocumentClassifier {
  constructor({ logger = null }) {
    this.logger = logger;
  }

  /**
   * Classify a document into a family using heuristics on text and block structure.
   * Pure function -- no I/O, no external deps.
   *
   * @param {string} text - The full document text
   * @param {object[]} blocks - The chunked blocks from DocumentChunker
   * @returns {{ family: string, confidence: number }}
   */
  classify(text, blocks) {
    const scores = {
      contract: 0,
      policy: 0,
      transcript: 0,
      creative: 0,
      technical: 0,
      report: 0,
      project: 0,
      system_log: 0,
      other: 0
    };

    const textLower = text.toLowerCase();
    const blockTypes = {};
    for (const b of blocks) {
      blockTypes[b.type] = (blockTypes[b.type] || 0) + 1;
    }

    // ─── Contract Signals ──────────────────────────────────

    if (/\bwhereas\b/i.test(text)) scores.contract += 3;
    if (/\bhereby\b/i.test(text)) scores.contract += 2;
    if (/\bherein\b/i.test(text)) scores.contract += 1;
    if (/\bhereof\b/i.test(text)) scores.contract += 1;
    if (/\bthereof\b/i.test(text)) scores.contract += 1;
    if (/\bterm shall mean\b/i.test(text)) scores.contract += 3;
    if (/\bshall mean\b/i.test(text)) scores.contract += 2;
    if (/\bindemnification\b/i.test(text)) scores.contract += 2;
    if (/\bgoverning law\b/i.test(text)) scores.contract += 2;
    if (/\blimitation of liability\b/i.test(text)) scores.contract += 2;
    if (/\bconfidentiality\b/i.test(text)) scores.contract += 1;
    if (/\btermination\b/i.test(text)) scores.contract += 1;
    if (/\barticle\s+\d+/i.test(text)) scores.contract += 2;
    if (/\bsection\s+\d+\.\d+/i.test(text)) scores.contract += 1;
    if ((blockTypes.definition || 0) > 0) scores.contract += 2;
    if ((blockTypes.signature || 0) > 0) scores.contract += 3;
    // Numbered articles in headings
    const articleHeadings = blocks.filter(b =>
      b.type === 'heading' && /article\s+\d+/i.test(b.text)
    );
    if (articleHeadings.length >= 2) scores.contract += 3;

    // ─── Policy Signals ────────────────────────────────────

    if (/\bpolicy\b/i.test(text)) scores.policy += 2;
    if (/\bprocedures?\b/i.test(text)) scores.policy += 2;
    if (/\bcompliance\b/i.test(text)) scores.policy += 2;
    if (/\bregulations?\b/i.test(text)) scores.policy += 1;
    if (/\bshall\b/i.test(text)) scores.policy += 1;
    if (/\bmust\b/i.test(text)) scores.policy += 1;
    // Section numbering like 1.1, 2.3.1
    const sectionNumbers = (text.match(/^\d+\.\d+/gm) || []).length;
    if (sectionNumbers >= 3) scores.policy += 2;
    // "shall" density (also boosts contract, but policy tends to have more)
    const shallCount = (text.match(/\bshall\b/gi) || []).length;
    if (shallCount >= 5) scores.policy += 2;

    // ─── Transcript Signals ────────────────────────────────

    // Timestamp patterns: [00:12:34], 12:34, (00:12)
    const timestamps = (text.match(/\b\d{1,2}:\d{2}(:\d{2})?\b/g) || []).length;
    if (timestamps >= 5) scores.transcript += 3;
    if (timestamps >= 15) scores.transcript += 2;

    // Speaker labels: "Speaker:", "Q:", "A:", "Speaker 1:"
    const speakerLabels = (text.match(/^(Speaker\s*\d*|Q|A|Interviewer|Interviewee|Moderator|Host|Guest|Participant\s*\d*)[\s]*:/igm) || []).length;
    if (speakerLabels >= 3) scores.transcript += 4;
    if (speakerLabels >= 10) scores.transcript += 3;

    // Dialogue formatting: lines starting with names followed by colons
    const dialogueLines = (text.match(/^[A-Z][a-zA-Z\s]{1,25}:\s/gm) || []).length;
    if (dialogueLines >= 5) scores.transcript += 2;

    // ─── Creative Signals ──────────────────────────────────

    // Narrative structure -- paragraph-heavy, few structural elements
    // Require minimum block count to avoid classifying short snippets as creative
    const paragraphRatio = (blockTypes.paragraph || 0) / Math.max(blocks.length, 1);
    if (paragraphRatio > 0.8 && blocks.length > 5) scores.creative += 2;

    // No legal/technical markers -- only meaningful with enough text
    const noLegalMarkers = !/\b(whereas|hereby|shall mean|indemnification)\b/i.test(text);
    const noTechMarkers = (blockTypes.code || 0) === 0 && !/\b(function|class|import|export|const|let|var)\b/.test(text.slice(0, 2000));
    if (noLegalMarkers && noTechMarkers && paragraphRatio > 0.7 && blocks.length > 5) scores.creative += 2;

    // Informal language signals
    if (/[!]{2,}/.test(text)) scores.creative += 1;
    if (/\blol\b|\bhaha\b|\bomg\b/i.test(text)) scores.creative += 2;

    // Dialogue in creative writing
    const quotedDialogue = (text.match(/[""][^""]+[""].*?(said|asked|replied|whispered|shouted)/gi) || []).length;
    if (quotedDialogue >= 3) scores.creative += 3;

    // ─── Technical Signals ─────────────────────────────────

    if ((blockTypes.code || 0) > 0) scores.technical += 3;
    if ((blockTypes.code || 0) >= 3) scores.technical += 2;
    if (/\bAPI\b/.test(text)) scores.technical += 1;
    if (/\bfunction\b|\bclass\b|\bmodule\b|\binterface\b/.test(text)) scores.technical += 1;
    if (/\b(GET|POST|PUT|DELETE|PATCH)\s+\//.test(text)) scores.technical += 2;
    if (/\b(npm|pip|cargo|brew)\s+(install|add)\b/.test(text)) scores.technical += 2;
    if (/\bconfiguration\b|\bparameters?\b|\bendpoint/i.test(text)) scores.technical += 1;
    // Technical terminology density
    const techTerms = (text.match(/\b(async|await|callback|middleware|schema|payload|serializ|deserializ|authenticat|authorizat|encrypt|decrypt|deploy|container|kubernetes|docker)/gi) || []).length;
    if (techTerms >= 3) scores.technical += 2;
    if (techTerms >= 8) scores.technical += 2;

    // ─── Report Signals ────────────────────────────────────

    if (/\bexecutive summary\b/i.test(text)) scores.report += 4;
    if (/\bfindings\b/i.test(text)) scores.report += 2;
    if (/\brecommendations?\b/i.test(text)) scores.report += 2;
    if (/\bconclusion\b/i.test(text)) scores.report += 2;
    if (/\babstract\b/i.test(text)) scores.report += 2;
    if (/\bmethodology\b/i.test(text)) scores.report += 2;
    if (/\bappendix\b/i.test(text)) scores.report += 1;
    if (/\breferences?\b/i.test(text)) scores.report += 1;
    if ((blockTypes.table || 0) > 0) scores.report += 1;
    // Structured sections with heading levels
    const headingCount = (blockTypes.heading || 0);
    if (headingCount >= 5) scores.report += 1;

    // ─── Project Signals ───────────────────────────────────

    if (/\bkickoff\b/i.test(text)) scores.project += 3;
    if (/\bagenda\b/i.test(text)) scores.project += 2;
    if (/\baction items?\b/i.test(text)) scores.project += 3;
    if (/\btimeline\b/i.test(text)) scores.project += 2;
    if (/\bmilestone/i.test(text)) scores.project += 2;
    if (/\bsprint\b/i.test(text)) scores.project += 2;
    if (/\bdeliverables?\b/i.test(text)) scores.project += 2;
    if (/\bstakeholder/i.test(text)) scores.project += 1;
    if (/\bproject plan\b/i.test(text)) scores.project += 3;
    if (/\b(TODO|DONE|IN PROGRESS|BLOCKED)\b/.test(text)) scores.project += 2;

    // ─── System Log Signals ────────────────────────────────

    // File paths
    const filePaths = (text.match(/\/[a-zA-Z0-9_./-]{5,}/g) || []).length;
    if (filePaths >= 5) scores.system_log += 2;

    // Log levels
    const logLevels = (text.match(/\b(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\b/g) || []).length;
    if (logLevels >= 3) scores.system_log += 3;
    if (logLevels >= 10) scores.system_log += 3;

    // Stack traces
    if (/\bat\s+[A-Za-z_.]+\s*\(/.test(text)) scores.system_log += 2;
    if (/Traceback \(most recent call last\)/i.test(text)) scores.system_log += 3;

    // Shell output patterns
    if (/^\$\s+/m.test(text)) scores.system_log += 2;
    if (/^\s*\d{4}-\d{2}-\d{2}T?\s*\d{2}:\d{2}/m.test(text)) scores.system_log += 2;

    // ─── Determine Winner ──────────────────────────────────

    // Base score for 'other' prevents zero-total division
    scores.other = 1;

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [winnerFamily, winnerScore] = sorted[0];
    const secondScore = sorted.length > 1 ? sorted[1][1] : 0;

    // If winner is 'other' or score is very low, return other with low confidence
    if (winnerFamily === 'other' || winnerScore <= 1) {
      return { family: 'other', confidence: 0.3 };
    }

    // Confidence = winner / (winner + second)
    const total = winnerScore + secondScore;
    const confidence = total > 0 ? Math.round((winnerScore / total) * 100) / 100 : 0.5;

    return {
      family: winnerFamily,
      confidence: Math.min(Math.max(confidence, 0.3), 0.99)
    };
  }
}

module.exports = { DocumentClassifier };

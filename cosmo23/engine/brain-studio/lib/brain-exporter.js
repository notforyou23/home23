/**
 * Brain Exporter
 * 
 * Export brain knowledge in various formats:
 * - Markdown: Human-readable research summary
 * - BibTeX: Academic citations
 * - JSON: Structured data export
 * 
 * Adapted from COSMO's query engine export functionality.
 */

class BrainExporter {
  constructor(brainLoader) {
    this.loader = brainLoader;
  }

  /**
   * Export brain knowledge as Markdown
   */
  async exportMarkdown(options = {}) {
    const {
      includeMetadata = true,
      includeNodes = true,
      includeInsights = false,
      maxNodes = 100
    } = options;

    let md = '';

    // Header
    const manifest = this.loader.manifest;
    md += `# ${manifest?.brain?.displayName || manifest?.brain?.name || 'Brain Export'}\n\n`;
    
    if (includeMetadata) {
      md += `## Metadata\n\n`;
      md += `- **Created:** ${manifest?.brain?.created || 'Unknown'}\n`;
      md += `- **Domain:** ${manifest?.brain?.description || 'N/A'}\n`;
      md += `- **Cycles:** ${manifest?.cosmo?.cycles || 0}\n`;
      md += `- **Nodes:** ${manifest?.content?.nodeCount || 0}\n`;
      md += `- **Edges:** ${manifest?.content?.edgeCount || 0}\n\n`;
    }

    // Top concepts
    if (includeNodes) {
      md += `## Knowledge Nodes\n\n`;
      const nodes = this.loader.getNodes({ limit: maxNodes }).nodes;
      
      // Group by tag
      const byTag = new Map();
      for (const node of nodes) {
        const tag = node.tag || 'unknown';
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(node);
      }

      for (const [tag, tagNodes] of byTag.entries()) {
        md += `### ${tag} (${tagNodes.length})\n\n`;
        for (const node of tagNodes.slice(0, 20)) {
          md += `#### Node ${node.id}\n\n`;
          md += `${node.concept || 'No content'}\n\n`;
          md += `*Weight: ${(node.weight || 0).toFixed(2)}, Activation: ${(node.activation || 0).toFixed(2)}*\n\n`;
        }
      }
    }

    return {
      content: md,
      filename: `${this.getSafeName()}-export.md`,
      format: 'markdown'
    };
  }

  /**
   * Export research sources as BibTeX
   */
  async exportBibTeX() {
    let bib = '';
    let entryCount = 0;

    // Try to find sources in outputs
    // (This is simplified - real implementation would parse source files)
    const manifest = this.loader.manifest;
    const brainName = this.getSafeName();

    // Add brain itself as entry
    bib += `@misc{${brainName},\n`;
    bib += `  title = {${manifest?.brain?.displayName || manifest?.brain?.name || 'Untitled Brain'}},\n`;
    bib += `  author = {COSMO},\n`;
    bib += `  year = {${this.getYear(manifest?.brain?.created)}},\n`;
    bib += `  note = {AI-generated knowledge graph with ${manifest?.content?.nodeCount || 0} nodes},\n`;
    bib += `  url = {local://brain/${brainName}}\n`;
    bib += `}\n\n`;
    entryCount++;

    return {
      content: bib,
      filename: `${brainName}-sources.bib`,
      format: 'bibtex',
      entryCount
    };
  }

  /**
   * Export brain data as JSON
   */
  async exportJSON(options = {}) {
    const {
      includeNodes = true,
      includeEdges = false,
      includeMetadata = true,
      maxNodes = 1000
    } = options;

    const data = {};

    if (includeMetadata) {
      data.metadata = {
        ...this.loader.manifest,
        exportedAt: new Date().toISOString()
      };
    }

    if (includeNodes) {
      const nodesData = this.loader.getNodes({ limit: maxNodes });
      data.nodes = nodesData.nodes.map(n => ({
        id: n.id,
        concept: n.concept,
        tag: n.tag,
        weight: n.weight,
        activation: n.activation,
        cluster: n.cluster
      }));
      data.nodeCount = nodesData.total;
    }

    if (includeEdges) {
      const edges = this.loader.state?.memory?.edges || [];
      data.edges = edges.slice(0, maxNodes * 3).map(e => ({
        source: e.source,
        target: e.target,
        weight: e.weight,
        type: e.type
      }));
      data.edgeCount = edges.length;
    }

    // Stats
    const stats = this.loader.getStats();
    data.stats = stats;

    return {
      content: JSON.stringify(data, null, 2),
      filename: `${this.getSafeName()}-export.json`,
      format: 'json'
    };
  }

  /**
   * Export query answer as formatted document
   */
  async exportQueryAnswer(query, answer, sources, format = 'markdown') {
    if (format === 'markdown') {
      let md = `# Query: ${query}\n\n`;
      md += `**Generated:** ${new Date().toLocaleString()}\n\n`;
      md += `---\n\n`;
      md += `## Answer\n\n`;
      md += answer + '\n\n';
      md += `---\n\n`;
      md += `## Sources\n\n`;
      
      for (const source of sources.slice(0, 20)) {
        md += `### Node ${source.id} (${source.tag || 'unknown'})\n\n`;
        md += `${source.concept || 'No content'}\n\n`;
      }

      return {
        content: md,
        filename: `query-${Date.now()}.md`,
        format: 'markdown'
      };
    }

    return {
      content: JSON.stringify({ query, answer, sources }, null, 2),
      filename: `query-${Date.now()}.json`,
      format: 'json'
    };
  }

  /**
   * Get safe filename from brain name
   */
  getSafeName() {
    const name = this.loader.manifest?.brain?.name || 'brain';
    return name.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
  }

  /**
   * Extract year from ISO date string
   */
  getYear(isoDate) {
    if (!isoDate) return new Date().getFullYear();
    return new Date(isoDate).getFullYear();
  }
}

module.exports = BrainExporter;


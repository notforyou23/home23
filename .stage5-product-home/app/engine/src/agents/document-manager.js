const fs = require('fs').promises;
const path = require('path');

/**
 * DocumentManager - Handles document versioning, updates, and lifecycle management
 *
 * Purpose:
 * - Track document versions and changes over time
 * - Manage document updates and revision history
 * - Provide document search and retrieval capabilities
 * - Handle document archiving and cleanup
 * - Support collaborative document editing workflows
 *
 * Features:
 * - Version control with diff tracking
 * - Document metadata management
 * - Search and filtering capabilities
 * - Archive and cleanup operations
 * - Collaborative editing support
 */
class DocumentManager {
  constructor(logger, capabilities = null) {
    this.logger = logger;
    this.capabilities = capabilities;
    this.documentsDir = path.join(process.cwd(), 'runtime', 'outputs', 'document-creation');
    this.versionsDir = path.join(this.documentsDir, 'versions');
    this.archiveDir = path.join(this.documentsDir, 'archive');
    this.documents = new Map(); // documentId -> metadata
    this.versions = new Map(); // documentId -> [versions]
  }
  
  setCapabilities(capabilities) {
    this.capabilities = capabilities;
  }

  /**
   * Initialize document manager
   */
  async initialize() {
    await this.ensureDirectories();
    await this.loadDocumentIndex();
    this.logger.info('📚 DocumentManager initialized', {
      documentsDir: this.documentsDir,
      documentsLoaded: this.documents.size
    });
  }

  /**
   * Ensure required directories exist
   */
  async ensureDirectories() {
    const dirs = [this.documentsDir, this.versionsDir, this.archiveDir];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Load document index from metadata files
   */
  async loadDocumentIndex() {
    try {
      const files = await fs.readdir(this.documentsDir);
      const metadataFiles = files.filter(f => f.endsWith('_metadata.json'));

      for (const metadataFile of metadataFiles) {
        try {
          const metadataPath = path.join(this.documentsDir, metadataFile);
          const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
          if (!metadata.metadataPath) {
            metadata.metadataPath = metadataPath;
          }

          this.documents.set(metadata.title, metadata);
          this.versions.set(metadata.title, [metadata]);
        } catch (error) {
          this.logger.warn('Failed to load document metadata', {
            file: metadataFile,
            error: error.message
          });
        }
      }
    } catch (error) {
      this.logger.warn('Failed to load document index', { error: error.message });
    }
  }

  /**
   * Create a new version of a document
   */
  async createVersion(documentTitle, newContent, changeDescription = '', author = 'system') {
    const originalDoc = this.documents.get(documentTitle);
    if (!originalDoc) {
      throw new Error(`Document not found: ${documentTitle}`);
    }

    // Read current content
    const currentContent = await fs.readFile(originalDoc.filePath, 'utf8');

    // Generate version info
    const version = {
      version: this.getNextVersion(originalDoc.title),
      timestamp: new Date().toISOString(),
      author,
      changeDescription,
      filePath: this.getVersionPath(originalDoc.title, version),
      previousVersion: originalDoc.version,
      contentHash: this.generateContentHash(newContent),
      size: newContent.length,
      wordCount: this.countWords(newContent)
    };

    // Save versioned content
    if (this.capabilities && this.capabilities.writeFile) {
      const result = await this.capabilities.writeFile(
        path.relative(process.cwd(), version.filePath),
        newContent,
        { agentId: author, agentType: 'document-manager', missionGoal: `document:${documentTitle}` }
      );
      if (!result?.success && !result?.skipped) {
        throw new Error(result?.error || result?.reason || 'Failed to write document version');
      }
    } else {
      await fs.writeFile(version.filePath, newContent, 'utf8');
    }

    // Update document metadata
    const updatedMetadata = {
      ...originalDoc,
      version: version.version,
      lastModified: version.timestamp,
      lastModifiedBy: author,
      latestContent: newContent,
      latestFilePath: version.filePath,
      versions: [...(originalDoc.versions || []), version]
    };

    // Save updated metadata
    if (this.capabilities && this.capabilities.writeFile) {
      const result = await this.capabilities.writeFile(
        path.relative(process.cwd(), originalDoc.metadataPath),
        JSON.stringify(updatedMetadata, null, 2),
        { agentId: author, agentType: 'document-manager', missionGoal: `document:${documentTitle}` }
      );
      if (!result?.success && !result?.skipped) {
        throw new Error(result?.error || result?.reason || 'Failed to write document metadata');
      }
    } else {
      await fs.writeFile(originalDoc.metadataPath, JSON.stringify(updatedMetadata, null, 2), 'utf8');
    }

    // Update in-memory structures
    this.documents.set(documentTitle, updatedMetadata);
    if (!this.versions.has(documentTitle)) {
      this.versions.set(documentTitle, []);
    }
    this.versions.get(documentTitle).push(version);

    this.logger.info('📝 Document version created', {
      title: documentTitle,
      version: version.version,
      author,
      changeDescription: changeDescription.substring(0, 50)
    });

    return version;
  }

  /**
   * Get all versions of a document
   */
  async getDocumentVersions(documentTitle) {
    const versions = this.versions.get(documentTitle) || [];
    return versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /**
   * Get specific version of a document
   */
  async getDocumentVersion(documentTitle, version) {
    const versions = await this.getDocumentVersions(documentTitle);
    return versions.find(v => v.version === version);
  }

  /**
   * Compare two versions of a document
   */
  async compareVersions(documentTitle, version1, version2) {
    const v1 = await this.getDocumentVersion(documentTitle, version1);
    const v2 = await this.getDocumentVersion(documentTitle, version2);

    if (!v1 || !v2) {
      throw new Error('One or both versions not found');
    }

    const content1 = await fs.readFile(v1.filePath, 'utf8');
    const content2 = await fs.readFile(v2.filePath, 'utf8');

    return {
      version1: v1,
      version2: v2,
      content1,
      content2,
      changes: this.calculateDiff(content1, content2)
    };
  }

  /**
   * Update document with new content
   */
  async updateDocument(documentTitle, newContent, changeDescription = '', author = 'system') {
    const version = await this.createVersion(documentTitle, newContent, changeDescription, author);

    this.logger.info('📝 Document updated', {
      title: documentTitle,
      version: version.version,
      author,
      changeDescription: changeDescription.substring(0, 50)
    });

    return version;
  }

  /**
   * Search documents by various criteria
   */
  async searchDocuments(criteria = {}) {
    let results = Array.from(this.documents.values());

    // Filter by type
    if (criteria.type) {
      results = results.filter(doc => doc.type === criteria.type);
    }

    // Filter by author
    if (criteria.author) {
      results = results.filter(doc => doc.createdBy?.includes(criteria.author) || doc.lastModifiedBy?.includes(criteria.author));
    }

    // Filter by date range
    if (criteria.dateFrom) {
      results = results.filter(doc => new Date(doc.createdAt) >= new Date(criteria.dateFrom));
    }
    if (criteria.dateTo) {
      results = results.filter(doc => new Date(doc.createdAt) <= new Date(criteria.dateTo));
    }

    // Filter by content search
    if (criteria.search) {
      const searchTerm = criteria.search.toLowerCase();
      results = results.filter(doc =>
        doc.title.toLowerCase().includes(searchTerm) ||
        doc.type.toLowerCase().includes(searchTerm) ||
        doc.description?.toLowerCase().includes(searchTerm)
      );
    }

    // Sort results
    results.sort((a, b) => new Date(b.lastModified || b.createdAt) - new Date(a.lastModified || a.createdAt));

    return results;
  }

  /**
   * Archive old document versions
   */
  async archiveOldVersions(documentTitle, keepVersions = 5) {
    const versions = await this.getDocumentVersions(documentTitle);
    const toArchive = versions.slice(keepVersions);

    for (const version of toArchive) {
      await this.moveToArchive(version.filePath, `version_${version.version}`);
      version.archived = true;
      version.archivedAt = new Date().toISOString();
    }

    this.logger.info('📦 Archived old document versions', {
      document: documentTitle,
      archived: toArchive.length,
      kept: keepVersions
    });

    return toArchive.length;
  }

  /**
   * Delete document and all its versions
   */
  async deleteDocument(documentTitle) {
    const doc = this.documents.get(documentTitle);
    if (!doc) {
      throw new Error(`Document not found: ${documentTitle}`);
    }

    // Delete all version files
    const versions = await this.getDocumentVersions(documentTitle);
    for (const version of versions) {
      try {
        await fs.unlink(version.filePath);
      } catch (error) {
        this.logger.warn('Failed to delete version file', {
          file: version.filePath,
          error: error.message
        });
      }
    }

    // Delete metadata file
    try {
      await fs.unlink(doc.metadataPath);
    } catch (error) {
      this.logger.warn('Failed to delete metadata file', {
        file: doc.metadataPath,
        error: error.message
      });
    }

    // Remove from memory
    this.documents.delete(documentTitle);
    this.versions.delete(documentTitle);

    this.logger.info('🗑️ Document deleted', {
      title: documentTitle,
      versionsDeleted: versions.length
    });

    return true;
  }

  /**
   * Get document statistics
   */
  getDocumentStats() {
    const docs = Array.from(this.documents.values());

    return {
      totalDocuments: docs.length,
      totalVersions: Array.from(this.versions.values()).reduce((sum, arr) => sum + arr.length, 0),
      documentsByType: this.groupByType(docs),
      documentsByAuthor: this.groupByAuthor(docs),
      recentActivity: this.getRecentActivity(docs),
      storageUsed: this.calculateStorageUsed(docs)
    };
  }

  /**
   * Export document index for backup
   */
  async exportIndex() {
    const index = {
      documents: Array.from(this.documents.entries()),
      versions: Array.from(this.versions.entries()),
      exportedAt: new Date().toISOString(),
      stats: this.getDocumentStats()
    };

    const exportPath = path.join(this.documentsDir, `document_index_${Date.now()}.json`);
    if (this.capabilities && this.capabilities.writeFile) {
      const result = await this.capabilities.writeFile(
        path.relative(process.cwd(), exportPath),
        JSON.stringify(index, null, 2),
        { agentId: 'system', agentType: 'document-manager', missionGoal: 'export_document_index' }
      );
      if (!result?.success && !result?.skipped) {
        throw new Error(result?.error || result?.reason || 'Failed to export document index');
      }
    } else {
      await fs.writeFile(exportPath, JSON.stringify(index, null, 2), 'utf8');
    }

    return exportPath;
  }

  /**
   * Import document index from backup
   */
  async importIndex(indexPath) {
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));

    this.documents = new Map(index.documents);
    this.versions = new Map(index.versions);

    this.logger.info('📥 Document index imported', {
      documentsImported: this.documents.size,
      versionsImported: this.versions.size
    });

    return true;
  }

  // Helper methods

  getNextVersion(documentTitle) {
    const versions = this.versions.get(documentTitle) || [];
    if (versions.length === 0) return '1.0.0';

    const latest = versions[versions.length - 1];
    const parts = latest.version.split('.').map(Number);
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }

  getVersionPath(documentTitle, version) {
    const sanitizedTitle = documentTitle.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(this.versionsDir, `${sanitizedTitle}_v${version}.md`);
  }

  generateContentHash(content) {
    // Simple hash function for content comparison
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  countWords(content) {
    return content.trim().split(/\s+/).length;
  }

  calculateDiff(content1, content2) {
    // Simple line-based diff for demonstration
    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');

    const changes = [];
    const maxLines = Math.max(lines1.length, lines2.length);

    for (let i = 0; i < maxLines; i++) {
      if (lines1[i] !== lines2[i]) {
        changes.push({
          line: i + 1,
          old: lines1[i] || '',
          new: lines2[i] || '',
          type: lines1[i] ? (lines2[i] ? 'modified' : 'deleted') : 'added'
        });
      }
    }

    return changes;
  }

  async moveToArchive(filePath, archiveName) {
    const archivePath = path.join(this.archiveDir, archiveName);
    await fs.rename(filePath, archivePath);
  }

  groupByType(docs) {
    return docs.reduce((acc, doc) => {
      acc[doc.type] = (acc[doc.type] || 0) + 1;
      return acc;
    }, {});
  }

  groupByAuthor(docs) {
    return docs.reduce((acc, doc) => {
      const author = doc.createdBy || 'unknown';
      acc[author] = (acc[author] || 0) + 1;
      return acc;
    }, {});
  }

  getRecentActivity(docs) {
    return docs
      .sort((a, b) => new Date(b.lastModified || b.createdAt) - new Date(a.lastModified || a.createdAt))
      .slice(0, 10)
      .map(doc => ({
        title: doc.title,
        type: doc.type,
        lastModified: doc.lastModified || doc.createdAt,
        author: doc.lastModifiedBy || doc.createdBy
      }));
  }

  calculateStorageUsed(docs) {
    return docs.reduce((total, doc) => {
      return total + (doc.characterCount || 0);
    }, 0);
  }
}

module.exports = { DocumentManager };

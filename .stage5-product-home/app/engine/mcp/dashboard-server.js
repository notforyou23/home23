#!/usr/bin/env node

/**
 * MCP Dashboard Server
 * 
 * Serves a web dashboard that visualizes Cosmo's brain via MCP protocol
 * Demonstrates how to build applications on top of the MCP server
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.COSMO_MCP_HTTP_PORT || 3346;

// NEW: Serve curated insights reports
// Path: /reports/insights_curated_LATEST.md
app.use('/reports', express.static(path.join(__dirname, '..', 'runtime', 'coordinator')));

// Serve dashboards
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-flow.html'));
});

app.get('/classic', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-enhanced.html'));
});

app.get('/graph', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-graph.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mcp-dashboard' });
});

app.listen(PORT, () => {
  console.log('🎨 Cosmo MCP Dashboard running at http://localhost:' + PORT);
  console.log('');
  console.log('   Dashboard Views:');
  console.log('   • Flow View (NEW):    http://localhost:' + PORT);
  console.log('   • Classic View:       http://localhost:' + PORT + '/classic');
  console.log('');
  console.log('   Connects to MCP server at http://localhost:3347/mcp');
  console.log('');
  console.log('Make sure the MCP server is running:');
  console.log('   npm run mcp:http');
  console.log('');
  
  // Try to open browser to main dashboard home (Research Lab)
  const open = require('child_process').exec;
  const command = process.platform === 'darwin' ? 'open' : 
                  process.platform === 'win32' ? 'start' : 'xdg-open';
  open(`${command} http://localhost:3344`, (error) => {
    if (error) {
      console.log('Open browser manually: http://localhost:3344');
    }
  });
});

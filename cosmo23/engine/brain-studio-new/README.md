# COSMO Brain Platform

A portable, standalone browser and IDE for exploring, querying, and interacting with COSMO `.brain` packages and runs.

## 🚀 Overview

This package provides a complete, self-contained environment to:
1. **Browse**: Discover and manage your library of exported brains and COSMO runs.
2. **Query**: Use the high-performance GPT-5 synthesis engine to search knowledge graphs.
3. **IDE**: Edit, preview, and collaborate with AI using a full Cursor-style web interface.
4. **Explore**: Visualize complex memory networks through interactive graph views.

## 📦 Installation

```bash
# 1. Clone or copy the platform folder
cd brain-studio-new

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY and ANTHROPIC_API_KEY
```

## 🛠️ Usage

### Quick Start
```bash
npm start
```
This launches the **Brain Browser** at `http://localhost:3398`. From there, you can see all available brains and launch the **Brain Studio IDE** with a single click.

### Direct Studio Launch
If you want to open a specific brain directly in the IDE:
```bash
npm run studio -- /path/to/your.brain
```

## 📁 Portability & Organization

The platform is designed to be decoupled from the main COSMO research engine. 

- **Brains Directory**: Place any `.brain` folder into the `brains/` subdirectory. The Browser will automatically detect and index them.
- **COSMO Fallback**: If run from within the COSMO repository, it will automatically detect and allow you to explore active runs in the `runs/` directory.
- **Self-Contained**: All core logic, front-end assets, and AI coordination are contained within this folder.

## 🔒 Security & Privacy

This platform is designed for **trusted local use**.
- **Local Isolation**: The IDE operates on the directory path provided to it.
- **API Safety**: All LLM communication is handled server-side using your configured keys in `.env`.
- **Process Management**: Dynamically spawned Studio instances are isolated from each other.
- **Data Privacy**: No data leaves your local machine except for standard LLM inference requests to OpenAI/Anthropic.
- **Terminal Access**: The AI Assistant has the capability to run terminal commands (via `run_terminal`) to help with coding tasks. Always review proposed actions in the "AI Edits" panel.
- **Network**: The server binds to `localhost` by default. Avoid exposing these ports to the public internet without a secure proxy.

## 🏗️ Architecture

```
brain-platform/
├── index.js            # Main entry (Browser launcher)
├── server/
│   ├── browser.js      # Brain discovery logic
│   ├── server.js       # IDE / Studio core server
│   └── ai-handler.js   # LLM coordination & Tools
├── lib/                # Shared logic (QueryEngine, Indexers)
├── public/             # IDE and Browser front-end
└── brains/             # Default location for portable brain packages
```

---
*COSMO Brain Platform v2.1*

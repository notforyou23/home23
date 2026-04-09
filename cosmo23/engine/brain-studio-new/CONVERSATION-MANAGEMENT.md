# 💬 Conversation Management Guide

Your COSMO IDE now has **full conversation saving and loading** capabilities!

## ✨ Features

- 💾 **Save conversations** - Keep important AI chats for later
- 📂 **Load conversations** - Continue where you left off
- 🔄 **Update conversations** - Save over existing conversations
- ➕ **Multiple conversations** - Manage unlimited saved chats
- 🗑️ **Delete conversations** - Remove old chats you don't need

---

## 🎯 How to Use

### **Save a Conversation**

1. Chat with the AI as normal
2. Click **💾 Save** button in the AI panel
3. Enter a title for your conversation
4. Done! Your conversation is saved

**Tip:** Give descriptive titles like "Bug fix for auth system" or "React refactoring discussion"

---

### **Load a Saved Conversation**

1. Click the **💬 Conversation** dropdown
2. Select any saved conversation from the list
3. The entire chat history loads automatically
4. Continue chatting where you left off!

The dropdown shows:
- Conversation title
- Number of messages (e.g., "Bug fix discussion (12 msgs)")

---

### **Start a New Conversation**

**Option 1:** Click **➕ New** button
- Confirms if you want to clear current chat
- Starts fresh

**Option 2:** Select "New Conversation" from dropdown

---

### **Update an Existing Conversation**

1. Load a saved conversation
2. Add more messages by chatting
3. Click **💾 Save** again
4. Enter same title (or new title)
5. Conversation is updated with new messages

---

### **Delete a Conversation**

1. Load the conversation you want to delete
2. Click **🗑️** button
3. Confirm deletion
4. Conversation is permanently removed

---

## 📁 Where Conversations are Stored

Conversations are saved in:
```
<your-cosmo-ide-directory>/conversations/
```

Each conversation is a JSON file containing:
- `id` - Unique identifier
- `title` - Your custom title
- `timestamp` - When created
- `folder` - Associated project folder (if any)
- `messages` - Full chat history

You can manually browse/backup these files if needed!

---

## 🔄 Conversation Format

Each saved conversation includes:
```json
{
  "id": "conv_1234567890_abc123",
  "title": "Bug fix discussion",
  "timestamp": "2025-12-10T04:50:00.000Z",
  "folder": "/path/to/your/project",
  "messages": [
    { "role": "user", "content": "Help me fix..." },
    { "role": "assistant", "content": "Sure, let me..." }
  ]
}
```

---

## 💡 Pro Tips

1. **Save often** - Save important conversations before starting something new
2. **Descriptive titles** - Use clear names to find conversations later
3. **Project-specific** - One conversation per project/task works best
4. **Continue context** - Load previous conversations to maintain context across sessions
5. **Backup** - The `conversations/` folder can be backed up/synced

---

## 🎨 UI Location

Find conversation management in the **AI Panel** (right side):

```
🤖 Model
└─ [Model Selector]

💬 Conversation
├─ [Conversation Dropdown]  ← Select saved conversations
├─ 💾 Save | ➕ New | 🗑️   ← Action buttons
```

---

## 🚀 Quick Workflow

**Typical usage:**
1. Start working on a task → Chat with AI
2. Save conversation → "Implementing auth system"
3. Next day → Load "Implementing auth system"
4. Continue chatting → AI remembers full context
5. Update saved conversation → Same title, adds new messages

**Project-based:**
- Save: "Project A - Frontend"
- Save: "Project A - Backend"  
- Save: "Project B - Database"
- Load whichever you're working on!

---

## 🔒 Privacy

- Conversations stored **locally only** on your Mac
- Not uploaded to cloud
- Full control over your data
- Delete anytime

---

Enjoy seamless conversation management! 🎉
